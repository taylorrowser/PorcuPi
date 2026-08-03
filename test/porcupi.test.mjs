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
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const porcupiVersion = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;
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
  mkdirSync(join(source, "packages", "ai", "src", "providers"), { recursive: true });
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
  writeFileSync(join(source, "series.txt"), "base\n");
  writeFileSync(join(source, "packages", "ai", "src", "models.generated.ts"), 'import { FIXTURE_MODELS } from "./providers/fixture.models.ts";\n');
  writeFileSync(join(source, "packages", "ai", "src", "providers", "fixture.models.ts"), [
    'import values from "./data/fixture.json" with { type: "json" };',
    "export const FIXTURE_MODELS = values as {",
    '\t"fixture-model": Model<"fixture-api"> & {',
    '\t\tid: "fixture-model";',
    '\t\tprovider: "fixture";',
    "\t};",
    "};",
    "",
  ].join("\n"));
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
if (process.env.PI_FIXTURE_CHECK_FAIL === args[0]) process.exitCode = 44;
else if (args[0] === "--version") console.log(process.env.PI_FIXTURE_VERSION_OVERRIDE || "${version}");
else if (args[0] === "--help") console.log("Pi fixture help");
else if (args[0] === "--list-models") {
  if (process.env.PI_FIXTURE_SMOKE_HOME_LOG) appendFileSync(process.env.PI_FIXTURE_SMOKE_HOME_LOG, process.env.HOME + "\\\\n");
  console.log("fixture-model");
}
else if (args[0] === "install" || args[0] === "remove") {
  const source = args[1];
  const local = args.includes("-l") || args.includes("--local");
  const scope = local ? "project" : "global";
  if (process.env.PI_FIXTURE_PACKAGE_LOG) appendFileSync(process.env.PI_FIXTURE_PACKAGE_LOG, JSON.stringify(args) + "\\\\n");
  if (local && process.env.PI_FIXTURE_PROJECT_TRUST_LOG) appendFileSync(process.env.PI_FIXTURE_PROJECT_TRUST_LOG, "Pi decided project trust\\\\n");
  if (local && process.env.PI_FIXTURE_PROJECT_TRUST === "deny") {
    console.error("Project is not trusted");
    process.exitCode = 32;
  } else if (args[0] === "install" && (process.env.PI_FIXTURE_PACKAGE_FAIL || scope === process.env.PI_FIXTURE_PACKAGE_FAIL_SCOPE || source.includes(process.env.PI_FIXTURE_PACKAGE_FAIL_SOURCE || "\0"))) {
    console.error("fixture Pi package install failed");
    process.exitCode = 31;
  } else {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent");
    const settingsPath = local ? join(process.cwd(), ".pi", "settings.json") : join(agentDir, "settings.json");
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
    const identity = (value) => (typeof value === "string" ? value : value.source).replace(/@(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "");
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
} else {
  if (process.env.PI_FIXTURE_LAUNCH_LOG) appendFileSync(process.env.PI_FIXTURE_LAUNCH_LOG, JSON.stringify(args) + "\\\\n");
  if (process.env.PI_FIXTURE_HOLD_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.PI_FIXTURE_HOLD_MS)));
}
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

function createReleaseFixture(root, base, expectedVersion = "0.81.1", { historicalRef } = {}) {
  const release = join(root, historicalRef ? `porcupi-release-${historicalRef}` : "porcupi-release");
  if (historicalRef) {
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", repositoryRoot, release]);
    execFileSync("git", ["checkout", "--quiet", "--detach", `${historicalRef}^{commit}`], { cwd: release });
    rmSync(join(release, ".git"), { recursive: true, force: true });
  } else {
    mkdirSync(release);
    for (const path of ["LICENSE", "README.md", "install.sh", "package-lock.json", "package.json", "release", "scripts", "src"]) {
      cpSync(join(repositoryRoot, path), join(release, path), { recursive: true });
    }
  }
  const modelData = join(release, "upstream", "model-data", "fixture");
  mkdirSync(modelData, { recursive: true });
  const modelFile = "fixture.json";
  const modelContents = `${JSON.stringify({
    "fixture-model": {
      id: "fixture-model",
      name: "Fixture Model",
      api: "fixture-api",
      provider: "fixture",
      baseUrl: "https://fixture.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    },
    "snapshot-extra": {
      id: "snapshot-extra",
      name: "Snapshot Extra",
      api: "fixture-api",
      provider: "fixture",
      baseUrl: "https://fixture.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    },
  })}\n`;
  const modelDigest = createHash("sha256").update(modelContents).digest("hex");
  const modelManifest = `${JSON.stringify({
    schemaVersion: 1,
    structureHash: "fixture-structure",
    files: { [modelFile]: modelDigest },
  }, null, 2)}\n`;
  writeFileSync(join(modelData, modelFile), modelContents);
  writeFileSync(join(modelData, ".manifest.json"), modelManifest);
  const piBase = {
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
  };
  writeFileSync(join(release, "upstream", "pi-base.json"), `${JSON.stringify(piBase, null, 2)}\n`);

  if (!historicalRef) {
    const packageManifestPath = join(release, "package.json");
    const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
    const releaseRecordPath = join(release, "release", `v${packageManifest.version}.json`);
    const releaseRecord = JSON.parse(readFileSync(releaseRecordPath, "utf8"));
    releaseRecord.piBase = { repository: piBase.repository, tag: piBase.tag, commit: piBase.commit };
    const packedInputs = [
      `release/v${packageManifest.version}.json`,
      "scripts/install.mjs",
    ];
    for (const directory of ["src", "upstream"]) {
      const visit = (path) => {
        for (const name of readdirSync(path).sort()) {
          const child = join(path, name);
          if (lstatSync(child).isDirectory()) visit(child);
          else packedInputs.push(child.slice(release.length + 1));
        }
      };
      visit(join(release, directory));
    }
    packageManifest.files = packedInputs;
    writeFileSync(packageManifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`);
    const packageInputHash = createHash("sha256");
    const packageInputPaths = ["package.json", ...packedInputs.filter((path) => !path.startsWith("release/"))].sort();
    for (const path of packageInputPaths) {
      packageInputHash.update(`${JSON.stringify(path)}\0`);
      packageInputHash.update(readFileSync(join(release, path)));
      packageInputHash.update("\0");
    }
    releaseRecord.packageInputsSha256 = packageInputHash.digest("hex");
    writeFileSync(releaseRecordPath, `${JSON.stringify(releaseRecord, null, 2)}\n`);
  }
  return release;
}

function setReleaseFixtureVersion(release, version) {
  const manifestPath = join(release, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const previousReleaseRecord = `release/v${manifest.version}.json`;
  const releaseRecordPath = `release/v${version}.json`;
  manifest.version = version;
  manifest.files = manifest.files.map((path) => path === previousReleaseRecord ? releaseRecordPath : path);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const packageLockPath = join(release, "package-lock.json");
  const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
  packageLock.version = version;
  packageLock.packages[""].version = version;
  writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

  const releaseRecord = JSON.parse(readFileSync(join(release, previousReleaseRecord), "utf8"));
  renameSync(join(release, previousReleaseRecord), join(release, releaseRecordPath));
  releaseRecord.porcupiVersion = version;
  releaseRecord.tag = `v${version}`;
  const packageInputHash = createHash("sha256");
  const packageInputPaths = ["package.json", ...manifest.files.filter((path) => !path.startsWith("release/"))].sort();
  for (const path of packageInputPaths) {
    packageInputHash.update(`${JSON.stringify(path)}\0`);
    packageInputHash.update(readFileSync(join(release, path)));
    packageInputHash.update("\0");
  }
  releaseRecord.packageInputsSha256 = packageInputHash.digest("hex");
  writeFileSync(join(release, releaseRecordPath), `${JSON.stringify(releaseRecord, null, 2)}\n`);
}

function packRelease(release, root) {
  const destination = join(root, "packed");
  mkdirSync(destination);
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: release,
    encoding: "utf8",
  });
  const [{ filename }] = JSON.parse(output);
  return join(destination, filename);
}

function runInstaller(release, home, inputHex = "0d", extraEnvironment = {}) {
  const guidedInput = inputHex === "0d" ? "0d0d0d" : inputHex;
  return spawnSync(
    "python3",
    [join(repositoryRoot, "test", "support", "pty-driver.py"), guidedInput, join(release, "install.sh")],
    {
      cwd: release,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: join(home, ".local", "share"),
        NODE_ENV: "test",
        PTY_WAIT_FOR: "1 of 3 — Installation",
        ...extraEnvironment,
      },
    },
  );
}

function runPackedInstaller(artifact, home, inputHex = "0d", extraEnvironment = {}) {
  const guidedInput = inputHex === "0d" ? "0d0d0d" : inputHex;
  return spawnSync(
    "python3",
    [
      join(repositoryRoot, "test", "support", "pty-driver.py"),
      guidedInput,
      "npm",
      "exec",
      "--yes",
      "--offline",
      "--package",
      artifact,
      "--",
      "porcupi",
    ],
    {
      cwd: dirname(artifact),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: join(home, ".local", "share"),
        NODE_ENV: "test",
        PTY_WAIT_FOR: "1 of 3 — Installation",
        ...extraEnvironment,
      },
    },
  );
}

function dataRoot(home) {
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "porcupi")
    : join(home, ".local", "share", "porcupi");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function treeDigest(root) {
  const entries = [];
  function visit(path, relativePath) {
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push([relativePath, "directory", stat.mode & 0o777]);
      for (const name of readdirSync(path).sort()) visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
    } else if (stat.isSymbolicLink()) entries.push([relativePath, "symlink", readlinkSync(path)]);
    else entries.push([relativePath, "file", stat.mode & 0o777, createHash("sha256").update(readFileSync(path)).digest("hex")]);
  }
  visit(root, "");
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function createSharedSentinels(root, home, { stockAtTarget = false } = {}) {
  const piRoot = join(home, ".pi");
  mkdirSync(join(piRoot, "agent", "sessions"), { recursive: true });
  writeFileSync(join(piRoot, "agent", "settings.json"), "{\"packages\":[\"shared-sentinel\"]}\n");
  writeFileSync(join(piRoot, "agent", "credentials.json"), "shared-credential\n");
  writeFileSync(join(piRoot, "agent", "sessions", "session"), "shared-session\n");
  const stockPi = stockAtTarget ? join(home, ".local", "bin", "pi") : join(root, "shared-stock", "bin", "pi");
  mkdirSync(dirname(stockPi), { recursive: true });
  writeFileSync(stockPi, "#!/bin/sh\necho shared-stock\n");
  chmodSync(stockPi, 0o755);
  const expected = { piRoot, piDigest: treeDigest(piRoot), stockPi, stockBytes: readFileSync(stockPi) };
  expected.assertUnchanged = () => {
    assert.equal(treeDigest(expected.piRoot), expected.piDigest);
    assert.deepEqual(readFileSync(expected.stockPi), expected.stockBytes);
  };
  return expected;
}

function rebindActiveReceipt(home, mutate) {
  const root = dataRoot(home);
  const activationPath = join(root, "state", "activation.json");
  const activation = JSON.parse(readFileSync(activationPath, "utf8"));
  const oldId = activation.active.compositionId;
  const oldComposition = join(root, "compositions", oldId);
  const oldCentral = join(root, "receipts", `${oldId}.json`);
  const receipt = JSON.parse(readFileSync(oldCentral, "utf8"));
  mutate(receipt);
  const identity = {
    schemaVersion: receipt.schemaVersion,
    porcupiVersion: receipt.porcupiVersion,
    piBase: receipt.piBase,
    patches: receipt.patches,
    recipe: receipt.recipe,
    platform: receipt.platform,
    requiredExecutable: receipt.requiredExecutable,
    payload: receipt.payload,
  };
  const compositionId = createHash("sha256").update(canonicalJson(identity)).digest("hex");
  receipt.compositionId = compositionId;
  const embedded = join(oldComposition, "receipt.json");
  chmodSync(embedded, 0o644);
  writeFileSync(embedded, `${JSON.stringify(receipt, null, 2)}\n`);
  const composition = join(root, "compositions", compositionId);
  renameSync(oldComposition, composition);
  writeFileSync(join(root, "receipts", `${compositionId}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  rmSync(oldCentral);
  activation.active.compositionId = compositionId;
  writeFileSync(activationPath, `${JSON.stringify(activation, null, 2)}\n`);
  return { activationPath, composition, compositionId, receipt };
}

function runPorcuPiProcess(home, args, extraEnvironment = {}, cwd) {
  return spawnSync(join(home, ".local", "bin", "porcupi"), args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      ...extraEnvironment,
    },
  });
}

