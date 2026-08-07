import { lstatSync } from "node:fs";
import { join } from "node:path";
import { compareReleaseVersions, isReleaseVersion, validateReleaseVersion } from "./release-version.mjs";
import { patchSelectionSnapshot, readSelections } from "./resource-intent.mjs";
import { formatSourceUpdates, readSourceUpdateCache } from "./source-update-status.mjs";
import {
  atomicWrite,
  canonicalJson,
  canonicalSourceLocator,
  defaultDataRoot,
  exactObject,
  fail,
  managedLayout,
  readActiveComposition,
  readJson,
  sha256Bytes,
  validateManagedRoot,
  validatePatchIdentities,
  verifyRuntime,
} from "./runtime.mjs";

const releaseStatusCacheName = "release-status.json";
const upgradeReadinessCacheName = "upgrade-readiness.json";
const defaultReleaseStatusUrl = "https://registry.npmjs.org/porcupi/latest";
const releaseStatusFields = new Set(["schemaVersion", "type", "latestVersion", "checkedAt"]);
const upgradeReadinessFields = new Set(["schemaVersion", "type", "identity", "identitySha256", "outcome", "reason", "checkedAt"]);
const readinessIdentityFields = new Set([
  "targetVersion", "piBase", "selectionIntentSha256", "sourceCommits", "patches",
  "platform", "architecture", "checkerContractSha256",
]);
const readinessPiBaseFields = new Set(["version", "commit"]);
const readinessSourceFields = new Set(["locator", "commit"]);
const readinessPatchFields = new Set(["locator", "seriesId", "commit", "path", "sha256"]);
const gitCommitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const maximumResponseBytes = 64 * 1024;
const releaseCheckTimeoutMilliseconds = 1_500;

export function porcupiOffline(environment = process.env) {
  const value = environment.PI_OFFLINE;
  return typeof value === "string" && new Set(["1", "true", "yes"]).has(value.toLowerCase());
}

export function backgroundReadinessDisabled(environment = process.env) {
  const value = environment.PORCUPI_BACKGROUND_READINESS;
  return typeof value === "string" && new Set(["0", "false", "no", "off"]).has(value.toLowerCase());
}

function releaseStatusCachePath(paths) {
  return paths.releaseStatus ?? join(paths.state, releaseStatusCacheName);
}

function upgradeReadinessCachePath(paths) {
  return paths.upgradeReadiness ?? join(paths.state, upgradeReadinessCacheName);
}

export function validateReleaseStatusCache(value) {
  if (
    !exactObject(value, releaseStatusFields)
    || value.schemaVersion !== 1
    || value.type !== "porcupi-release-availability"
    || !isReleaseVersion(value.latestVersion)
    || typeof value.checkedAt !== "string"
    || Number.isNaN(Date.parse(value.checkedAt))
    || new Date(value.checkedAt).toISOString() !== value.checkedAt
  ) fail("Malformed PorcuPi release availability cache");
  return value;
}

export function readReleaseStatusCache(paths, { allowMissing = true } = {}) {
  const path = releaseStatusCachePath(paths);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("Malformed PorcuPi release availability cache");
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return null;
    if (error instanceof Error && error.message === "Malformed PorcuPi release availability cache") throw error;
    fail("Malformed PorcuPi release availability cache");
  }
  return validateReleaseStatusCache(readJson(path, "PorcuPi release availability cache"));
}

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

function validReadinessSources(sources) {
  if (!Array.isArray(sources)) return false;
  let previousLocator;
  const locators = new Set();
  for (const source of sources) {
    if (
      !exactObject(source, readinessSourceFields)
      || !validSourceLocator(source.locator)
      || !gitCommitPattern.test(source.commit || "")
      || locators.has(source.locator)
      || (previousLocator !== undefined && previousLocator >= source.locator)
    ) return false;
    locators.add(source.locator);
    previousLocator = source.locator;
  }
  return true;
}

function validReadinessPatches(patches, sourceCommits) {
  if (
    !Array.isArray(patches)
    || patches.some((patch) => !exactObject(patch, readinessPatchFields) || !validText(patch.seriesId))
  ) return false;
  try {
    validatePatchIdentities(patches, "PorcuPi Upgrade Readiness cache");
  } catch {
    return false;
  }
  const commitsByLocator = new Map(sourceCommits.map((source) => [source.locator, source.commit]));
  return patches.every((patch) => commitsByLocator.get(patch.locator) === patch.commit);
}

