import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  pathExists,
  removePreparedTree,
  verifyCompositionContents,
  verifyPublishedComposition,
} from "./composition.mjs";
import {
  canonicalJson,
  compositionLeaseDirectory,
  fail,
  readJson,
  sha256Bytes,
  validateCompositionLeaseDirectory,
  validateCompositionReceipt,
} from "./runtime.mjs";

const lifecycleLockFields = new Set(["schemaVersion", "type", "pid", "nonce", "operation"]);
const cleanupOwnerFields = new Set(["schemaVersion", "type", "compositionId", "receiptSha256"]);
const leaseFields = new Set(["schemaVersion", "type", "compositionId", "pid", "nonce"]);
const leaseOwnerFields = new Set(["schemaVersion", "type", "compositionId"]);
const compositionIdPattern = /^[a-f0-9]{64}$/;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactObject(value, fields) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function lifecycleLockPath(dataRoot) {
  return `${resolve(dataRoot)}.lifecycle-lock`;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function strictLifecycleOwner(value) {
  return exactObject(value, lifecycleLockFields)
    && value.schemaVersion === 1
    && value.type === "porcupi-lifecycle-lock"
    && Number.isInteger(value.pid)
    && value.pid > 0
    && uuidV4Pattern.test(value.nonce || "")
    && typeof value.operation === "string"
    && value.operation.length > 0;
}

function recoverStaleLifecycleLock(lock) {
  let owner;
  try {
    const stat = lstatSync(lock);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`Foreign PorcuPi lifecycle lock requires manual inspection: ${lock}`);
    owner = readJson(lock, "PorcuPi lifecycle lock ownership");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Foreign PorcuPi lifecycle lock")) throw error;
    fail(`Foreign PorcuPi lifecycle lock requires manual inspection: ${lock}`);
  }
  if (!strictLifecycleOwner(owner)) fail(`Foreign PorcuPi lifecycle lock requires manual inspection: ${lock}`);
  if (processIsAlive(owner.pid)) fail(`PorcuPi lifecycle operation is already in progress: ${owner.operation} (pid ${owner.pid})`);
  const current = readJson(lock, "PorcuPi lifecycle lock ownership");
  if (canonicalJson(current) !== canonicalJson(owner)) fail(`PorcuPi lifecycle lock changed during recovery: ${lock}`);
  unlinkSync(lock);
}

function acquireLifecycleLock(dataRoot, operation) {
  const lock = lifecycleLockPath(dataRoot);
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = { schemaVersion: 1, type: "porcupi-lifecycle-lock", pid: process.pid, nonce: randomUUID(), operation };
    const temporary = join(dirname(lock), `.${basename(lock)}.tmp-${owner.nonce}`);
    try {
      writeFileSync(temporary, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      linkSync(temporary, lock);
      return { lock, owner };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      recoverStaleLifecycleLock(lock);
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  fail(`Could not acquire the PorcuPi lifecycle lock: ${lock}`);
}

function releaseLifecycleLock(held) {
  const current = readJson(held.lock, "PorcuPi lifecycle lock ownership");
  if (canonicalJson(current) !== canonicalJson(held.owner)) fail(`PorcuPi lifecycle lock changed while held: ${held.lock}`);
  unlinkSync(held.lock);
}

export async function withLifecycleLock(dataRoot, operation, callback) {
  const held = acquireLifecycleLock(dataRoot, operation);
  try {
    if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_HOLD_LOCK_MS) {
      const milliseconds = Number(process.env.PORCUPI_TEST_HOLD_LOCK_MS);
      if (Number.isFinite(milliseconds) && milliseconds > 0) await delay(milliseconds);
    }
    return await callback();
  } finally {
    releaseLifecycleLock(held);
  }
}

function cleanupCheckpoint(name) {
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAULT === name) process.kill(process.pid, "SIGKILL");
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAILURE === name) fail(`Injected failure at ${name}`);
}

function cleanupOwner(compositionId, receipt) {
  return {
    schemaVersion: 1,
    type: "porcupi-composition-cleanup",
    compositionId,
    receiptSha256: sha256Bytes(canonicalJson(receipt)),
  };
}

function readCleanupOwner(stage) {
  const owner = readJson(join(stage, "owner.json"), "Composition cleanup ownership");
  if (
    !exactObject(owner, cleanupOwnerFields)
    || owner.schemaVersion !== 1
    || owner.type !== "porcupi-composition-cleanup"
    || !compositionIdPattern.test(owner.compositionId || "")
    || !compositionIdPattern.test(owner.receiptSha256 || "")
  ) fail(`Foreign Composition cleanup stage requires manual inspection: ${stage}`);
  return owner;
}

export function durableUnlink(path) {
  unlinkSync(path);
  try {
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // The unlink is still atomic where directory fsync is unavailable.
  }
}