function runPorcuPi(home, args, inputHex, extraEnvironment = {}, cwd) {
  return spawnSync(
    "python3",
    [join(repositoryRoot, "test", "support", "pty-driver.py"), inputHex, join(home, ".local", "bin", "porcupi"), ...args],
    {
      cwd,
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

function createPatchRepository(root) {
  const source = join(root, "patch-source");
  mkdirSync(join(source, "patches", "nested"), { recursive: true });
  writeFileSync(join(source, "patches", "alpha.patch"), "alpha patch\n");
  writeFileSync(join(source, "patches", "nested", "beta.patch"), "beta patch\n");
  writeFileSync(join(source, "patches", "nested", "not-a-patch.txt"), "ignored\n");
  symlinkSync("../../outside.patch", join(source, "patches", "symbolic.patch"));
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "PorcuPi Test");
  git(source, "config", "user.email", "porcupi@example.test");
  git(source, "add", ".");
  git(source, "commit", "-m", "Patch fixture");
  const gitlinkCommit = git(source, "rev-parse", "HEAD");
  git(source, "update-index", "--add", "--cacheinfo", `160000,${gitlinkCommit},patches/submodule`);
  git(source, "commit", "-m", "Add rejected submodule");
  return { source, commit: git(source, "rev-parse", "HEAD") };
}

function textPatch(path, from, to) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
}

function newFilePatch(path, contents) {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${contents}\n`;
}

function escapingSymlinkPatch(path) {
  return `diff --git a/${path} b/${path}\nnew file mode 120000\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+../../outside\n\\ No newline at end of file\n`;
}

function patchFromBase(source, path, transform) {
  const absolute = join(source, path);
  const original = readFileSync(absolute, "utf8");
  writeFileSync(absolute, transform(original));
  const contents = `${git(source, "diff", "--", path)}\n`;
  writeFileSync(absolute, original);
  assert.equal(git(source, "status", "--porcelain"), "");
  return contents;
}

function buildCommandPatch(source, command) {
  return patchFromBase(source, "package.json", (contents) => {
    const manifest = JSON.parse(contents);
    manifest.scripts["build:offline"] = command;
    return `${JSON.stringify(manifest, null, 2)}\n`;
  });
}

function createApplicablePatchRepository(root, patches = [
  ["patches/0002-first.patch", textPatch("series.txt", "base", "first")],
  ["patches/nested/0001-second.patch", textPatch("series.txt", "first", "second")],
]) {
  const source = join(root, "applicable-patch-source");
  for (const [path, contents] of patches) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), contents);
  }
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "PorcuPi Test");
  git(source, "config", "user.email", "porcupi@example.test");
  git(source, "add", ".");
  git(source, "commit", "-m", "Applicable Patch fixture");
  return { source, commit: git(source, "rev-parse", "HEAD") };
}

function createMixedArtifactRepository(root) {
  const repository = createResourceRepository(root);
  mkdirSync(join(repository.source, "patches", "nested"), { recursive: true });
  writeFileSync(join(repository.source, "patches", "nested", "mixed.patch"), "mixed patch\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add Patch beside Pi resources");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  return repository;
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

test("the packed npm artifact is behaviorally equivalent to the exact-tag source entrance", () => {
  const root = temporaryRoot();
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  const artifact = packRelease(release, root);
  const stockBin = join(root, "stock-bin");
  const stockPi = join(stockBin, "pi");
  mkdirSync(stockBin);
  writeFileSync(stockPi, "#!/bin/sh\necho stock-pi\n");
  chmodSync(stockPi, 0o755);
  const stockBefore = readFileSync(stockPi);
  const environment = { PATH: `${stockBin}:${process.env.PATH}` };

  const cancelledHome = join(root, "cancelled-home");
  mkdirSync(cancelledHome);
  const cancelled = runPackedInstaller(artifact, cancelledHome, "1b", environment);
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, /Installation cancelled\. No changes were made\./);
  assert.equal(existsSync(dataRoot(cancelledHome)), false);
  assert.equal(existsSync(join(cancelledHome, ".local", "bin", "porcupi")), false);

  const collisionHome = join(root, "collision-home");
  const collisionLauncher = join(collisionHome, ".local", "bin", "porcupi");
  mkdirSync(dirname(collisionLauncher), { recursive: true });
  writeFileSync(collisionLauncher, "foreign command\n");
  const collision = runPackedInstaller(artifact, collisionHome, "0d", environment);
  assert.notEqual(collision.status, 0);
  assert.match(collision.stdout, /Refusing foreign porcupi command collision/);
  assert.equal(readFileSync(collisionLauncher, "utf8"), "foreign command\n");
  assert.equal(existsSync(dataRoot(collisionHome)), false);

  const sourceHome = join(root, "source-home");
  const packedHome = join(root, "packed-home");
  mkdirSync(sourceHome);
  mkdirSync(packedHome);
  const sourceInstall = runInstaller(release, sourceHome, "0d", environment);
  const packedInstall = runPackedInstaller(artifact, packedHome, "0d", environment);
  assert.equal(sourceInstall.status, 0, sourceInstall.stderr || sourceInstall.stdout);
  assert.equal(packedInstall.status, 0, packedInstall.stderr || packedInstall.stdout);
  assert.match(packedInstall.stdout, /Installed zero-Patch Managed Pi/);
  assert.deepEqual(readFileSync(stockPi), stockBefore);
  assert.equal(existsSync(join(packedHome, ".local", "bin", "pi")), false);

  const sourceActivation = JSON.parse(readFileSync(join(dataRoot(sourceHome), "state", "activation.json"), "utf8"));
  const packedActivation = JSON.parse(readFileSync(join(dataRoot(packedHome), "state", "activation.json"), "utf8"));
  assert.deepEqual(packedActivation, sourceActivation);
  assert.deepEqual(
    readFileSync(join(dataRoot(packedHome), "receipts", `${packedActivation.active.compositionId}.json`)),
    readFileSync(join(dataRoot(sourceHome), "receipts", `${sourceActivation.active.compositionId}.json`)),
  );

  const ownPi = runPorcuPiProcess(packedHome, ["pi", "enable"], environment);
  assert.equal(ownPi.status, 0, ownPi.stderr || ownPi.stdout);
  assert.match(ownPi.stdout, /Enabled PorcuPi ownership/);
  assert.equal(existsSync(join(packedHome, ".local", "bin", "pi")), true);
  assert.deepEqual(readFileSync(stockPi), stockBefore);

  rmSync(join(packedHome, ".npm"), { recursive: true, force: true });
  const launch = runPorcuPiProcess(packedHome, ["--version"], environment);
  assert.equal(launch.status, 0, launch.stderr || launch.stdout);
  assert.equal(launch.stdout.trim(), "0.81.1");
  const verified = runPorcuPiProcess(packedHome, ["verify"], environment);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.match(verified.stdout, /Verified Managed Pi Composition/);
  const uninstall = runPorcuPi(packedHome, ["uninstall"], "0d0d0d", environment);
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.match(uninstall.stdout, /Uninstalled receipt-proven PorcuPi state/);
  assert.equal(existsSync(dataRoot(packedHome)), false);
  assert.equal(existsSync(join(packedHome, ".local", "bin", "porcupi")), false);
  assert.equal(existsSync(join(packedHome, ".local", "bin", "pi")), false);
  assert.deepEqual(readFileSync(stockPi), stockBefore);
});

test("the packed release upgrades an intact historical v0.1.0 zero-Patch installation", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const historicalRelease = createReleaseFixture(root, base, "0.81.1", { historicalRef: "v0.1.0" });
  const targetRelease = createReleaseFixture(root, base);
  const artifact = packRelease(targetRelease, root);
  const shared = createSharedSentinels(root, home);
  const environment = { PATH: `${dirname(shared.stockPi)}:${process.env.PATH}` };

  const historicalInstall = runInstaller(historicalRelease, home, "0d790d0d", environment);
  assert.equal(historicalInstall.status, 0, historicalInstall.stderr || historicalInstall.stdout);
  const managedRoot = dataRoot(home);
  const activationPath = join(managedRoot, "state", "activation.json");
  const historicalActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  const historicalReceipt = JSON.parse(readFileSync(
    join(managedRoot, "receipts", `${historicalActivation.active.compositionId}.json`),
    "utf8",
  ));
  assert.equal(historicalReceipt.porcupiVersion, "0.1.0");
  assert.equal(existsSync(join(home, ".local", "bin", "pi")), true);
  shared.assertUnchanged();

  const beforeCancellation = treeDigest(managedRoot);
  const cancelled = runPackedInstaller(artifact, home, "0d0d1b", {
    ...environment,
    PTY_WAIT_FOR: "1 of 3 — Upgrade",
  });
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, /Installed PorcuPi: 0\.1\.0/);
  assert.match(cancelled.stdout, /Target PorcuPi: 0\.2\.0/);
  assert.match(cancelled.stdout, /Upgrade Readiness Check: ready/);
  assert.match(cancelled.stdout, /Upgrade cancelled\. No authoritative state was changed/);
  assert.equal(treeDigest(managedRoot), beforeCancellation);
  shared.assertUnchanged();

  const upgraded = runPackedInstaller(artifact, home, "0d0d0d", {
    ...environment,
    PTY_WAIT_FOR: "1 of 3 — Upgrade",
  });
  assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout);
  assert.match(upgraded.stdout, /Upgraded PorcuPi from 0\.1\.0 to 0\.2\.0/);
  assert.match(upgraded.stdout, /Selection Intent: empty — selected Artifact upgrades are handled separately/);
  assert.equal(existsSync(join(home, ".local", "bin", "pi")), true);
  const targetActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.equal(targetActivation.previous.compositionId, historicalActivation.active.compositionId);
  assert.notEqual(targetActivation.active.compositionId, historicalActivation.active.compositionId);
  const targetReceipt = JSON.parse(readFileSync(
    join(managedRoot, "receipts", `${targetActivation.active.compositionId}.json`),
    "utf8",
  ));
  assert.equal(targetReceipt.porcupiVersion, "0.2.0");
  assert.deepEqual(targetReceipt.patches, []);
  assert.equal(runPorcuPiProcess(home, ["--version"], environment).stdout.trim(), "0.81.1");
  const verified = runPorcuPiProcess(home, ["verify"], environment);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);

  const rolledBack = runPorcuPi(home, ["rollback"], "0d", { ...environment, PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.equal(rolledBack.status, 0, rolledBack.stderr || rolledBack.stdout);
  assert.equal(JSON.parse(readFileSync(activationPath, "utf8")).active.compositionId, historicalActivation.active.compositionId);
  const restored = runPorcuPi(home, ["rollback"], "0d", { ...environment, PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  assert.equal(JSON.parse(readFileSync(activationPath, "utf8")).active.compositionId, targetActivation.active.compositionId);

  const runtimeReceipt = JSON.parse(readFileSync(join(managedRoot, "state", "runtime.json"), "utf8"));
  assert.equal(runtimeReceipt.schemaVersion, 2);
  const beforeDowngrade = treeDigest(managedRoot);
  const downgrade = runInstaller(historicalRelease, home, "0d0d0d", environment);
  assert.notEqual(downgrade.status, 0);
  assert.match(`${downgrade.stdout}${downgrade.stderr}`, /Malformed PorcuPi runtime receipt/);
  assert.equal(treeDigest(managedRoot), beforeDowngrade);
  assert.equal(existsSync(join(home, ".local", "bin", "pi")), true);

  const repeated = runPackedInstaller(artifact, home, "", environment);
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.match(repeated.stdout, /Verified installed PorcuPi 0\.2\.0; no rebuild was needed/);
  assert.doesNotMatch(repeated.stdout, /npm ci --ignore-scripts/);
  shared.assertUnchanged();

  const uninstall = runPorcuPi(home, ["uninstall"], "0d0d0d", environment);
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.equal(existsSync(managedRoot), false);
  assert.equal(existsSync(join(home, ".local", "bin", "porcupi")), false);
  assert.equal(existsSync(join(home, ".local", "bin", "pi")), false);
  shared.assertUnchanged();
});

test("a version-aware exact target refuses a newer installation as an unsupported downgrade", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const futureRelease = createReleaseFixture(root, base);
  setReleaseFixtureVersion(futureRelease, "0.3.0");
  const futureArtifact = packRelease(futureRelease, root);
  const futureInstall = runPackedInstaller(futureArtifact, home);
  assert.equal(futureInstall.status, 0, futureInstall.stderr || futureInstall.stdout);

  const targetRoot = join(root, "target");
  mkdirSync(targetRoot);
  const targetRelease = createReleaseFixture(targetRoot, base);
  const artifact = packRelease(targetRelease, targetRoot);
  const before = treeDigest(dataRoot(home));

  const downgrade = runPackedInstaller(artifact, home, "");
  assert.notEqual(downgrade.status, 0);
  assert.match(
    `${downgrade.stdout}${downgrade.stderr}`,
    /Unsupported PorcuPi downgrade: installed 0\.3\.0, invoked target 0\.2\.0; no changes were made/,
  );
  assert.equal(treeDigest(dataRoot(home)), before);
});

test("a migration contract is bound to both exact release versions", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const historicalRelease = createReleaseFixture(root, base, "0.81.1", { historicalRef: "v0.1.0" });
  const historicalInstall = runInstaller(historicalRelease, home);
  assert.equal(historicalInstall.status, 0, historicalInstall.stderr || historicalInstall.stdout);

  const futureRelease = createReleaseFixture(root, base);
  setReleaseFixtureVersion(futureRelease, "0.3.0");
  const before = treeDigest(dataRoot(home));

  const unsupported = runInstaller(futureRelease, home, "1b", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });
  assert.notEqual(unsupported.status, 0);
  assert.match(
    `${unsupported.stdout}${unsupported.stderr}`,
    /No versioned state migration supports PorcuPi 0\.1\.0 → 0\.3\.0/,
  );
  assert.equal(treeDigest(dataRoot(home)), before);
});

test("a failed Upgrade Readiness Check leaves the historical installation unchanged", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const historicalBase = createPiBase(root);
  const historicalRelease = createReleaseFixture(root, historicalBase, "0.81.1", { historicalRef: "v0.1.0" });
  const historicalInstall = runInstaller(historicalRelease, home);
  assert.equal(historicalInstall.status, 0, historicalInstall.stderr || historicalInstall.stdout);

  const targetRoot = join(root, "target");
  mkdirSync(targetRoot);
  const failingTargetBase = createPiBase(targetRoot, { buildFails: true });
  const targetRelease = createReleaseFixture(targetRoot, failingTargetBase);
  const artifact = packRelease(targetRelease, targetRoot);
  const before = treeDigest(dataRoot(home));

  const failed = runPackedInstaller(artifact, home, "");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /Upgrade candidate: installed PorcuPi 0\.1\.0, target PorcuPi 0\.2\.0/);
  assert.match(failed.stdout, /fixture build failed/);
  assert.equal(treeDigest(dataRoot(home)), before);
  assert.equal(runPorcuPiProcess(home, ["--version"]).stdout.trim(), "0.81.1");
});

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

  const retry = runInstaller(release, home, "");

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

  const retry = runInstaller(release, home, "");

  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.match(retry.stdout, /Recovered installed zero-Patch Managed Pi/);
  const launcher = join(home, ".local", "bin", "porcupi");
  assert.equal(existsSync(launcher), true);
  const launch = spawnSync(launcher, ["--version"], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(launch.stdout.trim(), "0.81.1");
});

test("installation retry converges an interrupted pi alias publication without changing ownership", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);

  const interrupted = runInstaller(release, home, "0d790d0d", { PORCUPI_TEST_FAULT: "pi-alias-published" });
  assert.equal(interrupted.signal, "SIGKILL");
  const bin = join(home, ".local", "bin");
  const managedRoot = dataRoot(home);
  assert.equal(existsSync(join(bin, "porcupi")), true);
  assert.equal(existsSync(join(bin, "pi")), true);
  assert.equal(existsSync(join(managedRoot, "state", "pi-transition.json")), true);
  assert.equal(existsSync(join(managedRoot, "state", "pi-launcher.json")), false);

  const retry = runInstaller(release, home, "");
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.match(retry.stdout, /Recovered installed zero-Patch Managed Pi/);
  assert.equal(existsSync(join(bin, "pi")), true);
  assert.equal(existsSync(join(managedRoot, "state", "pi-transition.json")), false);
  assert.equal(existsSync(join(managedRoot, "state", "pi-launcher.json")), true);
  assert.equal(existsSync(join(bin, "porcupi")), true);
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
  const managedRoot = dataRoot(home);
  const activation = JSON.parse(readFileSync(join(managedRoot, "state", "activation.json"), "utf8"));
  assert.equal(activation.schemaVersion, 1);
  assert.equal(activation.previous, null);
  assert.deepEqual(activation.active.patches, []);
  const centralReceipt = readFileSync(join(managedRoot, "receipts", `${activation.active.compositionId}.json`), "utf8");
  const embeddedReceipt = readFileSync(join(managedRoot, "compositions", activation.active.compositionId, "receipt.json"), "utf8");
  const hydratedModels = JSON.parse(readFileSync(join(managedRoot, "compositions", activation.active.compositionId, "payload", "packages", "ai", "src", "providers", "data", "fixture.json"), "utf8"));
  assert.deepEqual(Object.keys(hydratedModels), ["fixture-model"]);
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

test("guided installation defaults pi ownership to no and preserves a Stock Pi target collision", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const bin = join(home, ".local", "bin");
  const stockPi = join(bin, "pi");
  mkdirSync(bin, { recursive: true });
  writeFileSync(stockPi, "#!/bin/sh\necho stock-at-target\n");
  chmodSync(stockPi, 0o755);
  const stockBefore = readFileSync(stockPi);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);

  const install = runInstaller(release, home);

  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /Should PorcuPi own the `pi` command\? \(default: No\)/);
  assert.match(install.stdout, /does not own.*no change was needed/);
  assert.deepEqual(readFileSync(stockPi), stockBefore);
  assert.equal(existsSync(join(dataRoot(home), "state", "pi-launcher.json")), false);
  assert.equal(existsSync(join(bin, "porcupi")), true);
  const stock = spawnSync(stockPi, [], { encoding: "utf8" });
  assert.equal(stock.status, 0, stock.stderr);
  assert.equal(stock.stdout.trim(), "stock-at-target");
});

test("guided installation can explicitly own pi while preserving independently resolved Stock Pi", () => {
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
  const bin = join(home, ".local", "bin");
  const environment = { PATH: `${stockBin}:${bin}:${process.env.PATH}` };

  const install = runInstaller(release, home, "0d790d0d", environment);

  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.match(install.stdout, /1 of 3 — Installation/);
  assert.match(install.stdout, /2 of 3 — Command ownership/);
  assert.match(install.stdout, /3 of 3 — Review/);
  assert.match(install.stdout, /Should PorcuPi own the `pi` command\? \(default: No\)/);
  assert.match(install.stdout, /Own `pi`: Yes — reversible PorcuPi alias/);
  assert.match(install.stdout, /Enabled PorcuPi ownership/);
  assert.match(install.stdout, new RegExp(`PATH currently resolves.*${stockPi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const alias = join(bin, "pi");
  const launcher = join(bin, "porcupi");
  assert.equal(existsSync(alias), true);
  assert.equal(existsSync(launcher), true);
  assert.deepEqual(readFileSync(stockPi), stockBefore);
  const managedRoot = dataRoot(home);
  const receipt = JSON.parse(readFileSync(join(managedRoot, "state", "pi-launcher.json"), "utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), ["kind", "mode", "path", "schemaVersion", "sha256", "size", "type"]);
  assert.equal(receipt.type, "porcupi-pi-launcher");
  assert.equal(receipt.path, alias);
  assert.equal(receipt.kind, "file");
  assert.equal(receipt.size, lstatSync(alias).size);
  assert.equal(receipt.sha256, createHash("sha256").update(readFileSync(alias)).digest("hex"));
  const aliasLaunch = spawnSync(alias, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), PATH: `${bin}:${stockBin}:${process.env.PATH}` },
  });
  assert.equal(aliasLaunch.status, 0, aliasLaunch.stderr || aliasLaunch.stdout);
  assert.equal(aliasLaunch.stdout.trim(), "0.81.1");

  const disable = runPorcuPiProcess(home, ["pi", "disable"], environment);
  assert.equal(disable.status, 0, disable.stderr || disable.stdout);
  assert.match(disable.stdout, new RegExp(`pi.*resolves independently.*${stockPi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(existsSync(alias), false);
  assert.equal(existsSync(join(managedRoot, "state", "pi-launcher.json")), false);
  assert.equal(existsSync(launcher), true);
  assert.deepEqual(readFileSync(stockPi), stockBefore);
  const stockLaunch = spawnSync("pi", [], { encoding: "utf8", env: { ...process.env, PATH: environment.PATH } });
  assert.equal(stockLaunch.status, 0, stockLaunch.stderr);
  assert.equal(stockLaunch.stdout.trim(), "stock-pi");

  const repeatedDisable = runPorcuPiProcess(home, ["pi", "disable"], environment);
  assert.equal(repeatedDisable.status, 0, repeatedDisable.stderr || repeatedDisable.stdout);
  assert.match(repeatedDisable.stdout, /does not own.*no change was needed/);
  const enable = runPorcuPiProcess(home, ["pi", "enable"], environment);
  assert.equal(enable.status, 0, enable.stderr || enable.stdout);
  const repeatedEnable = runPorcuPiProcess(home, ["pi", "enable"], environment);
  assert.equal(repeatedEnable.status, 0, repeatedEnable.stderr || repeatedEnable.stdout);
  assert.match(repeatedEnable.stdout, /already owns.*no change was needed/);
  const activationPath = join(managedRoot, "state", "activation.json");
  const activationBefore = readFileSync(activationPath);
  const launcherBefore = readFileSync(launcher);
  writeFileSync(activationPath, "malformed\n");
  writeFileSync(launcher, `${launcherBefore.toString()}# locally changed\n`);
  const recoveryDisable = runPorcuPiProcess(home, ["pi", "disable"], environment);
  assert.equal(recoveryDisable.status, 0, recoveryDisable.stderr || recoveryDisable.stdout);
  assert.equal(existsSync(alias), false);
  assert.notDeepEqual(readFileSync(launcher), launcherBefore);
  writeFileSync(activationPath, activationBefore);
  writeFileSync(launcher, launcherBefore);
  assert.deepEqual(readFileSync(stockPi), stockBefore);
});

test("pi ownership refuses foreign and modified aliases without adoption or removal", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const bin = join(home, ".local", "bin");
  const alias = join(bin, "pi");
  const foreign = join(root, "foreign-pi");
  writeFileSync(foreign, "#!/bin/sh\necho foreign\n");
  chmodSync(foreign, 0o755);
  symlinkSync(foreign, alias);
  const symbolicBefore = readlinkSync(alias);

  const symbolicCollision = runPorcuPiProcess(home, ["pi", "enable"]);
  assert.notEqual(symbolicCollision.status, 0);
  assert.match(`${symbolicCollision.stdout}${symbolicCollision.stderr}`, /Refusing foreign pi command collision/);
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
  assert.equal(readlinkSync(alias), symbolicBefore);
  rmSync(alias);
  writeFileSync(alias, "foreign command\n");
  const foreignBefore = readFileSync(alias);
  const regularCollision = runPorcuPiProcess(home, ["pi", "enable"]);
  assert.notEqual(regularCollision.status, 0);
  assert.deepEqual(readFileSync(alias), foreignBefore);
  rmSync(alias);

  const enabled = runPorcuPiProcess(home, ["pi", "enable"]);
  assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
  const managedRoot = dataRoot(home);
  const receiptPath = join(managedRoot, "state", "pi-launcher.json");
  const receiptBefore = readFileSync(receiptPath);
  const aliasBefore = readFileSync(alias);
  writeFileSync(alias, `${aliasBefore.toString()}# modified\n`);
  const modifiedBefore = readFileSync(alias);
  const modifiedDisable = runPorcuPiProcess(home, ["pi", "disable"]);
  assert.notEqual(modifiedDisable.status, 0);
  assert.match(`${modifiedDisable.stdout}${modifiedDisable.stderr}`, /does not match its ownership receipt/);
  assert.deepEqual(readFileSync(alias), modifiedBefore);
  assert.deepEqual(readFileSync(receiptPath), receiptBefore);
  const verifyModified = runPorcuPiProcess(home, ["verify"]);
  assert.notEqual(verifyModified.status, 0);
  assert.match(`${verifyModified.stdout}${verifyModified.stderr}`, /pi launcher does not match/);

  writeFileSync(alias, aliasBefore);
  const receipt = JSON.parse(receiptBefore.toString());
  writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, path: "../pi" }, null, 2)}\n`);
  const traversingDisable = runPorcuPiProcess(home, ["pi", "disable"]);
  assert.notEqual(traversingDisable.status, 0);
  assert.match(`${traversingDisable.stdout}${traversingDisable.stderr}`, /Malformed PorcuPi pi launcher receipt/);
  assert.deepEqual(readFileSync(alias), aliasBefore);
  writeFileSync(receiptPath, receiptBefore);
  rmSync(alias);
  symlinkSync(foreign, alias);
  const substitutedDisable = runPorcuPiProcess(home, ["pi", "disable"]);
  assert.notEqual(substitutedDisable.status, 0);
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(receiptPath), receiptBefore);
});

test("pi ownership retries converge across publication and removal interruptions without Stock Pi", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const bin = join(home, ".local", "bin");
  const alias = join(bin, "pi");
  const managedRoot = dataRoot(home);
  const transition = join(managedRoot, "state", "pi-transition.json");
  const receipt = join(managedRoot, "state", "pi-launcher.json");
  const environment = { PATH: `${bin}:/usr/bin:/bin` };
  const lifecycleLock = `${managedRoot}.lifecycle-lock`;
  const holder = spawn(join(bin, "porcupi"), ["pi", "enable"], {
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      PATH: environment.PATH,
      PORCUPI_TEST_HOLD_LOCK_MS: "1000",
    },
  });
  let holderOutput = "";
  holder.stdout.on("data", (chunk) => { holderOutput += chunk; });
  holder.stderr.on("data", (chunk) => { holderOutput += chunk; });
  for (let attempt = 0; attempt < 100 && !existsSync(lifecycleLock); attempt += 1) await delay(20);
  assert.equal(existsSync(lifecycleLock), true, "pi ownership lifecycle lock was not acquired");
  const contended = runPorcuPiProcess(home, ["pi", "disable"], environment);
  assert.notEqual(contended.status, 0);
  assert.match(`${contended.stdout}${contended.stderr}`, /lifecycle operation is already in progress: pi enable/);
  const holderResult = await new Promise((resolvePromise) => holder.once("close", (code, signal) => resolvePromise({ code, signal })));
  assert.equal(holderResult.code, 0, holderOutput);
  assert.equal(holderResult.signal, null);
  assert.equal(runPorcuPiProcess(home, ["pi", "disable"], environment).status, 0);

  const interruptedEnable = runPorcuPiProcess(home, ["pi", "enable"], {
    ...environment,
    PORCUPI_TEST_FAULT: "pi-alias-published",
  });
  assert.equal(interruptedEnable.signal, "SIGKILL");
  assert.equal(existsSync(alias), true);
  assert.equal(existsSync(transition), true);
  assert.equal(existsSync(receipt), false);
  const retryEnable = runPorcuPiProcess(home, ["pi", "enable"], environment);
  assert.equal(retryEnable.status, 0, retryEnable.stderr || retryEnable.stdout);
  assert.equal(existsSync(transition), false);
  assert.equal(existsSync(receipt), true);
  const launch = spawnSync("pi", ["--version"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), PATH: environment.PATH },
  });
  assert.equal(launch.status, 0, launch.stderr || launch.stdout);
  assert.equal(launch.stdout.trim(), "0.81.1");

  const interruptedDisable = runPorcuPiProcess(home, ["pi", "disable"], {
    ...environment,
    PORCUPI_TEST_FAULT: "pi-alias-removed",
  });
  assert.equal(interruptedDisable.signal, "SIGKILL");
  assert.equal(existsSync(alias), false);
  assert.equal(existsSync(receipt), true);
  assert.equal(existsSync(transition), true);
  const retryDisable = runPorcuPiProcess(home, ["pi", "disable"], environment);
  assert.equal(retryDisable.status, 0, retryDisable.stderr || retryDisable.stdout);
  assert.equal(existsSync(alias), false);
  assert.equal(existsSync(receipt), false);
  assert.equal(existsSync(transition), false);
  assert.match(retryDisable.stdout, /No `pi` command is currently available on PATH/);
  assert.equal(existsSync(join(bin, "porcupi")), true);
});

test("porcupi uninstall cancellation preserves all PorcuPi and shared state with terminal restoration", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const managedRoot = dataRoot(home);
  const shared = createSharedSentinels(root, home, { stockAtTarget: true });
  const rootBefore = treeDigest(managedRoot);
  const launcher = join(home, ".local", "bin", "porcupi");
  const launcherBefore = readFileSync(launcher);

  const cancelled = runPorcuPi(home, ["uninstall"], "1b");

  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, /1 of 3 — Owned state/);
  assert.match(cancelled.stdout, /Uninstall cancelled/);
  assert.match(cancelled.stdout, /\x1b\[\?25l/);
  assert.match(cancelled.stdout, /\x1b\[\?25h/);
  assert.equal(treeDigest(managedRoot), rootBefore);
  assert.deepEqual(readFileSync(launcher), launcherBefore);
  shared.assertUnchanged();
});

test("porcupi uninstall removes only receipt-proven state and retains Pi resources and Stock Pi", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const stockBin = join(root, "stock-bin");
  const stockPi = join(stockBin, "pi");
  mkdirSync(home);
  mkdirSync(stockBin);
  writeFileSync(stockPi, "#!/bin/sh\necho stock\n");
  chmodSync(stockPi, 0o755);
  const stockBefore = readFileSync(stockPi);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  const environment = { PATH: `${join(home, ".local", "bin")}:${stockBin}:${process.env.PATH}` };
  assert.equal(runInstaller(release, home, "0d790d0d", environment).status, 0);
  const project = join(root, "project");
  mkdirSync(project);
  const repository = createResourceRepository(root);
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e206a206a206a206e0d", environment, project);
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const piRoot = join(home, ".pi");
  mkdirSync(join(piRoot, "agent", "sessions"), { recursive: true });
  mkdirSync(join(piRoot, "agent", "packages", "foreign"), { recursive: true });
  writeFileSync(join(piRoot, "agent", "credentials.json"), "credential-sentinel\n");
  writeFileSync(join(piRoot, "agent", "trust.json"), "trust-sentinel\n");
  writeFileSync(join(piRoot, "agent", "sessions", "session.json"), "session-sentinel\n");
  writeFileSync(join(piRoot, "agent", "packages", "foreign", "asset"), "package-sentinel\n");
  mkdirSync(join(project, ".pi", "resources"), { recursive: true });
  writeFileSync(join(project, ".pi", "trust.json"), "project-trust-sentinel\n");
  writeFileSync(join(project, ".pi", "resources", "asset"), "project-resource-sentinel\n");
  const piBefore = treeDigest(piRoot);
  const projectBefore = treeDigest(join(project, ".pi"));

  const uninstall = runPorcuPi(home, ["uninstall"], "0d0d0d", environment);

  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.match(uninstall.stdout, /1 of 3 — Owned state/);
  assert.match(uninstall.stdout, /2 of 3 — Pi resources/);
  assert.match(uninstall.stdout, /3 of 3 — Review/);
  assert.match(uninstall.stdout, /Pi-owned resource groups that will remain: 1/);
  assert.match(uninstall.stdout, /Uninstalled receipt-proven PorcuPi state/);
  assert.equal(existsSync(dataRoot(home)), false);
  assert.equal(existsSync(`${dataRoot(home)}.uninstall-tombstone`), false);
  assert.equal(existsSync(join(home, ".local", "bin", "porcupi")), false);
  assert.equal(existsSync(join(home, ".local", "bin", "pi")), false);
  assert.equal(treeDigest(piRoot), piBefore);
  assert.equal(treeDigest(join(project, ".pi")), projectBefore);
  assert.deepEqual(readFileSync(stockPi), stockBefore);
  const foreignPorcuPi = join(home, ".local", "bin", "porcupi");
  writeFileSync(foreignPorcuPi, "foreign command after uninstall\n");
  const alreadyAbsent = spawnSync(process.execPath, [join(release, "src", "cli.mjs"), "uninstall"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), NODE_ENV: "test" },
  });
  assert.equal(alreadyAbsent.status, 0, alreadyAbsent.stderr || alreadyAbsent.stdout);
  assert.match(alreadyAbsent.stdout, /already absent.*no change/);
  assert.equal(readFileSync(foreignPorcuPi, "utf8"), "foreign command after uninstall\n");
});

test("porcupi uninstall refuses modified and malformed ownership targets without deletion", () => {
  for (const scenario of [
    "modified-launcher", "modified-runtime", "traversing-launcher-receipt", "malformed-activation",
    "symbolic-pi", "foreign-temporary", "foreign-tombstone",
  ]) {
    const root = temporaryRoot();
    const home = join(root, "home");
    mkdirSync(home);
    const base = createPiBase(root);
    const release = createReleaseFixture(root, base);
    const ownPi = scenario === "symbolic-pi";
    assert.equal(runInstaller(release, home, ownPi ? "0d790d0d" : "0d").status, 0);
    const managedRoot = dataRoot(home);
    const launcher = join(home, ".local", "bin", "porcupi");
    if (scenario === "modified-launcher") writeFileSync(launcher, `${readFileSync(launcher, "utf8")}# changed\n`);
    if (scenario === "modified-runtime") writeFileSync(join(managedRoot, "runtime", "add.mjs"), `${readFileSync(join(managedRoot, "runtime", "add.mjs"), "utf8")}\n// changed\n`);
    if (scenario === "traversing-launcher-receipt") {
      const receiptPath = join(managedRoot, "state", "launcher.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt.path = `${join(home, ".local", "bin")}/../bin/porcupi`;
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    }
    if (scenario === "malformed-activation") writeFileSync(join(managedRoot, "state", "activation.json"), "malformed\n");
    if (scenario === "symbolic-pi") {
      const alias = join(home, ".local", "bin", "pi");
      rmSync(alias);
      symlinkSync(launcher, alias);
    }
    if (scenario === "foreign-temporary") mkdirSync(join(managedRoot, "tmp", "foreign-stage"));
    if (scenario === "foreign-tombstone") writeFileSync(`${managedRoot}.uninstall-tombstone`, "foreign tombstone\n");
    const shared = createSharedSentinels(root, home);
    const rootBefore = treeDigest(managedRoot);
    const launcherBefore = readFileSync(launcher);

    const uninstall = runPorcuPi(home, ["uninstall"], "0d0d0d");

    assert.notEqual(uninstall.status, 0, `${scenario}: uninstall unexpectedly succeeded`);
    assert.equal(treeDigest(managedRoot), rootBefore);
    assert.deepEqual(readFileSync(launcher), launcherBefore);
    shared.assertUnchanged();
    if (scenario === "symbolic-pi") assert.equal(lstatSync(join(home, ".local", "bin", "pi")).isSymbolicLink(), true);
    if (scenario === "foreign-tombstone") assert.equal(readFileSync(`${managedRoot}.uninstall-tombstone`, "utf8"), "foreign tombstone\n");
  }
});

