import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  atomicWrite,
  canonicalJson,
  createLauncherReceipt,
  compositionLeaseDirectory,
  createPayloadInventory,
  createRuntimeReceipt,
  defaultBinDirectory,
  defaultDataRoot,
  ensureCompositionLeaseDirectory,
  exactObject,
  fail,
  managedLayout,
  managedRootOwner,
  platformIdentity,
  readActivation,
  readActiveComposition,
  readJson,
  sha256Bytes,
  shellLauncherContents,
  validateActivation,
  validateCompositionReceipt,
  validateCompositionLeaseDirectory,
  validateLauncherReceipt,
  validateOwnedDirectory,
  validateRuntimeReceipt,
  verifyLauncher,
  verifyLauncherReceipt,
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
  verifyCompositionContents,
  verifyHostNode,
  verifyPublishedComposition,
} from "./composition.mjs";
import { runGuidedTerminal } from "./guided-terminal.mjs";
import { cleanupRetainedCompositions, durableUnlink, withLifecycleLock } from "./lifecycle.mjs";
import { reconcilePiOwnershipLocked } from "./pi-ownership.mjs";
import {
  patchIntentPending,
  patchSelectionSnapshot,
  readSelections,
  stageSelectionIntent,
  summarizeRetainedPiResources,
} from "./resource-intent.mjs";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const migrationContractKey = (sourceVersion, targetVersion) => `${sourceVersion} → ${targetVersion}`;
const upgradeMigrationContracts = new Map([
  [migrationContractKey("0.1.0", "0.2.0"), Object.freeze({ sourceStateSchema: 1, targetStateSchema: 1 })],
]);
const noUpgradeRecovery = Object.freeze({ restartRequired: false });
const restartAfterUpgradeRecovery = Object.freeze({ restartRequired: true });

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
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_HOLD_UPGRADE_BOUNDARY === name) {
    if (process.env.PORCUPI_TEST_UPGRADE_BOUNDARY_FILE) {
      writeFileSync(process.env.PORCUPI_TEST_UPGRADE_BOUNDARY_FILE, `${name}\n`);
    }
    const milliseconds = Number(process.env.PORCUPI_TEST_HOLD_UPGRADE_BOUNDARY_MS ?? 1_500);
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }
  }
}

const upgradeStageOwnerFields = new Set([
  "schemaVersion", "type", "dataRoot", "stage", "installedVersion", "targetVersion", "nonce",
]);
const upgradeTransactionFields = new Set([
  "schemaVersion", "type", "dataRoot", "stage", "installedVersion", "targetVersion",
  "sourceRuntimeReceipt", "targetRuntimeReceipt", "sourceActivation", "targetActivation",
  "compositionReceipt", "sourceLauncherReceipt", "transitionLauncherReceipt", "piLauncherReceipt",
  "selectionIntentSha256", "stageInventory",
]);
const upgradeCleanupFields = new Set([
  "schemaVersion", "type", "dataRoot", "sourceStage", "retiredStage", "targetVersion", "nonce", "inventory",
  "removablePaths",
]);
const upgradeScratchReceiptFields = new Set(["schemaVersion", "type", "stage", "nonce", "inventory"]);
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function scratchInventory(root) {
  const entries = [];
  const visit = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        entries.push({ path, kind: "directory" });
        visit(absolute, path);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        entries.push({
          path,
          kind: "file",
          mode: stat.mode & 0o777,
          size: stat.size,
          sha256: sha256Bytes(readFileSync(absolute)),
        });
      } else if (stat.isSymbolicLink()) {
        entries.push({ path, kind: "symlink", target: readlinkSync(absolute) });
      } else fail(`Upgrade scratch contains an unsupported path: ${absolute}`);
    }
  };
  visit(root);
  return entries;
}

function validateScratchInventory(value, label) {
  if (!Array.isArray(value)) fail(`Malformed ${label}`);
  let previous;
  for (const entry of value) {
    const pathIsValid = typeof entry?.path === "string"
      && entry.path.length > 0
      && !entry.path.startsWith("/")
      && !entry.path.includes("\\")
      && !entry.path.split("/").some((part) => part === "" || part === "." || part === "..");
    const valid = pathIsValid && (
      (exactObject(entry, new Set(["path", "kind"])) && entry.kind === "directory")
      || (exactObject(entry, new Set(["path", "kind", "mode", "size", "sha256"]))
        && entry.kind === "file"
        && Number.isInteger(entry.mode)
        && entry.mode >= 0
        && entry.mode <= 0o777
        && Number.isSafeInteger(entry.size)
        && entry.size >= 0
        && /^[a-f0-9]{64}$/.test(entry.sha256 || ""))
      || (exactObject(entry, new Set(["path", "kind", "target"]))
        && entry.kind === "symlink"
        && typeof entry.target === "string")
    );
    if (!valid || (previous !== undefined && entry.path <= previous)) fail(`Malformed ${label}`);
    previous = entry.path;
  }
  return value;
}

