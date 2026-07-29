import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWrite,
  canonicalJson,
  compositionIdentity,
  compositionReceiptName,
  createPayloadInventory,
  fail,
  managedExecutablePath,
  platformIdentity,
  readActiveComposition,
  readBoundComposition,
  readJson,
  run,
  sha256Bytes,
  sha256File,
  validateRequiredExecutable,
  verifyLauncher,
} from "./runtime.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const releaseRoot = existsSync(join(moduleDirectory, "upstream")) ? moduleDirectory : dirname(moduleDirectory);
export const compositionRecipe = Object.freeze({
  id: "pi-v0.81.1-composition-v1",
  commands: [
    "npm ci --ignore-scripts",
    "porcupi hydrate pinned model data",
    "npm run check:model-data",
    "npm run build:offline",
    "pi --help",
    "pi --version",
    "pi --list-models",
  ],
});
const packageMetadata = readJson(join(releaseRoot, "package.json"), "PorcuPi package metadata");
if (typeof packageMetadata.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageMetadata.version)) {
  fail("Malformed PorcuPi package version");
}
export const porcupiVersion = packageMetadata.version;

export function copyCompositionInputs(destination) {
  cpSync(join(releaseRoot, "upstream"), join(destination, "upstream"), { recursive: true });
  cpSync(join(releaseRoot, "package.json"), join(destination, "package.json"));
}

export function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function validRelativePath(value) {
  return typeof value === "string"
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function verifyBaseLock(value) {
  if (
    value?.schemaVersion !== 1
    || typeof value.repository !== "string"
    || typeof value.tag !== "string"
    || typeof value.commit !== "string"
    || !/^[a-f0-9]{40}$/.test(value.commit)
    || !Array.isArray(value.packages)
    || value.packages.length === 0
  ) {
    fail("Malformed Pi Base lock");
  }
  for (const identity of value.packages) {
    if (!validRelativePath(identity?.path) || typeof identity.name !== "string" || typeof identity.version !== "string") {
      fail("Malformed Pi Base package identity");
    }
  }
  const modelData = value.modelData;
  if (
    !validRelativePath(modelData?.path)
    || typeof modelData.package !== "string"
    || typeof modelData.version !== "string"
    || typeof modelData.npmIntegrity !== "string"
    || !/^[a-f0-9]{64}$/.test(modelData.manifestSha256 || "")
    || !value.packages.some((identity) => identity.name === modelData.package && identity.version === modelData.version)
  ) {
    fail("Malformed pinned Pi Base model data identity");
  }
  return value;
}

export function verifyHostNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    fail(`PorcuPi requires Node.js 22.19 or newer; found ${process.versions.node}`);
  }
}

export function loadBaseLock() {
  return verifyBaseLock(readJson(join(releaseRoot, "upstream", "pi-base.json"), "Pi Base lock"));
}

function verifyBaseCheckout(source, lock) {
  const head = run("git", ["rev-parse", "HEAD"], { cwd: source, capture: true, log: false });
  if (head !== lock.commit) fail(`Pi Base commit: expected ${lock.commit}, found ${head}`);
  const tag = run("git", ["rev-parse", `${lock.tag}^{commit}`], { cwd: source, capture: true, log: false });
  if (tag !== lock.commit) fail(`Pi Base tag ${lock.tag}: expected ${lock.commit}, found ${tag}`);
  const repository = run("git", ["remote", "get-url", "origin"], { cwd: source, capture: true, log: false });
  if (repository !== lock.repository) fail(`Pi Base repository: expected ${lock.repository}, found ${repository}`);
  for (const expected of lock.packages) {
    const manifest = readJson(join(source, expected.path), expected.path);
    if (manifest.name !== expected.name) fail(`${expected.path}: expected package ${expected.name}, found ${String(manifest.name)}`);
    if (manifest.version !== expected.version) fail(`${expected.name}: expected ${expected.version}, found ${String(manifest.version)}`);
  }
  const status = run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source, capture: true, log: false });
  if (status) fail(`Pi Base has tracked changes and is not safe to build:\n${status}`);
}

function prepareBase(destination, lock) {
  run("git", ["clone", "--depth", "1", "--branch", lock.tag, "--single-branch", lock.repository, destination]);
  verifyBaseCheckout(destination, lock);
}

function makeWritable(path) {
  if (!pathExists(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  }
}

export function removePreparedTree(path) {
  if (!pathExists(path)) return;
  makeWritable(path);
  rmSync(path, { recursive: true, force: true });
}

function makeImmutable(path) {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      makeImmutable(child);
      chmodSync(child, 0o555);
    } else if (stat.isFile()) chmodSync(child, (stat.mode & 0o111) === 0 ? 0o444 : 0o555);
    else if (!stat.isSymbolicLink()) fail(`Managed Pi Composition contains an unsupported entry: ${name}`);
  }
  chmodSync(path, 0o555);
}

