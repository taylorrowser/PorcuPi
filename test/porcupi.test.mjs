import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoots = [];
const childProcesses = [];

function makeWritable(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}

after(() => {
  for (const child of childProcesses) child.kill("SIGTERM");
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("${version}");
else if (args[0] === "--help") console.log("Pi fixture help");
else if (args[0] === "--list-models") console.log("fixture-model");
else if (args[0] === "install" || args[0] === "remove") {
  const source = args[1];
  if (process.env.PI_FIXTURE_PACKAGE_LOG) appendFileSync(process.env.PI_FIXTURE_PACKAGE_LOG, JSON.stringify(args) + "\\\\n");
  if (args[0] === "install" && (process.env.PI_FIXTURE_PACKAGE_FAIL || source.includes(process.env.PI_FIXTURE_PACKAGE_FAIL_SOURCE || "\0"))) {
    console.error("fixture Pi package install failed");
    process.exitCode = 31;
  } else {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent");
    const settingsPath = join(agentDir, "settings.json");
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
    const identity = (value) => (typeof value === "string" ? value : value.source).replace(/@[a-f0-9]{40}$/, "");
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    const index = packages.findIndex((value) => identity(value) === identity(source));
    if (args[0] === "remove") {
      if (index >= 0) packages.splice(index, 1);
    } else if (index < 0) packages.push(source);
    else if (typeof packages[index] === "string") packages[index] = source;
    else packages[index] = { ...packages[index], source };
    settings.packages = packages;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\\\\n");
    console.log((args[0] === "remove" ? "Removed " : "Installed ") + source);
  }
} else if (process.env.PI_FIXTURE_LAUNCH_LOG) appendFileSync(process.env.PI_FIXTURE_LAUNCH_LOG, JSON.stringify(args) + "\\\\n");
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

function dataRoot(home) {
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "porcupi")
    : join(home, ".local", "share", "porcupi");
}

function runPorcuPi(home, args, inputHex, extraEnvironment = {}) {
  return spawnSync(
    "python3",
    [join(repositoryRoot, "test", "support", "pty-driver.py"), inputHex, join(home, ".local", "bin", "porcupi"), ...args],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: join(home, ".local", "share"),
        NODE_ENV: "test",
        PTY_WAIT_FOR: "1 of 3",
        ...extraEnvironment,
      },
    },
  );
}

const themeColors = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText",
  "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading",
  "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr",
  "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];

function createResourceRepository(root) {
  const source = join(root, "resource-source");
  mkdirSync(join(source, "extensions"), { recursive: true });
  mkdirSync(join(source, "skills", "fixture-skill"), { recursive: true });
  mkdirSync(join(source, "prompts"), { recursive: true });
  mkdirSync(join(source, "themes"), { recursive: true });
  mkdirSync(join(source, "unrelated"), { recursive: true });
  writeFileSync(join(source, "extensions", "fixture.ts"), "export default function fixture() {}\n");
  writeFileSync(join(source, "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture skill.\n---\n\n# Fixture\n");
  writeFileSync(join(source, "prompts", "fixture.md"), "---\ndescription: Fixture prompt\n---\nFixture prompt.\n");
  writeFileSync(join(source, "prompts", "ignored.md"), "Ignored by Pi package discovery.\n");
  writeFileSync(join(source, ".ignore"), "prompts/ignored.md\n");
  writeFileSync(join(source, "themes", "fixture.json"), `${JSON.stringify({
    name: "fixture-theme",
    colors: Object.fromEntries(themeColors.map((name) => [name, ""])),
  }, null, 2)}\n`);
  writeFileSync(join(source, "unrelated", "not-an-extension.ts"), "throw new Error('must not be discovered');\n");
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "PorcuPi Test");
  git(source, "config", "user.email", "porcupi@example.test");
  git(source, "add", ".");
  git(source, "commit", "-m", "Resource fixture");
  return { source, commit: git(source, "rev-parse", "HEAD") };
}

