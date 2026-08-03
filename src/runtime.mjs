import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const compositionReceiptName = "receipt.json";
export const managedExecutablePath = "packages/coding-agent/dist/cli.js";
export const managedRootOwner = Object.freeze({ schemaVersion: 1, type: "porcupi-managed-root" });

const activationFields = new Set(["schemaVersion", "active", "previous"]);
const activationEntryFields = new Set(["compositionId", "patches"]);
const patchIdentityFields = new Set(["locator", "commit", "path", "sha256"]);
const receiptFields = new Set([
  "schemaVersion", "porcupiVersion", "piBase", "patches", "recipe", "platform",
  "requiredExecutable", "payload", "compositionId",
]);
const piBaseFields = new Set(["schemaVersion", "repository", "tag", "commit", "modelData", "packages"]);
const modelDataFields = new Set(["path", "package", "version", "npmIntegrity", "manifestSha256"]);
const packageIdentityFields = new Set(["path", "name", "version"]);
const recipeFields = new Set(["id", "commands"]);
const payloadEntryFields = new Set(["path", "kind", "mode", "size", "sha256"]);
const payloadKinds = new Set(["file", "symlink"]);
const launcherReceiptFields = new Set(["schemaVersion", "type", "path", "kind", "mode", "size", "sha256"]);
const runtimeReceiptFields = new Set(["schemaVersion", "type", "inventorySha256"]);
const leaseDirectoryOwnerFields = new Set(["schemaVersion", "type", "compositionId"]);
const leaseFields = new Set(["schemaVersion", "type", "compositionId", "pid", "nonce"]);

export function fail(message) {
  throw new Error(message);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function compositionIdentity(value) {
  return {
    schemaVersion: value.schemaVersion,
    porcupiVersion: value.porcupiVersion,
    piBase: value.piBase,
    patches: value.patches,
    recipe: value.recipe,
    platform: value.platform,
    requiredExecutable: value.requiredExecutable,
    payload: value.payload,
  };
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function platformIdentity(platform = process.platform, architecture = process.arch) {
  if (!new Set(["darwin", "linux"]).has(platform)) fail(`PorcuPi supports macOS and Linux; found ${platform}`);
  return `${platform}-${architecture}`;
}

export function defaultDataRoot(environment = process.env, platform = process.platform) {
  const home = environment.HOME || homedir();
  if (!home) fail("HOME is required to select the PorcuPi data root");
  if (platform === "darwin") return join(home, "Library", "Application Support", "porcupi");
  if (platform === "linux") return join(environment.XDG_DATA_HOME || join(home, ".local", "share"), "porcupi");
  fail(`PorcuPi supports macOS and Linux; found ${platform}`);
}

export function defaultBinDirectory(environment = process.env) {
  const home = environment.HOME || homedir();
  if (!home) fail("HOME is required to select the PorcuPi command directory");
  return join(home, ".local", "bin");
}

export function managedLayout(dataRoot) {
  const root = resolve(dataRoot);
  return {
    root,
    owner: join(root, "owner.json"),
    temporary: join(root, "tmp"),
    runtime: join(root, "runtime"),
    compositions: join(root, "compositions"),
    receipts: join(root, "receipts"),
    leases: join(root, "leases"),
    state: join(root, "state"),
    activation: join(root, "state", "activation.json"),
    launcherReceipt: join(root, "state", "launcher.json"),
    runtimeReceipt: join(root, "state", "runtime.json"),
    piLauncherReceipt: join(root, "state", "pi-launcher.json"),
    piTransition: join(root, "state", "pi-transition.json"),
  };
}

export function readJson(path, label = basename(path)) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`Malformed ${label}`);
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Malformed ")) throw error;
    fail(`Malformed ${label}`);
  }
}

