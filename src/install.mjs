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
  createRuntimeReceipt,
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
  verifyOptionalPiLauncher,
  verifyRuntime,
} from "./runtime.mjs";
import {
  buildComposition,
  copyCompositionInputs,
  loadBaseLock,
  pathExists,
  porcupiVersion,
  publishComposition,
  removePreparedTree,
  verifyHostNode,
  verifyPublishedComposition,
} from "./composition.mjs";
import { runGuidedTerminal } from "./guided-terminal.mjs";
import { cleanupRetainedCompositions, withLifecycleLock } from "./lifecycle.mjs";
import { reconcilePiOwnershipLocked } from "./pi-ownership.mjs";
import { readSelections } from "./resource-intent.mjs";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const upgradeMigrationContracts = new Map([
  ["0.1.0", Object.freeze({ sourceStateSchema: 1, targetStateSchema: 1 })],
]);

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

function stageRuntime(stageRoot, name = "runtime") {
  const stagedRuntime = join(stageRoot, name);
  cpSync(sourceDirectory, stagedRuntime, { recursive: true });
  copyCompositionInputs(stagedRuntime);
  return stagedRuntime;
}

function publishFreshRuntime(paths, stageRoot) {
  renameSync(stageRuntime(stageRoot), paths.runtime);
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) fail(`Unsupported PorcuPi version identity: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? null };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    return a.prerelease === b.prerelease ? 0 : a.prerelease === null ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null || rightNumber !== null) {
      if (leftNumber === null) return 1;
      if (rightNumber === null) return -1;
      return leftNumber < rightNumber ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function readInstalledVersion(paths) {
  const metadata = readJson(join(paths.runtime, "package.json"), "installed PorcuPi package metadata");
  if (typeof metadata.version !== "string") fail("Malformed installed PorcuPi package version");
  compareVersions(metadata.version, metadata.version);
  return metadata.version;
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

function confirmUpgrade({ active, installedVersion, lock, ownPi, input, output }) {
  let page = 0;
  return runGuidedTerminal({
    command: "PorcuPi upgrade",
    input,
    output,
    createController: ({ finish }) => {
      const render = () => {
        output.write("\x1b[2J\x1b[H");
        output.write(`Upgrade PorcuPi — ${page + 1} of 3 — ${["Upgrade", "Readiness", "Review"][page]}\n\n`);
        if (page === 0) {
          output.write(`Installed PorcuPi: ${installedVersion}\n`);
          output.write(`Installed Pi Base: ${active.receipt.piBase.tag} (${active.receipt.piBase.commit})\n`);
          output.write(`Target PorcuPi: ${porcupiVersion}\n`);
          output.write(`Target Pi Base: ${lock.tag} (${lock.commit})\n\n`);
          output.write("[Enter/→] Continue  [Esc] cancel\n");
        } else if (page === 1) {
          output.write("Upgrade Readiness Check: ready\n\n");
          output.write("The exact zero-Patch target passed its fixed build, conformance, version, and smoke checks.\n");
          output.write("The check did not change Activation, Compositions, launchers, Selection Intent, or shared Pi state.\n\n");
          output.write("[Enter/→] Continue  [←] back  [Esc] cancel\n");
        } else {
          output.write(`PorcuPi: ${installedVersion} → ${porcupiVersion}\n`);
          output.write(`Pi Base: ${active.receipt.piBase.tag} → ${lock.tag}\n`);
          output.write("Selection Intent: empty — selected Artifact upgrades are handled separately\n");
          output.write(`Own \`pi\`: ${ownPi ? "Yes — existing reversible alias retained" : "No — independent resolution retained"}\n`);
          output.write("Stock Pi and Pi-owned state: retained\n\n");
          output.write("[Enter] Upgrade  [←] back  [Esc] cancel\n");
        }
      };
      const handleKeypress = (_character, key) => {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(false);
        if (key.name === "left" || key.name === "h") page = Math.max(0, page - 1);
        else if (page < 2 && (key.name === "right" || key.name === "return" || key.name === "l")) page += 1;
        else if (page === 2 && key.name === "return") return finish(true);
        render();
      };
      return { render, handleKeypress };
    },
  });
}