function createManifestResourceRepository(root) {
  const source = join(root, "manifest-resource-source");
  mkdirSync(join(source, "bundle", "good"), { recursive: true });
  mkdirSync(join(source, "bundle", "bad"), { recursive: true });
  mkdirSync(join(source, "extensions"), { recursive: true });
  writeFileSync(join(source, "bundle", "extension.js"), "export default function fixture() {}\n");
  writeFileSync(join(source, "bundle", "excluded.js"), "export default function excluded() {}\n");
  writeFileSync(join(source, "bundle", "good", "SKILL.md"), "---\nname: good-skill\ndescription: Good fixture skill.\n---\nGood.\n");
  writeFileSync(join(source, "bundle", "bad", "SKILL.md"), "---\nname: bad-skill\n---\nMissing description.\n");
  writeFileSync(join(source, "bundle", "prompt.md"), "Manifest prompt.\n");
  writeFileSync(join(source, "bundle", "theme.json"), `${JSON.stringify({
    name: "manifest-theme",
    colors: Object.fromEntries(themeColors.map((name) => [name, ""])),
  })}\n`);
  writeFileSync(join(source, "bundle", "bad-theme.json"), "{}\n");
  writeFileSync(join(source, "extensions", "must-not-be-scanned.ts"), "throw new Error('manifest excludes this');\n");
  writeFileSync(join(source, "package.json"), `${JSON.stringify({
    name: "manifest-fixture",
    pi: {
      extensions: ["bundle/*.js", "!bundle/excluded.js"],
      skills: ["bundle/good/SKILL.md", "bundle/bad/SKILL.md"],
      prompts: ["bundle/prompt.md"],
      themes: ["bundle/theme.json", "bundle/bad-theme.json"],
    },
  }, null, 2)}\n`);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "PorcuPi Test");
  git(source, "config", "user.email", "porcupi@example.test");
  git(source, "add", ".");
  git(source, "commit", "-m", "Manifest resource fixture");
  return { source, commit: git(source, "rev-parse", "HEAD") };
}

async function serveGitRepository(root, repository) {
  const daemonRoot = join(root, "git-daemon");
  mkdirSync(daemonRoot);
  mkdirSync(join(daemonRoot, "owner"));
  execFileSync("git", ["clone", "--bare", repository.source, join(daemonRoot, "owner", "resources.git")], { stdio: "ignore" });
  const port = Number(execFileSync("python3", ["-c", "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"], { encoding: "utf8" }).trim());
  const child = spawn("git", ["daemon", "--export-all", "--reuseaddr", "--listen=127.0.0.1", `--port=${port}`, `--base-path=${daemonRoot}`, daemonRoot], { stdio: "ignore" });
  childProcesses.push(child);
  const locator = `git://127.0.0.1:${port}/owner/resources.git`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (spawnSync("git", ["ls-remote", locator], { stdio: "ignore" }).status === 0) return locator;
    await delay(20);
  }
  throw new Error("Git fixture daemon did not start");
}

async function serveHttpRepository(root, repository) {
  const serverRoot = join(root, "git-http");
  const bare = join(serverRoot, "Owner", "CaseRepo.git");
  mkdirSync(dirname(bare), { recursive: true });
  execFileSync("git", ["clone", "--bare", repository.source, bare], { stdio: "ignore" });
  execFileSync("git", ["--git-dir", bare, "update-server-info"]);
  const port = Number(execFileSync("python3", ["-c", "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"], { encoding: "utf8" }).trim());
  const child = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", serverRoot], { stdio: "ignore" });
  childProcesses.push(child);
  const locator = `http://127.0.0.1:${port}/Owner/CaseRepo.git`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (spawnSync("git", ["ls-remote", locator], { stdio: "ignore" }).status === 0) return locator;
    await delay(20);
  }
  throw new Error("Git HTTP fixture did not start");
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

test("porcupi add pins and filters all four Pi resource kinds through Pi", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  const install = runInstaller(release, home);
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const activationBefore = readFileSync(activationPath);
  const repository = createResourceRepository(root);
  const locator = await serveGitRepository(root, repository);
  const packageLog = join(root, "package.log");

  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d", { PI_FIXTURE_PACKAGE_LOG: packageLog });

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /1 of 3 — Select Artifacts/);
  assert.match(add.stdout, /2 of 3 — Choose Installation Scope/);
  assert.match(add.stdout, /3 of 3 — Review and save/);
  assert.match(add.stdout, new RegExp(repository.commit));
  assert.match(add.stdout, /does not authenticate its publisher|does not prove publisher identity/);
  assert.match(add.stdout, /Neither Pi nor PorcuPi is a sandbox/);
  assert.match(add.stdout, /Saved 4 global Pi resource selections/);
  assert.match(add.stdout, /\x1b\[\?25l/);
  assert.match(add.stdout, /\x1b\[\?25h/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  const canonicalLocator = `127.0.0.1:${new URL(locator).port}/owner/resources`;
  const packageSource = `git:${locator}@${repository.commit}`;
  const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [{
    source: packageSource,
    extensions: ["extensions/fixture.ts"],
    skills: ["skills/fixture-skill/SKILL.md"],
    prompts: ["prompts/fixture.md"],
    themes: ["themes/fixture.json"],
  }]);
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.equal(selections.schemaVersion, 1);
  assert.deepEqual(selections.sources, [{
    locator: canonicalLocator,
    commit: repository.commit,
    packageSource,
    artifacts: [
      { kind: "Extension", path: "extensions/fixture.ts", scope: "global" },
      { kind: "Prompt", path: "prompts/fixture.md", scope: "global" },
      { kind: "Skill", path: "skills/fixture-skill/SKILL.md", scope: "global" },
      { kind: "Theme", path: "themes/fixture.json", scope: "global" },
    ],
  }]);
  assert.deepEqual(JSON.parse(readFileSync(packageLog, "utf8").trim()), ["install", packageSource]);
});