test("porcupi uninstall defers a live Composition lease and converges after the process exits", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const shared = createSharedSentinels(root, home, { stockAtTarget: true });
  const launchLog = join(root, "uninstall-held-launch.log");
  const held = spawn(join(home, ".local", "bin", "porcupi"), ["held"], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      PI_FIXTURE_LAUNCH_LOG: launchLog,
      PI_FIXTURE_HOLD_MS: "1800",
    },
  });
  childProcesses.push(held);
  for (let attempt = 0; attempt < 100 && !existsSync(launchLog); attempt += 1) await delay(20);
  assert.equal(existsSync(launchLog), true, "held Managed Pi did not start");

  const deferred = runPorcuPi(home, ["uninstall"], "0d0d0d");

  assert.equal(deferred.status, 0, deferred.stderr || deferred.stdout);
  assert.match(deferred.stdout, /Uninstall deferred.*live process lease/);
  assert.equal(existsSync(dataRoot(home)), true);
  assert.equal(existsSync(join(home, ".local", "bin", "porcupi")), true);
  await new Promise((resolvePromise) => held.once("exit", resolvePromise));
  const retry = runPorcuPi(home, ["uninstall"], "0d0d0d");
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.equal(existsSync(dataRoot(home)), false);
  shared.assertUnchanged();
});