function hydratePinnedModelData(payloadRoot, lock) {
  const source = join(releaseRoot, "upstream", lock.modelData.path);
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) fail("Pinned model data is not a regular directory");
  const manifestPath = join(source, ".manifest.json");
  if (sha256File(manifestPath) !== lock.modelData.manifestSha256) fail("Pinned model data manifest digest mismatch");
  const manifest = readJson(manifestPath, "pinned model data manifest");
  if (
    manifest.schemaVersion !== 1
    || typeof manifest.structureHash !== "string"
    || manifest.structureHash.length === 0
    || manifest.files === null
    || typeof manifest.files !== "object"
    || Array.isArray(manifest.files)
  ) {
    fail("Malformed pinned model data manifest");
  }
  const expectedFiles = Object.keys(manifest.files).sort();
  if (expectedFiles.length === 0 || expectedFiles.some((name) => !validRelativePath(name) || name.includes("/"))) {
    fail("Malformed pinned model data file inventory");
  }
  const actualFiles = readdirSync(source).filter((name) => name !== ".manifest.json").sort();
  if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) fail("Pinned model data file inventory mismatch");
  for (const name of expectedFiles) {
    const file = join(source, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(manifest.files[name])) {
      fail(`Malformed pinned model data file: ${name}`);
    }
    if (sha256File(file) !== manifest.files[name]) fail(`Pinned model data digest mismatch: ${name}`);
  }
  const destination = join(payloadRoot, "packages", "ai", "src", "providers", "data");
  if (pathExists(destination)) fail("Pi Base unexpectedly contains hydrated model data");
  process.stdout.write(`> PorcuPi hydrate pinned model data ${lock.modelData.package}@${lock.modelData.version}\n`);
  cpSync(source, destination, { recursive: true, errorOnExist: true });
}

function smokeEnvironment(stageRoot, environment = process.env) {
  const home = join(stageRoot, "smoke-home");
  mkdirSync(home, { mode: 0o700 });
  return { ...environment, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") };
}

function executeBuildRecipe(payloadRoot, stageRoot, lock) {
  run("npm", ["ci", "--ignore-scripts"], { cwd: payloadRoot });
  hydratePinnedModelData(payloadRoot, lock);
  run("npm", ["run", "check:model-data"], { cwd: payloadRoot });
  run("npm", ["run", "build:offline"], { cwd: payloadRoot });
  const executable = join(payloadRoot, managedExecutablePath);
  if (!pathExists(executable) || !lstatSync(executable).isFile()) fail("Managed Pi build did not produce its required executable");
  const environment = smokeEnvironment(stageRoot);
  run(process.execPath, [executable, "--help"], { cwd: payloadRoot, environment, capture: true });
  const version = run(process.execPath, [executable, "--version"], { cwd: payloadRoot, environment, capture: true });
  const expectedVersion = lock.packages.find((entry) => entry.name === "@earendil-works/pi-coding-agent")?.version;
  if (version !== expectedVersion) fail(`Managed Pi version: expected ${String(expectedVersion)}, found ${version}`);
  run(process.execPath, [executable, "--list-models"], { cwd: payloadRoot, environment, capture: true });
  rmSync(environment.HOME, { recursive: true, force: true });
}

function applyPatchSeries(checkout, patches, check) {
  for (const patch of patches) {
    const args = ["apply", ...(check ? ["--check"] : []), "--whitespace=error-all", patch.stagedPath];
    run("git", args, { cwd: checkout });
    if (check) run("git", ["apply", "--whitespace=error-all", patch.stagedPath], { cwd: checkout });
  }
}

function createReceipt(payloadRoot, lock, patches) {
  const payload = createPayloadInventory(payloadRoot);
  const executable = payload.find((entry) => entry.path === managedExecutablePath && entry.kind === "file");
  if (!executable) fail("Managed Pi payload inventory is missing its required executable");
  const identity = compositionIdentity({
    schemaVersion: 1,
    porcupiVersion,
    piBase: lock,
    patches: patches.map(({ locator, commit, path, sha256 }) => ({ locator, commit, path, sha256 })),
    recipe: compositionRecipe,
    platform: platformIdentity(),
    requiredExecutable: executable,
    payload,
  });
  return { ...identity, compositionId: sha256Bytes(canonicalJson(identity)) };
}

export function buildComposition({ candidateRoot, stageRoot, patches, lock }) {
  const payloadRoot = join(candidateRoot, "payload");
  mkdirSync(payloadRoot, { recursive: true, mode: 0o700 });
  if (patches.length > 0) {
    const preflight = join(stageRoot, `preflight-${randomUUID()}`);
    prepareBase(preflight, lock);
    applyPatchSeries(preflight, patches, true);
    removePreparedTree(preflight);
  }
  prepareBase(payloadRoot, lock);
  applyPatchSeries(payloadRoot, patches, false);
  executeBuildRecipe(payloadRoot, stageRoot, lock);
  removePreparedTree(join(payloadRoot, ".git"));
  makeImmutable(payloadRoot);
  const receipt = createReceipt(payloadRoot, lock, patches);
  writeFileSync(join(candidateRoot, compositionReceiptName), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444 });
  return receipt;
}

