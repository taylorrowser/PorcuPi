import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoots = [];

function makeWritable(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}

after(() => {
  for (const root of temporaryRoots) {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "porcupi-install-test-"));
  temporaryRoots.push(root);
  return root;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createPiBase(root, { version = "0.81.1", buildFails = false } = {}) {
  const source = join(root, "pi-base");
  mkdirSync(join(source, "packages", "coding-agent"), { recursive: true });
  mkdirSync(join(source, "packages", "ai"), { recursive: true });
  mkdirSync(join(source, "packages", "agent"), { recursive: true });
  mkdirSync(join(source, "packages", "tui"), { recursive: true });
  mkdirSync(join(source, "scripts"), { recursive: true });
  const packages = [
    ["ai", "@earendil-works/pi-ai"],
    ["agent", "@earendil-works/pi-agent-core"],
    ["tui", "@earendil-works/pi-tui"],
    ["coding-agent", "@earendil-works/pi-coding-agent"],
  ];
  for (const [directory, name] of packages) {
    writeFileSync(join(source, "packages", directory, "package.json"), `${JSON.stringify({ name, version, type: "module" }, null, 2)}\n`);
  }
  writeFileSync(
    join(source, "package.json"),
    `${JSON.stringify({
      name: "porcupi-pi-base-fixture",
      version,
      private: true,
      scripts: {
        "check:model-data": "node scripts/check-model-data.mjs",
        "build:offline": buildFails ? "node scripts/fail-build.mjs" : "node scripts/build.mjs",
      },
    }, null, 2)}\n`,
  );
  writeFileSync(join(source, "scripts", "check-model-data.mjs"), "console.log('fixture pinned model data is valid');\n");
  writeFileSync(join(source, "scripts", "fail-build.mjs"), "console.error('fixture build failed'); process.exit(23);\n");
  writeFileSync(
    join(source, "scripts", "build.mjs"),
    `import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const output = join(process.cwd(), "packages", "coding-agent", "dist");
mkdirSync(output, { recursive: true });
const cli = join(output, "cli.js");
writeFileSync(cli, \`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("${version}");
else if (args[0] === "--help") console.log("Pi fixture help");
else if (args[0] === "--list-models") console.log("fixture-model");
else if (process.env.PI_FIXTURE_LAUNCH_LOG) appendFileSync(process.env.PI_FIXTURE_LAUNCH_LOG, JSON.stringify(args) + "\\\\n");
\`);
chmodSync(cli, 0o755);
`,
  );
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: source, stdio: "ignore" });
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "PorcuPi Test");
  git(source, "config", "user.email", "porcupi@example.test");
  git(source, "add", ".");
  git(source, "commit", "-m", "Fixture Pi Base");
  git(source, "tag", "v0.81.1");
  git(source, "remote", "add", "origin", source);
  return { source, commit: git(source, "rev-parse", "HEAD") };
}

function createReleaseFixture(root, base, expectedVersion = "0.81.1") {
  const release = join(root, "porcupi-release");
  mkdirSync(release);
  for (const path of ["install.sh", "package.json", "scripts", "src"]) {
    cpSync(join(repositoryRoot, path), join(release, path), { recursive: true });
  }
  const modelData = join(release, "upstream", "model-data", "fixture");
  mkdirSync(modelData, { recursive: true });
  const modelFile = "fixture.json";
  const modelContents = "{}\n";
  const modelDigest = createHash("sha256").update(modelContents).digest("hex");
  const modelManifest = `${JSON.stringify({
    schemaVersion: 1,
    structureHash: "fixture-structure",
    files: { [modelFile]: modelDigest },
  }, null, 2)}\n`;
  writeFileSync(join(modelData, modelFile), modelContents);
  writeFileSync(join(modelData, ".manifest.json"), modelManifest);
  writeFileSync(join(release, "upstream", "pi-base.json"), `${JSON.stringify({
    schemaVersion: 1,
    repository: base.source,
    tag: "v0.81.1",
    commit: base.commit,
    modelData: {
      path: "model-data/fixture",
      package: "@earendil-works/pi-ai",
      version: expectedVersion,
      npmIntegrity: "fixture",
      manifestSha256: createHash("sha256").update(modelManifest).digest("hex"),
    },
    packages: [
      { path: "packages/ai/package.json", name: "@earendil-works/pi-ai", version: expectedVersion },
      { path: "packages/agent/package.json", name: "@earendil-works/pi-agent-core", version: expectedVersion },
      { path: "packages/tui/package.json", name: "@earendil-works/pi-tui", version: expectedVersion },
      { path: "packages/coding-agent/package.json", name: "@earendil-works/pi-coding-agent", version: expectedVersion },
    ],
  }, null, 2)}\n`);
  return release;
}