function validateLease(value, compositionId, name) {
  return exactObject(value, leaseFields)
    && value.schemaVersion === 1
    && value.type === "porcupi-composition-lease"
    && value.compositionId === compositionId
    && Number.isInteger(value.pid)
    && value.pid > 0
    && uuidV4Pattern.test(value.nonce || "")
    && name === `${value.nonce}.json`;
}

function validateStagedLeaseOwnership(directory, compositionId) {
  const owner = readJson(join(directory, "owner.json"), "Managed Pi Composition lease ownership");
  if (
    !exactObject(owner, leaseOwnerFields)
    || owner.schemaVersion !== 1
    || owner.type !== "porcupi-composition-leases"
    || owner.compositionId !== compositionId
  ) fail(`Foreign Composition lease directory requires manual inspection: ${directory}`);
}

function inspectLeaseDirectory(directory, compositionId) {
  validateStagedLeaseOwnership(directory, compositionId);
  const leases = [];
  for (const name of readdirSync(directory)) {
    if (name === "owner.json") continue;
    const path = join(directory, name);
    const lease = readJson(path, "Managed Pi Composition lease");
    if (!validateLease(lease, compositionId, name)) {
      fail(`Foreign Composition lease requires manual inspection: ${path}`);
    }
    leases.push({ path, lease, live: processIsAlive(lease.pid) });
  }
  return leases;
}

export function inspectStagedCompositionLeases(directory, compositionId) {
  return inspectLeaseDirectory(directory, compositionId);
}

export function inspectCompositionLeases(paths, compositionId) {
  const directory = validateCompositionLeaseDirectory(paths, compositionId);
  return inspectLeaseDirectory(directory, compositionId);
}

function leaseDirectoryHasLiveOrForeignEntries(directory, compositionId) {
  let leases;
  try {
    leases = inspectLeaseDirectory(directory, compositionId);
  } catch {
    return true;
  }
  if (leases.some((entry) => entry.live)) return true;
  for (const entry of leases) durableUnlink(entry.path);
  return false;
}

function restoreStageLease(paths, stage, compositionId) {
  const staged = join(stage, "leases");
  if (!pathExists(staged)) return;
  const stat = lstatSync(staged);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`Foreign Composition lease directory requires manual inspection: ${staged}`);
  }
  validateStagedLeaseOwnership(staged, compositionId);
  const destination = compositionLeaseDirectory(paths, compositionId);
  if (pathExists(destination)) fail(`Composition lease directory collision during cleanup recovery: ${destination}`);
  renameSync(staged, destination);
  validateCompositionLeaseDirectory(paths, compositionId);
}

function verifyStagedComposition(stage, owner) {
  const compositionRoot = join(stage, "composition");
  const receipt = validateCompositionReceipt(
    readJson(join(compositionRoot, "receipt.json"), "embedded Composition receipt"),
    owner.compositionId,
  );
  if (sha256Bytes(canonicalJson(receipt)) !== owner.receiptSha256) {
    fail(`Composition cleanup ownership receipt mismatch: ${stage}`);
  }
  verifyCompositionContents(compositionRoot, receipt);
  return receipt;
}