function exactObject(value, fields) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function validText(value) {
  return typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function validRelativePath(value) {
  return validText(value)
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function lexicalCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function withinRoot(root, path) {
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  return realPath === realRoot || realPath.startsWith(`${realRoot}${sep}`);
}

function validateOwnedDirectory(root, path, label) {
  let stat;
  try {
    stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !withinRoot(root, path)) fail(`Malformed ${label}`);
  } catch (error) {
    if (error instanceof Error && error.message === `Malformed ${label}`) throw error;
    fail(`Malformed ${label}`);
  }
}

export function validateManagedRoot(paths) {
  let stat;
  try {
    stat = lstatSync(paths.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Malformed PorcuPi ownership root");
  } catch (error) {
    if (error instanceof Error && error.message === "Malformed PorcuPi ownership root") throw error;
    fail("Malformed PorcuPi ownership root");
  }
  const owner = readJson(paths.owner, "PorcuPi root ownership");
  if (canonicalJson(owner) !== canonicalJson(managedRootOwner)) fail("Malformed PorcuPi root ownership");
  for (const [path, label] of [
    [paths.state, "PorcuPi state directory"],
    [paths.compositions, "PorcuPi compositions directory"],
    [paths.receipts, "PorcuPi receipts directory"],
    [paths.leases, "PorcuPi leases directory"],
    [paths.runtime, "PorcuPi runtime directory"],
    [paths.temporary, "PorcuPi temporary directory"],
  ]) validateOwnedDirectory(paths.root, path, label);
  return paths;
}

export function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  const contents = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  try {
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // Atomic rename still prevents a half-written record where directory fsync is unavailable.
  }
}

function safeLinkTarget(root, path) {
  const target = readlinkSync(path);
  const resolved = resolve(dirname(path), target);
  const rootPath = resolve(root);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${sep}`)) {
    fail(`Payload symbolic link escapes the Managed Pi Composition: ${relative(root, path)}`);
  }
  try {
    if (!withinRoot(root, path)) fail(`Payload symbolic link escapes the Managed Pi Composition: ${relative(root, path)}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

export function createPayloadInventory(root) {
  const entries = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        entries.push({ path, kind: "file", mode: stat.mode & 0o777, size: stat.size, sha256: sha256File(absolute) });
      } else if (stat.isSymbolicLink()) {
        const target = safeLinkTarget(root, absolute);
        entries.push({ path, kind: "symlink", mode: stat.mode & 0o777, size: stat.size, sha256: sha256Bytes(target) });
      } else fail(`Payload contains unsupported entry: ${path}`);
    }
  }
  visit(root);
  return entries.sort((left, right) => lexicalCompare(left.path, right.path));
}

export function run(command, args, { cwd, environment = process.env, capture = false, log = true } = {}) {
  if (log) process.stdout.write(`> ${basename(command)} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? [result.stdout, result.stderr].filter(Boolean).join("\n").trim() : "";
    fail(`${basename(command)} exited with status ${String(result.status)}${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout?.trim() || "";
}

function validatePatchIdentities(value, label) {
  if (!Array.isArray(value)) fail(`Malformed ${label}`);
  let previousKey;
  const keys = new Set();
  for (const patch of value) {
    if (
      !exactObject(patch, patchIdentityFields)
      || !validText(patch.locator)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(patch.commit || "")
      || !validRelativePath(patch.path)
      || !patch.path.startsWith("patches/")
      || !patch.path.endsWith(".patch")
      || !/^[a-f0-9]{64}$/.test(patch.sha256 || "")
    ) fail(`Malformed ${label}`);
    const key = `${patch.locator}\0${patch.path}`;
    if (keys.has(key) || (previousKey !== undefined && lexicalCompare(previousKey, key) >= 0)) fail(`Malformed ${label}`);
    keys.add(key);
    previousKey = key;
  }
  return value;
}

function validatePiBase(value) {
  if (
    !exactObject(value, piBaseFields)
    || value.schemaVersion !== 1
    || !validText(value.repository)
    || !validText(value.tag)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.commit || "")
    || !exactObject(value.modelData, modelDataFields)
    || !validRelativePath(value.modelData.path)
    || !validText(value.modelData.package)
    || !validText(value.modelData.version)
    || !validText(value.modelData.npmIntegrity)
    || !/^[a-f0-9]{64}$/.test(value.modelData.manifestSha256 || "")
    || !Array.isArray(value.packages)
    || value.packages.length === 0
  ) fail("Malformed Managed Pi Composition receipt");
  const paths = new Set();
  const names = new Set();
  for (const identity of value.packages) {
    if (
      !exactObject(identity, packageIdentityFields)
      || !validRelativePath(identity.path)
      || !validText(identity.name)
      || !validText(identity.version)
      || paths.has(identity.path)
      || names.has(identity.name)
    ) fail("Malformed Managed Pi Composition receipt");
    paths.add(identity.path);
    names.add(identity.name);
  }
  if (
    !value.packages.some((identity) => identity.name === value.modelData.package && identity.version === value.modelData.version)
    || !value.packages.some((identity) => identity.name === "@earendil-works/pi-coding-agent")
  ) fail("Malformed Managed Pi Composition receipt");
}

function validatePayloadEntry(entry) {
  return exactObject(entry, payloadEntryFields)
    && validRelativePath(entry.path)
    && payloadKinds.has(entry.kind)
    && Number.isInteger(entry.mode)
    && entry.mode >= 0
    && entry.mode <= 0o777
    && Number.isSafeInteger(entry.size)
    && entry.size >= 0
    && /^[a-f0-9]{64}$/.test(entry.sha256 || "");
}

export function validateCompositionReceipt(value, expectedCompositionId) {
  if (
    !exactObject(value, receiptFields)
    || value.schemaVersion !== 1
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.porcupiVersion || "")
    || !exactObject(value.recipe, recipeFields)
    || !validText(value.recipe.id)
    || !Array.isArray(value.recipe.commands)
    || value.recipe.commands.length === 0
    || value.recipe.commands.some((command) => !validText(command))
    || new Set(value.recipe.commands).size !== value.recipe.commands.length
    || !/^(?:darwin|linux)-[A-Za-z0-9_-]+$/.test(value.platform || "")
    || !Array.isArray(value.payload)
    || value.payload.length === 0
    || !/^[a-f0-9]{64}$/.test(value.compositionId || "")
    || value.compositionId !== expectedCompositionId
  ) fail("Malformed Managed Pi Composition receipt");
  validatePiBase(value.piBase);
  validatePatchIdentities(value.patches, "Managed Pi Composition receipt");
  let previousPath;
  const paths = new Set();
  for (const entry of value.payload) {
    if (!validatePayloadEntry(entry)) fail("Malformed Managed Pi Composition receipt");
    if (
      paths.has(entry.path)
      || (previousPath !== undefined && lexicalCompare(previousPath, entry.path) >= 0)
      || entry.path.split("/").slice(0, -1).some((_, index, parts) => paths.has(parts.slice(0, index + 1).join("/")))
    ) fail("Malformed Managed Pi Composition receipt");
    paths.add(entry.path);
    previousPath = entry.path;
  }
  if (!validatePayloadEntry(value.requiredExecutable) || value.requiredExecutable.path !== managedExecutablePath) {
    fail("Malformed Managed Pi Composition receipt");
  }
  const executable = value.payload.find((entry) => entry.path === managedExecutablePath);
  if (canonicalJson(executable) !== canonicalJson(value.requiredExecutable) || executable.kind !== "file") {
    fail("Malformed Managed Pi Composition receipt");
  }
  if (sha256Bytes(canonicalJson(compositionIdentity(value))) !== value.compositionId) {
    fail("Managed Pi Composition identity mismatch");
  }
  return value;
}