export function validateUpgradeReadinessCache(value) {
  const identity = value?.identity;
  const validSources = validReadinessSources(identity?.sourceCommits);
  const validIdentity = exactObject(identity, readinessIdentityFields)
    && isReleaseVersion(identity.targetVersion)
    && exactObject(identity.piBase, readinessPiBaseFields)
    && validText(identity.piBase.version)
    && gitCommitPattern.test(identity.piBase.commit || "")
    && sha256Pattern.test(identity.selectionIntentSha256 || "")
    && validSources
    && validReadinessPatches(identity.patches, identity.sourceCommits)
    && new Set(["darwin", "linux"]).has(identity.platform)
    && validText(identity.architecture)
    && sha256Pattern.test(identity.checkerContractSha256 || "");
  if (
    !exactObject(value, upgradeReadinessFields)
    || value.schemaVersion !== 1
    || value.type !== "porcupi-upgrade-readiness"
    || !validIdentity
    || !sha256Pattern.test(value.identitySha256 || "")
    || value.identitySha256 !== sha256Bytes(canonicalJson(identity))
    || !new Set(["ready", "blocked"]).has(value.outcome)
    || (value.outcome === "ready" ? value.reason !== null : !(
      validText(value.reason) && value.reason.length <= 240
    ))
    || !validIsoDate(value.checkedAt)
  ) fail("Malformed PorcuPi Upgrade Readiness cache");
  return value;
}

export function readUpgradeReadinessCache(paths, { allowMissing = true } = {}) {
  const path = upgradeReadinessCachePath(paths);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("Malformed PorcuPi Upgrade Readiness cache");
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return null;
    if (error instanceof Error && error.message === "Malformed PorcuPi Upgrade Readiness cache") throw error;
    fail("Malformed PorcuPi Upgrade Readiness cache");
  }
  return validateUpgradeReadinessCache(readJson(path, "PorcuPi Upgrade Readiness cache"));
}

function readinessLocalInput(selections, platform = process.platform, architecture = process.arch) {
  return {
    selectionIntentSha256: sha256Bytes(canonicalJson(selections)),
    sourceCommits: selections.sources.map(({ locator, commit }) => ({ locator, commit })),
    patches: patchSelectionSnapshot(selections.sources),
    platform,
    architecture,
  };
}

export function createUpgradeReadinessIdentity({
  targetVersion,
  piBase,
  selections,
  checkerContract,
  platform = process.platform,
  architecture = process.arch,
}) {
  validateReleaseVersion(targetVersion);
  const local = readinessLocalInput(selections, platform, architecture);
  return {
    targetVersion,
    piBase: { version: piBase.tag, commit: piBase.commit },
    ...local,
    checkerContractSha256: sha256Bytes(canonicalJson(checkerContract)),
  };
}

export function writeUpgradeReadinessCache(paths, { identity, outcome, reason = null, now = () => new Date() }) {
  const value = {
    schemaVersion: 1,
    type: "porcupi-upgrade-readiness",
    identity,
    identitySha256: sha256Bytes(canonicalJson(identity)),
    outcome,
    reason,
    checkedAt: now().toISOString(),
  };
  const cache = validateUpgradeReadinessCache(value);
  validateManagedRoot(paths);
  atomicWrite(upgradeReadinessCachePath(paths), cache);
  return cache;
}

function locallyMatchingUpgradeReadiness(cache, { targetVersion, selections, platform = process.platform, architecture = process.arch }) {
  if (!cache || cache.identity.targetVersion !== targetVersion) return null;
  const local = readinessLocalInput(selections, platform, architecture);
  return canonicalJson(local) === canonicalJson({
    selectionIntentSha256: cache.identity.selectionIntentSha256,
    sourceCommits: cache.identity.sourceCommits,
    patches: cache.identity.patches,
    platform: cache.identity.platform,
    architecture: cache.identity.architecture,
  }) ? cache : null;
}