function pathMatchesAny(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function validateScratchRemainder(root, expected, { ignoredPaths = [], removablePaths = [], message }) {
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actual = scratchInventory(root);
  const actualPaths = new Set(actual.map((entry) => entry.path));
  for (const entry of actual) {
    if (pathMatchesAny(entry.path, ignoredPaths)) continue;
    if (canonicalJson(entry) !== canonicalJson(expectedByPath.get(entry.path))) fail(message);
  }
  for (const entry of expected) {
    if (!actualPaths.has(entry.path) && !pathMatchesAny(entry.path, removablePaths)) fail(message);
  }
}

function validateUpgradeTransactionRemainder(stage, expected) {
  validateScratchRemainder(stage, expected, {
    ignoredPaths: ["previous-runtime", "transaction.json"],
    removablePaths: ["composition", "published-runtime", "target-leases"],
    message: `Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`,
  });
}

function upgradeScratchInventory(stage) {
  return scratchInventory(stage).filter((entry) => entry.path !== "scratch.json");
}

function writeUpgradeScratchReceipt(stage, owner) {
  atomicWrite(join(stage, "scratch.json"), {
    schemaVersion: 1,
    type: "porcupi-upgrade-scratch",
    stage,
    nonce: owner.nonce,
    inventory: upgradeScratchInventory(stage),
  });
}

function readUpgradeScratchReceipt(stage, owner) {
  const receipt = readJson(join(stage, "scratch.json"), "PorcuPi upgrade scratch receipt");
  if (
    !exactObject(receipt, upgradeScratchReceiptFields)
    || receipt.schemaVersion !== 1
    || receipt.type !== "porcupi-upgrade-scratch"
    || receipt.stage !== stage
    || receipt.nonce !== owner.nonce
  ) fail(`Foreign PorcuPi upgrade stage requires manual inspection: ${stage}`);
  validateScratchInventory(receipt.inventory, "PorcuPi upgrade scratch inventory");
  return receipt;
}

function validateUpgradeScratchReceipt(stage, owner) {
  const receipt = readUpgradeScratchReceipt(stage, owner);
  if (canonicalJson(upgradeScratchInventory(stage)) !== canonicalJson(receipt.inventory)) {
    fail(`Foreign PorcuPi upgrade stage requires manual inspection: ${stage}`);
  }
}

function validateIncompleteUpgradeScratch(stage, owner) {
  const receipt = readUpgradeScratchReceipt(stage, owner);
  const expectedByPath = new Map(receipt.inventory.map((entry) => [entry.path, entry]));
  const mutablePaths = [
    "composition", "patches", "published-runtime", "smoke-home", "target-activation.json", "target-leases",
    "target-runtime",
  ];
  for (const entry of upgradeScratchInventory(stage)) {
    const expected = expectedByPath.get(entry.path);
    if (canonicalJson(entry) === canonicalJson(expected)) continue;
    if (pathMatchesAny(entry.path, mutablePaths) || /^preflight-[0-9a-f-]+(?:\/|$)/.test(entry.path)) continue;
    fail(`Foreign PorcuPi upgrade stage requires manual inspection: ${stage}`);
  }
  const actualPaths = new Set(upgradeScratchInventory(stage).map((entry) => entry.path));
  for (const entry of receipt.inventory) {
    if (!actualPaths.has(entry.path) && !pathMatchesAny(entry.path, mutablePaths)) {
      fail(`Foreign PorcuPi upgrade stage requires manual inspection: ${stage}`);
    }
  }
}

function runtimeReceiptFor(root) {
  return {
    schemaVersion: 2,
    type: "porcupi-runtime",
    inventorySha256: sha256Bytes(canonicalJson(createPayloadInventory(root))),
  };
}

function validateRuntimeDirectory(ownershipRoot, path, receipt, label) {
  validateOwnedDirectory(ownershipRoot, path, label);
  if (runtimeReceiptFor(path).inventorySha256 !== receipt.inventorySha256) fail(`${label} inventory mismatch: ${path}`);
}

function validateUpgradeRecoveryRoot(paths) {
  let rootStat;
  try {
    rootStat = lstatSync(paths.root);
  } catch {
    fail("Malformed PorcuPi upgrade recovery root");
  }
  const owner = readJson(paths.owner, "PorcuPi root ownership");
  if (
    !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || canonicalJson(owner) !== canonicalJson(managedRootOwner)
  ) fail("Malformed PorcuPi upgrade recovery root");
  try {
    for (const path of [paths.temporary, paths.state, paths.compositions, paths.receipts, paths.leases]) {
      validateOwnedDirectory(paths.root, path, "PorcuPi upgrade recovery directory");
    }
  } catch {
    fail("Malformed PorcuPi upgrade recovery root");
  }
}

function readUpgradeStageOwner(paths, stage) {
  let stat;
  try {
    stat = lstatSync(stage);
  } catch {
    fail(`Foreign PorcuPi upgrade stage requires manual inspection: ${stage}`);
  }
  const owner = readJson(join(stage, "owner.json"), "PorcuPi upgrade stage ownership");
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || !exactObject(owner, upgradeStageOwnerFields)
    || owner.schemaVersion !== 1
    || owner.type !== "porcupi-upgrade-stage"
    || owner.dataRoot !== paths.root
    || owner.stage !== stage
    || dirname(stage) !== paths.temporary
    || !uuidV4Pattern.test(owner.nonce || "")
    || basename(stage) !== `upgrade-${owner.nonce}`
    || typeof owner.installedVersion !== "string"
    || typeof owner.targetVersion !== "string"
  ) fail(`Foreign PorcuPi upgrade stage requires manual inspection: ${stage}`);
  compareVersions(owner.installedVersion, owner.installedVersion);
  compareVersions(owner.targetVersion, owner.targetVersion);
  if (
    owner.targetVersion !== porcupiVersion
    || !upgradeMigrationContracts.has(migrationContractKey(owner.installedVersion, owner.targetVersion))
  ) fail(`Foreign PorcuPi upgrade stage requires manual inspection: ${stage}`);
  return owner;
}