test("interrupted PorcuPi uninstall retries every destructive durability boundary", () => {
  const boundaries = [
    "uninstall-tombstone-published",
    "uninstall-leases-gated",
    "uninstall-pi-alias-removed",
    "uninstall-recovery-launcher-published",
    "uninstall-root-removed",
    "uninstall-launcher-removed",
    "uninstall-tombstone-removed",
  ];
  for (const boundary of boundaries) {
    const root = temporaryRoot();
    const home = join(root, "home");
    mkdirSync(home);
    const base = createPiBase(root);
    const release = createReleaseFixture(root, base);
    const ownsPi = boundary === "uninstall-pi-alias-removed";
    assert.equal(runInstaller(release, home, ownsPi ? "0d790d0d" : "0d").status, 0);
    const shared = createSharedSentinels(root, home, { stockAtTarget: !ownsPi });
    const interrupted = runPorcuPi(home, ["uninstall"], "0d0d0d", { PORCUPI_TEST_FAULT: boundary });
    assert.notEqual(interrupted.status, 0, `${boundary}: fault did not interrupt uninstall`);
    const tombstone = `${dataRoot(home)}.uninstall-tombstone`;
    const launcher = join(home, ".local", "bin", "porcupi");
    let retry;
    if (existsSync(launcher)) retry = runPorcuPiProcess(home, ["uninstall"]);
    else if (existsSync(tombstone)) retry = spawnSync(process.execPath, [join(tombstone, "runtime", "cli.mjs"), "uninstall"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), NODE_ENV: "test" },
    });
    else retry = spawnSync(process.execPath, [join(release, "src", "cli.mjs"), "uninstall"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), NODE_ENV: "test" },
    });
    assert.equal(retry.status, 0, `${boundary}: ${retry.stderr || retry.stdout}`);
    assert.equal(existsSync(dataRoot(home)), false, boundary);
    assert.equal(existsSync(tombstone), false, boundary);
    assert.equal(existsSync(launcher), false, boundary);
    shared.assertUnchanged();
  }
});

test("porcupi verify audits the complete Composition and owned launcher while normal launch stays cheap and fail closed", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  const install = runInstaller(release, home);
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const managedRoot = dataRoot(home);
  const activation = JSON.parse(readFileSync(join(managedRoot, "state", "activation.json"), "utf8"));
  const composition = join(managedRoot, "compositions", activation.active.compositionId);
  const launcher = join(home, ".local", "bin", "porcupi");
  const launcherReceiptPath = join(managedRoot, "state", "launcher.json");
  const launcherReceipt = JSON.parse(readFileSync(launcherReceiptPath, "utf8"));
  assert.deepEqual(Object.keys(launcherReceipt).sort(), ["kind", "mode", "path", "schemaVersion", "sha256", "size", "type"]);
  assert.equal(launcherReceipt.type, "porcupi-launcher");
  assert.equal(launcherReceipt.path, launcher);
  assert.equal(launcherReceipt.kind, "file");
  assert.equal(launcherReceipt.mode, lstatSync(launcher).mode & 0o777);
  assert.equal(launcherReceipt.size, lstatSync(launcher).size);
  assert.equal(launcherReceipt.sha256, createHash("sha256").update(readFileSync(launcher)).digest("hex"));

  const launcherReceiptBytes = readFileSync(launcherReceiptPath);
  writeFileSync(launcherReceiptPath, `${JSON.stringify({ ...launcherReceipt, unknown: true }, null, 2)}\n`);
  const malformedLauncherReceipt = runPorcuPiProcess(home, ["verify"]);
  assert.notEqual(malformedLauncherReceipt.status, 0);
  assert.match(`${malformedLauncherReceipt.stdout}${malformedLauncherReceipt.stderr}`, /Malformed PorcuPi launcher receipt/);
  writeFileSync(launcherReceiptPath, launcherReceiptBytes);
  renameSync(launcherReceiptPath, `${launcherReceiptPath}.real`);
  symlinkSync("launcher.json.real", launcherReceiptPath);
  const symbolicLauncherReceipt = runPorcuPiProcess(home, ["verify"]);
  assert.notEqual(symbolicLauncherReceipt.status, 0);
  assert.match(`${symbolicLauncherReceipt.stdout}${symbolicLauncherReceipt.stderr}`, /Malformed PorcuPi launcher receipt/);
  rmSync(launcherReceiptPath);
  renameSync(`${launcherReceiptPath}.real`, launcherReceiptPath);

  const smokeHomeLog = join(root, "smoke-home.log");
  const verified = runPorcuPiProcess(home, ["verify"], { PI_FIXTURE_SMOKE_HOME_LOG: smokeHomeLog });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.match(verified.stdout, /--help[\s\S]*--version[\s\S]*--list-models[\s\S]*Verified Managed Pi Composition/);
  assert.match(verified.stdout, /Complete payload inventory/);
  const smokeHome = readFileSync(smokeHomeLog, "utf8").trim();
  assert.notEqual(smokeHome, home);
  assert.match(smokeHome, /tmp[\\/]verify-/);
  assert.equal(existsSync(smokeHome), false);

  const runtimeFile = join(managedRoot, "runtime", "add.mjs");
  const runtimeBefore = readFileSync(runtimeFile);
  writeFileSync(runtimeFile, `${runtimeBefore.toString()}\n// local runtime change\n`);
  const changedRuntime = runPorcuPiProcess(home, ["verify"]);
  assert.notEqual(changedRuntime.status, 0);
  assert.match(`${changedRuntime.stdout}${changedRuntime.stderr}`, /runtime inventory mismatch/);
  writeFileSync(runtimeFile, runtimeBefore);

  const series = join(composition, "payload", "series.txt");
  const seriesBefore = readFileSync(series);
  const seriesMode = lstatSync(series).mode & 0o777;
  chmodSync(series, 0o644);
  writeFileSync(series, "locally changed\n");
  const cheapLaunch = runPorcuPiProcess(home, ["--version"]);
  assert.equal(cheapLaunch.status, 0, cheapLaunch.stderr || cheapLaunch.stdout);
  assert.equal(cheapLaunch.stdout.trim(), "0.81.1");
  const changedPayload = runPorcuPiProcess(home, ["verify"]);
  assert.notEqual(changedPayload.status, 0);
  assert.match(`${changedPayload.stdout}${changedPayload.stderr}`, /payload inventory mismatch/);
  writeFileSync(series, seriesBefore);
  chmodSync(series, seriesMode);
  const payloadRoot = join(composition, "payload");
  chmodSync(payloadRoot, 0o755);
  rmSync(series);
  const missingPayload = runPorcuPiProcess(home, ["verify"]);
  assert.notEqual(missingPayload.status, 0);
  assert.match(`${missingPayload.stdout}${missingPayload.stderr}`, /payload inventory mismatch/);
  writeFileSync(series, seriesBefore, { mode: seriesMode });
  chmodSync(series, seriesMode);
  chmodSync(payloadRoot, 0o555);

  const executable = join(composition, "payload", "packages", "coding-agent", "dist", "cli.js");
  const executableBefore = readFileSync(executable);
  const executableMode = lstatSync(executable).mode & 0o777;
  chmodSync(executable, 0o755);
  writeFileSync(executable, `${executableBefore.toString()}\n// changed\n`);
  const launchLog = join(root, "launch-must-not-run.log");
  const refused = runPorcuPiProcess(home, ["hello"], { PI_FIXTURE_LAUNCH_LOG: launchLog });
  assert.notEqual(refused.status, 0);
  const refusalOutput = `${refused.stdout}${refused.stderr}`;
  assert.match(refusalOutput, /executable does not match its Composition receipt/);
  assert.match(refusalOutput, /neither the previous Composition nor Stock Pi was run/);
  assert.match(refusalOutput, /porcupi verify/);
  assert.match(refusalOutput, /porcupi rollback/);
  assert.match(refusalOutput, /porcupi pi disable/);
  assert.match(refusalOutput, /independently managed Stock Pi path/);
  assert.equal(existsSync(launchLog), false);
  writeFileSync(executable, executableBefore);
  chmodSync(executable, executableMode);

  const wrongVersion = runPorcuPiProcess(home, ["verify"], { PI_FIXTURE_VERSION_OVERRIDE: "9.9.9" });
  assert.notEqual(wrongVersion.status, 0);
  assert.match(`${wrongVersion.stdout}${wrongVersion.stderr}`, /expected 0\.81\.1, found 9\.9\.9/);
  for (const failedCheck of ["--help", "--list-models"]) {
    const failed = runPorcuPiProcess(home, ["verify"], { PI_FIXTURE_CHECK_FAIL: failedCheck });
    assert.notEqual(failed.status, 0);
    assert.match(`${failed.stdout}${failed.stderr}`, /exited with status 44/);
  }

  const launcherBefore = readFileSync(launcher);
  writeFileSync(launcher, `${launcherBefore.toString()}# local change\n`);
  const changedLauncher = runPorcuPiProcess(home, ["verify"]);
  assert.notEqual(changedLauncher.status, 0);
  assert.match(`${changedLauncher.stdout}${changedLauncher.stderr}`, /launcher does not match its ownership receipt/);
  assert.notDeepEqual(readFileSync(launcher), launcherBefore);
});