export function verifyCompositionContents(compositionRoot, receipt) {
  const stat = lstatSync(compositionRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Managed Pi Composition root is malformed");
  const payloadRoot = join(compositionRoot, "payload");
  const payload = createPayloadInventory(payloadRoot);
  if (canonicalJson(payload) !== canonicalJson(receipt.payload)) fail("Managed Pi Composition payload inventory mismatch");
  const requiredExecutable = payload.find((entry) => entry.path === managedExecutablePath && entry.kind === "file");
  if (!requiredExecutable || canonicalJson(requiredExecutable) !== canonicalJson(receipt.requiredExecutable)) {
    fail("Managed Pi Composition required executable receipt mismatch");
  }
  if (sha256Bytes(canonicalJson(compositionIdentity(receipt))) !== receipt.compositionId) {
    fail("Managed Pi Composition identity mismatch");
  }
  validateRequiredExecutable(payloadRoot, receipt.requiredExecutable);
}

export function verifyPublishedComposition(paths, compositionId) {
  const { compositionRoot, receipt } = readBoundComposition(paths, compositionId);
  verifyCompositionContents(compositionRoot, receipt);
  return receipt;
}

export function verifyManagedInstallation({ dataRoot, environment = process.env } = {}) {
  verifyHostNode();
  const active = readActiveComposition(dataRoot);
  verifyLauncher(active.paths, environment);
  verifyCompositionContents(active.compositionRoot, active.receipt);
  const stageRoot = join(active.paths.temporary, `verify-${randomUUID()}`);
  mkdirSync(stageRoot, { mode: 0o700 });
  writeFileSync(join(stageRoot, "owner.json"), `${JSON.stringify({ schemaVersion: 1, type: "porcupi-verify-stage" })}\n`, { mode: 0o600 });
  try {
    const smoke = smokeEnvironment(stageRoot, environment);
    run(process.execPath, [active.executable, "--help"], { cwd: active.payloadRoot, environment: smoke, capture: true });
    const version = run(process.execPath, [active.executable, "--version"], { cwd: active.payloadRoot, environment: smoke, capture: true });
    const expectedVersion = active.receipt.piBase.packages
      .find((entry) => entry.name === "@earendil-works/pi-coding-agent")?.version;
    if (version !== expectedVersion) fail(`Managed Pi version: expected ${String(expectedVersion)}, found ${version}`);
    run(process.execPath, [active.executable, "--list-models"], { cwd: active.payloadRoot, environment: smoke, capture: true });
  } finally {
    removePreparedTree(stageRoot);
  }
  return active.receipt;
}

export function publishComposition(paths, candidateRoot, receipt) {
  makeImmutable(candidateRoot);
  chmodSync(candidateRoot, 0o700);
  const compositionRoot = join(paths.compositions, receipt.compositionId);
  if (pathExists(compositionRoot)) {
    chmodSync(candidateRoot, 0o555);
    const embedded = readJson(join(compositionRoot, compositionReceiptName), "embedded Composition receipt");
    if (canonicalJson(embedded) !== canonicalJson(receipt)) fail("Managed Pi Composition identity collision");
    verifyCompositionContents(compositionRoot, embedded);
    removePreparedTree(candidateRoot);
  } else {
    renameSync(candidateRoot, compositionRoot);
    chmodSync(compositionRoot, 0o555);
  }
  const centralPath = join(paths.receipts, `${receipt.compositionId}.json`);
  if (pathExists(centralPath)) {
    if (canonicalJson(readJson(centralPath, "central Composition receipt")) !== canonicalJson(receipt)) {
      fail("Managed Pi Composition central receipt collision");
    }
  } else atomicWrite(centralPath, receipt);
  verifyPublishedComposition(paths, receipt.compositionId);
}