function expectedTransitionLauncherReceipt(sourceReceipt, stage) {
  const contents = shellLauncherContents(join(stage, "target-runtime", "cli.mjs"));
  return {
    schemaVersion: 1,
    type: "porcupi-launcher",
    path: sourceReceipt.path,
    kind: "file",
    mode: sourceReceipt.mode,
    size: Buffer.byteLength(contents),
    sha256: sha256Bytes(contents),
  };
}

function readUpgradeTransaction({ paths, stage, owner, launcher }) {
  const transaction = readJson(join(stage, "transaction.json"), "PorcuPi upgrade transaction");
  if (
    !exactObject(transaction, upgradeTransactionFields)
    || transaction.schemaVersion !== 1
    || transaction.type !== "porcupi-upgrade-transaction"
    || transaction.dataRoot !== paths.root
    || transaction.stage !== stage
    || transaction.installedVersion !== owner.installedVersion
    || transaction.targetVersion !== owner.targetVersion
    || transaction.targetVersion !== porcupiVersion
  ) fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
  const sourceActivation = validateActivation(transaction.sourceActivation);
  const targetActivation = validateActivation(transaction.targetActivation);
  const receipt = validateCompositionReceipt(transaction.compositionReceipt, targetActivation.active.compositionId);
  if (
    targetActivation.previous === null
    || canonicalJson(targetActivation.previous) !== canonicalJson(sourceActivation.active)
    || canonicalJson(targetActivation.active.patches) !== canonicalJson(receipt.patches)
  ) fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
  validateRuntimeReceipt(transaction.sourceRuntimeReceipt, "PorcuPi upgrade source runtime receipt");
  validateRuntimeReceipt(transaction.targetRuntimeReceipt, "PorcuPi upgrade target runtime receipt");
  validateLauncherReceipt(transaction.sourceLauncherReceipt, {
    type: "porcupi-launcher", path: launcher, label: "PorcuPi upgrade source launcher receipt",
  });
  validateLauncherReceipt(transaction.transitionLauncherReceipt, {
    type: "porcupi-launcher", path: launcher, label: "PorcuPi upgrade transition launcher receipt",
  });
  if (canonicalJson(transaction.transitionLauncherReceipt) !== canonicalJson(expectedTransitionLauncherReceipt(
    transaction.sourceLauncherReceipt,
    stage,
  ))) fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
  if (
    (transaction.piLauncherReceipt !== null && transaction.piLauncherReceipt?.type !== "porcupi-pi-launcher")
    || (transaction.selectionIntentSha256 !== null && !/^[a-f0-9]{64}$/.test(transaction.selectionIntentSha256 || ""))
  ) fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
  const migrated = validateActivation(readJson(join(stage, "target-activation.json"), "migrated PorcuPi activation"));
  if (canonicalJson(migrated) !== canonicalJson(targetActivation)) {
    fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
  }
  validateRuntimeDirectory(stage, join(stage, "target-runtime"), transaction.targetRuntimeReceipt, "Staged target PorcuPi runtime");
  if (canonicalJson(transaction.targetRuntimeReceipt) !== canonicalJson(runtimeReceiptFor(join(stage, "target-runtime")))) {
    fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
  }
  const candidateRoot = join(stage, "composition");
  if (pathExists(candidateRoot)) {
    const embedded = validateCompositionReceipt(
      readJson(join(candidateRoot, "receipt.json"), "staged Composition receipt"),
      receipt.compositionId,
    );
    if (canonicalJson(embedded) !== canonicalJson(receipt)) {
      fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
    }
    verifyCompositionContents(candidateRoot, receipt);
  } else {
    const compositionRoot = join(paths.compositions, receipt.compositionId);
    let stat;
    try {
      stat = lstatSync(compositionRoot);
    } catch {
      fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
    }
    const embedded = validateCompositionReceipt(
      readJson(join(compositionRoot, "receipt.json"), "interrupted Composition receipt"),
      receipt.compositionId,
    );
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalJson(embedded) !== canonicalJson(receipt)) {
      fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
    }
    verifyCompositionContents(compositionRoot, receipt);
    const centralPath = join(paths.receipts, `${receipt.compositionId}.json`);
    if (pathExists(centralPath) && canonicalJson(readJson(centralPath, "central Composition receipt")) !== canonicalJson(receipt)) {
      fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
    }
  }
  const stagedLeases = join(stage, "target-leases");
  const finalLeases = compositionLeaseDirectory(paths, receipt.compositionId);
  if (pathExists(stagedLeases)) {
    const leaseOwner = readJson(join(stagedLeases, "owner.json"), "staged Composition lease ownership");
    if (
      lstatSync(stagedLeases).isSymbolicLink()
      || !lstatSync(stagedLeases).isDirectory()
      || canonicalJson(readdirSync(stagedLeases).sort()) !== canonicalJson(["owner.json"])
      || canonicalJson(leaseOwner) !== canonicalJson({
        schemaVersion: 1, type: "porcupi-composition-leases", compositionId: receipt.compositionId,
      })
    ) fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
  } else if (!pathExists(finalLeases)) {
    fail(`Foreign PorcuPi upgrade transaction requires manual inspection: ${stage}`);
  }
  if (pathExists(finalLeases)) validateCompositionLeaseDirectory(paths, receipt.compositionId);
  validateScratchInventory(transaction.stageInventory, "PorcuPi upgrade transaction stage inventory");
  validateUpgradeTransactionRemainder(stage, transaction.stageInventory);
  return transaction;
}