test("Managed Pi launch strictly rejects malformed control state, receipt disagreement, symlinks, and foreign identities", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const managedRoot = dataRoot(home);
  const activationPath = join(managedRoot, "state", "activation.json");
  const activationBytes = readFileSync(activationPath);
  const activation = JSON.parse(activationBytes.toString());
  const compositionId = activation.active.compositionId;
  const composition = join(managedRoot, "compositions", compositionId);
  const centralPath = join(managedRoot, "receipts", `${compositionId}.json`);
  const embeddedPath = join(composition, "receipt.json");
  const centralBytes = readFileSync(centralPath);
  const embeddedBytes = readFileSync(embeddedPath);
  const launchLog = join(root, "malformed-launch.log");
  const ownerPath = join(managedRoot, "owner.json");
  const ownerBytes = readFileSync(ownerPath);

  const assertRefused = (expected) => {
    const result = runPorcuPiProcess(home, ["hello"], { PI_FIXTURE_LAUNCH_LOG: launchLog });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, expected);
    assert.match(`${result.stdout}${result.stderr}`, /launch was refused/);
    assert.equal(existsSync(launchLog), false);
  };
  const restoreActivation = () => writeFileSync(activationPath, activationBytes);

  writeFileSync(ownerPath, `${JSON.stringify({ schemaVersion: 1, type: "porcupi-managed-root", unknown: true }, null, 2)}\n`);
  assertRefused(/Malformed PorcuPi root ownership/);
  writeFileSync(ownerPath, ownerBytes);

  writeFileSync(activationPath, `${JSON.stringify({ ...activation, unknown: true }, null, 2)}\n`);
  assertRefused(/Malformed PorcuPi activation/);
  restoreActivation();
  const missing = { ...activation };
  delete missing.previous;
  writeFileSync(activationPath, `${JSON.stringify(missing, null, 2)}\n`);
  assertRefused(/Malformed PorcuPi activation/);
  restoreActivation();
  writeFileSync(activationPath, `${JSON.stringify({
    ...activation,
    previous: {
      compositionId: "f".repeat(64),
      patches: [
        { locator: "example.test/source", commit: "a".repeat(40), path: "patches/../escape.patch", sha256: "b".repeat(64) },
      ],
    },
  }, null, 2)}\n`);
  assertRefused(/Malformed PorcuPi activation/);
  restoreActivation();
  writeFileSync(activationPath, `${JSON.stringify({
    ...activation,
    active: {
      ...activation.active,
      patches: [
        { locator: "example.test/source", commit: "a".repeat(40), path: "patches/one.patch", sha256: "b".repeat(64) },
      ],
    },
  }, null, 2)}\n`);
  assertRefused(/activation and Composition Patch receipts disagree/);
  restoreActivation();

  renameSync(activationPath, `${activationPath}.real`);
  symlinkSync("activation.json.real", activationPath);
  assertRefused(/Malformed PorcuPi activation/);
  rmSync(activationPath);
  renameSync(`${activationPath}.real`, activationPath);

  const central = JSON.parse(centralBytes.toString());
  writeFileSync(centralPath, `${JSON.stringify({ ...central, porcupiVersion: "0.1.1" }, null, 2)}\n`);
  assertRefused(/Composition receipt mismatch/);
  writeFileSync(centralPath, centralBytes);
  chmodSync(embeddedPath, 0o644);
  const changedIdentity = { ...central, porcupiVersion: "0.1.1" };
  writeFileSync(centralPath, `${JSON.stringify(changedIdentity, null, 2)}\n`);
  writeFileSync(embeddedPath, `${JSON.stringify(changedIdentity, null, 2)}\n`);
  assertRefused(/Composition identity mismatch/);
  const malformedReceipt = { ...central, unknown: true };
  writeFileSync(centralPath, `${JSON.stringify(malformedReceipt, null, 2)}\n`);
  writeFileSync(embeddedPath, `${JSON.stringify(malformedReceipt, null, 2)}\n`);
  assertRefused(/Malformed Managed Pi Composition receipt/);
  writeFileSync(centralPath, centralBytes);
  writeFileSync(embeddedPath, embeddedBytes);
  chmodSync(embeddedPath, 0o444);

  chmodSync(composition, 0o755);
  renameSync(embeddedPath, `${embeddedPath}.real`);
  symlinkSync("receipt.json.real", embeddedPath);
  assertRefused(/Malformed embedded Composition receipt/);
  rmSync(embeddedPath);
  renameSync(`${embeddedPath}.real`, embeddedPath);
  chmodSync(composition, 0o555);

  const movedComposition = join(managedRoot, "compositions", `moved-${compositionId}`);
  renameSync(composition, movedComposition);
  symlinkSync(`moved-${compositionId}`, composition);
  assertRefused(/Malformed Managed Pi Composition root/);
  rmSync(composition);
  renameSync(movedComposition, composition);

  const receipts = join(managedRoot, "receipts");
  const movedReceipts = join(managedRoot, "receipts-real");
  renameSync(receipts, movedReceipts);
  symlinkSync("receipts-real", receipts);
  assertRefused(/Malformed PorcuPi receipts directory/);
  rmSync(receipts);
  renameSync(movedReceipts, receipts);

  activation.active.compositionId = "f".repeat(64);
  writeFileSync(activationPath, `${JSON.stringify(activation, null, 2)}\n`);
  assertRefused(/Malformed Managed Pi Composition root/);
});