function runInstaller(release, home, inputHex = "0d", extraEnvironment = {}) {
  return spawnSync(
    "python3",
    [join(repositoryRoot, "test", "support", "pty-driver.py"), inputHex, join(release, "install.sh")],
    {
      cwd: release,
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), NODE_ENV: "test", ...extraEnvironment },
    },
  );
}

test("guided installation can be cancelled without creating PorcuPi state", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);

  const install = runInstaller(release, home, "1b");

  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /Installation cancelled\. No changes were made\./);
  assert.match(install.stdout, /\x1b\[\?25h/);
  assert.equal(existsSync(join(home, ".local", "bin", "porcupi")), false);
  assert.equal(existsSync(join(home, "Library", "Application Support", "porcupi")), false);
});

test("installation rejects changed pinned model data before the offline build", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  writeFileSync(join(release, "upstream", "model-data", "fixture", "fixture.json"), "{\"changed\":true}\n");

  const install = runInstaller(release, home);

  assert.notEqual(install.status, 0);
  assert.match(install.stdout, /Pinned model data digest mismatch/);
  assert.doesNotMatch(install.stdout, /npm run check:model-data|npm run build:offline/);
  assert.equal(existsSync(join(home, ".local", "bin", "porcupi")), false);
  assert.equal(existsSync(join(home, "Library", "Application Support", "porcupi")), false);
});

test("failed zero-Patch build leaves no active composition or launcher", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root, { buildFails: true });
  const release = createReleaseFixture(root, base);

  const install = runInstaller(release, home);

  assert.notEqual(install.status, 0);
  assert.match(install.stdout, /fixture build failed/);
  assert.equal(existsSync(join(home, ".local", "bin", "porcupi")), false);
  assert.equal(existsSync(join(home, "Library", "Application Support", "porcupi")), false);
});

test("installation rejects a mismatched exact Pi Base before dependency installation", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root, { version: "0.81.2" });
  const release = createReleaseFixture(root, base, "0.81.1");

  const install = runInstaller(release, home);

  assert.notEqual(install.status, 0);
  assert.match(install.stdout, /expected 0\.81\.1, found 0\.81\.2/);
  assert.doesNotMatch(install.stdout, /npm ci/);
  assert.equal(existsSync(join(home, ".local", "bin", "porcupi")), false);
  assert.equal(existsSync(join(home, "Library", "Application Support", "porcupi")), false);
});

test("guided installation refuses a foreign porcupi command without changing it", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const bin = join(home, ".local", "bin");
  const launcher = join(bin, "porcupi");
  mkdirSync(bin, { recursive: true });
  writeFileSync(launcher, "foreign command\n");
  const before = readFileSync(launcher);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);

  const install = runInstaller(release, home);

  assert.notEqual(install.status, 0);
  assert.match(install.stdout, /Refusing foreign porcupi command collision/);
  assert.deepEqual(readFileSync(launcher), before);
  assert.equal(existsSync(join(home, "Library", "Application Support", "porcupi")), false);
});

test("installation retry discards an unactivated published composition after interruption", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);

  const interrupted = runInstaller(release, home, "0d", { PORCUPI_TEST_FAULT: "composition-published" });
  assert.equal(interrupted.signal, "SIGKILL");
  const dataRoot = join(home, "Library", "Application Support", "porcupi");
  assert.equal(existsSync(join(dataRoot, "state", "activation.json")), false);
  assert.equal(existsSync(join(home, ".local", "bin", "porcupi")), false);

  const retry = runInstaller(release, home);

  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.match(retry.stdout, /Installed zero-Patch Managed Pi/);
  assert.equal(existsSync(join(dataRoot, "state", "activation.json")), true);
  assert.equal(existsSync(join(home, ".local", "bin", "porcupi")), true);
});