function replaceLauncher(path, contents, mode) {
  const temporary = join(dirname(path), `.${basename(path)}.upgrade-${randomUUID()}`);
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    if (pathExists(temporary)) unlinkSync(temporary);
  }
}

function runtimeKind(ownershipRoot, path, transaction) {
  if (!pathExists(path)) return "missing";
  validateOwnedDirectory(ownershipRoot, path, "PorcuPi runtime during upgrade recovery");
  const inventorySha256 = runtimeReceiptFor(path).inventorySha256;
  if (inventorySha256 === transaction.sourceRuntimeReceipt.inventorySha256) return "source";
  if (inventorySha256 === transaction.targetRuntimeReceipt.inventorySha256) return "target";
  fail(`PorcuPi runtime changed during upgrade recovery: ${path}`);
}

function validateUpgradePublicationState({ paths, launcher, stage, transaction, environment }) {
  const activation = readActivation(paths);
  if (
    canonicalJson(activation) !== canonicalJson(transaction.sourceActivation)
    && canonicalJson(activation) !== canonicalJson(transaction.targetActivation)
  ) fail("PorcuPi Activation changed during upgrade recovery");
  const sourceActive = verifyPublishedComposition(paths, transaction.sourceActivation.active.compositionId);
  if (canonicalJson(sourceActive.patches) !== canonicalJson(transaction.sourceActivation.active.patches)) {
    fail("Source Managed Pi Composition changed during upgrade recovery");
  }
  if (canonicalJson(activation) === canonicalJson(transaction.sourceActivation) && transaction.sourceActivation.previous) {
    verifyPublishedComposition(paths, transaction.sourceActivation.previous.compositionId);
  }
  const selectionsPath = join(paths.state, "selections.json");
  const selectionIntentSha256 = pathExists(selectionsPath) ? sha256Bytes(readFileSync(selectionsPath)) : null;
  if (selectionIntentSha256 !== transaction.selectionIntentSha256) {
    fail("PorcuPi Selection Intent changed during upgrade recovery");
  }
  const runtimeReceipt = validateRuntimeReceipt(readJson(paths.runtimeReceipt, "PorcuPi runtime receipt"));
  if (
    canonicalJson(runtimeReceipt) !== canonicalJson(transaction.sourceRuntimeReceipt)
    && canonicalJson(runtimeReceipt) !== canonicalJson(transaction.targetRuntimeReceipt)
  ) fail("PorcuPi runtime receipt changed during upgrade recovery");
  const kind = runtimeKind(paths.root, paths.runtime, transaction);
  const targetIsAuthoritative = kind === "target"
    && canonicalJson(activation) === canonicalJson(transaction.targetActivation)
    && canonicalJson(runtimeReceipt) === canonicalJson(transaction.targetRuntimeReceipt);
  const previousRuntime = join(stage, "previous-runtime");
  if (pathExists(previousRuntime)) {
    validateRuntimeDirectory(stage, previousRuntime, transaction.sourceRuntimeReceipt, "Previous PorcuPi runtime");
  } else if (kind !== "source" && !targetIsAuthoritative) {
    fail("Previous PorcuPi runtime is missing during upgrade recovery");
  }
  const sourceContents = shellLauncherContents(join(paths.runtime, "cli.mjs"));
  const transitionContents = shellLauncherContents(join(stage, "target-runtime", "cli.mjs"));
  const launcherContents = readFileSync(launcher, "utf8");
  if (launcherContents === sourceContents) {
    verifyLauncherReceipt(transaction.sourceLauncherReceipt, sourceContents, "PorcuPi launcher");
  } else if (launcherContents === transitionContents) {
    verifyLauncherReceipt(transaction.transitionLauncherReceipt, transitionContents, "PorcuPi upgrade transition launcher");
  } else fail(`PorcuPi launcher changed during upgrade recovery: ${launcher}`);
  const launcherReceipt = readJson(paths.launcherReceipt, "PorcuPi launcher receipt");
  if (
    canonicalJson(launcherReceipt) !== canonicalJson(transaction.sourceLauncherReceipt)
    && canonicalJson(launcherReceipt) !== canonicalJson(transaction.transitionLauncherReceipt)
  ) fail("PorcuPi launcher receipt changed during upgrade recovery");
  const piReceipt = verifyOptionalPiLauncher(paths, environment);
  if (canonicalJson(piReceipt) !== canonicalJson(transaction.piLauncherReceipt)) {
    fail("PorcuPi-owned pi launcher changed during upgrade recovery");
  }
  return { activation, kind };
}

function prepareUpgradeCleanup({ paths, stage, owner, removablePaths = [] }) {
  const retiredStage = join(paths.temporary, `upgrade-retired-${owner.nonce}`);
  const cleanupMarker = join(paths.temporary, `upgrade-cleanup-${owner.nonce}.json`);
  if (!pathExists(cleanupMarker)) atomicWrite(cleanupMarker, {
    schemaVersion: 1,
    type: "porcupi-upgrade-cleanup",
    dataRoot: paths.root,
    sourceStage: stage,
    retiredStage,
    targetVersion: owner.targetVersion,
    nonce: owner.nonce,
    inventory: scratchInventory(stage),
    removablePaths,
  });
  return { cleanupMarker, retiredStage };
}