function recoverCleanupStage(paths, activation, stage) {
  const stat = lstatSync(stage);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Foreign Composition cleanup stage requires manual inspection: ${stage}`);
  const owner = readCleanupOwner(stage);
  const names = readdirSync(stage);
  if (names.some((name) => !new Set(["owner.json", "leases", "composition"]).has(name))) {
    fail(`Foreign Composition cleanup stage requires manual inspection: ${stage}`);
  }
  const referenced = new Set([activation.active.compositionId, activation.previous?.compositionId].filter(Boolean));
  const stagedComposition = join(stage, "composition");
  if (!pathExists(stagedComposition)) {
    restoreStageLease(paths, stage, owner.compositionId);
    removePreparedTree(stage);
    return;
  }
  if (referenced.has(owner.compositionId)) {
    const receipt = verifyStagedComposition(stage, owner);
    const centralPath = join(paths.receipts, `${owner.compositionId}.json`);
    if (!pathExists(centralPath) || canonicalJson(readJson(centralPath, "central Composition receipt")) !== canonicalJson(receipt)) {
      fail(`Referenced Composition cleanup receipt mismatch: ${stage}`);
    }
    const destination = join(paths.compositions, owner.compositionId);
    if (pathExists(destination)) fail(`Composition collision during cleanup recovery: ${destination}`);
    renameSync(stagedComposition, destination);
    chmodSync(destination, 0o555);
    restoreStageLease(paths, stage, owner.compositionId);
    removePreparedTree(stage);
    return;
  }
  const stagedLeases = join(stage, "leases");
  if (!pathExists(stagedLeases) || leaseDirectoryHasLiveOrForeignEntries(stagedLeases, owner.compositionId)) {
    fail(`Composition cleanup stage contains a live or foreign lease: ${stage}`);
  }
  const receipt = verifyStagedComposition(stage, owner);
  const centralPath = join(paths.receipts, `${owner.compositionId}.json`);
  if (pathExists(centralPath)) {
    const central = readJson(centralPath, "central Composition receipt");
    if (canonicalJson(central) !== canonicalJson(receipt)) fail(`Composition cleanup central receipt mismatch: ${stage}`);
    durableUnlink(centralPath);
  }
  removePreparedTree(stage);
}

export function preflightCompositionCleanup(paths, activation) {
  const referenced = new Set([activation.active.compositionId, activation.previous?.compositionId].filter(Boolean));
  const stagedCompositionIds = new Set();
  for (const name of readdirSync(paths.temporary).sort()) {
    if (!name.startsWith("cleanup-")) continue;
    const stage = join(paths.temporary, name);
    const stat = lstatSync(stage);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Foreign Composition cleanup stage requires manual inspection: ${stage}`);
    const owner = readCleanupOwner(stage);
    const names = readdirSync(stage);
    if (names.some((entry) => !new Set(["owner.json", "leases", "composition"]).has(entry))) {
      fail(`Foreign Composition cleanup stage requires manual inspection: ${stage}`);
    }
    const stagedLeases = join(stage, "leases");
    if (pathExists(stagedLeases)) inspectLeaseDirectory(stagedLeases, owner.compositionId);
    const stagedComposition = join(stage, "composition");
    if (!pathExists(stagedComposition)) continue;
    const receipt = verifyStagedComposition(stage, owner);
    stagedCompositionIds.add(owner.compositionId);
    const centralPath = join(paths.receipts, `${owner.compositionId}.json`);
    if (pathExists(centralPath)) {
      const central = readJson(centralPath, "central Composition receipt");
      if (canonicalJson(central) !== canonicalJson(receipt)) fail(`Composition cleanup central receipt mismatch: ${stage}`);
    } else if (referenced.has(owner.compositionId)) {
      fail(`Referenced Composition cleanup receipt mismatch: ${stage}`);
    }
  }
  return stagedCompositionIds;
}

export function recoverCompositionCleanup(paths, activation) {
  for (const name of readdirSync(paths.temporary).sort()) {
    if (!name.startsWith("cleanup-")) continue;
    recoverCleanupStage(paths, activation, join(paths.temporary, name));
  }
}

function stageCompositionForCleanup(paths, compositionId, receipt, output) {
  const stage = join(paths.temporary, `cleanup-${compositionId}-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  writeFileSync(join(stage, "owner.json"), `${JSON.stringify(cleanupOwner(compositionId, receipt), null, 2)}\n`, { mode: 0o600 });
  const leaseDirectory = validateCompositionLeaseDirectory(paths, compositionId);
  renameSync(leaseDirectory, join(stage, "leases"));
  cleanupCheckpoint("cleanup-lease-gated");
  if (leaseDirectoryHasLiveOrForeignEntries(join(stage, "leases"), compositionId)) {
    restoreStageLease(paths, stage, compositionId);
    removePreparedTree(stage);
    output?.write(`Deferred cleanup of Managed Pi Composition ${compositionId}: a process lease is live or foreign.\n`);
    return false;
  }
  verifyPublishedComposition(paths, compositionId);
  const compositionRoot = join(paths.compositions, compositionId);
  chmodSync(compositionRoot, 0o700);
  renameSync(compositionRoot, join(stage, "composition"));
  cleanupCheckpoint("cleanup-composition-staged");
  const centralPath = join(paths.receipts, `${compositionId}.json`);
  const central = readJson(centralPath, "central Composition receipt");
  if (canonicalJson(central) !== canonicalJson(receipt)) fail(`Composition changed during cleanup: ${compositionId}`);
  cleanupCheckpoint("cleanup-receipt-remove");
  durableUnlink(centralPath);
  cleanupCheckpoint("cleanup-receipt-removed");
  removePreparedTree(stage);
  return true;
}

export function cleanupRetainedCompositions(paths, activation, output = process.stdout) {
  recoverCompositionCleanup(paths, activation);
  const referenced = new Set([activation.active.compositionId, activation.previous?.compositionId].filter(Boolean));
  for (const compositionId of readdirSync(paths.compositions).sort()) {
    if (referenced.has(compositionId)) continue;
    if (!compositionIdPattern.test(compositionId)) {
      output.write(`Left foreign Composition path untouched: ${join(paths.compositions, compositionId)}\n`);
      continue;
    }
    let receipt;
    try {
      receipt = verifyPublishedComposition(paths, compositionId);
      validateCompositionLeaseDirectory(paths, compositionId);
    } catch (error) {
      output.write(`Left unproven Composition untouched: ${compositionId} (${error instanceof Error ? error.message : String(error)})\n`);
      continue;
    }
    stageCompositionForCleanup(paths, compositionId, receipt, output);
  }
}