test("strict Composition receipts reject validly rebound platform, executable-path, and payload-path mismatches", () => {
  const scenarios = [
    {
      name: "platform",
      mutate: (receipt) => { receipt.platform = `${process.platform === "darwin" ? "linux" : "darwin"}-${process.arch}`; },
      expected: /platform mismatch/,
    },
    {
      name: "required-executable-path",
      mutate: (receipt) => { receipt.requiredExecutable = { ...receipt.requiredExecutable, path: "../outside" }; },
      expected: /Malformed Managed Pi Composition receipt/,
    },
    {
      name: "duplicate-payload-path",
      mutate: (receipt) => { receipt.payload.splice(1, 0, { ...receipt.payload[0] }); },
      expected: /Malformed Managed Pi Composition receipt/,
    },
    {
      name: "traversing-payload-path",
      mutate: (receipt) => { receipt.payload[0] = { ...receipt.payload[0], path: "../outside" }; },
      expected: /Malformed Managed Pi Composition receipt/,
    },
  ];
  for (const scenario of scenarios) {
    const scenarioRoot = join(temporaryRoot(), scenario.name);
    const home = join(scenarioRoot, "home");
    mkdirSync(home, { recursive: true });
    const base = createPiBase(scenarioRoot);
    const release = createReleaseFixture(scenarioRoot, base);
    assert.equal(runInstaller(release, home).status, 0);
    rebindActiveReceipt(home, scenario.mutate);
    const launchLog = join(scenarioRoot, "must-not-launch.log");
    const result = runPorcuPiProcess(home, ["hello"], { PI_FIXTURE_LAUNCH_LOG: launchLog });
    assert.notEqual(result.status, 0, `${scenario.name} unexpectedly launched`);
    assert.match(`${result.stdout}${result.stderr}`, scenario.expected);
    assert.equal(existsSync(launchLog), false);
  }
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

test("porcupi add saves Patches and Pi resources together while delegating only resources to Pi", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createMixedArtifactRepository(root);
  const locator = await serveGitRepository(root, repository);
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const activationBefore = readFileSync(activationPath);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /4 Pi resource\(s\), 1 Patch\(es\) selected/);
  const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(settings.packages[0].extensions, ["extensions/fixture.ts"]);
  assert.deepEqual(settings.packages[0].skills, ["skills/fixture-skill/SKILL.md"]);
  assert.deepEqual(settings.packages[0].prompts, ["prompts/fixture.md"]);
  assert.deepEqual(settings.packages[0].themes, ["themes/fixture.json"]);
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.equal(selections.sources[0].artifacts.length, 5);
  const patch = selections.sources[0].artifacts.find((artifact) => artifact.kind === "Patch");
  assert.deepEqual(Object.keys(patch).sort(), ["kind", "path", "sha256"]);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("porcupi add discovers only exact regular nested Patches and leaves them pending", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createPatchRepository(root);
  const locator = await serveGitRepository(root, repository);
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const activationBefore = readFileSync(activationPath);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /Patch\s+patches\/alpha\.patch/);
  assert.match(add.stdout, /Patch\s+patches\/nested\/beta\.patch/);
  assert.match(add.stdout, /Rejected patches\/symbolic\.patch: Patch candidate is symbolic/);
  assert.match(add.stdout, /Rejected patches\/submodule: Patch candidate is a Git submodule/);
  assert.doesNotMatch(add.stdout, /not-a-patch\.txt/);
  assert.match(add.stdout, /2 Patch\(es\).*no Installation Scope|Patches do not have an Installation Scope/);
  assert.match(add.stdout, /Patch Selection Intent is pending `porcupi apply`/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  assert.equal(existsSync(join(home, ".pi", "agent", "settings.json")), false);

  const canonicalLocator = `127.0.0.1:${new URL(locator).port}/owner/resources`;
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.deepEqual(selections.sources, [{
    locator: canonicalLocator,
    commit: repository.commit,
    packageSource: `git:${locator}@${repository.commit}`,
    artifacts: [
      { kind: "Patch", path: "patches/alpha.patch", sha256: "15adc195c931723b85b314beb297d55a1cab3becf2ed2f2e8cca653297c45d8f" },
      { kind: "Patch", path: "patches/nested/beta.patch", sha256: "fa01de4182e25ce6287e9f1bfda7196c0f36438b19b244c3938497a8f970bf03" },
    ],
  }]);
});

test("porcupi apply builds and atomically activates the exact ordered Patch series", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createApplicablePatchRepository(root);
  const locator = await serveGitRepository(root, repository);
  assert.equal(runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d").status, 0);
  const secondRoot = join(root, "second-source");
  const secondRepository = createApplicablePatchRepository(secondRoot, [[
    "patches/independent.patch",
    newFilePatch("second-source.txt", "second source"),
  ]]);
  const secondServer = join(root, "second-server");
  mkdirSync(secondServer);
  const secondLocator = await serveGitRepository(secondServer, secondRepository);
  assert.equal(runPorcuPi(home, ["add", `${secondLocator}@main`], "616e6e0d").status, 0);
  const rootPath = dataRoot(home);
  const activationPath = join(rootPath, "state", "activation.json");
  const activationBefore = JSON.parse(readFileSync(activationPath, "utf8"));
  const selectionsBefore = readFileSync(join(rootPath, "state", "selections.json"));

  const cancelled = runPorcuPi(home, ["apply"], "1b", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, /Apply cancelled/);
  assert.match(cancelled.stdout, /\x1b\[\?25h/);
  assert.deepEqual(JSON.parse(readFileSync(activationPath, "utf8")), activationBefore);

  const apply = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });

  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  assert.match(apply.stdout, /Apply selected Patches/);
  const canonicalLocator = `127.0.0.1:${new URL(locator).port}/owner/resources`;
  const canonicalSecondLocator = `127.0.0.1:${new URL(secondLocator).port}/owner/resources`;
  const expectedOrder = [
    `${canonicalLocator} · patches/0002-first.patch`,
    `${canonicalLocator} · patches/nested/0001-second.patch`,
    `${canonicalSecondLocator} · patches/independent.patch`,
  ].sort();
  for (let index = 1; index < expectedOrder.length; index += 1) {
    assert.ok(apply.stdout.indexOf(expectedOrder[index - 1]) < apply.stdout.indexOf(expectedOrder[index]));
  }
  assert.match(apply.stdout, /git apply --check --whitespace=error-all/);
  assert.match(apply.stdout, /Activated Managed Pi Composition/);
  assert.match(apply.stdout, /Patch Selection Intent matches the active Managed Pi Composition/);
  assert.deepEqual(readFileSync(join(rootPath, "state", "selections.json")), selectionsBefore);

  const activation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.deepEqual(activation.previous, activationBefore.active);
  assert.equal(activation.active.patches.length, 3);
  const receiptPath = join(rootPath, "receipts", `${activation.active.compositionId}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.deepEqual(receipt.patches, activation.active.patches);
  assert.equal(receipt.porcupiVersion, porcupiVersion);
  assert.equal(receipt.piBase.commit, base.commit);
  assert.equal(receipt.recipe.id, "pi-v0.81.1-composition-v2");
  assert.equal(receipt.platform, `${process.platform}-${process.arch}`);
  assert.equal(receipt.requiredExecutable.path, "packages/coding-agent/dist/cli.js");
  assert.ok(receipt.payload.every((entry) => typeof entry.path === "string"
    && new Set(["file", "symlink"]).has(entry.kind)
    && Number.isInteger(entry.mode)
    && Number.isInteger(entry.size)
    && /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.equal(readFileSync(join(rootPath, "compositions", activation.active.compositionId, "payload", "series.txt"), "utf8"), "second\n");
  assert.equal(readFileSync(join(rootPath, "compositions", activation.active.compositionId, "payload", "second-source.txt"), "utf8"), "second source\n");
  assert.equal(lstatSync(join(rootPath, "compositions", activation.active.compositionId)).mode & 0o777, 0o555);
  assert.equal(lstatSync(join(rootPath, "compositions", activation.active.compositionId, "payload", "series.txt")).mode & 0o777, 0o444);
  assert.equal(lstatSync(join(rootPath, "compositions", activation.active.compositionId, "payload", "packages", "coding-agent", "dist", "cli.js")).mode & 0o777, 0o555);
  assert.deepEqual(
    readFileSync(receiptPath),
    readFileSync(join(rootPath, "compositions", activation.active.compositionId, "receipt.json")),
  );

  const remove = runPorcuPi(home, ["manage"], "206a206a206e6e0d", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
  const zero = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(zero.status, 0, zero.stderr || zero.stdout);
  assert.match(zero.stdout, /zero Patches/);
  const zeroActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.deepEqual(zeroActivation.active, activationBefore.active);
  assert.deepEqual(zeroActivation.previous, activation.active);
  assert.equal(readFileSync(join(rootPath, "compositions", zeroActivation.active.compositionId, "payload", "series.txt"), "utf8"), "base\n");

  const beforeNoOp = readFileSync(activationPath);
  const noOp = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(noOp.status, 0, noOp.stderr || noOp.stdout);
  assert.match(noOp.stdout, /no rebuild was needed/);
  assert.doesNotMatch(noOp.stdout, /npm ci|git clone/);
  assert.deepEqual(readFileSync(activationPath), beforeNoOp);

  const activeSeries = join(rootPath, "compositions", zeroActivation.active.compositionId, "payload", "series.txt");
  chmodSync(activeSeries, 0o644);
  writeFileSync(activeSeries, "corrupt\n");
  const corruptNoOp = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.notEqual(corruptNoOp.status, 0);
  assert.match(corruptNoOp.stdout, /payload inventory mismatch/);
  assert.doesNotMatch(corruptNoOp.stdout, /npm ci|git clone/);
  assert.deepEqual(readFileSync(activationPath), beforeNoOp);
});

test("porcupi rollback verifies and swaps the retained Composition without changing Selection Intent", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const managedRoot = dataRoot(home);
  const activationPath = join(managedRoot, "state", "activation.json");
  const initialActivation = JSON.parse(readFileSync(activationPath, "utf8"));

  const noTarget = runPorcuPi(home, ["rollback"], "0d", { PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.equal(noTarget.status, 0, noTarget.stderr || noTarget.stdout);
  assert.match(noTarget.stdout, /Previous: \(none retained\)/);
  assert.match(noTarget.stdout, /No previous Managed Pi Composition is retained/);
  assert.deepEqual(JSON.parse(readFileSync(activationPath, "utf8")), initialActivation);

  const repository = createApplicablePatchRepository(root, [[
    "patches/one.patch",
    textPatch("series.txt", "base", "patched"),
  ]]);
  const locator = await serveGitRepository(root, repository);
  assert.equal(runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d").status, 0);
  assert.equal(runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" }).status, 0);
  const patchedActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  const selectionsPath = join(managedRoot, "state", "selections.json");
  const selectionsBefore = readFileSync(selectionsPath);

  const cancelled = runPorcuPi(home, ["rollback"], "1b", { PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, /Rollback cancelled/);
  assert.match(cancelled.stdout, /\x1b\[\?25h/);
  assert.deepEqual(JSON.parse(readFileSync(activationPath, "utf8")), patchedActivation);

  const rolledBack = runPorcuPi(home, ["rollback"], "0d", { PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.equal(rolledBack.status, 0, rolledBack.stderr || rolledBack.stdout);
  assert.match(rolledBack.stdout, /uses only this retained local Composition/);
  assert.match(rolledBack.stdout, /Activated retained Managed Pi Composition/);
  assert.match(rolledBack.stdout, /Selection Intent is unchanged/);
  assert.doesNotMatch(rolledBack.stdout, /git clone|npm ci|build:offline/);
  const baseActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.deepEqual(baseActivation.active, initialActivation.active);
  assert.deepEqual(baseActivation.previous, patchedActivation.active);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);

  const previousSeries = join(managedRoot, "compositions", baseActivation.previous.compositionId, "payload", "series.txt");
  const previousSeriesBytes = readFileSync(previousSeries);
  const previousSeriesMode = lstatSync(previousSeries).mode & 0o777;
  chmodSync(previousSeries, 0o644);
  writeFileSync(previousSeries, "corrupt\n");
  const activationBeforeInvalid = readFileSync(activationPath);
  const invalid = runPorcuPi(home, ["rollback"], "0d", { PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.notEqual(invalid.status, 0);
  assert.match(`${invalid.stdout}${invalid.stderr}`, /payload inventory mismatch/);
  assert.deepEqual(readFileSync(activationPath), activationBeforeInvalid);
  writeFileSync(previousSeries, previousSeriesBytes);
  chmodSync(previousSeries, previousSeriesMode);

  const failedWrite = runPorcuPi(home, ["rollback"], "0d", {
    PTY_WAIT_FOR: "Roll back Managed Pi",
    PORCUPI_TEST_FAILURE: "rollback-activation-write",
  });
  assert.notEqual(failedWrite.status, 0);
  assert.match(`${failedWrite.stdout}${failedWrite.stderr}`, /Injected failure/);
  assert.deepEqual(readFileSync(activationPath), activationBeforeInvalid);

  const interrupted = runPorcuPi(home, ["rollback"], "0d", {
    PTY_WAIT_FOR: "Roll back Managed Pi",
    PORCUPI_TEST_FAULT: "rollback-activation-written",
  });
  assert.equal(interrupted.signal, "SIGKILL");
  const afterInterruption = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.deepEqual(afterInterruption.active, patchedActivation.active);
  assert.deepEqual(afterInterruption.previous, initialActivation.active);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
  assert.equal(existsSync(join(managedRoot, "compositions", afterInterruption.active.compositionId)), true);
  assert.equal(existsSync(join(managedRoot, "compositions", afterInterruption.previous.compositionId)), true);
});

test("lifecycle locking and process leases defer cleanup until running Managed Pi exits", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const managedRoot = dataRoot(home);
  const activationPath = join(managedRoot, "state", "activation.json");
  const initialId = JSON.parse(readFileSync(activationPath, "utf8")).active.compositionId;
  const launchLog = join(root, "held-launch.log");
  const heldLaunch = spawn(join(home, ".local", "bin", "porcupi"), ["held"], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      PI_FIXTURE_LAUNCH_LOG: launchLog,
      PI_FIXTURE_HOLD_MS: "12000",
    },
  });
  childProcesses.push(heldLaunch);
  for (let attempt = 0; attempt < 100 && !existsSync(launchLog); attempt += 1) await delay(20);
  assert.equal(existsSync(launchLog), true, "held Managed Pi did not start");
  assert.ok(readdirSync(join(managedRoot, "leases", initialId)).some((name) => name !== "owner.json"));

  const firstRepository = createApplicablePatchRepository(root, [[
    "patches/first.patch",
    textPatch("series.txt", "base", "first"),
  ]]);
  const firstLocator = await serveGitRepository(root, firstRepository);
  assert.equal(runPorcuPi(home, ["add", `${firstLocator}@main`], "616e6e0d").status, 0);
  assert.equal(runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" }).status, 0);

  const secondRoot = join(root, "second");
  const secondRepository = createApplicablePatchRepository(secondRoot, [[
    "patches/second.patch",
    newFilePatch("second.txt", "second"),
  ]]);
  const secondServer = join(root, "second-server");
  mkdirSync(secondServer);
  const secondLocator = await serveGitRepository(secondServer, secondRepository);
  assert.equal(runPorcuPi(home, ["add", `${secondLocator}@main`], "616e6e0d").status, 0);
  const secondApply = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(secondApply.status, 0, secondApply.stderr || secondApply.stdout);
  assert.match(secondApply.stdout, /Deferred cleanup.*process lease/);
  assert.equal(existsSync(join(managedRoot, "compositions", initialId)), true);

  await new Promise((resolvePromise) => heldLaunch.once("exit", resolvePromise));
  const lock = `${managedRoot}.lifecycle-lock`;
  const driver = join(repositoryRoot, "test", "support", "pty-driver.py");
  const holder = spawn("python3", [driver, "0d", join(home, ".local", "bin", "porcupi"), "rollback"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      PTY_WAIT_FOR: "Roll back Managed Pi",
      PORCUPI_TEST_HOLD_LOCK_MS: "1500",
    },
  });
  let holderOutput = "";
  holder.stdout.on("data", (chunk) => { holderOutput += chunk; });
  holder.stderr.on("data", (chunk) => { holderOutput += chunk; });
  for (let attempt = 0; attempt < 100 && !existsSync(lock); attempt += 1) await delay(20);
  assert.equal(existsSync(lock), true, "lifecycle lock was not acquired");

  const ordinaryLaunch = runPorcuPiProcess(home, ["--version"]);
  assert.equal(ordinaryLaunch.status, 0, ordinaryLaunch.stderr || ordinaryLaunch.stdout);
  const contended = runPorcuPi(home, ["rollback"], "0d", { PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.notEqual(contended.status, 0);
  assert.match(`${contended.stdout}${contended.stderr}`, /lifecycle operation is already in progress/);
  const holderResult = await new Promise((resolvePromise) => holder.once("close", (code, signal) => resolvePromise({ code, signal })));
  assert.equal(holderResult.code, 0, holderOutput);
  assert.equal(holderResult.signal, null);
  assert.equal(existsSync(join(managedRoot, "compositions", initialId)), false);
  assert.equal(existsSync(join(managedRoot, "receipts", `${initialId}.json`)), false);
  assert.equal(existsSync(join(managedRoot, "leases", initialId)), false);
  assert.deepEqual(readdirSync(join(managedRoot, "compositions")).sort(), [
    JSON.parse(readFileSync(activationPath, "utf8")).active.compositionId,
    JSON.parse(readFileSync(activationPath, "utf8")).previous.compositionId,
  ].sort());
});

test("interrupted receipt-proven cleanup converges and leaves foreign paths untouched", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const managedRoot = dataRoot(home);
  const activationPath = join(managedRoot, "state", "activation.json");
  const initialId = JSON.parse(readFileSync(activationPath, "utf8")).active.compositionId;

  const firstRepository = createApplicablePatchRepository(root, [[
    "patches/first.patch",
    textPatch("series.txt", "base", "first"),
  ]]);
  const firstLocator = await serveGitRepository(root, firstRepository);
  assert.equal(runPorcuPi(home, ["add", `${firstLocator}@main`], "616e6e0d").status, 0);
  assert.equal(runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" }).status, 0);

  const secondRoot = join(root, "second");
  const secondRepository = createApplicablePatchRepository(secondRoot, [[
    "patches/second.patch",
    newFilePatch("second.txt", "second"),
  ]]);
  const secondServer = join(root, "second-server");
  mkdirSync(secondServer);
  const secondLocator = await serveGitRepository(secondServer, secondRepository);
  assert.equal(runPorcuPi(home, ["add", `${secondLocator}@main`], "616e6e0d").status, 0);
  const interrupted = runPorcuPi(home, ["apply"], "0d", {
    PTY_WAIT_FOR: "Apply selected Patches",
    PORCUPI_TEST_FAULT: "cleanup-composition-staged",
  });
  assert.equal(interrupted.signal, "SIGKILL");
  const interruptedActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.notEqual(interruptedActivation.active.compositionId, initialId);
  assert.notEqual(interruptedActivation.previous.compositionId, initialId);
  assert.equal(existsSync(join(managedRoot, "compositions", initialId)), false);
  assert.equal(existsSync(join(managedRoot, "receipts", `${initialId}.json`)), true);
  assert.ok(readdirSync(join(managedRoot, "tmp")).some((name) => name.startsWith(`cleanup-${initialId}-`)));

  const foreignId = "f".repeat(64);
  symlinkSync(interruptedActivation.active.compositionId, join(managedRoot, "compositions", foreignId));
  const recovered = runPorcuPi(home, ["rollback"], "0d", { PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.match(recovered.stdout, /Left unproven Composition untouched/);
  assert.equal(existsSync(join(managedRoot, "receipts", `${initialId}.json`)), false);
  assert.equal(readdirSync(join(managedRoot, "tmp")).some((name) => name.startsWith("cleanup-")), false);
  assert.equal(lstatSync(join(managedRoot, "compositions", foreignId)).isSymbolicLink(), true);

  const beforeThird = JSON.parse(readFileSync(activationPath, "utf8"));
  const thirdRoot = join(root, "third");
  const thirdRepository = createApplicablePatchRepository(thirdRoot, [[
    "patches/third.patch",
    newFilePatch("third.txt", "third"),
  ]]);
  const thirdServer = join(root, "third-server");
  mkdirSync(thirdServer);
  const thirdLocator = await serveGitRepository(thirdServer, thirdRepository);
  assert.equal(runPorcuPi(home, ["add", `${thirdLocator}@main`], "616e6e0d").status, 0);
  const receiptRemoved = runPorcuPi(home, ["apply"], "0d", {
    PTY_WAIT_FOR: "Apply selected Patches",
    PORCUPI_TEST_FAULT: "cleanup-receipt-removed",
  });
  assert.equal(receiptRemoved.signal, "SIGKILL");
  const stagedId = beforeThird.previous.compositionId;
  assert.equal(existsSync(join(managedRoot, "compositions", stagedId)), false);
  assert.equal(existsSync(join(managedRoot, "receipts", `${stagedId}.json`)), false);
  assert.ok(readdirSync(join(managedRoot, "tmp")).some((name) => name.startsWith(`cleanup-${stagedId}-`)));

  const recoveredAfterReceipt = runPorcuPi(home, ["rollback"], "0d", { PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.equal(recoveredAfterReceipt.status, 0, recoveredAfterReceipt.stderr || recoveredAfterReceipt.stdout);
  assert.equal(readdirSync(join(managedRoot, "tmp")).some((name) => name.startsWith("cleanup-")), false);
  assert.equal(existsSync(join(managedRoot, "compositions", stagedId)), false);
  assert.equal(lstatSync(join(managedRoot, "compositions", foreignId)).isSymbolicLink(), true);
});

test("porcupi apply rejects digest drift and sequential preflight failure without publishing or activating", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createApplicablePatchRepository(root, [
    ["patches/0001-valid.patch", textPatch("series.txt", "base", "first")],
    ["patches/0002-invalid.patch", textPatch("series.txt", "missing", "second")],
  ]);
  const locator = await serveGitRepository(root, repository);
  assert.equal(runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d").status, 0);
  const rootPath = dataRoot(home);
  const activationPath = join(rootPath, "state", "activation.json");
  const selectionsPath = join(rootPath, "state", "selections.json");
  const activationBefore = readFileSync(activationPath);
  const compositionsBefore = readdirSync(join(rootPath, "compositions")).sort();
  const receiptsBefore = readdirSync(join(rootPath, "receipts")).sort();
  const selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  const originalCommit = selections.sources[0].commit;
  const originalPackageSource = selections.sources[0].packageSource;
  const missingCommit = "f".repeat(40);
  selections.sources[0].commit = missingCommit;
  selections.sources[0].packageSource = originalPackageSource.replace(`@${originalCommit}`, `@${missingCommit}`);
  writeFileSync(selectionsPath, `${JSON.stringify(selections, null, 2)}\n`);
  const missingSource = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.notEqual(missingSource.status, 0);
  assert.match(missingSource.stdout, /Git could not resolve the requested Source Repository/);
  assert.doesNotMatch(missingSource.stdout, /git apply --check|npm ci/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  selections.sources[0].commit = originalCommit;
  selections.sources[0].packageSource = originalPackageSource;
  const originalDigest = selections.sources[0].artifacts[0].sha256;
  selections.sources[0].artifacts[0].sha256 = "0".repeat(64);
  writeFileSync(selectionsPath, `${JSON.stringify(selections, null, 2)}\n`);

  const mismatch = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stdout, /Selected Patch digest mismatch/);
  assert.doesNotMatch(mismatch.stdout, /git apply --check|npm ci/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  selections.sources[0].artifacts[0].sha256 = originalDigest;
  writeFileSync(selectionsPath, `${JSON.stringify(selections, null, 2)}\n`);
  const preflight = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.notEqual(preflight.status, 0);
  assert.match(preflight.stdout, /git apply --check --whitespace=error-all/);
  assert.doesNotMatch(preflight.stdout, /npm ci/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  assert.deepEqual(readdirSync(join(rootPath, "compositions")).sort(), compositionsBefore);
  assert.deepEqual(readdirSync(join(rootPath, "receipts")).sort(), receiptsBefore);
  assert.deepEqual(readdirSync(join(rootPath, "tmp")).filter((name) => name.startsWith("apply-")), []);
});

test("post-preflight recipe and receipt failures leave activation and publication unchanged", async () => {
  const root = temporaryRoot();
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  const scenarios = [
    {
      name: "install",
      expected: /npm.*exited with status/,
      patch: patchFromBase(base.source, "package-lock.json", () => "{\n"),
    },
    {
      name: "build",
      expected: /fixture build failed|npm exited with status 23/,
      patch: buildCommandPatch(base.source, "node scripts/fail-build.mjs"),
    },
    {
      name: "conformance",
      expected: /node exited with status 41/,
      patch: buildCommandPatch(base.source, `node scripts/build.mjs && node -e "require('node:fs').appendFileSync('packages/coding-agent/dist/cli.js', '\\nif (process.argv[2] === \\\"--help\\\") process.exit(41);\\n')"`),
    },
    {
      name: "smoke",
      expected: /node exited with status 42/,
      patch: buildCommandPatch(base.source, `node scripts/build.mjs && node -e "require('node:fs').appendFileSync('packages/coding-agent/dist/cli.js', '\\nif (process.argv[2] === \\\"--list-models\\\") process.exit(42);\\n')"`),
    },
    {
      name: "receipt",
      expected: /Payload symbolic link escapes the Managed Pi Composition/,
      patch: escapingSymlinkPatch("packages/escape"),
    },
  ];

  for (const scenario of scenarios) {
    const scenarioRoot = join(root, scenario.name);
    const home = join(scenarioRoot, "home");
    mkdirSync(home, { recursive: true });
    assert.equal(runInstaller(release, home).status, 0);
    const repository = createApplicablePatchRepository(join(scenarioRoot, "source"), [["patches/failure.patch", scenario.patch]]);
    const serverRoot = join(scenarioRoot, "server");
    mkdirSync(serverRoot);
    const locator = await serveGitRepository(serverRoot, repository);
    assert.equal(runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d").status, 0);
    const rootPath = dataRoot(home);
    const activationPath = join(rootPath, "state", "activation.json");
    const activationBefore = readFileSync(activationPath);
    const compositionsBefore = readdirSync(join(rootPath, "compositions")).sort();
    const receiptsBefore = readdirSync(join(rootPath, "receipts")).sort();

    const apply = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });

    assert.notEqual(apply.status, 0, `${scenario.name} unexpectedly succeeded`);
    assert.match(apply.stdout, scenario.expected);
    assert.deepEqual(readFileSync(activationPath), activationBefore);
    assert.deepEqual(readdirSync(join(rootPath, "compositions")).sort(), compositionsBefore);
    assert.deepEqual(readdirSync(join(rootPath, "receipts")).sort(), receiptsBefore);
    assert.deepEqual(readdirSync(join(rootPath, "tmp")).filter((name) => name.startsWith("apply-")), []);
  }
});

test("interrupted Patch publication and activation expose only complete old or new state and recover", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createApplicablePatchRepository(root);
  const locator = await serveGitRepository(root, repository);
  assert.equal(runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d").status, 0);
  const rootPath = dataRoot(home);
  const activationPath = join(rootPath, "state", "activation.json");
  const oldActivation = JSON.parse(readFileSync(activationPath, "utf8"));

  const published = runPorcuPi(home, ["apply"], "0d", {
    PTY_WAIT_FOR: "Apply selected Patches",
    PORCUPI_TEST_FAULT: "apply-composition-published",
  });
  assert.equal(published.signal, "SIGKILL");
  assert.deepEqual(JSON.parse(readFileSync(activationPath, "utf8")), oldActivation);
  const publishedIds = readdirSync(join(rootPath, "receipts")).map((name) => name.replace(/\.json$/, ""));
  assert.equal(publishedIds.length, 2);
  const candidateId = publishedIds.find((id) => id !== oldActivation.active.compositionId);
  assert.deepEqual(
    readFileSync(join(rootPath, "receipts", `${candidateId}.json`)),
    readFileSync(join(rootPath, "compositions", candidateId, "receipt.json")),
  );
  assert.equal(readFileSync(join(rootPath, "compositions", candidateId, "payload", "series.txt"), "utf8"), "second\n");
  const centralPath = join(rootPath, "receipts", `${candidateId}.json`);
  const centralBefore = readFileSync(centralPath);
  writeFileSync(centralPath, "{}\n");
  const collision = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.notEqual(collision.status, 0);
  assert.match(collision.stdout, /central receipt collision/);
  assert.deepEqual(JSON.parse(readFileSync(activationPath, "utf8")), oldActivation);
  writeFileSync(centralPath, centralBefore);
  const activationFailure = runPorcuPi(home, ["apply"], "0d", {
    PTY_WAIT_FOR: "Apply selected Patches",
    PORCUPI_TEST_FAILURE: "apply-activation-write",
  });
  assert.notEqual(activationFailure.status, 0);
  assert.match(activationFailure.stdout, /Injected failure at apply-activation-write/);
  assert.deepEqual(JSON.parse(readFileSync(activationPath, "utf8")), oldActivation);

  const retry = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  let activation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.equal(activation.active.compositionId, candidateId);
  assert.deepEqual(activation.previous, oldActivation.active);
  assert.deepEqual(readdirSync(join(rootPath, "tmp")).filter((name) => name.startsWith("apply-")), []);

  const remove = runPorcuPi(home, ["manage"], "206a206e6e0d", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
  const activated = runPorcuPi(home, ["apply"], "0d", {
    PTY_WAIT_FOR: "Apply selected Patches",
    PORCUPI_TEST_FAULT: "apply-activation-written",
  });
  assert.equal(activated.signal, "SIGKILL");
  activation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.deepEqual(activation.active, oldActivation.active);
  assert.equal(activation.previous.compositionId, candidateId);
  assert.equal(readdirSync(join(rootPath, "tmp")).filter((name) => name.startsWith("apply-")).length, 1);

  const converge = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(converge.status, 0, converge.stderr || converge.stdout);
  assert.match(converge.stdout, /no rebuild was needed/);
  assert.deepEqual(JSON.parse(readFileSync(activationPath, "utf8")), activation);
  assert.deepEqual(readdirSync(join(rootPath, "tmp")).filter((name) => name.startsWith("apply-")), []);
});

test("porcupi manage removes Patch intent without giving Patches an Installation Scope", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createPatchRepository(root);
  const locator = await serveGitRepository(root, repository);
  assert.equal(runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d").status, 0);
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const activationBefore = readFileSync(activationPath);

  const manage = runPorcuPi(home, ["manage"], "6a206e6e0d", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });

  assert.equal(manage.status, 0, manage.stderr || manage.stdout);
  assert.match(manage.stdout, /Patches do not have an Installation Scope and are not listed on this page/);
  assert.match(manage.stdout, /Remove Patch.*patches\/nested\/beta\.patch/);
  assert.match(manage.stdout, /Patch Selection Intent is pending `porcupi apply`/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  assert.equal(existsSync(join(home, ".pi", "agent", "settings.json")), false);
  let selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  assert.deepEqual(selections.sources[0].artifacts, [{
    kind: "Patch",
    path: "patches/alpha.patch",
    sha256: "15adc195c931723b85b314beb297d55a1cab3becf2ed2f2e8cca653297c45d8f",
  }]);

  const selectionsBeforeCancellation = readFileSync(selectionsPath);
  const cancelled = runPorcuPi(home, ["manage"], "206e1b", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, /Management cancelled/);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBeforeCancellation);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("re-adding a Patch source reviews exact commit and digest replacement without retargeting silently", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createPatchRepository(root);
  mkdirSync(join(repository.source, "extensions"));
  writeFileSync(join(repository.source, "extensions", "alongside.ts"), "export default function alongside() {}\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add Pi resource beside Patches");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const oldCommit = repository.commit;
  git(repository.source, "tag", "old-patches");
  writeFileSync(join(repository.source, "patches", "alpha.patch"), "alpha patch revision two\n");
  git(repository.source, "add", "patches/alpha.patch");
  git(repository.source, "commit", "-m", "Revise selected Patch bytes");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  assert.equal(runPorcuPi(home, ["add", `${locator}@old-patches`], "616e6e0d").status, 0);
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const selectionsBefore = readFileSync(selectionsPath);
  const activationBefore = readFileSync(activationPath);

  const cancelled = runPorcuPi(home, ["add", `${locator}@main`], "1b");
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  const replacement = runPorcuPi(home, ["add", `${locator}@main`], "6e6e6a0d");
  assert.equal(replacement.status, 0, replacement.stderr || replacement.stdout);
  assert.match(replacement.stdout, new RegExp(`Source-wide change: ${oldCommit} → ${repository.commit}`));
  assert.match(replacement.stdout, /Patch bytes changed: patches\/alpha\.patch .*15adc195c931.*a56651b16b4c/);
  let selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  assert.equal(selections.sources[0].commit, repository.commit);
  assert.equal(selections.sources[0].artifacts.find((artifact) => artifact.path === "patches/alpha.patch").sha256, "a56651b16b4c629952286285ac23b9a490bd10e88bcf2430b079bbc917b3b449");
  const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.match(settings.packages[0].source, new RegExp(`@${repository.commit}$`));
  assert.deepEqual(settings.packages[0].extensions, ["extensions/alongside.ts"]);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  const patchIndex = selections.sources[0].artifacts.findIndex((artifact) => artifact.path === "patches/alpha.patch");
  selections.sources[0].artifacts[patchIndex].sha256 = "0".repeat(64);
  writeFileSync(selectionsPath, `${JSON.stringify(selections, null, 2)}\n`);
  const mismatch = runPorcuPi(home, ["add", `${locator}@main`], "");
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stdout, /saved Patch digest does not match its exact Source Repository commit/i);
  assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].artifacts[patchIndex].sha256, "0".repeat(64));
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("invalid Patch metadata is prominently ignored as a whole without suppressing convention discovery", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createPatchRepository(root);
  writeFileSync(join(repository.source, "porcupi.json"), "{\n");
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Malformed metadata");
  git(repository.source, "tag", "malformed-metadata");
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    patches: [{ path: "patches/alpha.patch", scripts: ["./configure.sh"] }],
  })}\n`);
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Unsupported metadata");
  git(repository.source, "tag", "unsupported-metadata");
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    patches: [
      { path: "patches/alpha.patch", displayName: "First claim" },
      { path: "patches/alpha.patch", displayName: "Contradictory claim" },
    ],
  })}\n`);
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Contradictory metadata");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);

  const malformed = runPorcuPi(home, ["add", `${locator}@malformed-metadata`], "1b");
  const unsupported = runPorcuPi(home, ["add", `${locator}@unsupported-metadata`], "1b");
  const contradictory = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");

  assert.equal(malformed.status, 0, malformed.stderr || malformed.stdout);
  assert.match(malformed.stdout, /Patch metadata is invalid and ignored as a whole: malformed JSON/);
  assert.equal(unsupported.status, 0, unsupported.stderr || unsupported.stdout);
  assert.match(unsupported.stdout, /unsupported field or unsafe Patch path/);
  assert.equal(contradictory.status, 0, contradictory.stderr || contradictory.stdout);
  assert.match(contradictory.stdout, /duplicate Patch entry patches\/alpha\.patch/);
  assert.doesNotMatch(contradictory.stdout, /First claim|Contradictory claim/);
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.deepEqual(selections.sources[0].artifacts.map((artifact) => artifact.path), [
    "patches/alpha.patch",
    "patches/nested/beta.patch",
  ]);
});

test("valid Patch metadata overlays display and blocks declared Pi Base incompatibility", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createPatchRepository(root);
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    patches: [
      {
        path: "patches/alpha.patch",
        displayName: "Alpha improvement",
        description: "Improves alpha behavior.",
        supportedPiBaseVersions: ["v0.81.1"],
        supportedPiBaseCommits: [base.commit],
      },
      {
        path: "patches/nested/beta.patch",
        displayName: "Future beta",
        supportedPiBaseCommits: ["f".repeat(40)],
      },
      {
        path: "patches/missing.patch",
        displayName: "Missing Patch",
      },
    ],
  }, null, 2)}\n`);
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Add narrow Patch metadata");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /Alpha improvement/);
  assert.match(add.stdout, /Improves alpha behavior/);
  assert.match(add.stdout, /Future beta.*not supported by this Pi Base/);
  assert.match(add.stdout, /Patch metadata entry patches\/missing\.patch does not address a discovered regular Patch/);
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.deepEqual(selections.sources[0].artifacts, [{
    kind: "Patch",
    path: "patches/alpha.patch",
    sha256: "15adc195c931723b85b314beb297d55a1cab3becf2ed2f2e8cca653297c45d8f",
  }]);
});