function completeUpgradeTransaction(context) {
  const { paths, launcher, stage, owner, environment, output } = context;
  const transaction = readUpgradeTransaction(context);
  let publication = validateUpgradePublicationState({ ...context, transaction });
  const candidateRoot = join(stage, "composition");
  if (pathExists(candidateRoot)) {
    publishComposition(paths, candidateRoot, transaction.compositionReceipt, {
      afterCompositionPublished: () => checkpoint("upgrade-candidate-directory-published"),
    });
  } else {
    const centralPath = join(paths.receipts, `${transaction.compositionReceipt.compositionId}.json`);
    if (!pathExists(centralPath)) atomicWrite(centralPath, transaction.compositionReceipt);
    chmodSync(join(paths.compositions, transaction.compositionReceipt.compositionId), 0o555);
    verifyPublishedComposition(paths, transaction.compositionReceipt.compositionId);
  }
  const stagedLeases = join(stage, "target-leases");
  const finalLeases = compositionLeaseDirectory(paths, transaction.compositionReceipt.compositionId);
  if (pathExists(stagedLeases)) {
    if (pathExists(finalLeases)) {
      validateCompositionLeaseDirectory(paths, transaction.compositionReceipt.compositionId);
      removePreparedTree(stagedLeases);
    } else renameSync(stagedLeases, finalLeases);
  }
  validateCompositionLeaseDirectory(paths, transaction.compositionReceipt.compositionId);
  checkpoint("upgrade-candidate-published");

  if (publication.kind !== "target") {
    validateRuntimeDirectory(
      stage,
      join(stage, "published-runtime"),
      transaction.targetRuntimeReceipt,
      "Prepared target PorcuPi runtime",
    );
    const transitionContents = shellLauncherContents(join(stage, "target-runtime", "cli.mjs"));
    replaceLauncher(launcher, transitionContents, transaction.transitionLauncherReceipt.mode);
    checkpoint("upgrade-transition-launcher-published");
    atomicWrite(paths.launcherReceipt, transaction.transitionLauncherReceipt);
    checkpoint("upgrade-transition-launcher-receipt-written");
    verifyLauncherReceipt(transaction.transitionLauncherReceipt, transitionContents, "PorcuPi upgrade transition launcher");
    const piReceipt = verifyOptionalPiLauncher(paths, environment);
    if (canonicalJson(piReceipt) !== canonicalJson(transaction.piLauncherReceipt)) {
      fail("PorcuPi-owned pi launcher changed during upgrade publication");
    }
    checkpoint("upgrade-optional-alias-verified");

    const previousRuntime = join(stage, "previous-runtime");
    if (publication.kind === "source") {
      renameSync(paths.runtime, previousRuntime);
      checkpoint("upgrade-source-runtime-retired");
    }
    const publishedRuntime = join(stage, "published-runtime");
    if (!pathExists(paths.runtime)) renameSync(publishedRuntime, paths.runtime);
    publication = { ...publication, kind: runtimeKind(paths.root, paths.runtime, transaction) };
    if (publication.kind !== "target") fail("Target PorcuPi runtime publication did not converge");
    checkpoint("upgrade-target-runtime-published");
  }

  atomicWrite(paths.runtimeReceipt, transaction.targetRuntimeReceipt);
  checkpoint("upgrade-target-runtime-receipt-written");
  atomicWrite(paths.activation, transaction.targetActivation);
  checkpoint("upgrade-activation-written");

  const stableContents = shellLauncherContents(join(paths.runtime, "cli.mjs"));
  replaceLauncher(launcher, stableContents, transaction.sourceLauncherReceipt.mode);
  checkpoint("upgrade-stable-launcher-published");
  atomicWrite(paths.launcherReceipt, transaction.sourceLauncherReceipt);
  checkpoint("upgrade-stable-launcher-receipt-written");
  verifyLauncher(paths, environment);
  const piReceipt = verifyOptionalPiLauncher(paths, environment);
  if (canonicalJson(piReceipt) !== canonicalJson(transaction.piLauncherReceipt)) {
    fail("PorcuPi-owned pi launcher changed during upgrade publication");
  }
  checkpoint("upgrade-cleanup-started");
  cleanupRetainedCompositions(paths, transaction.targetActivation, output);
  checkpoint("upgrade-composition-cleanup-complete");
  for (const [path, receipt, label] of [
    [join(stage, "previous-runtime"), transaction.sourceRuntimeReceipt, "Previous PorcuPi runtime"],
    [join(stage, "published-runtime"), transaction.targetRuntimeReceipt, "Prepared target PorcuPi runtime"],
  ]) {
    if (pathExists(path)) validateRuntimeDirectory(stage, path, receipt, label);
  }
  const { cleanupMarker, retiredStage } = prepareUpgradeCleanup({
    paths,
    stage,
    owner,
    removablePaths: ["previous-runtime", "published-runtime"],
  });
  checkpoint("upgrade-cleanup-marker-written");
  removePreparedTree(join(stage, "previous-runtime"));
  checkpoint("upgrade-previous-runtime-removed");
  removePreparedTree(join(stage, "published-runtime"));
  if (pathExists(stage)) renameSync(stage, retiredStage);
  checkpoint("upgrade-cleanup-retired");
  removePreparedTree(retiredStage);
  checkpoint("upgrade-cleanup-complete");
  durableUnlink(cleanupMarker);
  return transaction;
}