function validateActivationEntry(value) {
  if (!exactObject(value, activationEntryFields) || !/^[a-f0-9]{64}$/.test(value.compositionId || "")) {
    fail("Malformed PorcuPi activation");
  }
  validatePatchIdentities(value.patches, "PorcuPi activation");
  return value;
}

export function validateActivation(activation) {
  if (!exactObject(activation, activationFields) || activation.schemaVersion !== 1) fail("Malformed PorcuPi activation");
  validateActivationEntry(activation.active);
  if (activation.previous !== null) validateActivationEntry(activation.previous);
  if (activation.previous?.compositionId === activation.active.compositionId) fail("Malformed PorcuPi activation");
  return activation;
}

export function readActivation(paths) {
  return validateActivation(readJson(paths.activation, "PorcuPi activation"));
}

function validateCompositionDirectory(paths, compositionId) {
  const compositionRoot = join(paths.compositions, compositionId);
  validateOwnedDirectory(paths.root, compositionRoot, "Managed Pi Composition root");
  const payloadRoot = join(compositionRoot, "payload");
  validateOwnedDirectory(paths.root, payloadRoot, "Managed Pi Composition payload");
  return { compositionRoot, payloadRoot };
}

export function readBoundComposition(paths, compositionId) {
  if (!/^[a-f0-9]{64}$/.test(compositionId || "")) fail("Malformed Managed Pi Composition identity");
  const { compositionRoot, payloadRoot } = validateCompositionDirectory(paths, compositionId);
  const centralValue = readJson(join(paths.receipts, `${compositionId}.json`), "central Composition receipt");
  const embeddedValue = readJson(join(compositionRoot, compositionReceiptName), "embedded Composition receipt");
  if (
    canonicalJson(centralValue) !== canonicalJson(embeddedValue)
    || centralValue?.compositionId !== compositionId
    || embeddedValue?.compositionId !== compositionId
  ) fail("Managed Pi Composition receipt mismatch");
  const receipt = validateCompositionReceipt(centralValue, compositionId);
  if (receipt.platform !== platformIdentity()) fail(`Managed Pi Composition platform mismatch: ${receipt.platform}`);
  return { receipt, compositionRoot, payloadRoot };
}