export function validateUpgradeReadinessTarget(value) {
  if (
    !exactObject(value, new Set(["targetVersion", "piBase", "checkerContractSha256"]))
    || !isReleaseVersion(value.targetVersion)
    || !exactObject(value.piBase, readinessPiBaseFields)
    || !validText(value.piBase.version)
    || !gitCommitPattern.test(value.piBase.commit || "")
    || !sha256Pattern.test(value.checkerContractSha256 || "")
  ) fail("Malformed target Upgrade Readiness identity");
  return value;
}

export function upgradeReadinessTarget(cache) {
  validateUpgradeReadinessCache(cache);
  return {
    targetVersion: cache.identity.targetVersion,
    piBase: cache.identity.piBase,
    checkerContractSha256: cache.identity.checkerContractSha256,
  };
}

export function matchingUpgradeReadiness(cache, {
  target,
  selections,
  platform = process.platform,
  architecture = process.arch,
}) {
  validateUpgradeReadinessTarget(target);
  const local = locallyMatchingUpgradeReadiness(cache, {
    targetVersion: target.targetVersion,
    selections,
    platform,
    architecture,
  });
  return local
    && canonicalJson(target.piBase) === canonicalJson(local.identity.piBase)
    && target.checkerContractSha256 === local.identity.checkerContractSha256
    ? local
    : null;
}

export function verifyReleaseStatusState(paths) {
  readReleaseStatusCache(paths);
  readSourceUpdateCache(paths);
  return readUpgradeReadinessCache(paths);
}

function statusFromCache(installedVersion, cache) {
  if (!cache) return null;
  return compareReleaseVersions(cache.latestVersion, installedVersion) > 0
    ? { kind: "available", installedVersion, targetVersion: cache.latestVersion, cache }
    : { kind: "current", installedVersion, targetVersion: null, cache };
}

function statusFromReadiness({ installedVersion, targetVersion, readiness, selections, context }) {
  const matching = targetVersion
    ? locallyMatchingUpgradeReadiness(readiness, { targetVersion, selections })
    : null;
  if (!matching) return null;
  return {
    kind: matching.outcome,
    installedVersion,
    targetVersion,
    cache: matching,
    context,
    reason: matching.reason,
  };
}

export function initialReleaseStatus({ installedVersion, cache, readiness = null, selections = { schemaVersion: 2, sources: [] }, offline }) {
  validateReleaseVersion(installedVersion);
  const cached = statusFromCache(installedVersion, cache);
  const ready = statusFromReadiness({
    installedVersion,
    targetVersion: cached?.targetVersion,
    readiness,
    selections,
    context: offline ? "offline" : "cached",
  });
  if (ready) return ready;
  if (offline) {
    return {
      kind: "offline",
      installedVersion,
      targetVersion: cached?.targetVersion ?? null,
      cache,
      stale: Boolean(readiness),
    };
  }
  return { kind: "checking", installedVersion, targetVersion: cached?.targetVersion ?? null, cache };
}

export function cachedReleaseStatus({ installedVersion, cache, readiness = null, selections = { schemaVersion: 2, sources: [] } }) {
  validateReleaseVersion(installedVersion);
  const cached = statusFromCache(installedVersion, cache)
    ?? { kind: "unavailable", installedVersion, targetVersion: null, cache: null };
  return statusFromReadiness({
    installedVersion,
    targetVersion: cached.targetVersion,
    readiness,
    selections,
    context: "cached",
  }) ?? (cached.kind === "available"
    ? readinessUnavailableStatus({ installedVersion, targetVersion: cached.targetVersion, stale: Boolean(readiness) })
    : cached);
}

export function checkingCompatibilityStatus({ installedVersion, targetVersion }) {
  return { kind: "checking-readiness", installedVersion, targetVersion, cache: null };
}

export function readinessUnavailableStatus({ installedVersion, targetVersion, stale = false, disabled = false }) {
  return { kind: "readiness-unavailable", installedVersion, targetVersion, cache: null, stale, disabled };
}

export function revalidatedReadinessStatus({ installedVersion, target, readiness, selections }) {
  const matching = matchingUpgradeReadiness(readiness, { target, selections });
  return matching ? {
    kind: matching.outcome,
    installedVersion,
    targetVersion: target.targetVersion,
    cache: matching,
    context: "fresh",
    reason: matching.reason,
  } : readinessUnavailableStatus({
    installedVersion,
    targetVersion: target.targetVersion,
    stale: Boolean(readiness),
  });
}