function validateUpgradeTemporaryNames(paths) {
  const names = readdirSync(paths.temporary).filter((name) => name.startsWith("upgrade-"));
  for (const name of names) {
    const stage = /^upgrade-([0-9a-f-]+)$/.exec(name);
    const marker = /^upgrade-cleanup-([0-9a-f-]+)\.json$/.exec(name);
    const retired = /^upgrade-retired-([0-9a-f-]+)$/.exec(name);
    const nonce = stage?.[1] ?? marker?.[1] ?? retired?.[1];
    if (!nonce || !uuidV4Pattern.test(nonce)) {
      fail(`Foreign PorcuPi upgrade temporary path requires manual inspection: ${join(paths.temporary, name)}`);
    }
    if (retired && !pathExists(join(paths.temporary, `upgrade-cleanup-${nonce}.json`))) {
      fail(`Foreign PorcuPi retired upgrade stage requires manual inspection: ${join(paths.temporary, name)}`);
    }
  }
}

function recoverUpgradeCleanupMarkers(paths) {
  for (const name of readdirSync(paths.temporary).filter((entry) => /^upgrade-cleanup-[0-9a-f-]+\.json$/.test(entry)).sort()) {
    const markerPath = join(paths.temporary, name);
    const marker = readJson(markerPath, "PorcuPi upgrade cleanup ownership");
    if (
      !exactObject(marker, upgradeCleanupFields)
      || marker.schemaVersion !== 1
      || marker.type !== "porcupi-upgrade-cleanup"
      || marker.dataRoot !== paths.root
      || marker.targetVersion !== porcupiVersion
      || !uuidV4Pattern.test(marker.nonce || "")
      || marker.sourceStage !== join(paths.temporary, `upgrade-${marker.nonce}`)
      || marker.retiredStage !== join(paths.temporary, `upgrade-retired-${marker.nonce}`)
      || name !== `upgrade-cleanup-${marker.nonce}.json`
      || !Array.isArray(marker.removablePaths)
      || !new Set([canonicalJson([]), canonicalJson(["previous-runtime", "published-runtime"])]).has(
        canonicalJson(marker.removablePaths),
      )
    ) fail(`Foreign PorcuPi upgrade cleanup marker requires manual inspection: ${markerPath}`);
    validateScratchInventory(marker.inventory, "PorcuPi upgrade cleanup inventory");
    if (pathExists(marker.retiredStage)) {
      const stat = lstatSync(marker.retiredStage);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(`Foreign PorcuPi retired upgrade stage requires manual inspection: ${marker.retiredStage}`);
      }
      validateScratchRemainder(marker.retiredStage, marker.inventory, {
        removablePaths: marker.removablePaths,
        message: `Retired PorcuPi upgrade stage changed during cleanup: ${marker.retiredStage}`,
      });
      removePreparedTree(marker.retiredStage);
      durableUnlink(markerPath);
    } else if (pathExists(marker.sourceStage)) {
      const stat = lstatSync(marker.sourceStage);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(`Foreign PorcuPi upgrade stage requires manual inspection: ${marker.sourceStage}`);
      }
      validateScratchRemainder(marker.sourceStage, marker.inventory, {
        removablePaths: marker.removablePaths,
        message: `Retired PorcuPi upgrade stage changed during cleanup: ${marker.sourceStage}`,
      });
    } else durableUnlink(markerPath);
  }
}

function retireUpgradeScratch(paths, stage, owner, { allowIncomplete = false } = {}) {
  validateUpgradeTemporaryNames(paths);
  const persistedOwner = readUpgradeStageOwner(paths, stage);
  if (canonicalJson(persistedOwner) !== canonicalJson(owner)) {
    fail(`Foreign PorcuPi upgrade stage requires manual inspection: ${stage}`);
  }
  recoverUpgradeCleanupMarkers(paths);
  if (!pathExists(join(stage, "scratch.json"))) {
    fail(`Foreign PorcuPi upgrade stage requires manual inspection: ${stage}`);
  }
  if (allowIncomplete) validateIncompleteUpgradeScratch(stage, owner);
  else validateUpgradeScratchReceipt(stage, owner);
  const { cleanupMarker, retiredStage } = prepareUpgradeCleanup({ paths, stage, owner });
  if (pathExists(stage)) renameSync(stage, retiredStage);
  if (pathExists(retiredStage)) removePreparedTree(retiredStage);
  if (pathExists(cleanupMarker)) durableUnlink(cleanupMarker);
}

function recoverInterruptedUpgradesLocked(paths, launcher, environment, output) {
  if (!pathExists(paths.temporary)) return [];
  const temporaryStat = lstatSync(paths.temporary);
  if (!temporaryStat.isDirectory() || temporaryStat.isSymbolicLink()) {
    fail("Malformed PorcuPi upgrade recovery root");
  }
  if (!readdirSync(paths.temporary).some((name) => name.startsWith("upgrade-"))) return [];
  validateUpgradeRecoveryRoot(paths);
  validateUpgradeTemporaryNames(paths);
  recoverUpgradeCleanupMarkers(paths);
  const recovered = [];
  for (const name of readdirSync(paths.temporary).filter((entry) => /^upgrade-[0-9a-f-]+$/.test(entry)).sort()) {
    const stage = join(paths.temporary, name);
    const owner = readUpgradeStageOwner(paths, stage);
    if (!pathExists(join(stage, "transaction.json"))) {
      retireUpgradeScratch(paths, stage, owner);
      continue;
    }
    const transaction = completeUpgradeTransaction({ paths, launcher, stage, owner, environment, output });
    recovered.push(transaction);
    output?.write(`Recovered interrupted PorcuPi upgrade from ${transaction.installedVersion} to ${transaction.targetVersion}.\n`);
  }
  return recovered;
}