function validateExistingInstallation(paths, launcher, environment) {
  const rootStat = lstatSync(paths.root);
  const owner = readJson(paths.owner, "PorcuPi root ownership");
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || canonicalJson(owner) !== canonicalJson(managedRootOwner)) {
    fail(`PorcuPi data root is foreign: ${paths.root}`);
  }
  const active = readActiveComposition(paths.root);
  verifyRuntime(paths);
  const installedCli = join(paths.runtime, "cli.mjs");
  const cliStat = lstatSync(installedCli);
  if (!cliStat.isFile() || cliStat.isSymbolicLink()) fail("Installed PorcuPi runtime is malformed");
  const hasLauncher = pathExists(launcher);
  const hasLauncherReceipt = pathExists(paths.launcherReceipt);
  if (hasLauncher) {
    const stat = lstatSync(launcher);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || readFileSync(launcher, "utf8") !== shellLauncherContents(installedCli)
    ) fail(`Refusing foreign porcupi command collision: ${launcher}`);
    if (hasLauncherReceipt) verifyLauncher(paths, environment);
  } else if (hasLauncherReceipt) fail(`Receipt-owned PorcuPi launcher is missing: ${launcher}`);
  return { active, installedCli, installedVersion: readInstalledVersion(paths), hasLauncher, hasLauncherReceipt };
}