export function unavailableReleaseStatus({ installedVersion, cache }) {
  const cached = statusFromCache(installedVersion, cache);
  return { kind: "unavailable", installedVersion, targetVersion: cached?.targetVersion ?? null, cache };
}

async function boundedResponseJson(response, controller) {
  if (!response.ok) fail(`PorcuPi release availability request returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
    controller.abort();
    fail("PorcuPi release availability response is too large");
  }
  if (!response.body) fail("PorcuPi release availability response is empty");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumResponseBytes) {
      controller.abort();
      fail("PorcuPi release availability response is too large");
    }
    chunks.push(value);
  }
  const contents = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString("utf8");
  try {
    return JSON.parse(contents);
  } catch {
    fail("Malformed PorcuPi release availability response");
  }
}

export async function checkReleaseAvailability({
  paths,
  installedVersion,
  endpoint = defaultReleaseStatusUrl,
  signal,
  now = () => new Date(),
} = {}) {
  validateReleaseVersion(installedVersion);
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    fail("Malformed PorcuPi release availability endpoint");
  }
  if (!new Set(["https:", "http:"]).has(endpointUrl.protocol)) fail("Malformed PorcuPi release availability endpoint");

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, releaseCheckTimeoutMilliseconds);
  timeout.unref?.();
  try {
    const response = await fetch(endpointUrl, {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
    const value = await boundedResponseJson(response, controller);
    if (!isReleaseVersion(value?.version)) fail("Malformed PorcuPi release availability response");
    const cache = {
      schemaVersion: 1,
      type: "porcupi-release-availability",
      latestVersion: value.version,
      checkedAt: now().toISOString(),
    };
    validateManagedRoot(paths);
    atomicWrite(releaseStatusCachePath(paths), cache);
    return compareReleaseVersions(value.version, installedVersion) > 0
      ? { kind: "available", installedVersion, targetVersion: value.version, cache }
      : { kind: "current", installedVersion, targetVersion: null, cache };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function releaseInstallCommand(version) {
  validateReleaseVersion(version);
  return `npx --yes porcupi@${version}`;
}

function externalReleaseInstallGuidance(targetVersion, compact) {
  const command = releaseInstallCommand(targetVersion);
  return compact ? `outside: ${command}` : `${command} (outside session)`;
}

export function renderReleaseStatusRow(status, { compact = false } = {}) {
  const guidance = status.targetVersion
    ? externalReleaseInstallGuidance(status.targetVersion, compact)
    : null;
  if (status.kind === "checking") {
    if (status.targetVersion) {
      return compact
        ? `${status.targetVersion} checking release availability; ${guidance}`
        : `PorcuPi: checking release availability; cached target ${status.targetVersion}: ${guidance}`;
    }
    return "PorcuPi: checking release availability...";
  }
  if (status.kind === "checking-readiness") {
    return `PorcuPi ${status.targetVersion}${compact ? "" : ":"} checking compatibility; ${guidance}`;
  }
  if (status.kind === "ready") {
    const context = status.context === "offline"
      ? compact ? "ready/offline" : "cached ready (offline)"
      : "ready";
    return `PorcuPi ${status.targetVersion} ${context}${compact ? ";" : ":"} ${guidance}`;
  }
  if (status.kind === "blocked") {
    const context = status.context === "offline" ? " (cached offline)" : "";
    return `PorcuPi ${status.targetVersion} blocked${context}: ${status.reason}; ${guidance}`;
  }
  if (status.kind === "readiness-unavailable") {
    const evidence = status.stale ? "stale" : "unavailable";
    let disabled = "";
    if (status.disabled) disabled = compact ? " (disabled)" : " (background disabled)";
    return `PorcuPi ${status.targetVersion} readiness ${evidence}${disabled}${compact ? ";" : ":"} ${guidance}`;
  }
  if (status.kind === "current") return `PorcuPi ${status.installedVersion}: current`;
  if (status.kind === "available") {
    return compact
      ? `PorcuPi ${status.targetVersion} readiness unavailable; ${guidance}`
      : `PorcuPi ${status.targetVersion} available; Upgrade Readiness unavailable: ${guidance}`;
  }
  if (status.kind === "offline") {
    if (status.targetVersion) {
      const evidence = status.stale ? "stale" : "unavailable";
      return compact
        ? `PorcuPi ${status.targetVersion} offline/readiness-${evidence}; ${guidance}`
        : `PorcuPi offline; cached ${status.targetVersion}; Upgrade Readiness ${evidence}: ${guidance}`;
    }
    if (status.cache) return `PorcuPi ${status.installedVersion}: offline; cached current`;
    return `PorcuPi ${status.installedVersion}: offline; cached release status unavailable`;
  }
  if (status.targetVersion) {
    return compact
      ? `PorcuPi ${status.targetVersion} release status stale; ${guidance}`
      : `PorcuPi unavailable; stale ${status.targetVersion}: ${guidance}`;
  }
  if (status.cache) return `PorcuPi ${status.installedVersion}: unavailable; cached current result is stale`;
  return `PorcuPi ${status.installedVersion}: release status unavailable; no cached result`;
}

export function releaseStatusColor(status) {
  if (status.kind === "ready" || status.kind === "current") return "success";
  if (status.kind === "available" || status.kind === "blocked") return "warning";
  if (status.kind === "checking" || status.kind === "checking-readiness") return "accent";
  return "muted";
}

export function formatReleaseStatus({
  installedVersion,
  piBase,
  cache,
  readiness,
  selections,
  offline = false,
  readinessDisabled = false,
}) {
  const cached = statusFromCache(installedVersion, cache);
  const targetVersion = cached?.targetVersion ?? null;
  const matching = targetVersion ? locallyMatchingUpgradeReadiness(readiness, { targetVersion, selections }) : null;
  const state = offline
    ? "offline — startup network and assessment work suppressed"
    : targetVersion
      ? "update available (cached availability evidence)"
      : cache
        ? "current (cached availability evidence)"
        : "unavailable — no cached release evidence";
  const lines = [
    "PorcuPi release status",
    `Installed release: ${installedVersion}`,
    `Installed Pi Base: ${piBase.tag} (${piBase.commit})`,
    `Target release: ${targetVersion ?? "none known"}`,
    `State: ${state}`,
    `Last successful availability check: ${cache?.checkedAt ?? "none"}`,
  ];
  if (targetVersion) {
    lines.push(`Upgrade Readiness: ${matching?.outcome ?? (readiness ? "unavailable — cached evidence is stale" : "unavailable — no cached evidence")}`);
    if (matching) {
      lines.push(`Target Pi Base: ${matching.identity.piBase.version} (${matching.identity.piBase.commit})`);
      lines.push(`Input identity: ${matching.identitySha256}`);
      lines.push(`Last successful readiness assessment: ${matching.checkedAt}`);
      if (matching.reason) lines.push(`Blocker: ${matching.reason}`);
    }
    if (readinessDisabled) lines.push("Background assessment: disabled by PORCUPI_BACKGROUND_READINESS.");
    lines.push(`Next command: ${releaseInstallCommand(targetVersion)}`);
    lines.push("Run the guided Release Installation outside the current Managed Pi session; it re-resolves and revalidates readiness before mutation.");
  } else {
    lines.push("Upgrade Readiness: unavailable — no actionable target release.");
    lines.push("Next step: no release upgrade command is currently available.");
  }
  lines.push("This command is side-effect-free; it does not check the network or change Managed Pi lifecycle state.");
  return `${lines.join("\n")}\n`;
}

export function showReleaseStatus({ environment = process.env, dataRoot = defaultDataRoot(environment), output = process.stdout } = {}) {
  const active = readActiveComposition(dataRoot);
  verifyRuntime(active.paths);
  const metadata = readJson(join(active.paths.runtime, "package.json"), "installed PorcuPi package metadata");
  if (!isReleaseVersion(metadata.version)) fail("Malformed installed PorcuPi package version");
  const cache = readReleaseStatusCache(active.paths);
  const readiness = readUpgradeReadinessCache(active.paths);
  const sourceUpdates = readSourceUpdateCache(active.paths);
  const selections = readSelections(active.paths.root);
  output.write(formatReleaseStatus({
    installedVersion: metadata.version,
    piBase: active.receipt.piBase,
    cache,
    readiness,
    selections,
    offline: porcupiOffline(environment),
    readinessDisabled: backgroundReadinessDisabled(environment),
  }));
  output.write(`${formatSourceUpdates(sourceUpdates, selections, active.receipt)}\n`);
  return { installedVersion: metadata.version, cache, readiness, sourceUpdates };
}