export async function recoverInterruptedUpgrade({
  environment = process.env,
  platform = process.platform,
  output = process.stdout,
} = {}) {
  const dataRoot = defaultDataRoot(environment, platform);
  const paths = managedLayout(dataRoot);
  if (!pathExists(paths.temporary)) return noUpgradeRecovery;
  const launcher = join(defaultBinDirectory(environment), "porcupi");
  let waitedForPublisher = false;
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    const temporaryStat = lstatSync(paths.temporary);
    if (!temporaryStat.isDirectory() || temporaryStat.isSymbolicLink()) {
      fail("Malformed PorcuPi upgrade recovery root");
    }
    const hasUpgrade = readdirSync(paths.temporary).some((name) => name.startsWith("upgrade-"));
    if (!hasUpgrade) return waitedForPublisher ? restartAfterUpgradeRecovery : noUpgradeRecovery;
    validateUpgradeRecoveryRoot(paths);
    validateUpgradeTemporaryNames(paths);
    try {
      const recovered = await withLifecycleLock(dataRoot, "upgrade recovery", () => (
        recoverInterruptedUpgradesLocked(paths, launcher, environment, output).length > 0
      ));
      return recovered ? restartAfterUpgradeRecovery : noUpgradeRecovery;
    } catch (error) {
      if (
        error instanceof Error
        && error.message.startsWith("PorcuPi lifecycle operation is already in progress:")
        && attempt < 1_499
      ) {
        waitedForPublisher = true;
        await delay(20);
        continue;
      }
      throw error;
    }
  }
  return noUpgradeRecovery;
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

function patchReview(patches) {
  return patches.map((patch) => `${patch.locator}@${patch.commit}:${patch.path} (sha256 ${patch.sha256})`);
}

function confirmUpgrade({ active, installedVersion, lock, ownPi, selections, input, output }) {
  const artifacts = selectedArtifactReview(selections.sources);
  const selectedPatches = patchSelectionSnapshot(selections.sources);
  const activePatches = active.activation.active.patches;
  const pending = patchIntentPending(selections.sources, activePatches);
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
          output.write(`The exact target with ${selectedPatches.length} selected Patch${selectedPatches.length === 1 ? "" : "es"} passed Patch preflight, fixed build, conformance, version, and smoke checks.\n`);
          output.write(`${artifacts.length - selectedPatches.length} selected Pi resource${artifacts.length - selectedPatches.length === 1 ? "" : "s"} remained discoverable at the exact retained source snapshot.\n`);
          output.write("The check did not change Activation, Compositions, launchers, Selection Intent, Pi settings/checkouts, or shared Pi state.\n\n");
          output.write("[Enter/→] Continue  [←] back  [Esc] cancel\n");
        } else {
          output.write(`PorcuPi: ${installedVersion} → ${porcupiVersion}\n`);
          output.write(`Pi Base: ${active.receipt.piBase.tag} → ${lock.tag}\n`);
          output.write(`Active Composition: ${active.activation.active.compositionId}\n`);
          output.write(`Previous Composition: ${active.activation.previous?.compositionId ?? "none"}\n`);
          output.write(`Patch Selection Intent: ${pending ? "pending — differs from the active Patch selection" : "current — matches the active Patch selection"}\n`);
          output.write(`Active Patches (${activePatches.length}):\n`);
          if (activePatches.length === 0) output.write("- none\n");
          else for (const patch of patchReview(activePatches)) output.write(`- ${patch}\n`);
          output.write(`Selected Patches (${selectedPatches.length}):\n`);
          if (selectedPatches.length === 0) output.write("- none\n");
          else for (const patch of patchReview(selectedPatches)) output.write(`- ${patch}\n`);
          output.write(`Selected Artifacts (${artifacts.length}):\n`);
          if (artifacts.length === 0) output.write("- none\n");
          else for (const artifact of artifacts) output.write(`- ${artifact}\n`);
          if (artifacts.length === 0) output.write("Selection Intent: empty\n");
          output.write(`Own \`pi\`: ${ownPi ? "Yes — existing reversible alias retained" : "No — independent resolution retained"}\n`);
          output.write("Pi package lifecycle: retained under Pi ownership\n");
          output.write("Credentials, sessions, trust, package/project data, Stock Pi, and other shared state: retained\n\n");
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
  const runtimeReceipt = verifyRuntime(paths);
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
  return { active, installedCli, installedVersion: readInstalledVersion(paths), hasLauncher, hasLauncherReceipt, runtimeReceipt };
}