test("porcupi add installs every resource kind in project scope without granting Pi project trust", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(join(project, ".pi"), { recursive: true });
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const locator = await serveGitRepository(root, repository);
  const packageSource = `git:${locator}@${repository.commit}`;
  const globalSettingsPath = join(home, ".pi", "agent", "settings.json");
  mkdirSync(dirname(globalSettingsPath), { recursive: true });
  writeFileSync(globalSettingsPath, `${JSON.stringify({ packages: ["npm:global-foreign", packageSource], theme: "dark" }, null, 2)}\n`);
  const projectSettingsPath = join(project, ".pi", "settings.json");
  writeFileSync(projectSettingsPath, `${JSON.stringify({ packages: ["npm:project-foreign"], quietStartup: true }, null, 2)}\n`);
  const globalBefore = readFileSync(globalSettingsPath);
  const packageLog = join(root, "package.log");
  const trustLog = join(root, "trust.log");

  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e206a206a206a206e0d", {
    PI_FIXTURE_PACKAGE_LOG: packageLog,
    PI_FIXTURE_PROJECT_TRUST_LOG: trustLog,
  }, project);

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /Project.*project/);
  assert.deepEqual(readFileSync(globalSettingsPath), globalBefore);
  const projectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf8"));
  assert.deepEqual(projectSettings, {
    packages: [
      "npm:project-foreign",
      {
        source: packageSource,
        extensions: ["extensions/fixture.ts"],
        skills: ["skills/fixture-skill/SKILL.md"],
        prompts: ["prompts/fixture.md"],
        themes: ["themes/fixture.json"],
      },
    ],
    quietStartup: true,
  });
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  const canonicalProject = realpathSync(project);
  assert.deepEqual(selections.sources[0].artifacts, [
    { kind: "Extension", path: "extensions/fixture.ts", scope: "project", projectRoot: canonicalProject },
    { kind: "Prompt", path: "prompts/fixture.md", scope: "project", projectRoot: canonicalProject },
    { kind: "Skill", path: "skills/fixture-skill/SKILL.md", scope: "project", projectRoot: canonicalProject },
    { kind: "Theme", path: "themes/fixture.json", scope: "project", projectRoot: canonicalProject },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(packageLog, "utf8").trim()), ["install", packageSource, "-l"]);
  assert.match(readFileSync(trustLog, "utf8"), /Pi decided project trust/);
  assert.equal(existsSync(join(home, ".pi", "agent", "trust.json")), false);
});