test("porcupi add prompts and persists a credential-free case-preserving exact source identity", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const locator = await serveHttpRepository(root, repository);
  const requested = locator.replace("http://", "http://Token:Secret@") + "/@main#discarded-fragment";

  const parsedLocator = new URL(locator);
  const add = runPorcuPi(home, ["add"], "206e6e0d", {
    PTY_INITIAL_INPUT_HEX: Buffer.from(`${requested}\n`).toString("hex"),
    PTY_INITIAL_WAIT_FOR: "Git source:",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.http://127.0.0.1:${parsedLocator.port}/.insteadOf`,
    GIT_CONFIG_VALUE_0: `http://Token:Secret@127.0.0.1:${parsedLocator.port}/`,
  });

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /Git source:/);
  const canonicalLocator = `127.0.0.1:${parsedLocator.port}/Owner/CaseRepo`;
  assert.match(add.stdout, new RegExp(canonicalLocator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const selectionsText = readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8");
  const settingsText = readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8");
  assert.doesNotMatch(selectionsText, /Token|Secret|fragment/);
  assert.doesNotMatch(settingsText, /Token|Secret|fragment/);
  const selections = JSON.parse(selectionsText);
  assert.equal(selections.sources[0].locator, canonicalLocator);
  assert.equal(selections.sources[0].commit, repository.commit);
  assert.equal(selections.sources[0].artifacts.length, 1);
  assert.match(selections.sources[0].packageSource, new RegExp(`^git:http://127\\.0\\.0\\.1:${parsedLocator.port}/Owner/CaseRepo\\.git@[a-f0-9]{40}$`));
});

test("porcupi add follows the Pi package manifest and rejects unloadable candidates", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createManifestResourceRepository(root);
  const locator = await serveGitRepository(root, repository);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /Rejected bundle\/bad\/SKILL\.md: Skill has no loadable description/);
  assert.match(add.stdout, /Rejected bundle\/bad-theme\.json: Theme does not satisfy/);
  assert.doesNotMatch(add.stdout, /must-not-be-scanned/);
  const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(settings.packages[0].extensions, ["bundle/extension.js"]);
  assert.deepEqual(settings.packages[0].skills, ["bundle/good/SKILL.md"]);
  assert.deepEqual(settings.packages[0].prompts, ["bundle/prompt.md"]);
  assert.deepEqual(settings.packages[0].themes, ["bundle/theme.json"]);
});

test("Artifact selection distinguishes resource kind when structural paths are equal", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const source = join(root, "same-path-source");
  mkdirSync(source);
  writeFileSync(join(source, "shared.md"), "---\ndescription: Shared resource.\n---\nShared.\n");
  writeFileSync(join(source, "package.json"), `${JSON.stringify({
    name: "same-path-fixture",
    pi: { skills: ["shared.md"], prompts: ["shared.md"] },
  }, null, 2)}\n`);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "PorcuPi Test");
  git(source, "config", "user.email", "porcupi@example.test");
  git(source, "add", ".");
  git(source, "commit", "-m", "Same path fixture");
  const repository = { source, commit: git(source, "rev-parse", "HEAD") };
  const locator = await serveGitRepository(root, repository);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "206e6e0d");

  assert.equal(add.status, 0, add.stderr || add.stdout);
  const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(settings.packages[0].prompts, ["shared.md"]);
  assert.deepEqual(settings.packages[0].skills, []);
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.deepEqual(selections.sources[0].artifacts, [{ kind: "Prompt", path: "shared.md", scope: "global" }]);
});