test("installation retry accepts its unchanged stable command after launcher publication", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);

  const interrupted = runInstaller(release, home, "0d", { PORCUPI_TEST_FAULT: "launcher-published" });
  assert.equal(interrupted.signal, "SIGKILL");
  const launcher = join(home, ".local", "bin", "porcupi");
  const launcherBefore = readFileSync(launcher);

  const retry = runInstaller(release, home);

  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.match(retry.stdout, /Recovered installed zero-Patch Managed Pi/);
  assert.deepEqual(readFileSync(launcher), launcherBefore);
});

test("installation retry publishes the stable command after interruption following activation", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);

  const interrupted = runInstaller(release, home, "0d", { PORCUPI_TEST_FAULT: "activation-written" });
  assert.equal(interrupted.signal, "SIGKILL");
  const dataRoot = join(home, "Library", "Application Support", "porcupi");
  assert.equal(existsSync(join(dataRoot, "state", "activation.json")), true);
  assert.equal(existsSync(join(home, ".local", "bin", "porcupi")), false);

  const retry = runInstaller(release, home);

  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.match(retry.stdout, /Recovered installed zero-Patch Managed Pi/);
  const launcher = join(home, ".local", "bin", "porcupi");
  assert.equal(existsSync(launcher), true);
  const launch = spawnSync(launcher, ["--version"], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(launch.stdout.trim(), "0.81.1");
});

test("guided install builds, activates, and launches a zero-Patch Managed Pi without changing Stock Pi", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const stockBin = join(root, "stock-bin");
  const stockPi = join(stockBin, "pi");
  mkdirSync(home);
  mkdirSync(stockBin);
  writeFileSync(stockPi, "#!/bin/sh\necho stock-pi\n");
  chmodSync(stockPi, 0o755);
  const stockBefore = readFileSync(stockPi);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);

  const install = runInstaller(release, home);

  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /Install PorcuPi/);
  assert.match(install.stdout, new RegExp(base.commit));
  assert.match(install.stdout, /Stock Pi.*preserved/);
  assert.match(install.stdout, /Installed zero-Patch Managed Pi/);
  assert.match(install.stdout, /npm ci --ignore-scripts[\s\S]*hydrate pinned model data[\s\S]*npm run check:model-data[\s\S]*npm run build:offline[\s\S]*--help[\s\S]*--version[\s\S]*--list-models/);
  assert.match(install.stdout, /\x1b\[\?25l/);
  assert.match(install.stdout, /\x1b\[\?25h/);
  assert.deepEqual(readFileSync(stockPi), stockBefore);

  const launcher = join(home, ".local", "bin", "porcupi");
  const dataRoot = join(home, "Library", "Application Support", "porcupi");
  const activation = JSON.parse(readFileSync(join(dataRoot, "state", "activation.json"), "utf8"));
  assert.equal(activation.schemaVersion, 1);
  assert.equal(activation.previous, null);
  assert.deepEqual(activation.active.patches, []);
  const centralReceipt = readFileSync(join(dataRoot, "receipts", `${activation.active.compositionId}.json`), "utf8");
  const embeddedReceipt = readFileSync(join(dataRoot, "compositions", activation.active.compositionId, "receipt.json"), "utf8");
  assert.equal(centralReceipt, embeddedReceipt);
  assert.equal(existsSync(launcher), true);
  assert.equal(existsSync(join(home, ".local", "bin", "pi")), false);

  const launchLog = join(root, "launch.log");
  const launch = spawnSync(launcher, ["--model", "fixture-model", "hello"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PI_FIXTURE_LAUNCH_LOG: launchLog },
  });
  assert.equal(launch.status, 0, launch.stderr);
  assert.deepEqual(JSON.parse(readFileSync(launchLog, "utf8").trim()), ["--model", "fixture-model", "hello"]);
});
