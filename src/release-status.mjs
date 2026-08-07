import { lstatSync } from "node:fs";
import { join } from "node:path";
import { compareReleaseVersions, isReleaseVersion, validateReleaseVersion } from "./release-version.mjs";
import {
  atomicWrite,
  defaultDataRoot,
  exactObject,
  fail,
  managedLayout,
  readActiveComposition,
  readJson,
  validateManagedRoot,
  verifyRuntime,
} from "./runtime.mjs";

const releaseStatusCacheName = "release-status.json";
const defaultReleaseStatusUrl = "https://registry.npmjs.org/porcupi/latest";
const releaseStatusFields = new Set(["schemaVersion", "type", "latestVersion", "checkedAt"]);
const maximumResponseBytes = 64 * 1024;
const releaseCheckTimeoutMilliseconds = 1_500;

export function porcupiOffline(environment = process.env) {
  const value = environment.PI_OFFLINE;
  return typeof value === "string" && new Set(["1", "true", "yes"]).has(value.toLowerCase());
}

function releaseStatusCachePath(paths) {
  return paths.releaseStatus ?? join(paths.state, releaseStatusCacheName);
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

export function verifyReleaseStatusState(paths) {
  return readReleaseStatusCache(paths);
}

function statusFromCache(installedVersion, cache) {
  if (!cache) return null;
  return compareReleaseVersions(cache.latestVersion, installedVersion) > 0
    ? { kind: "available", installedVersion, targetVersion: cache.latestVersion, cache }
    : { kind: "current", installedVersion, targetVersion: null, cache };
}

export function initialReleaseStatus({ installedVersion, cache, offline }) {
  validateReleaseVersion(installedVersion);
  const cached = statusFromCache(installedVersion, cache);
  if (offline) return { kind: "offline", installedVersion, targetVersion: cached?.targetVersion ?? null, cache };
  return { kind: "checking", installedVersion, targetVersion: cached?.targetVersion ?? null, cache };
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

export function renderReleaseStatusRow(status) {
  if (status.kind === "checking") {
    const cachedTarget = status.targetVersion ? `; cached target ${status.targetVersion}` : "";
    return `PorcuPi: checking release availability${cachedTarget}...`;
  }
  if (status.kind === "current") return `PorcuPi ${status.installedVersion}: current`;
  if (status.kind === "available") {
    return `PorcuPi ${status.targetVersion} available: ${releaseInstallCommand(status.targetVersion)} (outside session)`;
  }
  if (status.kind === "offline") {
    if (status.targetVersion) {
      return `PorcuPi offline; cached ${status.targetVersion}: ${releaseInstallCommand(status.targetVersion)} (outside session)`;
    }
    if (status.cache) return `PorcuPi ${status.installedVersion}: offline; cached current`;
    return `PorcuPi ${status.installedVersion}: offline; cached release status unavailable`;
  }
  if (status.targetVersion) {
    return `PorcuPi unavailable; stale ${status.targetVersion}: ${releaseInstallCommand(status.targetVersion)}`;
  }
  if (status.cache) return `PorcuPi ${status.installedVersion}: unavailable; cached current result is stale`;
  return `PorcuPi ${status.installedVersion}: release status unavailable; no cached result`;
}

export function releaseStatusColor(status) {
  if (status.kind === "available") return "warning";
  if (status.kind === "current") return "success";
  if (status.kind === "checking") return "accent";
  return "muted";
}

export function formatReleaseStatus({ installedVersion, piBase, cache, offline = false }) {
  const cached = statusFromCache(installedVersion, cache);
  const targetVersion = cached?.targetVersion ?? null;
  const state = offline
    ? "offline — startup release request suppressed"
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
    lines.push(`Next command: ${releaseInstallCommand(targetVersion)}`);
    lines.push("Run the guided Release Installation outside the current Managed Pi session.");
  } else {
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
  output.write(formatReleaseStatus({
    installedVersion: metadata.version,
    piBase: active.receipt.piBase,
    cache,
    offline: porcupiOffline(environment),
  }));
  return { installedVersion: metadata.version, cache };
}
