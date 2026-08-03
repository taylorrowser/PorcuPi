import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
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
  createPayloadInventory,
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
import { patchIntentPending, patchSelectionSnapshot, readSelections } from "./resource-intent.mjs";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const upgradeMigrationContracts = new Map([
  ["0.1.0", Object.freeze({
    sourceStateSchema: 1,
    targetStateSchema: 1,
    runtimeChangedPaths: Object.freeze(["runtime.mjs", "install.mjs", "package.json"]),
  })],
]);
const upgradeOwnerBaseFields = new Set(["schemaVersion", "type", "installedVersion", "targetVersion", "phase"]);
const upgradeOwnerCompleteFields = new Set([
  ...upgradeOwnerBaseFields,
  "targetCompositionId",
  "sourceActivation",
  "targetActivation",
  "previousRuntimeReceipt",
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

function atomicallyReplaceRuntimeFile(source, destination) {
  const sourceStat = lstatSync(source);
  const destinationStat = lstatSync(destination);
  if (
    !sourceStat.isFile()
    || sourceStat.isSymbolicLink()
    || !destinationStat.isFile()
    || destinationStat.isSymbolicLink()
  ) fail(`Upgrade runtime path is not a regular file: ${destination}`);
  const temporary = join(dirname(destination), `.${basename(destination)}.upgrade-${randomUUID()}`);
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, sourceStat.mode & 0o777);
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, destination);
    try {
      const directory = openSync(dirname(destination), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch {
      // Atomic replacement still prevents a missing or partial runtime file.
    }
  } finally {
    if (pathExists(temporary)) unlinkSync(temporary);
  }
}

function validateRuntimeMigration(paths, targetRuntime, migration) {
  const sourceEntries = new Map(createPayloadInventory(paths.runtime).map((entry) => [entry.path, entry]));
  const targetEntries = new Map(createPayloadInventory(targetRuntime).map((entry) => [entry.path, entry]));
  const changed = new Set(migration.runtimeChangedPaths);
  const sourceOnly = [...sourceEntries.keys()].filter((path) => !targetEntries.has(path));
  const targetOnly = [...targetEntries.keys()].filter((path) => !sourceEntries.has(path));
  if (sourceEntries.size !== targetEntries.size || sourceOnly.length !== 0 || targetOnly.length !== 0) {
    fail(`Upgrade runtime migration requires identical source and target inventories; source-only: ${sourceOnly.join(", ") || "none"}; target-only: ${targetOnly.join(", ") || "none"}`);
  }
  for (const [path, sourceEntry] of sourceEntries) {
    const targetEntry = targetEntries.get(path);
    const differs = canonicalJson(sourceEntry) !== canonicalJson(targetEntry);
    if (differs !== changed.has(path)) {
      fail(`Upgrade runtime migration contract mismatch at ${path}`);
    }
    if (changed.has(path) && (sourceEntry.kind !== "file" || targetEntry.kind !== "file")) {
      fail(`Upgrade runtime migration requires regular changed files: ${path}`);
    }
  }
}

function publishTargetRuntimeFiles(paths, stageRoot, migration) {
  const targetRuntime = join(stageRoot, "target-runtime");
  for (const path of migration.runtimeChangedPaths) {
    atomicallyReplaceRuntimeFile(join(targetRuntime, path), join(paths.runtime, path));
    checkpoint(`upgrade-runtime-${path.replaceAll(".", "-")}-published`);
  }
}

function restorePreviousRuntimeFiles(paths, stageRoot, migration) {
  const previousRuntime = join(stageRoot, "previous-runtime");
  for (const path of migration.runtimeChangedPaths) {
    atomicallyReplaceRuntimeFile(join(previousRuntime, path), join(paths.runtime, path));
  }
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

function recoverUpgradeStages(paths, environment, output) {
  let recoveredUpgrade = null;
  for (const name of readdirSync(paths.temporary).sort()) {
    if (!name.startsWith("upgrade-")) continue;
    const stageRoot = join(paths.temporary, name);
    const stageStat = lstatSync(stageRoot);
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) fail(`Foreign upgrade stage requires manual inspection: ${stageRoot}`);
    const owner = readJson(join(stageRoot, "owner.json"), "upgrade stage ownership");
    const fields = owner?.phase === "readiness" ? upgradeOwnerBaseFields : upgradeOwnerCompleteFields;
    if (
      owner === null
      || typeof owner !== "object"
      || Array.isArray(owner)
      || Object.keys(owner).length !== fields.size
      || Object.keys(owner).some((field) => !fields.has(field))
      || owner.schemaVersion !== 1
      || owner.type !== "porcupi-upgrade-stage"
      || typeof owner.installedVersion !== "string"
      || owner.targetVersion !== porcupiVersion
      || !new Set(["readiness", "prepared", "composition-published", "runtime-switching", "runtime-published", "activated"]).has(owner.phase)
    ) fail(`Foreign upgrade stage requires manual inspection: ${stageRoot}`);

    if (new Set(["readiness", "prepared", "composition-published"]).has(owner.phase)) {
      removePreparedTree(stageRoot);
      continue;
    }
    const migration = upgradeMigrationContracts.get(owner.installedVersion);
    if (
      !migration
      || typeof owner.targetCompositionId !== "string"
      || owner.targetActivation?.active?.compositionId !== owner.targetCompositionId
      || owner.targetActivation?.previous?.compositionId !== owner.sourceActivation?.active?.compositionId
      || owner.previousRuntimeReceipt?.schemaVersion !== 1
      || owner.previousRuntimeReceipt?.type !== "porcupi-runtime"
      || !/^[a-f0-9]{64}$/.test(owner.previousRuntimeReceipt?.inventorySha256 || "")
    ) fail(`Upgrade stage does not match the invoking release: ${stageRoot}`);

    if (owner.phase === "runtime-switching") {
      const targetRuntime = join(stageRoot, "target-runtime");
      const previousRuntime = join(stageRoot, "previous-runtime");
      if (!pathExists(targetRuntime) || !pathExists(previousRuntime) || !pathExists(paths.runtime)) {
        fail(`Interrupted upgrade runtime state requires manual inspection: ${stageRoot}`);
      }
      validateRuntimeMigration({ ...paths, runtime: previousRuntime }, targetRuntime, migration);
      publishTargetRuntimeFiles(paths, stageRoot, migration);
      atomicWrite(paths.runtimeReceipt, createRuntimeReceipt(paths));
      atomicWrite(join(stageRoot, "owner.json"), { ...owner, phase: "runtime-published" });
      owner.phase = "runtime-published";
    }
    if (owner.phase === "runtime-published") {
      verifyRuntime(paths);
      if (readInstalledVersion(paths) !== owner.targetVersion) fail(`Upgrade target runtime identity mismatch: ${stageRoot}`);
      verifyPublishedComposition(paths, owner.targetCompositionId);
      verifyLauncher(paths, environment);
      verifyOptionalPiLauncher(paths, environment);
      atomicWrite(paths.activation, owner.targetActivation);
      atomicWrite(join(stageRoot, "owner.json"), { ...owner, phase: "activated" });
      owner.phase = "activated";
    }
    if (owner.phase === "activated") {
      const activation = readJson(paths.activation, "PorcuPi activation");
      if (canonicalJson(activation) !== canonicalJson(owner.targetActivation)) {
        fail(`Activated upgrade state mismatch: ${stageRoot}`);
      }
      removePreparedTree(stageRoot);
      cleanupRetainedCompositions(paths, activation, output);
      output.write(`Recovered completed PorcuPi upgrade to ${owner.targetVersion}.\n`);
      recoveredUpgrade = { installed: true, upgraded: true, recovered: true, compositionId: owner.targetCompositionId };
    }
  }
  return recoveredUpgrade;
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

function selectedArtifactReview(sources) {
  return sources.flatMap((source) => source.artifacts.map((artifact) => {
    const scope = artifact.scope ? ` [${artifact.scope}${artifact.projectRoot ? `: ${artifact.projectRoot}` : ""}]` : "";
    return `${artifact.kind} ${source.locator}@${source.commit}:${artifact.path}${scope}`;
  }));
}

function confirmUpgrade({ active, installedVersion, lock, ownPi, selections, input, output }) {
  const artifacts = selectedArtifactReview(selections.sources);
  const pending = patchIntentPending(selections.sources, active.activation.active.patches);
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
          output.write(`Active Composition: ${active.activation.active.compositionId}\n`);
          output.write(`Previous Composition: ${active.activation.previous?.compositionId ?? "none"}\n`);
          output.write(`Patch Selection Intent: ${pending ? "pending — differs from the active Patch selection" : "current — matches the active Patch selection"}\n`);
          output.write(`Selected Artifacts (${artifacts.length}):\n`);
          if (artifacts.length === 0) output.write("- none\n");
          else for (const artifact of artifacts) output.write(`- ${artifact}\n`);
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
  verifyPublishedComposition(paths, existing.active.activation.active.compositionId);
  if (existing.active.activation.previous) {
    verifyPublishedComposition(paths, existing.active.activation.previous.compositionId);
  }
  const ownedPi = Boolean(verifyOptionalPiLauncher(paths, environment));
  const selections = readSelections(paths.root);
  const selectedPatches = patchSelectionSnapshot(selections.sources);
  const activePatches = existing.active.activation.active.patches;

  output.write(`Upgrade candidate: installed PorcuPi ${existing.installedVersion}, target PorcuPi ${porcupiVersion}.\n`);
  output.write(`Migration contract: state schema ${migration.sourceStateSchema} → ${migration.targetStateSchema}.\n`);
  output.write(`Installed Pi Base: ${existing.active.receipt.piBase.tag} (${existing.active.receipt.piBase.commit}); target Pi Base: ${lock.tag} (${lock.commit}).\n`);
  if (selectedPatches.length !== 0 || activePatches.length !== 0) {
    output.write(`Upgrade Readiness Check blocked for target Pi Base ${lock.tag} (${lock.commit}):\n`);
    for (const patch of selectedPatches) {
      output.write(`- selected Patch ${patch.locator}@${patch.commit}:${patch.path} (sha256 ${patch.sha256})\n`);
    }
    for (const patch of activePatches) {
      output.write(`- active Patch ${patch.locator}@${patch.commit}:${patch.path} (sha256 ${patch.sha256})\n`);
    }
    fail(`Upgrade Readiness Check blocked: target PorcuPi ${porcupiVersion} requires zero selected and active Patches; exact blockers are listed above`);
  }
  const stageRoot = join(paths.temporary, `upgrade-${randomUUID()}`);
  let stageOwner = {
    schemaVersion: 1,
    type: "porcupi-upgrade-stage",
    installedVersion: existing.installedVersion,
    targetVersion: porcupiVersion,
    phase: "readiness",
  };
  mkdirSync(stageRoot, { mode: 0o700 });
  writeFileSync(join(stageRoot, "owner.json"), `${JSON.stringify(stageOwner, null, 2)}\n`, { mode: 0o600 });
  const candidateRoot = join(stageRoot, "composition");
  mkdirSync(candidateRoot, { mode: 0o700 });
  let runtimeSwitchStarted = false;
  let activated = false;
  const previousRuntime = join(stageRoot, "previous-runtime");
  const previousRuntimeReceipt = readJson(paths.runtimeReceipt, "PorcuPi runtime receipt");
  try {
    const receipt = buildComposition({ candidateRoot, stageRoot, patches: [], lock });
    const targetRuntime = stageRuntime(stageRoot, "target-runtime");
    cpSync(paths.runtime, previousRuntime, { recursive: true });
    validateRuntimeMigration(paths, targetRuntime, migration);
    const targetActivation = {
      schemaVersion: migration.targetStateSchema,
      active: { compositionId: receipt.compositionId, patches: [] },
      previous: existing.active.activation.active,
    };
    stageOwner = {
      ...stageOwner,
      phase: "prepared",
      targetCompositionId: receipt.compositionId,
      sourceActivation: existing.active.activation,
      targetActivation,
      previousRuntimeReceipt,
    };
    atomicWrite(join(stageRoot, "owner.json"), stageOwner);
    const confirmed = await confirmUpgrade({
      active: existing.active,
      installedVersion: existing.installedVersion,
      lock,
      ownPi: ownedPi,
      selections,
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
    stageOwner = { ...stageOwner, phase: "composition-published" };
    atomicWrite(join(stageRoot, "owner.json"), stageOwner);
    checkpoint("upgrade-composition-published");
    stageOwner = { ...stageOwner, phase: "runtime-switching" };
    atomicWrite(join(stageRoot, "owner.json"), stageOwner);
    runtimeSwitchStarted = true;
    publishTargetRuntimeFiles(paths, stageRoot, migration);
    atomicWrite(paths.runtimeReceipt, createRuntimeReceipt(paths));
    stageOwner = { ...stageOwner, phase: "runtime-published" };
    atomicWrite(join(stageRoot, "owner.json"), stageOwner);
    verifyRuntime(paths);
    verifyLauncher(paths, environment);
    verifyOptionalPiLauncher(paths, environment);
    checkpoint("upgrade-runtime-published");
    const activation = targetActivation;
    atomicWrite(paths.activation, activation);
    activated = true;
    stageOwner = { ...stageOwner, phase: "activated" };
    atomicWrite(join(stageRoot, "owner.json"), stageOwner);
    checkpoint("upgrade-activation-written");
    removePreparedTree(stageRoot);
    cleanupRetainedCompositions(paths, activation, output);
    output.write(`\nUpgraded PorcuPi from ${existing.installedVersion} to ${porcupiVersion}.\n`);
    output.write(`Activated verified zero-Patch Managed Pi Composition ${receipt.compositionId}.\n`);
    output.write(`Retained previous Managed Pi Composition ${existing.active.activation.active.compositionId}.\n`);
    output.write(`Command: ${launcher}\n`);
    output.write("Stock Pi, Pi-owned state, Selection Intent, and `pi` ownership were preserved.\n");
    return { installed: true, upgraded: true, launcher, compositionId: receipt.compositionId };
  } catch (error) {
    if (runtimeSwitchStarted && !activated && pathExists(previousRuntime)) {
      restorePreviousRuntimeFiles(paths, stageRoot, migration);
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
    const recoveredUpgrade = recoverUpgradeStages(paths, environment, output);
    const existing = validateExistingInstallation(paths, launcher, environment);
    if (recoveredUpgrade) return { ...recoveredUpgrade, launcher };
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
