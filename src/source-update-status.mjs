import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { canonicalJson, atomicWrite, canonicalSourceLocator, defaultDataRoot, exactObject, fail, managedLayout, readActiveComposition, readJson, sha256Bytes, validateManagedRoot } from "./runtime.mjs";
import { readSelections } from "./resource-intent.mjs";
import { inspectTrackedSourceAvailability } from "./manage.mjs";
import { isCanonicalTrackedBranch } from "./source-repository.mjs";

const cacheName = "source-updates.json";
const cacheFields = new Set(["schemaVersion", "type", "selectionIntentSha256", "sources", "checkedAt"]);
const sourceFields = new Set([
  "locator", "trackedBranch", "acceptedCommit", "candidateCommit", "changedArtifactCount",
  "changedPatchSeriesCount", "checkedAt",
]);
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const maximumWorkerOutputBytes = 16 * 1024;
const maximumConcurrency = 3;
const workerTimeoutMilliseconds = 5_000;

function validIsoDate(value) {
  return typeof value === "string"
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validText(value) {
  return typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function validSourceLocator(value) {
  if (!validText(value)) return false;
  const slash = value.indexOf("/");
  return slash > 0 && canonicalSourceLocator(value.slice(0, slash), value.slice(slash + 1)) === value;
}

function cachePath(paths) {
  return paths.sourceUpdates ?? `${paths.state}/${cacheName}`;
}

export function validateSourceUpdateCache(value) {
  if (
    !exactObject(value, cacheFields)
    || value.schemaVersion !== 1
    || value.type !== "porcupi-tracked-branch-availability"
    || !sha256Pattern.test(value.selectionIntentSha256 || "")
    || !Array.isArray(value.sources)
    || !validIsoDate(value.checkedAt)
  ) fail("Malformed PorcuPi Tracked Branch availability cache");
  let previousLocator;
  const locators = new Set();
  for (const source of value.sources) {
    if (
      !exactObject(source, sourceFields)
      || !validSourceLocator(source.locator)
      || !isCanonicalTrackedBranch(source.trackedBranch)
      || !commitPattern.test(source.acceptedCommit || "")
      || !commitPattern.test(source.candidateCommit || "")
      || source.acceptedCommit === source.candidateCommit
      || !Number.isSafeInteger(source.changedArtifactCount)
      || source.changedArtifactCount < 1
      || !Number.isSafeInteger(source.changedPatchSeriesCount)
      || source.changedPatchSeriesCount < 0
      || source.changedPatchSeriesCount > source.changedArtifactCount
      || !validIsoDate(source.checkedAt)
      || locators.has(source.locator)
      || (previousLocator !== undefined && previousLocator >= source.locator)
    ) fail("Malformed PorcuPi Tracked Branch availability cache");
    locators.add(source.locator);
    previousLocator = source.locator;
  }
  return value;
}

export function readSourceUpdateCache(paths, { allowMissing = true } = {}) {
  const path = cachePath(paths);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("Malformed PorcuPi Tracked Branch availability cache");
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return null;
    if (error instanceof Error && error.message === "Malformed PorcuPi Tracked Branch availability cache") throw error;
    fail("Malformed PorcuPi Tracked Branch availability cache");
  }
  return validateSourceUpdateCache(readJson(path, "PorcuPi Tracked Branch availability cache"));
}

function selectionIdentity(selections) {
  return sha256Bytes(canonicalJson(selections));
}

export function matchingSourceUpdates(cache, selections) {
  if (!cache || cache.selectionIntentSha256 !== selectionIdentity(selections)) return [];
  const retained = new Map(selections.sources
    .filter((source) => source.trackedBranch)
    .map((source) => [source.locator, source]));
  return cache.sources.filter((candidate) => {
    const source = retained.get(candidate.locator);
    return source
      && source.trackedBranch === candidate.trackedBranch
      && source.commit === candidate.acceptedCommit;
  });
}

function workerResult(locator, environment, signal) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], "--porcupi-background-tracked-branch", locator], {
      detached: true,
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-maximumWorkerOutputBytes);
    });
    const abort = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const timeout = setTimeout(abort, workerTimeoutMilliseconds);
    timeout.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve({ outcome: "failed", locator });
    });
    child.once("exit", (code, exitSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (exitSignal || code !== 0) {
        resolve({ outcome: "failed", locator });
        return;
      }
      try {
        const value = JSON.parse(output.trim().split("\n").at(-1));
        if (value?.locator !== locator || !new Set(["candidate", "none"]).has(value?.outcome)) throw new Error();
        resolve(value);
      } catch {
        resolve({ outcome: "failed", locator });
      }
    });
  });
}

