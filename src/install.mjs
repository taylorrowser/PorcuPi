import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWrite,
  canonicalJson,
  compositionReceiptName,
  createPayloadInventory,
  defaultBinDirectory,
  defaultDataRoot,
  fail,
  managedExecutablePath,
  managedLayout,
  platformIdentity,
  readActiveComposition,
  readJson,
  run,
  sha256Bytes,
  sha256File,
} from "./runtime.mjs";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(sourceDirectory);
const recipe = Object.freeze({
  id: "pi-v0.81.1-zero-patch-v1",
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
const rootOwner = Object.freeze({ schemaVersion: 1, type: "porcupi-managed-root" });

function pathExists(path) {
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
    if (
      !validRelativePath(identity?.path)
      || typeof identity.name !== "string"
      || typeof identity.version !== "string"
    ) {
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

function loadBaseLock() {
  return verifyBaseLock(readJson(join(projectRoot, "upstream", "pi-base.json"), "Pi Base lock"));
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
    if (manifest.name !== expected.name) {
      fail(`${expected.path}: expected package ${expected.name}, found ${String(manifest.name)}`);
    }
    if (manifest.version !== expected.version) {
      fail(`${expected.name}: expected ${expected.version}, found ${String(manifest.version)}`);
    }
  }
  const status = run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source, capture: true, log: false });
  if (status) fail(`Pi Base has tracked changes and is not safe to build:\n${status}`);
}

function prepareBase(destination, lock) {
  run("git", ["clone", "--branch", lock.tag, "--single-branch", lock.repository, destination]);
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

function removeOwnedTree(path) {
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
    }
  }
  chmodSync(path, 0o555);
}