test("cancelling porcupi add preserves Pi settings, Selection Intent, activation, and cursor state", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const locator = await serveGitRepository(root, repository);
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, "{\n  \"packages\": [\"npm:foreign-package\"],\n  \"theme\": \"dark\"\n}\n");
  const settingsBefore = readFileSync(settingsPath);
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const activationBefore = readFileSync(activationPath);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "1b");

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /Selection cancelled/);
  assert.match(add.stdout, /\x1b\[\?25h/);
  assert.deepEqual(readFileSync(settingsPath), settingsBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  assert.equal(existsSync(join(dataRoot(home), "state", "selections.json")), false);

  const interrupted = runPorcuPi(home, ["add", `${locator}@main`], "03");
  assert.equal(interrupted.status, 0, interrupted.stderr || interrupted.stdout);
  assert.match(interrupted.stdout, /Selection cancelled/);
  assert.match(interrupted.stdout, /\x1b\[\?25h/);
  assert.deepEqual(readFileSync(settingsPath), settingsBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("a Pi package failure saves no Selection Intent and never rebuilds or activates Managed Pi", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const locator = await serveGitRepository(root, repository);
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const activationBefore = readFileSync(activationPath);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d", { PI_FIXTURE_PACKAGE_FAIL: "1" });

  assert.notEqual(add.status, 0);
  assert.match(add.stdout, /fixture Pi package install failed/);
  assert.match(add.stdout, /Pi package lifecycle failed with status 31/);
  assert.match(add.stdout, /\x1b\[\?25h/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  assert.equal(existsSync(join(dataRoot(home), "state", "selections.json")), false);
  assert.equal(existsSync(join(home, ".pi", "agent", "settings.json")), false);
});

test("missing and ambiguous Git refs fail without mutation", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  git(repository.source, "branch", "collision");
  git(repository.source, "tag", "collision");
  const locator = await serveGitRepository(root, repository);
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const activationBefore = readFileSync(activationPath);

  const missing = runPorcuPi(home, ["add", `${locator}@does-not-exist`], "");
  const ambiguous = runPorcuPi(home, ["add", `${locator}@collision`], "");

  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /does-not-exist.*does not exist/);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stdout, /collision.*ambiguous between a branch and tag/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  assert.equal(existsSync(join(dataRoot(home), "state", "selections.json")), false);
  assert.equal(existsSync(join(home, ".pi", "agent", "settings.json")), false);
});

test("re-adding a Source Repository reviews and replaces its commit and complete selection", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const oldCommit = repository.commit;
  git(repository.source, "tag", "old-selection");
  writeFileSync(join(repository.source, "prompts", "second.md"), "Second revision prompt.\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Advance resource source");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const packageLog = join(root, "package.log");
  const environment = { PI_FIXTURE_PACKAGE_LOG: packageLog };

  const first = runPorcuPi(home, ["add", `${locator}@old-selection`], "616e6e0d", environment);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const settingsBeforeFailure = readFileSync(settingsPath);
  const selectionsBeforeFailure = readFileSync(selectionsPath);
  const activationBeforeFailure = readFileSync(activationPath);

  const failedUpdate = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d", {
    ...environment,
    PI_FIXTURE_PACKAGE_FAIL_SOURCE: repository.commit,
  });
  assert.notEqual(failedUpdate.status, 0);
  assert.deepEqual(readFileSync(settingsPath), settingsBeforeFailure);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBeforeFailure);
  assert.deepEqual(readFileSync(activationPath), activationBeforeFailure);

  const second = runPorcuPi(home, ["add", `${locator}@main`], "64206e6e0d", environment);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.match(second.stdout, new RegExp(`Source-wide change: ${oldCommit} → ${repository.commit}`));
  const selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  assert.equal(selections.sources.length, 1);
  assert.equal(selections.sources[0].commit, repository.commit);
  assert.deepEqual(selections.sources[0].artifacts, [{ kind: "Extension", path: "extensions/fixture.ts", scope: "global" }]);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.packages.length, 1);
  assert.match(settings.packages[0].source, new RegExp(`@${repository.commit}$`));
  assert.deepEqual(settings.packages[0].extensions, ["extensions/fixture.ts"]);
  assert.deepEqual(settings.packages[0].skills, []);
  assert.deepEqual(settings.packages[0].prompts, []);
  assert.deepEqual(settings.packages[0].themes, []);

  const removal = runPorcuPi(home, ["add", `${locator}@main`], "646e6e0d", environment);
  assert.equal(removal.status, 0, removal.stderr || removal.stdout);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).packages, []);
  assert.deepEqual(JSON.parse(readFileSync(selectionsPath, "utf8")).sources, []);

  const lifecycleCalls = readFileSync(packageLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lifecycleCalls.length, 5);
  assert.match(lifecycleCalls[0][1], new RegExp(`@${oldCommit}$`));
  assert.match(lifecycleCalls[1][1], new RegExp(`@${repository.commit}$`));
  assert.match(lifecycleCalls[2][1], new RegExp(`@${oldCommit}$`));
  assert.match(lifecycleCalls[3][1], new RegExp(`@${repository.commit}$`));
  assert.deepEqual(lifecycleCalls[4], ["remove", settings.packages[0].source]);
});