async function upgradeManagedPi({ paths, launcher, existing, lock, input, output, environment }) {
  const migration = upgradeMigrationContracts.get(migrationContractKey(existing.installedVersion, porcupiVersion));
  if (!migration) fail(`No versioned state migration supports PorcuPi ${existing.installedVersion} → ${porcupiVersion}`);
  if (existing.active.activation.schemaVersion !== migration.sourceStateSchema) {
    fail(`Upgrade requires PorcuPi ${existing.installedVersion} state schema ${migration.sourceStateSchema}`);
  }
  verifyPublishedComposition(paths, existing.active.activation.active.compositionId);
  if (existing.active.activation.previous) verifyPublishedComposition(paths, existing.active.activation.previous.compositionId);
  const piLauncherReceipt = verifyOptionalPiLauncher(paths, environment);
  const ownedPi = Boolean(piLauncherReceipt);
  const sourceLauncherReceipt = verifyLauncher(paths, environment);
  const selections = readSelections(paths.root);
  const resourceSummary = summarizeRetainedPiResources(paths.root, environment);
  const changedResource = resourceSummary.resources.find((resource) => !resource.configured);
  if (changedResource) {
    const scope = changedResource.scope === "global" ? "global" : `project ${changedResource.projectRoot}`;
    fail(`Upgrade Readiness Check blocked by externally changed Pi ${scope} package configuration for ${changedResource.locator}`);
  }

  output.write(`Upgrade candidate: installed PorcuPi ${existing.installedVersion}, target PorcuPi ${porcupiVersion}.\n`);
  output.write(`Migration contract: state schema ${migration.sourceStateSchema} → ${migration.targetStateSchema}.\n`);
  output.write(`Installed Pi Base: ${existing.active.receipt.piBase.tag} (${existing.active.receipt.piBase.commit}); target Pi Base: ${lock.tag} (${lock.commit}).\n`);
  const nonce = randomUUID();
  const stageRoot = join(paths.temporary, `upgrade-${nonce}`);
  mkdirSync(stageRoot, { mode: 0o700 });
  const stageOwner = {
    schemaVersion: 1,
    type: "porcupi-upgrade-stage",
    dataRoot: paths.root,
    stage: stageRoot,
    installedVersion: existing.installedVersion,
    targetVersion: porcupiVersion,
    nonce,
  };
  atomicWrite(join(stageRoot, "owner.json"), stageOwner);
  const candidateRoot = join(stageRoot, "composition");
  mkdirSync(candidateRoot, { mode: 0o700 });
  writeUpgradeScratchReceipt(stageRoot, stageOwner);
  let transactionCommitted = false;
  try {
    const stagedPatches = stageSelectionIntent({ stageRoot, sources: selections.sources, piBase: lock });
    writeUpgradeScratchReceipt(stageRoot, stageOwner);
    const receipt = buildComposition({ candidateRoot, stageRoot, patches: stagedPatches, lock });
    writeUpgradeScratchReceipt(stageRoot, stageOwner);
    const stagedLeases = join(stageRoot, "target-leases");
    mkdirSync(stagedLeases, { mode: 0o700 });
    atomicWrite(join(stagedLeases, "owner.json"), {
      schemaVersion: 1,
      type: "porcupi-composition-leases",
      compositionId: receipt.compositionId,
    });
    const targetRuntime = stageRuntime(stageRoot, "target-runtime");
    cpSync(targetRuntime, join(stageRoot, "published-runtime"), { recursive: true, errorOnExist: true });
    const targetActivation = {
      schemaVersion: migration.targetStateSchema,
      active: { compositionId: receipt.compositionId, patches: receipt.patches },
      previous: existing.active.activation.active,
    };
    atomicWrite(join(stageRoot, "target-activation.json"), targetActivation);
    writeUpgradeScratchReceipt(stageRoot, stageOwner);
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
      retireUpgradeScratch(paths, stageRoot, stageOwner);
      output.write("\nUpgrade cancelled. No authoritative state was changed.\n");
      return { installed: false, upgraded: false, cancelled: true };
    }

    const transaction = {
      schemaVersion: 1,
      type: "porcupi-upgrade-transaction",
      dataRoot: paths.root,
      stage: stageRoot,
      installedVersion: existing.installedVersion,
      targetVersion: porcupiVersion,
      sourceRuntimeReceipt: existing.runtimeReceipt,
      targetRuntimeReceipt: runtimeReceiptFor(targetRuntime),
      sourceActivation: existing.active.activation,
      targetActivation,
      compositionReceipt: receipt,
      sourceLauncherReceipt,
      transitionLauncherReceipt: expectedTransitionLauncherReceipt(sourceLauncherReceipt, stageRoot),
      piLauncherReceipt,
      selectionIntentSha256: pathExists(join(paths.state, "selections.json"))
        ? sha256Bytes(readFileSync(join(paths.state, "selections.json")))
        : null,
      stageInventory: scratchInventory(stageRoot),
    };
    atomicWrite(join(stageRoot, "transaction.json"), transaction);
    transactionCommitted = true;
    checkpoint("upgrade-state-migrated");
    completeUpgradeTransaction({ paths, launcher, stage: stageRoot, owner: stageOwner, environment, output });

    output.write(`\nUpgraded PorcuPi from ${existing.installedVersion} to ${porcupiVersion}.\n`);
    output.write(`Activated verified Managed Pi Composition ${receipt.compositionId} with ${receipt.patches.length} selected Patch${receipt.patches.length === 1 ? "" : "es"}.\n`);
    output.write(`Retained previous Managed Pi Composition ${existing.active.activation.active.compositionId}.\n`);
    output.write(`Command: ${launcher}\n`);
    output.write(`Preserved ${selectedArtifactReview(selections.sources).length} selected Artifacts, their Installation Scope, Pi-owned state, Stock Pi, and \`pi\` ownership.\n`);
    return { installed: true, upgraded: true, launcher, compositionId: receipt.compositionId };
  } catch (error) {
    if (!transactionCommitted) retireUpgradeScratch(paths, stageRoot, stageOwner, { allowIncomplete: true });
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
    recoverInterruptedUpgradesLocked(paths, launcher, environment, output);
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