function leaseDirectoryOwner(compositionId) {
  return { schemaVersion: 1, type: "porcupi-composition-leases", compositionId };
}

export function compositionLeaseDirectory(paths, compositionId) {
  if (!/^[a-f0-9]{64}$/.test(compositionId || "")) fail("Malformed Managed Pi Composition identity");
  return join(paths.leases, compositionId);
}

export function validateCompositionLeaseDirectory(paths, compositionId) {
  const directory = compositionLeaseDirectory(paths, compositionId);
  validateOwnedDirectory(paths.root, directory, "Managed Pi Composition lease directory");
  const owner = readJson(join(directory, "owner.json"), "Managed Pi Composition lease ownership");
  if (
    !exactObject(owner, leaseDirectoryOwnerFields)
    || canonicalJson(owner) !== canonicalJson(leaseDirectoryOwner(compositionId))
  ) fail("Malformed Managed Pi Composition lease ownership");
  return directory;
}

export function ensureCompositionLeaseDirectory(paths, compositionId) {
  const directory = compositionLeaseDirectory(paths, compositionId);
  try {
    mkdirSync(directory, { mode: 0o700 });
    atomicWrite(join(directory, "owner.json"), leaseDirectoryOwner(compositionId));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return validateCompositionLeaseDirectory(paths, compositionId);
}

function writeExclusiveJson(path, value) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function claimCompositionLease(paths, compositionId) {
  const directory = compositionLeaseDirectory(paths, compositionId);
  try {
    lstatSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    validateCompositionLeaseDirectory(paths, compositionId);
  } catch (error) {
    try {
      lstatSync(directory);
    } catch (statError) {
      if (statError?.code === "ENOENT") return null;
    }
    throw error;
  }
  const nonce = randomUUID();
  const path = join(directory, `${nonce}.json`);
  const value = { schemaVersion: 1, type: "porcupi-composition-lease", compositionId, pid: process.pid, nonce };
  try {
    writeExclusiveJson(path, value);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let released = false;
  return {
    path,
    value,
    release() {
      if (released) return;
      try {
        lstatSync(path);
      } catch (error) {
        if (error?.code === "ENOENT") {
          released = true;
          return;
        }
        throw error;
      }
      const current = readJson(path, "Managed Pi Composition lease");
      if (!exactObject(current, leaseFields) || canonicalJson(current) !== canonicalJson(value)) {
        fail(`Managed Pi Composition lease changed while held: ${path}`);
      }
      unlinkSync(path);
      released = true;
    },
  };
}

export function validateRequiredExecutable(payloadRoot, expected) {
  const executable = join(payloadRoot, expected.path);
  let realPayload;
  let realExecutable;
  try {
    realPayload = realpathSync(payloadRoot);
    realExecutable = realpathSync(executable);
  } catch {
    fail("Managed Pi executable is missing or inaccessible");
  }
  if (!realExecutable.startsWith(`${realPayload}${sep}`)) fail("Managed Pi executable escapes its Composition");
  const stat = lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Managed Pi executable is not a regular file");
  if (stat.size !== expected.size || (stat.mode & 0o777) !== expected.mode || sha256File(executable) !== expected.sha256) {
    fail("Managed Pi executable does not match its Composition receipt");
  }
  return executable;
}

export function createRuntimeReceipt(paths) {
  return {
    schemaVersion: 2,
    type: "porcupi-runtime",
    inventorySha256: sha256Bytes(canonicalJson(createPayloadInventory(paths.runtime))),
  };
}

export function validateRuntimeReceipt(receipt, label = "PorcuPi runtime receipt") {
  if (
    !exactObject(receipt, runtimeReceiptFields)
    || !new Set([1, 2]).has(receipt.schemaVersion)
    || receipt.type !== "porcupi-runtime"
    || !/^[a-f0-9]{64}$/.test(receipt.inventorySha256 || "")
  ) fail(`Malformed ${label}`);
  return receipt;
}

export function verifyRuntime(paths) {
  const receipt = validateRuntimeReceipt(readJson(paths.runtimeReceipt, "PorcuPi runtime receipt"));
  if (createRuntimeReceipt(paths).inventorySha256 !== receipt.inventorySha256) fail("PorcuPi runtime inventory mismatch");
  return receipt;
}

export function shellLauncherContents(cliPath) {
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cliPath)} "$@"\n`;
}

export function shellPiLauncherContents(porcupiPath) {
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return `#!/bin/sh\nexec ${quote(porcupiPath)} "$@"\n`;
}