async function mapBounded(values, limit, operation) {
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function inspectOneTrackedBranch(locator, { environment = process.env, dataRoot = defaultDataRoot(environment) } = {}) {
  const selections = readSelections(dataRoot);
  const source = selections.sources.find((candidate) => candidate.locator === locator && candidate.trackedBranch);
  if (!source) fail("Tracked Branch availability source is no longer retained");
  const active = readActiveComposition(dataRoot);
  try {
    const candidate = inspectTrackedSourceAvailability(source, active);
    return candidate
      ? { outcome: "candidate", locator, ...candidate }
      : { outcome: "none", locator };
  } catch (error) {
    if (
      error instanceof Error
      && (error.message.startsWith("Inter-release Source Update blocked:")
        || /moved non-fast-forward/.test(error.message))
    ) return { outcome: "none", locator };
    throw error;
  }
}

export async function checkTrackedBranchAvailability({
  environment = process.env,
  dataRoot = defaultDataRoot(environment),
  signal,
  now = () => new Date(),
} = {}) {
  const paths = managedLayout(dataRoot);
  const selections = readSelections(dataRoot);
  const tracked = selections.sources.filter((source) => source.trackedBranch);
  if (tracked.length === 0) return { cache: readSourceUpdateCache(paths), checked: 0 };
  const identity = selectionIdentity(selections);
  const previous = readSourceUpdateCache(paths);
  const retained = previous?.selectionIntentSha256 === identity
    ? new Map(previous.sources.map((source) => [source.locator, source]))
    : new Map();
  const results = await mapBounded(tracked, maximumConcurrency, (source) => workerResult(source.locator, environment, signal));
  let successful = 0;
  const checkedAt = now().toISOString();
  for (const result of results) {
    if (result.outcome === "failed") continue;
    successful += 1;
    if (result.outcome === "none") retained.delete(result.locator);
    else retained.set(result.locator, {
      locator: result.locator,
      trackedBranch: result.trackedBranch,
      acceptedCommit: result.acceptedCommit,
      candidateCommit: result.candidateCommit,
      changedArtifactCount: result.changedArtifactCount,
      changedPatchSeriesCount: result.changedPatchSeriesCount,
      checkedAt,
    });
  }
  if (successful === 0) return { cache: previous, checked: 0 };
  if (selectionIdentity(readSelections(dataRoot)) !== identity) return { cache: previous, checked: 0 };
  const cache = validateSourceUpdateCache({
    schemaVersion: 1,
    type: "porcupi-tracked-branch-availability",
    selectionIntentSha256: identity,
    sources: [...retained.values()].sort((left, right) => left.locator.localeCompare(right.locator)),
    checkedAt,
  });
  validateManagedRoot(paths);
  atomicWrite(cachePath(paths), cache);
  return { cache, checked: successful };
}

export function renderSourceUpdateRow(updates, { checking = false } = {}) {
  if (updates.length === 0) return null;
  const patchCount = updates.reduce((sum, update) => sum + update.changedPatchSeriesCount, 0);
  const noun = updates.length === 1 ? "update" : "updates";
  const checkingText = checking && patchCount === 0 ? " (refreshing)" : "";
  const patchText = patchCount > 0 ? "; Patch pending until porcupi apply" : "";
  return `PorcuPi: ${updates.length} Tracked Branch ${noun}${checkingText}; porcupi manage${patchText}`;
}

export function formatSourceUpdates(cache, selections) {
  const updates = matchingSourceUpdates(cache, selections);
  const lines = ["", "Tracked Branch source status", `Tracked Branch updates: ${updates.length}`];
  if (updates.length === 0) {
    lines.push("No relevant compatible Inter-release Source Update is cached for current Selection Intent.");
  } else {
    for (const update of updates) {
      lines.push(`${update.locator}: ${update.acceptedCommit} → ${update.candidateCommit}`);
      lines.push(`  Changed selected Artifacts: ${update.changedArtifactCount}; changed Patch Series: ${update.changedPatchSeriesCount}; checked: ${update.checkedAt}`);
    }
    lines.push("Next source command: porcupi manage");
    lines.push("Review and accept one exact source snapshot in the guided management flow. Changed Patch Series remain pending until `porcupi apply`; status never adopts or applies them.");
  }
  lines.push("This cached source status is side-effect-free to read and never changes Selection Intent, Pi settings, or a source snapshot.");
  return lines.join("\n");
}