test("declining Pi project trust saves no project Selection Intent", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const locator = await serveGitRepository(root, repository);
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const activationBefore = readFileSync(activationPath);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "206e206e0d", {
    PI_FIXTURE_PROJECT_TRUST: "deny",
  }, project);

  assert.notEqual(add.status, 0);
  assert.match(add.stdout, /Project is not trusted/);
  assert.match(add.stdout, /Pi package lifecycle failed with status 32/);
  assert.equal(existsSync(join(project, ".pi", "settings.json")), false);
  assert.equal(existsSync(join(dataRoot(home), "state", "selections.json")), false);
  assert.equal(existsSync(join(home, ".pi", "agent", "trust.json")), false);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("porcupi manage removes resources and moves retained intent between global and project scopes", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(join(project, ".pi"), { recursive: true });
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const locator = await serveGitRepository(root, repository);
  const packageLog = join(root, "package.log");
  const environment = { PI_FIXTURE_PACKAGE_LOG: packageLog };
  assert.equal(runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d", environment, project).status, 0);
  const projectSettingsPath = join(project, ".pi", "settings.json");
  writeFileSync(projectSettingsPath, `${JSON.stringify({ packages: ["npm:project-foreign"], quietStartup: true }, null, 2)}\n`);
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const activationBefore = readFileSync(activationPath);

  const manage = runPorcuPi(home, ["manage"], "6a206e206a6a206e0d", {
    ...environment,
    PTY_WAIT_FOR: "1 of 3 — Keep or remove",
  }, project);

  assert.equal(manage.status, 0, manage.stderr || manage.stdout);
  assert.match(manage.stdout, /1 of 3 — Keep or remove current selections/);
  assert.match(manage.stdout, /2 of 3 — Choose Installation Scope/);
  assert.match(manage.stdout, /3 of 3 — Review and save/);
  assert.match(manage.stdout, /Remove Prompt/);
  assert.match(manage.stdout, /Move Extension to project/);
  assert.match(manage.stdout, /Move Theme to project/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  const packageSource = `git:${locator}@${repository.commit}`;
  const globalSettings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(globalSettings.packages, [{
    source: packageSource,
    extensions: [],
    skills: ["skills/fixture-skill/SKILL.md"],
    prompts: [],
    themes: [],
  }]);
  const projectSettings = JSON.parse(readFileSync(projectSettingsPath, "utf8"));
  assert.deepEqual(projectSettings, {
    packages: [
      "npm:project-foreign",
      {
        source: packageSource,
        autoload: false,
        extensions: ["extensions/fixture.ts"],
        skills: [],
        prompts: [],
        themes: ["themes/fixture.json"],
      },
    ],
    quietStartup: true,
  });
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.deepEqual(selections.sources[0].artifacts, [
    { kind: "Extension", path: "extensions/fixture.ts", scope: "project", projectRoot: realpathSync(project) },
    { kind: "Skill", path: "skills/fixture-skill/SKILL.md", scope: "global" },
    { kind: "Theme", path: "themes/fixture.json", scope: "project", projectRoot: realpathSync(project) },
  ]);
  let calls = readFileSync(packageLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.slice(-2), [["install", packageSource], ["install", packageSource, "-l"]]);

  const moveBack = runPorcuPi(home, ["manage"], "6e206a6a206e0d", {
    ...environment,
    PTY_WAIT_FOR: "1 of 3 — Keep or remove",
  }, project);
  assert.equal(moveBack.status, 0, moveBack.stderr || moveBack.stdout);
  const movedGlobalSettings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(movedGlobalSettings.packages[0], {
    source: packageSource,
    extensions: ["extensions/fixture.ts"],
    skills: ["skills/fixture-skill/SKILL.md"],
    prompts: [],
    themes: ["themes/fixture.json"],
  });
  assert.deepEqual(JSON.parse(readFileSync(projectSettingsPath, "utf8")), {
    packages: ["npm:project-foreign"],
    quietStartup: true,
  });
  calls = readFileSync(packageLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.slice(-2), [["install", packageSource], ["remove", packageSource, "-l"]]);
});

test("porcupi manage lists every Source Repository and cancellation preserves reviewed state", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const sourceRootA = join(root, "source-a");
  const sourceRootB = join(root, "source-b");
  const serverRootA = join(root, "server-a");
  const serverRootB = join(root, "server-b");
  for (const path of [sourceRootA, sourceRootB, serverRootA, serverRootB]) mkdirSync(path);
  const repositoryA = createResourceRepository(sourceRootA);
  const repositoryB = createResourceRepository(sourceRootB);
  writeFileSync(join(repositoryB.source, "prompts", "second-source.md"), "Second source.\n");
  git(repositoryB.source, "add", ".");
  git(repositoryB.source, "commit", "-m", "Distinguish second source");
  repositoryB.commit = git(repositoryB.source, "rev-parse", "HEAD");
  const locatorA = await serveGitRepository(serverRootA, repositoryA);
  const locatorB = await serveGitRepository(serverRootB, repositoryB);
  assert.equal(runPorcuPi(home, ["add", `${locatorA}@main`], "206e6e0d").status, 0);
  assert.equal(runPorcuPi(home, ["add", `${locatorB}@main`], "206e6e0d").status, 0);
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const settingsBefore = readFileSync(settingsPath);
  const selectionsBefore = readFileSync(selectionsPath);
  const activationBefore = readFileSync(activationPath);

  const cancelled = runPorcuPi(home, ["manage"], "64616e6e68681b", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });

  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, new RegExp(`127\\.0\\.0\\.1:${new URL(locatorA).port}/owner/resources`));
  assert.match(cancelled.stdout, new RegExp(`127\\.0\\.0\\.1:${new URL(locatorB).port}/owner/resources`));
  assert.match(cancelled.stdout, /Management cancelled/);
  assert.match(cancelled.stdout, /\x1b\[\?25h/);
  assert.deepEqual(readFileSync(settingsPath), settingsBefore);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  const interrupted = runPorcuPi(home, ["manage"], "03", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(interrupted.status, 0, interrupted.stderr || interrupted.stdout);
  assert.match(interrupted.stdout, /Management cancelled/);
  assert.match(interrupted.stdout, /\x1b\[\?25h/);
  assert.deepEqual(readFileSync(settingsPath), settingsBefore);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("a manage package failure restores both scopes and leaves Selection Intent and activation unchanged", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(join(project, ".pi"), { recursive: true });
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const locator = await serveGitRepository(root, repository);
  const packageLog = join(root, "package.log");
  assert.equal(runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d", { PI_FIXTURE_PACKAGE_LOG: packageLog }, project).status, 0);
  const projectSettingsPath = join(project, ".pi", "settings.json");
  writeFileSync(projectSettingsPath, `${JSON.stringify({ packages: ["npm:project-foreign"], quietStartup: true }, null, 2)}\n`);
  const globalSettingsPath = join(home, ".pi", "agent", "settings.json");
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const activationPath = join(dataRoot(home), "state", "activation.json");
  const globalBefore = readFileSync(globalSettingsPath);
  const projectBefore = readFileSync(projectSettingsPath);
  const selectionsBefore = readFileSync(selectionsPath);
  const activationBefore = readFileSync(activationPath);

  const manage = runPorcuPi(home, ["manage"], "6e206e0d", {
    PI_FIXTURE_PACKAGE_LOG: packageLog,
    PI_FIXTURE_PACKAGE_FAIL_SCOPE: "project",
    PTY_WAIT_FOR: "1 of 3 — Keep or remove",
  }, project);

  assert.notEqual(manage.status, 0);
  assert.match(manage.stdout, /fixture Pi package install failed/);
  assert.match(manage.stdout, /Pi package lifecycle failed with status 31/);
  assert.match(manage.stdout, /\x1b\[\?25h/);
  assert.deepEqual(readFileSync(globalSettingsPath), globalBefore);
  assert.deepEqual(readFileSync(projectSettingsPath), projectBefore);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  const packageSource = `git:${locator}@${repository.commit}`;
  const calls = readFileSync(packageLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.slice(-4), [
    ["install", packageSource],
    ["install", packageSource, "-l"],
    ["remove", packageSource, "-l"],
    ["install", packageSource],
  ]);
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