export function createLauncherReceipt(path, type = "porcupi-launcher") {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("PorcuPi launcher is not a regular owned file");
  return {
    schemaVersion: 1,
    type,
    path,
    kind: "file",
    mode: stat.mode & 0o777,
    size: stat.size,
    sha256: sha256File(path),
  };
}

export function validateLauncherReceipt(receipt, { type, path, label }) {
  if (
    !exactObject(receipt, launcherReceiptFields)
    || receipt.schemaVersion !== 1
    || receipt.type !== type
    || receipt.path !== path
    || !validText(receipt.path)
    || resolve(receipt.path) !== receipt.path
    || receipt.kind !== "file"
    || !Number.isInteger(receipt.mode)
    || receipt.mode < 0
    || receipt.mode > 0o777
    || !Number.isSafeInteger(receipt.size)
    || receipt.size < 0
    || !/^[a-f0-9]{64}$/.test(receipt.sha256 || "")
  ) fail(`Malformed ${label}`);
  return receipt;
}

export function verifyLauncherReceipt(receipt, expectedContents, label) {
  let stat;
  try {
    stat = lstatSync(receipt.path);
  } catch {
    fail(`${label} is missing: ${receipt.path}`);
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== receipt.mode
    || stat.size !== receipt.size
    || sha256File(receipt.path) !== receipt.sha256
    || readFileSync(receipt.path, "utf8") !== expectedContents
  ) fail(`${label} does not match its ownership receipt: ${receipt.path}`);
  return receipt;
}

export function verifyLauncher(paths, environment = process.env) {
  const expectedPath = join(defaultBinDirectory(environment), "porcupi");
  const receipt = validateLauncherReceipt(readJson(paths.launcherReceipt, "PorcuPi launcher receipt"), {
    type: "porcupi-launcher",
    path: expectedPath,
    label: "PorcuPi launcher receipt",
  });
  return verifyLauncherReceipt(receipt, shellLauncherContents(join(paths.runtime, "cli.mjs")), "PorcuPi launcher");
}

export function verifyPiLauncher(paths, environment = process.env) {
  const binDirectory = defaultBinDirectory(environment);
  const expectedPath = join(binDirectory, "pi");
  const receipt = validateLauncherReceipt(readJson(paths.piLauncherReceipt, "PorcuPi pi launcher receipt"), {
    type: "porcupi-pi-launcher",
    path: expectedPath,
    label: "PorcuPi pi launcher receipt",
  });
  return verifyLauncherReceipt(
    receipt,
    shellPiLauncherContents(join(binDirectory, "porcupi")),
    "PorcuPi-owned pi launcher",
  );
}

function pathIsPresent(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function verifyOptionalPiLauncher(paths, environment = process.env) {
  if (pathIsPresent(paths.piTransition)) fail("PorcuPi pi ownership transition requires recovery");
  return pathIsPresent(paths.piLauncherReceipt) ? verifyPiLauncher(paths, environment) : null;
}

function readActivatedComposition(paths, activation) {
  const bound = readBoundComposition(paths, activation.active.compositionId);
  if (canonicalJson(bound.receipt.patches) !== canonicalJson(activation.active.patches)) {
    fail("Managed Pi activation and Composition Patch receipts disagree");
  }
  const executable = validateRequiredExecutable(bound.payloadRoot, bound.receipt.requiredExecutable);
  return { paths, activation, executable, ...bound };
}

export function readActiveComposition(dataRoot = defaultDataRoot()) {
  const paths = validateManagedRoot(managedLayout(dataRoot));
  return readActivatedComposition(paths, readActivation(paths));
}

export function readLeasedActiveComposition(dataRoot = defaultDataRoot()) {
  const paths = validateManagedRoot(managedLayout(dataRoot));
  let lastActivation;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const activation = readActivation(paths);
    lastActivation = activation;
    const lease = claimCompositionLease(paths, activation.active.compositionId);
    if (!lease) continue;
    try {
      return { ...readActivatedComposition(paths, activation), lease };
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  const current = readActivation(paths);
  if (current.active.compositionId !== lastActivation?.active.compositionId) {
    fail("Managed Pi activation changed during launch; retry the command");
  }
  readActivatedComposition(paths, current);
  fail("Managed Pi Composition lease directory is unavailable; retry the command");
}
