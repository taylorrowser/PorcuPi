import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWrite,
  canonicalJson,
  createLauncherReceipt,
  defaultBinDirectory,
  defaultDataRoot,
  ensureCompositionLeaseDirectory,
  fail,
  managedLayout,
  managedRootOwner,
  platformIdentity,
  readActiveComposition,
  readJson,
  shellLauncherContents,
  verifyLauncher,
} from "./runtime.mjs";
import {
  buildComposition,
  copyCompositionInputs,
  loadBaseLock,
  pathExists,
  publishComposition,
  removePreparedTree,
  verifyHostNode,
} from "./composition.mjs";
import { runGuidedTerminal } from "./guided-terminal.mjs";
import { withLifecycleLock } from "./lifecycle.mjs";
import { reconcilePiOwnershipLocked } from "./pi-ownership.mjs";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

function initializeFreshRoot(paths) {
  if (pathExists(paths.root)) {
    const owner = readJson(paths.owner, "PorcuPi root ownership");
    if (canonicalJson(owner) !== canonicalJson(managedRootOwner)) fail(`PorcuPi data root is foreign: ${paths.root}`);
    if (existsSync(paths.activation)) fail(`PorcuPi is already installed at ${paths.root}`);
    removePreparedTree(paths.root);
  }
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  atomicWrite(paths.owner, managedRootOwner);
  for (const path of [paths.temporary, paths.compositions, paths.receipts, paths.leases, paths.state]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

function publishRuntime(paths, stageRoot) {
  const stagedRuntime = join(stageRoot, "runtime");
  cpSync(sourceDirectory, stagedRuntime, { recursive: true });
  copyCompositionInputs(stagedRuntime);
  renameSync(stagedRuntime, paths.runtime);
}

function checkpoint(name) {
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAULT === name) {
    process.kill(process.pid, "SIGKILL");
  }
}

function publishLauncher(path, cliPath) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  try {
    writeFileSync(temporary, shellLauncherContents(cliPath), { mode: 0o755 });
    // A same-directory hard link is an atomic exclusive publication: EEXIST
    // refuses a command created during the long build instead of replacing it.
    linkSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function confirmInstallation(lock, input, output) {
  let page = 0;
  let ownPi = false;
  return runGuidedTerminal({
    command: "PorcuPi installation",
    input,
    output,
    createController: ({ finish }) => {
      const render = () => {
        output.write("\x1b[2J\x1b[H");
        output.write(`Install PorcuPi — ${page + 1} of 3 — ${["Installation", "Command ownership", "Review"][page]}\n\n`);
        if (page === 0) {
          output.write(`Pi Base: ${lock.tag} (${lock.commit})\n`);
          output.write("Stock Pi files: preserved\n");
          output.write("Patches: none\n\n");
          output.write("[Enter/→] Continue  [Esc] cancel\n");
        } else if (page === 1) {
          output.write("Should PorcuPi own the `pi` command? (default: No)\n\n");
          output.write(`${ownPi ? "○" : "●"} No  — keep \`pi\` independently resolved\n`);
          output.write(`${ownPi ? "●" : "○"} Yes — publish a reversible ~/.local/bin/pi alias\n\n`);
          output.write("[↑/↓ y/n] choose  [Enter/→] Continue  [←] back  [Esc] cancel\n");
        } else {
          output.write(`Pi Base: ${lock.tag} (${lock.commit})\n`);
          output.write(`Own \`pi\`: ${ownPi ? "Yes — reversible PorcuPi alias" : "No — independent resolution"}\n`);
          output.write("Stock Pi files: preserved\n\n");
          output.write("[Enter] Install  [←] back  [Esc] cancel\n");
        }
      };
      const handleKeypress = (character, key) => {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(null);
        if (key.name === "left" || key.name === "h") page = Math.max(0, page - 1);
        else if (page === 0 && (key.name === "right" || key.name === "return" || key.name === "l")) page = 1;
        else if (page === 1 && (key.name === "up" || key.name === "n" || character === "n")) ownPi = false;
        else if (page === 1 && (key.name === "down" || key.name === "y" || character === "y")) ownPi = true;
        else if (page === 1 && (key.name === "right" || key.name === "return" || key.name === "l")) page = 2;
        else if (page === 2 && key.name === "return") return finish(ownPi);
        render();
      };
      return { render, handleKeypress };
    },
  });
}

async function installManagedPiLocked({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  platform = process.platform,
} = {}) {
  verifyHostNode();
  platformIdentity(platform, process.arch);
  const lock = loadBaseLock();
  const ownPi = await confirmInstallation(lock, input, output);
  if (ownPi === null) {
    output.write("\nInstallation cancelled. No changes were made.\n");
    return { installed: false };
  }

  const dataRoot = defaultDataRoot(environment, platform);
  const binDirectory = defaultBinDirectory(environment);
  const launcher = join(binDirectory, "porcupi");
  const paths = managedLayout(dataRoot);
  let recoverable;
  if (pathExists(paths.root) && pathExists(paths.activation)) {
    const rootStat = lstatSync(paths.root);
    const owner = readJson(paths.owner, "PorcuPi root ownership");
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || canonicalJson(owner) !== canonicalJson(managedRootOwner)) {
      fail(`PorcuPi data root is foreign: ${paths.root}`);
    }
    const active = readActiveComposition(dataRoot);
    const installedCli = join(paths.runtime, "cli.mjs");
    const cliStat = lstatSync(installedCli);
    if (!cliStat.isFile() || cliStat.isSymbolicLink()) fail("Installed PorcuPi runtime is malformed");
    recoverable = { active, installedCli };
  }
  const hasLauncher = pathExists(launcher);
  const hasLauncherReceipt = pathExists(paths.launcherReceipt);
  if (hasLauncher) {
    const stat = lstatSync(launcher);
    if (
      !recoverable
      || !stat.isFile()
      || stat.isSymbolicLink()
      || readFileSync(launcher, "utf8") !== shellLauncherContents(recoverable.installedCli)
    ) {
      fail(`Refusing foreign porcupi command collision: ${launcher}`);
    }
    if (hasLauncherReceipt) verifyLauncher(paths, environment);
  } else if (hasLauncherReceipt) fail(`Receipt-owned PorcuPi launcher is missing: ${launcher}`);
  if (recoverable) {
    if (!hasLauncher) publishLauncher(launcher, recoverable.installedCli);
    if (!hasLauncherReceipt) atomicWrite(paths.launcherReceipt, createLauncherReceipt(launcher));
    verifyLauncher(paths, environment);
    reconcilePiOwnershipLocked(paths, ownPi, environment, output);
    output.write(`\nRecovered installed zero-Patch Managed Pi ${recoverable.active.receipt.piBase.tag}.\n`);
    output.write(`Command: ${launcher}\n`);
    output.write("Stock Pi and Pi user data were preserved.\n");
    return { installed: true, recovered: true, launcher, compositionId: recoverable.active.receipt.compositionId };
  }
  let initialized = false;
  let publishedLauncher = false;
  try {
    initializeFreshRoot(paths);
    initialized = true;
    const temporaryRoot = join(paths.temporary, `install-${randomUUID()}`);
    const stagedComposition = join(temporaryRoot, "composition");
    mkdirSync(stagedComposition, { recursive: true, mode: 0o700 });
    writeFileSync(join(temporaryRoot, "owner.json"), `${JSON.stringify({ schemaVersion: 1, type: "porcupi-install-stage" })}\n`, { mode: 0o600 });

    const receipt = buildComposition({ candidateRoot: stagedComposition, stageRoot: temporaryRoot, patches: [], lock });
    publishComposition(paths, stagedComposition, receipt);
    ensureCompositionLeaseDirectory(paths, receipt.compositionId);
    checkpoint("composition-published");
    publishRuntime(paths, temporaryRoot);
    atomicWrite(paths.activation, {
      schemaVersion: 1,
      active: { compositionId: receipt.compositionId, patches: [] },
      previous: null,
    });
    checkpoint("activation-written");
    publishLauncher(launcher, join(paths.runtime, "cli.mjs"));
    publishedLauncher = true;
    atomicWrite(paths.launcherReceipt, createLauncherReceipt(launcher));
    verifyLauncher(paths, environment);
    checkpoint("launcher-published");
    reconcilePiOwnershipLocked(paths, ownPi, environment, output);
    removePreparedTree(temporaryRoot);

    output.write(`\nInstalled zero-Patch Managed Pi ${lock.tag}.\n`);
    output.write(`Command: ${launcher}\n`);
    const pathDirectories = (environment.PATH || "").split(":");
    if (!pathDirectories.includes(binDirectory)) output.write(`Add ${binDirectory} to PATH.\n`);
    output.write("Stock Pi and Pi user data were preserved.\n");
    return { installed: true, launcher, compositionId: receipt.compositionId };
  } catch (error) {
    if (initialized && pathExists(paths.activation)) {
      reconcilePiOwnershipLocked(paths, false, environment, { write() {} });
    }
    if (publishedLauncher) {
      try {
        const stat = lstatSync(launcher);
        if (
          stat.isFile()
          && !stat.isSymbolicLink()
          && readFileSync(launcher, "utf8") === shellLauncherContents(join(paths.runtime, "cli.mjs"))
        ) unlinkSync(launcher);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
    }
    if (initialized) removePreparedTree(paths.root);
    throw error;
  }
}

export async function installManagedPi(options = {}) {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const dataRoot = defaultDataRoot(environment, platform);
  return withLifecycleLock(dataRoot, "install", () => installManagedPiLocked({ ...options, environment, platform }));
}
