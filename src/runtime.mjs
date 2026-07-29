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
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const compositionReceiptName = "receipt.json";
export const managedExecutablePath = "packages/coding-agent/dist/cli.js";

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
    state: join(root, "state"),
    activation: join(root, "state", "activation.json"),
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
  return entries;
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

export function validateRequiredExecutable(payloadRoot, expected) {
  const executable = join(payloadRoot, expected.path);
  const realPayload = realpathSync(payloadRoot);
  const realExecutable = realpathSync(executable);
  if (!realExecutable.startsWith(`${realPayload}${sep}`)) fail("Managed Pi executable escapes its Composition");
  const stat = lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Managed Pi executable is not a regular file");
  if (stat.size !== expected.size || (stat.mode & 0o777) !== expected.mode || sha256File(executable) !== expected.sha256) {
    fail("Managed Pi executable does not match its Composition receipt");
  }
  return executable;
}

export function readActiveComposition(dataRoot = defaultDataRoot()) {
  const paths = managedLayout(dataRoot);
  const activation = readJson(paths.activation, "PorcuPi activation");
  if (activation.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(activation.active?.compositionId || "")) {
    fail("Malformed PorcuPi activation");
  }
  const compositionRoot = join(paths.compositions, activation.active.compositionId);
  const central = readJson(join(paths.receipts, `${activation.active.compositionId}.json`), "central Composition receipt");
  const embedded = readJson(join(compositionRoot, compositionReceiptName), "embedded Composition receipt");
  if (canonicalJson(central) !== canonicalJson(embedded) || central.compositionId !== activation.active.compositionId) {
    fail("Managed Pi Composition receipt mismatch");
  }
  if (central.platform !== platformIdentity()) fail(`Managed Pi Composition platform mismatch: ${central.platform}`);
  const payloadRoot = join(compositionRoot, "payload");
  const executable = validateRequiredExecutable(payloadRoot, central.requiredExecutable);
  return { activation, receipt: central, executable };
}