function initializeFreshRoot(paths) {
  if (pathExists(paths.root)) {
    const owner = readJson(paths.owner, "PorcuPi root ownership");
    if (canonicalJson(owner) !== canonicalJson(rootOwner)) fail(`PorcuPi data root is foreign: ${paths.root}`);
    if (existsSync(paths.activation)) fail(`PorcuPi is already installed at ${paths.root}`);
    removeOwnedTree(paths.root);
  }
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  atomicWrite(paths.owner, rootOwner);
  for (const path of [paths.temporary, paths.compositions, paths.receipts, paths.state]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

function hydratePinnedModelData(payloadRoot, lock) {
  const source = join(projectRoot, "upstream", lock.modelData.path);
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

function smokeEnvironment(stageRoot) {
  const home = join(stageRoot, "smoke-home");
  mkdirSync(home, { mode: 0o700 });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
  };
}

function executeBuildRecipe(payloadRoot, temporaryRoot, lock) {
  run("npm", ["ci", "--ignore-scripts"], { cwd: payloadRoot });
  hydratePinnedModelData(payloadRoot, lock);
  run("npm", ["run", "check:model-data"], { cwd: payloadRoot });
  run("npm", ["run", "build:offline"], { cwd: payloadRoot });
  const executable = join(payloadRoot, managedExecutablePath);
  if (!pathExists(executable) || !lstatSync(executable).isFile()) fail("Managed Pi build did not produce its required executable");
  const environment = smokeEnvironment(temporaryRoot);
  // Pi v0.81.1 has no `conformance` command until a downstream Patch adds it.
  // Its zero-Patch public conformance gate is therefore the fixed public help check.
  run(process.execPath, [executable, "--help"], { cwd: payloadRoot, environment, capture: true });
  const version = run(process.execPath, [executable, "--version"], { cwd: payloadRoot, environment, capture: true });
  const expectedVersion = lock.packages.find((entry) => entry.name === "@earendil-works/pi-coding-agent")?.version;
  if (version !== expectedVersion) fail(`Managed Pi version: expected ${String(expectedVersion)}, found ${version}`);
  run(process.execPath, [executable, "--list-models"], { cwd: payloadRoot, environment, capture: true });
  rmSync(environment.HOME, { recursive: true, force: true });
}

function createReceipt(payloadRoot, lock) {
  const payload = createPayloadInventory(payloadRoot);
  const executable = payload.find((entry) => entry.path === managedExecutablePath && entry.kind === "file");
  if (!executable) fail("Managed Pi payload inventory is missing its required executable");
  const identity = {
    schemaVersion: 1,
    piBase: lock,
    patches: [],
    recipe,
    platform: platformIdentity(),
    payload,
  };
  const compositionId = sha256Bytes(canonicalJson(identity));
  return {
    schemaVersion: 1,
    compositionId,
    piBase: lock,
    patches: [],
    recipe,
    platform: identity.platform,
    requiredExecutable: executable,
    payload,
  };
}

function publishRuntime(paths, stageRoot) {
  const stagedRuntime = join(stageRoot, "runtime");
  cpSync(sourceDirectory, stagedRuntime, { recursive: true });
  renameSync(stagedRuntime, paths.runtime);
}

function checkpoint(name) {
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAULT === name) {
    process.kill(process.pid, "SIGKILL");
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function publishLauncher(path, cliPath) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  writeFileSync(temporary, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} "$@"\n`, { mode: 0o755 });
  renameSync(temporary, path);
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
    const restore = () => {
      input.off("data", onData);
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
    input.on("data", onData);
    input.once("error", (error) => {
      restore();
      rejectPromise(error);
    });
  });
}

export async function installManagedPi({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  platform = process.platform,
} = {}) {
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
  if (pathExists(launcher)) fail(`Refusing foreign porcupi command collision: ${launcher}`);
  const paths = managedLayout(dataRoot);
  if (pathExists(paths.root) && pathExists(paths.activation)) {
    const rootStat = lstatSync(paths.root);
    const owner = readJson(paths.owner, "PorcuPi root ownership");
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || canonicalJson(owner) !== canonicalJson(rootOwner)) {
      fail(`PorcuPi data root is foreign: ${paths.root}`);
    }
    const active = readActiveComposition(dataRoot);
    const installedCli = join(paths.runtime, "cli.mjs");
    const cliStat = lstatSync(installedCli);
    if (!cliStat.isFile() || cliStat.isSymbolicLink()) fail("Installed PorcuPi runtime is malformed");
    publishLauncher(launcher, installedCli);
    output.write(`\nRecovered installed zero-Patch Managed Pi ${active.receipt.piBase.tag}.\n`);
    output.write(`Command: ${launcher}\n`);
    output.write("Stock Pi and Pi user data were preserved.\n");
    return { installed: true, recovered: true, launcher, compositionId: active.receipt.compositionId };
  }
  let initialized = false;
  try {
    initializeFreshRoot(paths);
    initialized = true;
    const temporaryRoot = join(paths.temporary, `install-${randomUUID()}`);
    const stagedComposition = join(temporaryRoot, "composition");
    const payloadRoot = join(stagedComposition, "payload");
    mkdirSync(payloadRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(temporaryRoot, "owner.json"), `${JSON.stringify({ schemaVersion: 1, type: "porcupi-install-stage" })}\n`, { mode: 0o600 });

    prepareBase(payloadRoot, lock);
    executeBuildRecipe(payloadRoot, temporaryRoot, lock);
    removeOwnedTree(join(payloadRoot, ".git"));
    const receipt = createReceipt(payloadRoot, lock);
    writeFileSync(join(stagedComposition, compositionReceiptName), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444 });
    makeImmutable(stagedComposition);
    // macOS requires the directory being renamed to remain owner-writable.
    // Its descendants are already immutable; seal the root immediately after publication.
    chmodSync(stagedComposition, 0o700);
    const compositionRoot = join(paths.compositions, receipt.compositionId);
    renameSync(stagedComposition, compositionRoot);
    chmodSync(compositionRoot, 0o555);
    checkpoint("composition-published");
    atomicWrite(join(paths.receipts, `${receipt.compositionId}.json`), receipt);
    publishRuntime(paths, temporaryRoot);
    atomicWrite(paths.activation, {
      schemaVersion: 1,
      active: { compositionId: receipt.compositionId, patches: [] },
      previous: null,
    });
    checkpoint("activation-written");
    publishLauncher(launcher, join(paths.runtime, "cli.mjs"));
    removeOwnedTree(temporaryRoot);

    output.write(`\nInstalled zero-Patch Managed Pi ${lock.tag}.\n`);
    output.write(`Command: ${launcher}\n`);
    const pathDirectories = (environment.PATH || "").split(":");
    if (!pathDirectories.includes(binDirectory)) output.write(`Add ${binDirectory} to PATH.\n`);
    output.write("Stock Pi and Pi user data were preserved.\n");
    return { installed: true, launcher, compositionId: receipt.compositionId };
  } catch (error) {
    if (initialized) removeOwnedTree(paths.root);
    throw error;
  }
}
