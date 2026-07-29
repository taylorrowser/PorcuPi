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
  for (const path of [paths.temporary, paths.compositions, paths.receipts, paths.state]) {
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

async function confirmInstallation(lock, input, output) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    fail("Guided installation requires an interactive terminal");
  }
  output.write("\x1b[?25l");
  output.write("\nInstall PorcuPi\n\n");
  output.write(`Pi Base: ${lock.tag} (${lock.commit})\n`);
  output.write("Stock Pi: preserved\n");
  output.write("Patches: none\n\n");
  output.write("Enter  Install    Esc  Cancel\n");
  input.setRawMode(true);
  input.resume();
  return await new Promise((resolvePromise, rejectPromise) => {
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      input.off("data", onData);
      input.off("error", onError);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h");
    };
    const onData = (data) => {
      const byte = data[0];
      if (byte === 0x0d || byte === 0x0a) {
        restore();
        resolvePromise(true);
      } else if (byte === 0x1b || byte === 0x03) {
        restore();
        resolvePromise(false);
      }
    };
    const onError = (error) => {
      restore();
      rejectPromise(error);
    };
    const onSignal = (signal) => {
      restore();
      process.kill(process.pid, signal);
    };
    const onSigint = () => onSignal("SIGINT");
    const onSigterm = () => onSignal("SIGTERM");
    input.on("data", onData);
    input.once("error", onError);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

export async function installManagedPi({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  platform = process.platform,
} = {}) {
  verifyHostNode();
  platformIdentity(platform, process.arch);
  const lock = loadBaseLock();
  const confirmed = await confirmInstallation(lock, input, output);
  if (!confirmed) {
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
    removePreparedTree(temporaryRoot);

    output.write(`\nInstalled zero-Patch Managed Pi ${lock.tag}.\n`);
    output.write(`Command: ${launcher}\n`);
    const pathDirectories = (environment.PATH || "").split(":");
    if (!pathDirectories.includes(binDirectory)) output.write(`Add ${binDirectory} to PATH.\n`);
    output.write("Stock Pi and Pi user data were preserved.\n");
    return { installed: true, launcher, compositionId: receipt.compositionId };
  } catch (error) {
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