async function upgradeManagedPi({ paths, launcher, existing, lock, input, output, environment }) {
  const migration = upgradeMigrationContracts.get(existing.installedVersion);
  if (!migration) fail(`No versioned state migration supports PorcuPi ${existing.installedVersion} → ${porcupiVersion}`);
  if (existing.active.activation.schemaVersion !== migration.sourceStateSchema) {
    fail(`Upgrade requires PorcuPi ${existing.installedVersion} state schema ${migration.sourceStateSchema}`);
  }
  const activeReceipt = verifyPublishedComposition(paths, existing.active.activation.active.compositionId);
  if (activeReceipt.patches.length !== 0 || existing.active.activation.active.patches.length !== 0) {
    fail(`Upgrade Readiness Check blocked: PorcuPi ${porcupiVersion} supports only an intact zero-Patch v0.1.0 installation`);
  }
  if (existing.active.activation.previous) {
    verifyPublishedComposition(paths, existing.active.activation.previous.compositionId);
  }
  const ownedPi = Boolean(verifyOptionalPiLauncher(paths, environment));
  const selections = readSelections(paths.root);
  if (selections.sources.length !== 0) {
    fail(`Upgrade Readiness Check blocked: PorcuPi ${porcupiVersion} selected Artifact migration is handled by a later upgrade contract`);
  }

  output.write(`Upgrade candidate: installed PorcuPi ${existing.installedVersion}, target PorcuPi ${porcupiVersion}.\n`);
  output.write(`Migration contract: state schema ${migration.sourceStateSchema} → ${migration.targetStateSchema}.\n`);
  output.write(`Installed Pi Base: ${existing.active.receipt.piBase.tag} (${existing.active.receipt.piBase.commit}); target Pi Base: ${lock.tag} (${lock.commit}).\n`);
  const stageRoot = join(paths.temporary, `upgrade-${randomUUID()}`);
  mkdirSync(stageRoot, { mode: 0o700 });
  writeFileSync(join(stageRoot, "owner.json"), `${JSON.stringify({
    schemaVersion: 1,
    type: "porcupi-upgrade-stage",
    installedVersion: existing.installedVersion,
    targetVersion: porcupiVersion,
  }, null, 2)}\n`, { mode: 0o600 });
  const candidateRoot = join(stageRoot, "composition");
  mkdirSync(candidateRoot, { mode: 0o700 });
  let runtimeSwitchStarted = false;
  let activated = false;
  const previousRuntime = join(stageRoot, "previous-runtime");
  const previousRuntimeReceipt = readJson(paths.runtimeReceipt, "PorcuPi runtime receipt");
  try {
    const receipt = buildComposition({ candidateRoot, stageRoot, patches: [], lock });
    stageRuntime(stageRoot, "target-runtime");
    const targetActivation = {
      schemaVersion: migration.targetStateSchema,
      active: { compositionId: receipt.compositionId, patches: [] },
      previous: existing.active.activation.active,
    };
    const confirmed = await confirmUpgrade({
      active: existing.active,
      installedVersion: existing.installedVersion,
      lock,
      ownPi: ownedPi,
      input,
      output,
    });
    if (!confirmed) {
      removePreparedTree(stageRoot);
      output.write("\nUpgrade cancelled. No authoritative state was changed.\n");
      return { installed: false, upgraded: false, cancelled: true };
    }

    publishComposition(paths, candidateRoot, receipt);
    ensureCompositionLeaseDirectory(paths, receipt.compositionId);
    runtimeSwitchStarted = true;
    renameSync(paths.runtime, previousRuntime);
    renameSync(join(stageRoot, "target-runtime"), paths.runtime);
    atomicWrite(paths.runtimeReceipt, createRuntimeReceipt(paths));
    verifyRuntime(paths);
    verifyLauncher(paths, environment);
    verifyOptionalPiLauncher(paths, environment);
    atomicWrite(paths.activation, targetActivation);
    activated = true;
    cleanupRetainedCompositions(paths, targetActivation, output);
    removePreparedTree(previousRuntime);
    removePreparedTree(stageRoot);
    output.write(`\nUpgraded PorcuPi from ${existing.installedVersion} to ${porcupiVersion}.\n`);
    output.write(`Activated verified zero-Patch Managed Pi Composition ${receipt.compositionId}.\n`);
    output.write(`Retained previous Managed Pi Composition ${existing.active.activation.active.compositionId}.\n`);
    output.write(`Command: ${launcher}\n`);
    output.write("Stock Pi, Pi-owned state, empty Selection Intent, and `pi` ownership were preserved.\n");
    return { installed: true, upgraded: true, launcher, compositionId: receipt.compositionId };
  } catch (error) {
    if (runtimeSwitchStarted && !activated && pathExists(previousRuntime)) {
      removePreparedTree(paths.runtime);
      renameSync(previousRuntime, paths.runtime);
      atomicWrite(paths.runtimeReceipt, previousRuntimeReceipt);
    }
    removePreparedTree(stageRoot);
    throw error;
  }
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
  const dataRoot = defaultDataRoot(environment, platform);
  const binDirectory = defaultBinDirectory(environment);
  const launcher = join(binDirectory, "porcupi");
  const paths = managedLayout(dataRoot);

  if (pathExists(paths.root) && pathExists(paths.activation)) {
    const existing = validateExistingInstallation(paths, launcher, environment);
    const comparison = compareVersions(porcupiVersion, existing.installedVersion);
    if (comparison < 0) {
      fail(`Unsupported PorcuPi downgrade: installed ${existing.installedVersion}, invoked target ${porcupiVersion}; no changes were made`);
    }
    if (comparison > 0) {
      if (!existing.hasLauncher || !existing.hasLauncherReceipt) {
        fail("Upgrade requires an intact receipt-owned PorcuPi launcher; run the installed release to recover it first");
      }
      return upgradeManagedPi({ paths, launcher, existing, lock, input, output, environment });
    }

    if (!existing.hasLauncher) publishLauncher(launcher, existing.installedCli);
    if (!existing.hasLauncherReceipt) atomicWrite(paths.launcherReceipt, createLauncherReceipt(launcher));
    verifyLauncher(paths, environment);
    verifyPublishedComposition(paths, existing.active.activation.active.compositionId);
    if (pathExists(paths.piTransition)) {
      const transition = readJson(paths.piTransition, "PorcuPi pi ownership transition");
      if (!new Set(["enable", "disable"]).has(transition?.action)) fail("Malformed PorcuPi pi ownership transition");
      reconcilePiOwnershipLocked(paths, transition.action === "enable", environment, output);
    }
    verifyOptionalPiLauncher(paths, environment);
    output.write(`\nRecovered installed zero-Patch Managed Pi ${existing.active.receipt.piBase.tag}.\n`);
    output.write(`Verified installed PorcuPi ${porcupiVersion}; no rebuild was needed.\n`);
    output.write(`Command: ${launcher}\n`);
    output.write("Stock Pi and Pi user data were preserved.\n");
    return { installed: true, recovered: true, launcher, compositionId: existing.active.receipt.compositionId };
  }

  const ownPi = await confirmInstallation(lock, input, output);
  if (ownPi === null) {
    output.write("\nInstallation cancelled. No changes were made.\n");
    return { installed: false };
  }
  if (pathExists(launcher)) fail(`Refusing foreign porcupi command collision: ${launcher}`);
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
    publishFreshRuntime(paths, temporaryRoot);
    atomicWrite(paths.runtimeReceipt, createRuntimeReceipt(paths));
    verifyRuntime(paths);
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
