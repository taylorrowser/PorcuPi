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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  mkdirSync(join(source, "packages", "tui", "dist"), { recursive: true });
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
  writeFileSync(
    join(source, "packages", "tui", "dist", "index.js"),
    `export class TUI {
  constructor(onRender) { this.onRender = onRender; this.children = []; }
  requestRender() { this.onRender(); }
}
`,
  );
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
    `import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { getPriority } from "node:os";
import { join } from "node:path";
const output = join(process.cwd(), "packages", "coding-agent", "dist");
if (process.env.PI_FIXTURE_BUILD_LOG) appendFileSync(process.env.PI_FIXTURE_BUILD_LOG, "build\\n");
if (process.env.PI_FIXTURE_BUILD_PRIORITY_LOG) appendFileSync(process.env.PI_FIXTURE_BUILD_PRIORITY_LOG, String(getPriority()) + "\\n");
mkdirSync(output, { recursive: true });
if (process.env.PI_FIXTURE_LEXICAL_PREFIX_PATHS) {
  mkdirSync(join(output, "prefix"), { recursive: true });
  writeFileSync(join(output, "prefix", "child"), "nested\\n");
  writeFileSync(join(output, "prefix-sibling"), "sibling\\n");
}
const cli = join(output, "cli.js");
writeFileSync(cli, \`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TUI } from "../../tui/dist/index.js";
const args = process.argv.slice(2);
if (process.env.PI_FIXTURE_FORWARD_LOG) {
  appendFileSync(process.env.PI_FIXTURE_FORWARD_LOG, JSON.stringify(args) + "\\\\n");
} else if (process.env.PI_FIXTURE_TUI === "1") {
  if (args.includes("--offline")) process.env.PI_OFFLINE = "1";
  const extensionIndex = args.indexOf("--extension");
  if (extensionIndex < 0 || !args[extensionIndex + 1]) throw new Error("Managed Pi TUI Integration was not loaded");
  const extension = await import(args[extensionIndex + 1]);
  const handlers = new Map();
  let renderCount = 0;
  let renderReason = "update";
  let sessionReason;
  const frameLog = process.env.PI_FIXTURE_TUI_FRAME_LOG;
  const width = Number(process.env.PI_FIXTURE_TUI_WIDTH || 80);
  const widgetContainer = {
    children: [],
    addChild(child) { this.children.push(child); },
    clear() { this.children = []; },
  };
  const render = () => {
    if (!frameLog) return;
    const component = widgetContainer.children.find((child) => typeof child.render === "function");
    const lines = component ? ["", ...component.render(width)] : [""];
    appendFileSync(frameLog, JSON.stringify({ reason: renderReason, sessionReason, renderCount: ++renderCount, width, lines }) + "\\\\n");
  };
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const tui = new TUI(render);
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      setWidget(id, value) {
        if (id !== "porcupi-release-status") throw new Error("Unexpected Managed Pi TUI widget identity: " + id);
        const component = typeof value === "function"
          ? value(tui, theme)
          : { render: () => value, invalidate() {} };
        widgetContainer.clear();
        widgetContainer.addChild({});
        widgetContainer.addChild(component);
        tui.requestRender();
      },
    },
  };
  const pi = {
    on(event, handler) {
      const values = handlers.get(event) || [];
      values.push(handler);
      handlers.set(event, values);
    },
  };
  await extension.default(pi);
  let startupRenderCount = 0;
  const startupTui = new TUI(() => { startupRenderCount += 1; });
  startupTui.children.push({});
  startupTui.requestRender();
  if (startupRenderCount !== 1) throw new Error("Managed Pi TUI Integration blocked Pi's project-trust UI");
  tui.children.push({}, {}, {}, {}, widgetContainer);
  renderReason = "pre-bind";
  tui.requestRender();
  const sessionReasons = (process.env.PI_FIXTURE_TUI_SESSION_REASONS || "startup").split(",");
  for (let index = 0; index < sessionReasons.length; index += 1) {
    sessionReason = sessionReasons[index];
    if (index > 0) {
      if (sessionReason === "reload") {
        widgetContainer.clear();
        widgetContainer.addChild({});
        renderReason = "reload-reset";
        tui.requestRender();
      }
      for (const handler of handlers.get("session_shutdown") || []) await handler({ reason: sessionReason }, ctx);
    }
    renderReason = "session-start";
    for (const handler of handlers.get("session_start") || []) await handler({ reason: sessionReason }, ctx);
    renderReason = "update";
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.PI_FIXTURE_TUI_WAIT_MS || 250)));
  }
  widgetContainer.children.find((child) => typeof child.invalidate === "function")?.invalidate();
  renderReason = "theme-invalidation";
  tui.requestRender();
  renderReason = "repeated";
  tui.requestRender();
  for (const handler of handlers.get("session_shutdown") || []) await handler({ reason: "quit" }, ctx);
} else if (process.env.PI_FIXTURE_CHECK_FAIL === args[0]) process.exitCode = 44;
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
  const failOnce = (statePath) => {
    if (!statePath || existsSync(statePath)) return false;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "failed\\\\n");
    return true;
  };
  const failAttempts = (statePath, limitValue) => {
    const limit = Number(limitValue);
    if (!statePath || !Number.isInteger(limit) || limit < 1) return false;
    const count = existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
    if (count >= limit) return false;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, String(count + 1));
    return true;
  };
  const trustSource = process.env.PI_FIXTURE_PROJECT_TRUST_DENY_SOURCE;
  const trustDenied = local && process.env.PI_FIXTURE_PROJECT_TRUST === "deny" && (!trustSource || source.includes(trustSource));
  const failOnceScope = args[0] === "install"
    && scope === process.env.PI_FIXTURE_PACKAGE_FAIL_ONCE_SCOPE
    && failOnce(process.env.PI_FIXTURE_PACKAGE_FAIL_ONCE_STATE);
  const failSourceAttempts = args[0] === "install"
    && source.includes(process.env.PI_FIXTURE_PACKAGE_FAIL_ATTEMPTS_SOURCE || "\0")
    && failAttempts(process.env.PI_FIXTURE_PACKAGE_FAIL_ATTEMPTS_STATE, process.env.PI_FIXTURE_PACKAGE_FAIL_ATTEMPTS);
  if (trustDenied) {
    console.error("Project is not trusted");
    process.exitCode = 32;
  } else if (args[0] === "install" && (process.env.PI_FIXTURE_PACKAGE_FAIL || scope === process.env.PI_FIXTURE_PACKAGE_FAIL_SCOPE || source.includes(process.env.PI_FIXTURE_PACKAGE_FAIL_SOURCE || "\0") || failOnceScope || failSourceAttempts)) {
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
    if (process.env.PI_FIXTURE_PACKAGE_SNAPSHOT_ROOT) {
      mkdirSync(process.env.PI_FIXTURE_PACKAGE_SNAPSHOT_ROOT, { recursive: true });
      const snapshotPath = join(process.env.PI_FIXTURE_PACKAGE_SNAPSHOT_ROOT, scope + ".txt");
      if (args[0] === "remove") rmSync(snapshotPath, { force: true });
      else writeFileSync(snapshotPath, source + "\\\\n");
    }
    const failAfterSource = process.env.PI_FIXTURE_PACKAGE_FAIL_AFTER_SNAPSHOT_SOURCE;
    const failAfterSnapshot = args[0] === "install"
      && scope === process.env.PI_FIXTURE_PACKAGE_FAIL_AFTER_SNAPSHOT_SCOPE
      && (!failAfterSource || source.includes(failAfterSource))
      && failOnce(process.env.PI_FIXTURE_PACKAGE_FAIL_AFTER_SNAPSHOT_STATE);
    if (failAfterSnapshot) {
      console.error("fixture Pi package install failed after changing its source snapshot");
      process.exitCode = 33;
    } else console.log((args[0] === "remove" ? "Removed " : "Installed ") + source);
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
    releaseRecord.npmArtifact = {
      name: packageManifest.name,
      version: packageManifest.version,
      executable: "porcupi",
      packageInputsSha256: releaseRecord.packageInputsSha256,
    };
    writeFileSync(releaseRecordPath, `${JSON.stringify(releaseRecord, null, 2)}\n`);
  }
  return release;
}

function setReleaseFixtureVersion(release, version, { supportedUpgradeFrom } = {}) {
  if (supportedUpgradeFrom) {
    const installerPath = join(release, "src", "install.mjs");
    const installer = readFileSync(installerPath, "utf8");
    const contractStart = "const upgradeMigrationContracts = new Map([\n";
    assert.ok(installer.includes(contractStart));
    writeFileSync(installerPath, installer.replace(
      contractStart,
      `${contractStart}  [migrationContractKey("${supportedUpgradeFrom}", "${version}"), Object.freeze({ sourceStateSchema: 1, targetStateSchema: 1 })],\n`,
    ));
  }
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
  releaseRecord.source.tag = `v${version}`;
  const packageInputHash = createHash("sha256");
  const packageInputPaths = ["package.json", ...manifest.files.filter((path) => !path.startsWith("release/"))].sort();
  for (const path of packageInputPaths) {
    packageInputHash.update(`${JSON.stringify(path)}\0`);
    packageInputHash.update(readFileSync(join(release, path)));
    packageInputHash.update("\0");
  }
  releaseRecord.packageInputsSha256 = packageInputHash.digest("hex");
  releaseRecord.npmArtifact = {
    name: manifest.name,
    version,
    executable: "porcupi",
    packageInputsSha256: releaseRecord.packageInputsSha256,
  };
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

function createUpgradeFixture() {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const historicalRelease = createReleaseFixture(root, base, "0.81.1", { historicalRef: "v0.1.0" });
  const targetRelease = createReleaseFixture(root, base);
  const artifact = packRelease(targetRelease, root);
  return { artifact, base, historicalRelease, home, root, targetRelease };
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

function serveReleaseStatus(root) {
  const responsePath = join(root, "release-status-response.json");
  const requestLog = join(root, "release-status-requests.log");
  const delayPath = join(root, "release-status-delay.txt");
  const serverPath = join(root, "release-status-server.py");
  const port = Number(execFileSync("python3", ["-c", "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"], { encoding: "utf8" }).trim());
  writeFileSync(responsePath, `${JSON.stringify({ version: porcupiVersion })}\n`);
  writeFileSync(requestLog, "");
  writeFileSync(delayPath, "0");
  writeFileSync(serverPath, `
import http.server
import pathlib
import time

response_path = pathlib.Path(${JSON.stringify(responsePath)})
request_log = pathlib.Path(${JSON.stringify(requestLog)})
delay_path = pathlib.Path(${JSON.stringify(delayPath)})

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with request_log.open("a") as log:
            log.write(self.path + "\\n")
        time.sleep(float(delay_path.read_text()))
        body = response_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *args):
        pass

http.server.ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()
`);
  const child = spawn("python3", [serverPath], { stdio: "ignore" });
  childProcesses.push(child);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = spawnSync("python3", ["-c", `import socket; s=socket.socket(); s.settimeout(.1); s.connect(('127.0.0.1',${port})); s.close()`]);
    if (ready.status === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return {
    url: `http://127.0.0.1:${port}/porcupi/latest`,
    requestLog,
    setDelay(seconds) { writeFileSync(delayPath, String(seconds)); },
    setVersion(version) { writeFileSync(responsePath, `${JSON.stringify({ version })}\n`); },
  };
}

function runManagedTui(home, frameLog, extraEnvironment = {}, args = []) {
  return spawnSync(
    "python3",
    [join(repositoryRoot, "test", "support", "pty-driver.py"), "", join(home, ".local", "bin", "porcupi"), ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: join(home, ".local", "share"),
        NODE_ENV: "test",
        PI_FIXTURE_TUI: "1",
        PI_FIXTURE_TUI_FRAME_LOG: frameLog,
        ...extraEnvironment,
      },
    },
  );
}

function readFrames(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function releaseStatusLine(frame) {
  return frame.lines.find((line) => line.length > 0) ?? "";
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

function publishRepositoryHead(root, repository) {
  const bare = join(root, "git-daemon", "owner", "resources.git");
  git(repository.source, "push", "--force", bare, "main:main");
  return git(repository.source, "rev-parse", "HEAD");
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

test("Managed Pi forwards Pi's uninstall package alias", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  const installed = runInstaller(release, home);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);

  const forwardLog = join(root, "forwarded-pi-uninstall.jsonl");
  const args = ["uninstall", "npm:example"];
  const forwarded = runManagedTui(home, join(root, "unused-frames.jsonl"), { PI_FIXTURE_FORWARD_LOG: forwardLog }, args);
  assert.equal(forwarded.status, 0, forwarded.stderr || forwarded.stdout);
  assert.deepEqual(JSON.parse(readFileSync(forwardLog, "utf8")), args);
});

test("Managed Pi rejects malformed release identities before rendering guidance", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  const installed = runInstaller(release, home);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);

  const server = serveReleaseStatus(root);
  const cachePath = join(dataRoot(home), "state", "release-status.json");
  for (const [index, malformedVersion] of ["1.0.0-.", "1.0.0-a..b", "1.0.0-01"].entries()) {
    server.setVersion(malformedVersion);
    const frameLog = join(root, `malformed-release-${index}.jsonl`);
    const result = runManagedTui(home, frameLog, { PORCUPI_TEST_RELEASE_STATUS_URL: server.url });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const rows = readFrames(frameLog).map(releaseStatusLine);
    assert.ok(rows.some((row) => /unavailable/i.test(row)), `${malformedVersion} must remain unavailable`);
    assert.ok(rows.every((row) => !row.includes(`porcupi@${malformedVersion}`)), `${malformedVersion} must not become exact guidance`);
    assert.equal(existsSync(cachePath), false, `${malformedVersion} must not enter the availability cache`);
  }
});

test("Managed Pi renders bounded release availability in one runtime-owned TUI row", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({ packages: ["settings-sentinel"], extensions: ["extension-sentinel"] }, null, 2)}\n`);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  const installed = runInstaller(release, home);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);

  const managedRoot = dataRoot(home);
  const activationPath = join(managedRoot, "state", "activation.json");
  const activationBefore = readFileSync(activationPath);
  const activeId = JSON.parse(activationBefore).active.compositionId;
  const activeReceipt = JSON.parse(readFileSync(join(managedRoot, "receipts", `${activeId}.json`), "utf8"));
  assert.equal(activeReceipt.payload.some((entry) => /tui-integration|release-status/.test(entry.path)), false);
  assert.equal(existsSync(join(managedRoot, "runtime", "tui-integration.mjs")), true);
  assert.equal(existsSync(join(managedRoot, "state", "selections.json")), false);
  assert.doesNotMatch(readFileSync(settingsPath, "utf8"), /tui-integration|porcupi-release-status/);
  const forwardedArguments = [
    ["install", "npm:example"],
    ["remove", "npm:example"],
    ["update", "--all"],
    ["list"],
    ["config"],
  ];
  const forwardLog = join(root, "forwarded-pi-commands.jsonl");
  for (const args of forwardedArguments) {
    const forwarded = runManagedTui(home, join(root, "unused-frames.jsonl"), { PI_FIXTURE_FORWARD_LOG: forwardLog }, args);
    assert.equal(forwarded.status, 0, forwarded.stderr || forwarded.stdout);
  }
  assert.deepEqual(
    readFileSync(forwardLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    forwardedArguments,
    "Pi package and config commands must remain first and otherwise unchanged",
  );

  const server = serveReleaseStatus(root);
  server.setDelay(0.1);
  server.setVersion("0.3.0");
  const frameLog = join(root, "release-frames.jsonl");
  const sessionPath = join(home, ".pi", "agent", "sessions", "release-status.jsonl");
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, "session sentinel\n");
  const sessionBefore = readFileSync(sessionPath);

  const available = runManagedTui(home, frameLog, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_BACKGROUND_READINESS: "0",
    PI_FIXTURE_TUI_WIDTH: "72",
    PI_FIXTURE_TUI_SESSION_REASONS: "startup,new,resume,fork,reload",
  });
  assert.equal(available.status, 0, available.stderr || available.stdout);
  const availableFrames = readFrames(frameLog);
  assert.match(releaseStatusLine(availableFrames[0]), /checking release availability/i);
  const reloadResetFrame = availableFrames.find((frame) => frame.reason === "reload-reset");
  assert.ok(reloadResetFrame, "the pinned Pi reload fixture must render after clearing Extension widgets");
  assert.match(releaseStatusLine(reloadResetFrame), /PorcuPi 0\.3\.0 readiness unavailable/);
  assert.ok(availableFrames.some((frame) => /PorcuPi 0\.3\.0 readiness unavailable/.test(releaseStatusLine(frame))));
  assert.ok(availableFrames.some((frame) => /npx --yes porcupi@0\.3\.0/.test(releaseStatusLine(frame))));
  const transitionReasons = new Set(["new", "resume", "fork", "reload"]);
  const transitionFrames = availableFrames.filter((frame) => transitionReasons.has(frame.sessionReason));
  assert.ok(transitionFrames.length > 0);
  assert.ok(transitionFrames.every((frame) => !/checking/i.test(releaseStatusLine(frame))));
  assert.ok(transitionFrames.every((frame) => /PorcuPi 0\.3\.0 readiness unavailable/.test(releaseStatusLine(frame))));
  assert.ok(availableFrames.every((frame) => frame.lines.length === 2 && frame.lines.every((line) => line.length <= frame.width)));
  assert.deepEqual(availableFrames.at(-1).lines, availableFrames.at(-2).lines, "theme invalidation and repeated render must be stable");
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  assert.deepEqual(readFileSync(sessionPath), sessionBefore);

  const narrowAvailableFramesPath = join(root, "narrow-available-frames.jsonl");
  const narrowAvailable = runManagedTui(home, narrowAvailableFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_BACKGROUND_READINESS: "0",
    PI_FIXTURE_TUI_WIDTH: "40",
  });
  assert.equal(narrowAvailable.status, 0, narrowAvailable.stderr || narrowAvailable.stdout);
  const narrowAvailableLines = readFrames(narrowAvailableFramesPath).map(releaseStatusLine);
  assert.ok(narrowAvailableLines.some((line) => line === "npx --yes porcupi@0.3.0"));

  const requestsBeforeStatus = readFileSync(server.requestLog, "utf8");
  const status = runPorcuPiProcess(home, ["status"]);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.equal(readFileSync(server.requestLog, "utf8"), requestsBeforeStatus, "local status must not check the network");
  assert.match(status.stdout, /Installed release: 0\.2\.0/);
  assert.match(status.stdout, /Target release: 0\.3\.0/);
  assert.match(status.stdout, /npx --yes porcupi@0\.3\.0/);
  assert.match(status.stdout, /outside the current Managed Pi session/i);

  server.setVersion(porcupiVersion);
  server.setDelay(0);
  const currentFramesPath = join(root, "current-frames.jsonl");
  const current = runManagedTui(home, currentFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PI_FIXTURE_TUI_WIDTH: "24",
  });
  assert.equal(current.status, 0, current.stderr || current.stdout);
  const currentFrames = readFrames(currentFramesPath);
  assert.ok(currentFrames.some((frame) => /current/i.test(releaseStatusLine(frame))));
  assert.ok(currentFrames.every((frame) => frame.lines.length === 2 && frame.lines.every((line) => line.length <= 24)));

  const requestCount = readFileSync(server.requestLog, "utf8").trim().split("\n").filter(Boolean).length;
  const offlineFramesPath = join(root, "offline-frames.jsonl");
  const offline = runManagedTui(home, offlineFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PI_FIXTURE_TUI_WIDTH: "72",
  }, ["--offline"]);
  assert.equal(offline.status, 0, offline.stderr || offline.stdout);
  assert.equal(readFileSync(server.requestLog, "utf8").trim().split("\n").filter(Boolean).length, requestCount);
  assert.ok(readFrames(offlineFramesPath).every((frame) => /offline/i.test(releaseStatusLine(frame))));

  const staleFramesPath = join(root, "stale-frames.jsonl");
  const stale = runManagedTui(home, staleFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: "http://127.0.0.1:1/unavailable",
    PI_FIXTURE_TUI_WIDTH: "72",
  });
  assert.equal(stale.status, 0, stale.stderr || stale.stdout);
  assert.ok(readFrames(staleFramesPath).some((frame) => /unavailable|stale/i.test(releaseStatusLine(frame))));

  const verified = runPorcuPiProcess(home, ["verify"]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  const integrationPath = join(managedRoot, "runtime", "tui-integration.mjs");
  const integrationBytes = readFileSync(integrationPath);
  writeFileSync(integrationPath, Buffer.concat([integrationBytes, Buffer.from("\n// changed\n")]));
  const changed = runPorcuPiProcess(home, ["verify"]);
  assert.notEqual(changed.status, 0);
  assert.match(`${changed.stdout}${changed.stderr}`, /runtime inventory mismatch/i);
  writeFileSync(integrationPath, integrationBytes);

  const cachePath = join(managedRoot, "state", "release-status.json");
  assert.equal(existsSync(cachePath), true);
  const cacheBytes = readFileSync(cachePath);
  writeFileSync(cachePath, `${JSON.stringify({ schemaVersion: 1, type: "porcupi-release-availability", latestVersion: "latest", checkedAt: "never" }, null, 2)}\n`);
  const malformedCache = runPorcuPiProcess(home, ["verify"]);
  assert.notEqual(malformedCache.status, 0);
  assert.match(`${malformedCache.stdout}${malformedCache.stderr}`, /Malformed PorcuPi release availability cache/);
  writeFileSync(cachePath, cacheBytes);
  const uninstall = runPorcuPi(home, ["uninstall"], "0d0d0d");
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.equal(existsSync(managedRoot), false);
  assert.deepEqual(readFileSync(settingsPath), Buffer.from(`${JSON.stringify({ packages: ["settings-sentinel"], extensions: ["extension-sentinel"] }, null, 2)}\n`));
  assert.deepEqual(readFileSync(sessionPath), sessionBefore);
});

test("Managed Pi surfaces relevant Tracked Branch updates without adopting them", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  const installed = runInstaller(release, home);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const server = serveReleaseStatus(root);

  const repository = createApplicablePatchRepository(join(root, "tracked-status-source"), [[
    "patches/status.patch",
    textPatch("series.txt", "base", "status-one"),
  ]]);
  const locator = await serveGitRepository(root, repository);
  const added = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");
  assert.equal(added.status, 0, added.stderr || added.stdout);

  writeFileSync(join(repository.source, "README.md"), "Irrelevant branch movement.\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Publish irrelevant documentation");
  publishRepositoryHead(root, repository);
  const irrelevantFrames = join(root, "tracked-status-irrelevant.jsonl");
  const irrelevant = runManagedTui(home, irrelevantFrames, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_BACKGROUND_READINESS: "0",
    PI_FIXTURE_TUI_WAIT_MS: "2500",
  });
  assert.equal(irrelevant.status, 0, irrelevant.stderr || irrelevant.stdout);
  assert.ok(readFrames(irrelevantFrames).every((frame) => !/Tracked Branch update(?!s: 0)/i.test(releaseStatusLine(frame))));
  const irrelevantStatus = runPorcuPiProcess(home, ["status"]);
  assert.match(irrelevantStatus.stdout, /Tracked Branch updates: 0/);

  writeFileSync(join(repository.source, "patches", "status.patch"), textPatch("series.txt", "base", "status-two"));
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Publish selected Patch Series update");
  const candidateCommit = publishRepositoryHead(root, repository);
  server.setVersion("0.3.0");

  const managedRoot = dataRoot(home);
  const activationBefore = readFileSync(join(managedRoot, "state", "activation.json"));
  const selectionsBefore = readFileSync(join(managedRoot, "state", "selections.json"));
  const frameLog = join(root, "tracked-status-frames.jsonl");
  const launched = runManagedTui(home, frameLog, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_BACKGROUND_READINESS: "0",
    PI_FIXTURE_TUI_WAIT_MS: "2500",
    PI_FIXTURE_TUI_WIDTH: "120",
  });
  assert.equal(launched.status, 0, launched.stderr || launched.stdout);
  const rows = readFrames(frameLog).map(releaseStatusLine);
  assert.ok(
    rows.some((row) => /1 Tracked Branch update/i.test(row)
      && /porcupi manage/.test(row)
      && /readiness unavailable/i.test(row)
      && /npx --yes porcupi@0\.3\.0/.test(row)),
    JSON.stringify(rows),
  );

  const status = runPorcuPiProcess(home, ["status"]);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /Tracked Branch updates: 1/);
  assert.match(status.stdout, new RegExp(candidateCommit));
  assert.match(status.stdout, /Next source command: porcupi manage/);
  assert.match(status.stdout, /changed Patch Series remain pending.*porcupi apply/i);
  assert.deepEqual(readFileSync(join(managedRoot, "state", "activation.json")), activationBefore);
  assert.deepEqual(readFileSync(join(managedRoot, "state", "selections.json")), selectionsBefore);

  const pinnedRoot = join(root, "pinned-status");
  const pinnedRepository = createApplicablePatchRepository(pinnedRoot, [[
    "patches/pinned.patch",
    textPatch("series.txt", "base", "pinned-one"),
  ]]);
  const pinnedLocator = await serveGitRepository(pinnedRoot, pinnedRepository);
  const pinned = runPorcuPi(home, ["add", `${pinnedLocator}@${pinnedRepository.commit}`], "616e6e0d");
  assert.equal(pinned.status, 0, pinned.stderr || pinned.stdout);

  const secondRoot = join(root, "second-status");
  const secondRepository = createApplicablePatchRepository(secondRoot, [[
    "patches/second.patch",
    textPatch("series.txt", "base", "second-one"),
  ]]);
  const secondLocator = await serveGitRepository(secondRoot, secondRepository);
  const secondAdded = runPorcuPi(home, ["add", `${secondLocator}@main`], "616e6e0d");
  assert.equal(secondAdded.status, 0, secondAdded.stderr || secondAdded.stdout);

  const failedRoot = join(root, "failed-status");
  const failedRepository = createApplicablePatchRepository(failedRoot, [[
    "patches/failed.patch",
    textPatch("series.txt", "base", "failed-one"),
  ]]);
  const failedLocator = await serveGitRepository(failedRoot, failedRepository);
  const failedDaemon = childProcesses.at(-1);
  const failedAdded = runPorcuPi(home, ["add", `${failedLocator}@main`], "616e6e0d");
  assert.equal(failedAdded.status, 0, failedAdded.stderr || failedAdded.stdout);

  writeFileSync(join(pinnedRepository.source, "patches", "pinned.patch"), textPatch("series.txt", "base", "pinned-two"));
  git(pinnedRepository.source, "add", ".");
  git(pinnedRepository.source, "commit", "-m", "Move pinned source repository");
  publishRepositoryHead(pinnedRoot, pinnedRepository);
  writeFileSync(join(secondRepository.source, "patches", "second.patch"), textPatch("series.txt", "base", "second-two"));
  git(secondRepository.source, "add", ".");
  git(secondRepository.source, "commit", "-m", "Publish second selected update");
  const secondCandidate = publishRepositoryHead(secondRoot, secondRepository);
  writeFileSync(join(failedRepository.source, "patches", "failed.patch"), textPatch("series.txt", "base", "failed-two"));
  git(failedRepository.source, "add", ".");
  git(failedRepository.source, "commit", "-m", "Publish temporarily unavailable update");
  const failedCandidate = publishRepositoryHead(failedRoot, failedRepository);
  failedDaemon.kill("SIGTERM");
  await new Promise((resolvePromise) => failedDaemon.once("close", resolvePromise));

  const aggregateActivation = readFileSync(join(managedRoot, "state", "activation.json"));
  const aggregateSelections = readFileSync(join(managedRoot, "state", "selections.json"));
  const manyFrames = join(root, "tracked-status-many.jsonl");
  const many = runManagedTui(home, manyFrames, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_BACKGROUND_READINESS: "0",
    PI_FIXTURE_TUI_WAIT_MS: "3000",
  });
  assert.equal(many.status, 0, many.stderr || many.stdout);
  assert.ok(readFrames(manyFrames).some((frame) => /2 Tracked Branch updates/i.test(releaseStatusLine(frame))));
  const manyStatus = runPorcuPiProcess(home, ["status"]);
  assert.match(manyStatus.stdout, /Tracked Branch updates: 2/);
  assert.match(manyStatus.stdout, new RegExp(candidateCommit));
  assert.match(manyStatus.stdout, new RegExp(secondCandidate));
  assert.doesNotMatch(manyStatus.stdout, new RegExp(failedCandidate));
  assert.doesNotMatch(manyStatus.stdout, new RegExp(pinnedLocator));

  const restartedDaemon = spawn(failedDaemon.spawnargs[0], failedDaemon.spawnargs.slice(1), { stdio: "ignore" });
  childProcesses.push(restartedDaemon);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (spawnSync("git", ["ls-remote", failedLocator], { stdio: "ignore" }).status === 0) break;
    await delay(20);
  }
  const resolvedFrames = join(root, "tracked-status-resolved.jsonl");
  const resolvedCandidate = runManagedTui(home, resolvedFrames, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_BACKGROUND_READINESS: "0",
    PI_FIXTURE_TUI_WAIT_MS: "3000",
  });
  assert.equal(resolvedCandidate.status, 0, resolvedCandidate.stderr || resolvedCandidate.stdout);
  assert.ok(readFrames(resolvedFrames).some((frame) => /3 Tracked Branch updates/i.test(releaseStatusLine(frame))));
  const resolvedStatus = runPorcuPiProcess(home, ["status"]);
  assert.match(resolvedStatus.stdout, /Tracked Branch updates: 3/);
  assert.match(resolvedStatus.stdout, new RegExp(failedCandidate));

  const sourceCachePath = join(managedRoot, "state", "source-updates.json");
  const cachedSourceStatus = readFileSync(sourceCachePath);
  const sideEffectFreeStatus = runPorcuPiProcess(home, ["status"]);
  assert.equal(sideEffectFreeStatus.status, 0, sideEffectFreeStatus.stderr || sideEffectFreeStatus.stdout);
  assert.deepEqual(readFileSync(sourceCachePath), cachedSourceStatus);
  const verified = runPorcuPiProcess(home, ["verify"]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  const malformedSourceCache = { ...JSON.parse(cachedSourceStatus), unowned: true };
  writeFileSync(sourceCachePath, `${JSON.stringify(malformedSourceCache, null, 2)}\n`);
  const malformedVerified = runPorcuPiProcess(home, ["verify"]);
  assert.notEqual(malformedVerified.status, 0);
  assert.match(`${malformedVerified.stdout}${malformedVerified.stderr}`, /Malformed PorcuPi Tracked Branch availability cache/);
  writeFileSync(sourceCachePath, cachedSourceStatus);
  const releaseRequests = readFileSync(server.requestLog, "utf8");
  const offlineFrames = join(root, "tracked-status-offline.jsonl");
  const offline = runManagedTui(home, offlineFrames, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_BACKGROUND_READINESS: "0",
  }, ["--offline"]);
  assert.equal(offline.status, 0, offline.stderr || offline.stdout);
  assert.ok(readFrames(offlineFrames).every((frame) => /3 Tracked Branch updates/i.test(releaseStatusLine(frame))));
  assert.deepEqual(readFileSync(sourceCachePath), cachedSourceStatus);
  assert.equal(readFileSync(server.requestLog, "utf8"), releaseRequests);
  assert.deepEqual(readFileSync(join(managedRoot, "state", "activation.json")), aggregateActivation);
  assert.deepEqual(readFileSync(join(managedRoot, "state", "selections.json")), aggregateSelections);
});

test("Managed Pi caches exact-input background Upgrade Readiness through the target public process", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const installedRelease = createReleaseFixture(root, base);
  assert.equal(runInstaller(installedRelease, home).status, 0);

  const targetRoot = join(root, "target");
  mkdirSync(targetRoot);
  const targetRelease = createReleaseFixture(targetRoot, base);
  setReleaseFixtureVersion(targetRelease, "0.3.0", { supportedUpgradeFrom: "0.2.0" });
  const targetArtifact = packRelease(targetRelease, targetRoot);
  const server = serveReleaseStatus(root);
  const buildLog = join(root, "readiness-builds.log");
  const buildPriorityLog = join(root, "readiness-build-priorities.log");
  writeFileSync(buildLog, "");
  writeFileSync(buildPriorityLog, "");
  const currentFramesPath = join(root, "readiness-current.jsonl");
  const current = runManagedTui(home, currentFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
    PI_FIXTURE_TUI_WAIT_MS: "500",
  });
  assert.equal(current.status, 0, current.stderr || current.stdout);
  assert.ok(readFrames(currentFramesPath).some((frame) => /current/i.test(releaseStatusLine(frame))));
  assert.equal(readFileSync(buildLog, "utf8"), "", "no heavy readiness work may run without a newer release");
  server.setVersion("0.3.0");
  const managedRoot = dataRoot(home);
  const unsupportedRoot = join(root, "unsupported-target");
  mkdirSync(unsupportedRoot);
  const unsupportedRelease = createReleaseFixture(unsupportedRoot, base);
  setReleaseFixtureVersion(unsupportedRelease, "0.3.0");
  const unsupportedArtifact = packRelease(unsupportedRelease, unsupportedRoot);
  const unsupportedFramesPath = join(root, "readiness-unsupported.jsonl");
  const unsupported = runManagedTui(home, unsupportedFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: unsupportedArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
    PI_FIXTURE_TUI_WAIT_MS: "1000",
  });
  assert.equal(unsupported.status, 0, unsupported.stderr || unsupported.stdout);
  const unsupportedRows = readFrames(unsupportedFramesPath).map(releaseStatusLine);
  assert.ok(unsupportedRows.some((row) => /readiness unavailable/i.test(row)));
  assert.ok(unsupportedRows.some((row) => /readiness unavailable/i.test(row)
    && /npx --yes porcupi@0\.3\.0/.test(row)
    && /outside/i.test(row)
    && !/stale/i.test(row)), "unavailable evidence must retain exact external guidance without claiming staleness");
  assert.equal(readFileSync(buildLog, "utf8"), "", "an unsupported upgrade route must not run heavy readiness work");
  assert.equal(existsSync(join(managedRoot, "state", "upgrade-readiness.json")), false);

  const authoritativePaths = [
    join(managedRoot, "state", "activation.json"),
    join(managedRoot, "state", "launcher.json"),
    join(managedRoot, "state", "runtime.json"),
  ];
  const authoritativeBefore = authoritativePaths.map((path) => readFileSync(path));

  const lifecycleLock = `${managedRoot}.lifecycle-lock`;
  const holder = spawn(join(home, ".local", "bin", "porcupi"), ["pi", "enable"], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      PORCUPI_TEST_HOLD_LOCK_MS: "10000",
    },
  });
  childProcesses.push(holder);
  for (let attempt = 0; attempt < 100 && !existsSync(lifecycleLock); attempt += 1) await delay(20);
  assert.equal(existsSync(lifecycleLock), true, "the competing lifecycle mutation did not acquire its lock");
  const contendedFramesPath = join(root, "readiness-contended.jsonl");
  const contended = runManagedTui(home, contendedFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
    PI_FIXTURE_TUI_WAIT_MS: "500",
  });
  assert.equal(contended.status, 0, contended.stderr || contended.stdout);
  assert.ok(readFrames(contendedFramesPath).some((frame) => /unavailable/i.test(releaseStatusLine(frame))));
  assert.equal(readFileSync(buildLog, "utf8"), "", "readiness must not run while lifecycle mutation owns the lock");
  holder.kill("SIGKILL");
  await new Promise((resolvePromise) => holder.once("close", resolvePromise));

  const firstFramesPath = join(root, "readiness-first.jsonl");
  const first = runManagedTui(home, firstFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
    PI_FIXTURE_BUILD_PRIORITY_LOG: buildPriorityLog,
    PI_FIXTURE_TUI_WAIT_MS: "3000",
  });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstRows = readFrames(firstFramesPath).map(releaseStatusLine);
  assert.match(firstRows[0], /checking release availability/i);
  assert.ok(firstRows.some((row) => /checking compatibility/i.test(row)));
  assert.ok(firstRows.some((row) => /PorcuPi 0\.3\.0.*ready/i.test(row)), JSON.stringify(firstRows));
  assert.equal(readFileSync(buildLog, "utf8"), "build\n");
  assert.ok(Number(readFileSync(buildPriorityLog, "utf8").trim()) > 0, "background assessment must inherit reduced process priority");
  assert.deepEqual(authoritativePaths.map((path) => readFileSync(path)), authoritativeBefore);

  const status = runPorcuPiProcess(home, ["status"]);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /Upgrade Readiness: ready/);
  assert.match(status.stdout, /Target Pi Base: v0\.81\.1/);
  assert.match(status.stdout, /Input identity: [a-f0-9]{64}/);

  const readinessPath = join(managedRoot, "state", "upgrade-readiness.json");
  const readinessBytes = readFileSync(readinessPath);
  const validReadiness = JSON.parse(readinessBytes.toString("utf8"));
  const fixtureSource = { locator: "example.com/owner/source", commit: validReadiness.identity.piBase.commit };
  const fixturePatch = {
    locator: fixtureSource.locator,
    seriesId: "series-a",
    commit: fixtureSource.commit,
    path: "patches/a.patch",
    sha256: "0".repeat(64),
  };
  const malformedIdentities = [
    { ...validReadiness.identity, piBase: { ...validReadiness.identity.piBase, version: "bad\u0000version" } },
    { ...validReadiness.identity, architecture: "x64\nforeign" },
    { ...validReadiness.identity, sourceCommits: [{ ...fixtureSource, locator: "" }] },
    { ...validReadiness.identity, sourceCommits: [fixtureSource, fixtureSource] },
    {
      ...validReadiness.identity,
      sourceCommits: [
        { ...fixtureSource, locator: "z.example/owner/source" },
        { ...fixtureSource, locator: "a.example/owner/source" },
      ],
    },
    { ...validReadiness.identity, sourceCommits: [fixtureSource], patches: [{ ...fixturePatch, path: "../escape.patch" }] },
    { ...validReadiness.identity, sourceCommits: [fixtureSource], patches: [{ ...fixturePatch, seriesId: "series\u0000a" }] },
    { ...validReadiness.identity, sourceCommits: [fixtureSource], patches: [fixturePatch, fixturePatch] },
    {
      ...validReadiness.identity,
      sourceCommits: [fixtureSource],
      patches: [
        { ...fixturePatch, seriesId: "series-z", path: "patches/z.patch" },
        { ...fixturePatch, seriesId: "series-a", path: "patches/a.patch" },
      ],
    },
  ];
  for (const identity of malformedIdentities) {
    const malformed = {
      ...validReadiness,
      identity,
      identitySha256: createHash("sha256").update(canonicalJson(identity)).digest("hex"),
    };
    writeFileSync(readinessPath, `${JSON.stringify(malformed, null, 2)}\n`);
    const verified = runPorcuPiProcess(home, ["verify"]);
    assert.notEqual(verified.status, 0);
    assert.match(`${verified.stdout}${verified.stderr}`, /Malformed PorcuPi Upgrade Readiness cache/);
  }
  writeFileSync(readinessPath, readinessBytes);

  const repository = createApplicablePatchRepository(join(root, "readiness-source"), [[
    "patches/readiness.patch",
    textPatch("series.txt", "base", "readiness"),
  ]]);
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const activationAfterAdd = readFileSync(join(managedRoot, "state", "activation.json"));
  const selectionsAfterAdd = readFileSync(join(managedRoot, "state", "selections.json"));

  const disabledFramesPath = join(root, "readiness-disabled.jsonl");
  const disabled = runManagedTui(home, disabledFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PORCUPI_BACKGROUND_READINESS: "0",
    PI_FIXTURE_BUILD_LOG: buildLog,
    PI_FIXTURE_TUI_WAIT_MS: "500",
  });
  assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
  const disabledRows = readFrames(disabledFramesPath).map(releaseStatusLine);
  assert.ok(disabledRows.some((row) => /stale/i.test(row)
    && /disabled/i.test(row)
    && /npx --yes porcupi@0\.3\.0/.test(row)
    && /outside/i.test(row)), "stale disabled evidence must remain distinct and actionable");
  assert.equal(readFileSync(buildLog, "utf8"), "build\n", "the opt-out must suppress invalidated readiness work");

  const refreshedFramesPath = join(root, "readiness-refreshed.jsonl");
  const refreshed = runManagedTui(home, refreshedFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
    PI_FIXTURE_TUI_WAIT_MS: "3000",
  });
  assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout);
  assert.ok(readFrames(refreshedFramesPath).some((frame) => /PorcuPi 0\.3\.0.*ready/i.test(releaseStatusLine(frame))));
  assert.equal(readFileSync(buildLog, "utf8"), "build\nbuild\n", "changed Selection Intent must invalidate readiness");
  assert.deepEqual(readFileSync(join(managedRoot, "state", "activation.json")), activationAfterAdd);
  assert.deepEqual(readFileSync(join(managedRoot, "state", "selections.json")), selectionsAfterAdd);

  const cachedFramesPath = join(root, "readiness-cached.jsonl");
  const requestsBeforeCachedLaunch = readFileSync(server.requestLog, "utf8");
  const cached = runManagedTui(home, cachedFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
  });
  assert.equal(cached.status, 0, cached.stderr || cached.stdout);
  assert.match(releaseStatusLine(readFrames(cachedFramesPath)[0]), /PorcuPi 0\.3\.0.*ready/i);
  assert.equal(readFileSync(buildLog, "utf8"), "build\nbuild\n", "a matching cache must skip heavy readiness work");

  const writeChangedReadinessDimension = (changeIdentity) => {
    const value = JSON.parse(readFileSync(readinessPath, "utf8"));
    value.identity = changeIdentity(value.identity);
    value.identitySha256 = createHash("sha256").update(canonicalJson(value.identity)).digest("hex");
    writeFileSync(readinessPath, `${JSON.stringify(value, null, 2)}\n`);
  };
  writeChangedReadinessDimension((identity) => ({
    ...identity,
    piBase: { ...identity.piBase, version: "v9.9.9" },
  }));
  const changedPiBase = runManagedTui(home, join(root, "readiness-changed-pi-base.jsonl"), {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
    PI_FIXTURE_TUI_WAIT_MS: "3000",
  });
  assert.equal(changedPiBase.status, 0, changedPiBase.stderr || changedPiBase.stdout);
  assert.equal(readFileSync(buildLog, "utf8"), "build\nbuild\nbuild\n", "changed target Pi Base evidence must invalidate readiness");

  writeChangedReadinessDimension((identity) => ({
    ...identity,
    checkerContractSha256: "0".repeat(64),
  }));
  const changedChecker = runManagedTui(home, join(root, "readiness-changed-checker.jsonl"), {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
    PI_FIXTURE_TUI_WAIT_MS: "3000",
  });
  assert.equal(changedChecker.status, 0, changedChecker.stderr || changedChecker.stdout);
  assert.equal(readFileSync(buildLog, "utf8"), "build\nbuild\nbuild\nbuild\n", "changed checker contract evidence must invalidate readiness");

  const requestCount = readFileSync(server.requestLog, "utf8").trim().split("\n").filter(Boolean).length;
  assert.ok(requestCount > requestsBeforeCachedLaunch.toString().trim().split("\n").filter(Boolean).length);
  const offlineFramesPath = join(root, "readiness-offline.jsonl");
  const offline = runManagedTui(home, offlineFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
  }, ["--offline"]);
  assert.equal(offline.status, 0, offline.stderr || offline.stdout);
  assert.match(releaseStatusLine(readFrames(offlineFramesPath)[0]), /PorcuPi 0\.3\.0.*ready/i);
  assert.equal(readFileSync(server.requestLog, "utf8").trim().split("\n").filter(Boolean).length, requestCount);
  assert.equal(readFileSync(buildLog, "utf8"), "build\nbuild\nbuild\nbuild\n");

  const failureSource = createApplicablePatchRepository(join(root, "failure-readiness-source"), [[
    "patches/add-marker.patch",
    [
      "diff --git a/readiness-marker.txt b/readiness-marker.txt",
      "new file mode 100644",
      "index 0000000..9e842ad",
      "--- /dev/null",
      "+++ b/readiness-marker.txt",
      "@@ -0,0 +1 @@",
      "+marker",
      "",
    ].join("\n"),
  ]]);
  const failureServerRoot = join(root, "failure-readiness-server");
  mkdirSync(failureServerRoot);
  const failureLocator = await serveGitRepository(failureServerRoot, failureSource);
  const addFailureInput = runPorcuPi(home, ["add", `${failureLocator}@main`], "616e6e0d");
  assert.equal(addFailureInput.status, 0, addFailureInput.stderr || addFailureInput.stdout);
  const failingTargetRoot = join(root, "failing-readiness-target");
  mkdirSync(failingTargetRoot);
  const failingBase = createPiBase(failingTargetRoot, { buildFails: true });
  const failingRelease = createReleaseFixture(failingTargetRoot, failingBase);
  setReleaseFixtureVersion(failingRelease, "0.3.0", { supportedUpgradeFrom: "0.2.0" });
  const failingArtifact = packRelease(failingRelease, failingTargetRoot);
  const failedFramesPath = join(root, "readiness-build-failed.jsonl");
  const failed = runManagedTui(home, failedFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: failingArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
    PI_FIXTURE_TUI_WAIT_MS: "4000",
  });
  assert.equal(failed.status, 0, failed.stderr || failed.stdout);
  const failedRows = readFrames(failedFramesPath).map(releaseStatusLine);
  assert.ok(failedRows.some((row) => /stale/i.test(row)
    && /npx --yes porcupi@0\.3\.0/.test(row)
    && /outside/i.test(row)), "failed reassessment must expose stale rather than unavailable evidence with external guidance");
  assert.equal(readFileSync(buildLog, "utf8"), "build\nbuild\nbuild\nbuild\n");

  const staleOfflineFramesPath = join(root, "readiness-stale-offline.jsonl");
  const staleOffline = runManagedTui(home, staleOfflineFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PI_FIXTURE_BUILD_LOG: buildLog,
  }, ["--offline"]);
  assert.equal(staleOffline.status, 0, staleOffline.stderr || staleOffline.stdout);
  assert.ok(readFrames(staleOfflineFramesPath).some((frame) => {
    const row = releaseStatusLine(frame);
    return /offline/i.test(row)
      && /stale/i.test(row)
      && /npx --yes porcupi@0\.3\.0/.test(row)
      && /outside/i.test(row);
  }), "offline stale target evidence must retain exact external guidance");
  assert.equal(readFileSync(buildLog, "utf8"), "build\nbuild\nbuild\nbuild\n");

  const staleStatus = runPorcuPiProcess(home, ["status"]);
  assert.equal(staleStatus.status, 0, staleStatus.stderr || staleStatus.stdout);
  assert.match(staleStatus.stdout, /Upgrade Readiness: unavailable — cached evidence is stale/);
  assert.doesNotMatch(staleStatus.stdout, /Upgrade Readiness: ready/);
});

test("background Upgrade Readiness caches an exact selected blocker without lifecycle mutation", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const installedBase = createPiBase(root);
  const installedRelease = createReleaseFixture(root, installedBase);
  assert.equal(runInstaller(installedRelease, home).status, 0);

  const repository = createApplicablePatchRepository(join(root, "blocked-readiness-source"), [[
    "patches/blocked.patch",
    textPatch("series.txt", "base", "blocked"),
  ]]);
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    supportedPiBaseVersions: ["v0.81.1"],
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Declare current Pi Base compatibility");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const targetRoot = join(root, "blocked-target");
  mkdirSync(targetRoot);
  const targetBase = createPiBase(targetRoot, { version: "0.82.0" });
  git(targetBase.source, "tag", "v0.82.0");
  const targetRelease = createReleaseFixture(targetRoot, targetBase, "0.82.0");
  const targetLockPath = join(targetRelease, "upstream", "pi-base.json");
  const targetLock = JSON.parse(readFileSync(targetLockPath, "utf8"));
  targetLock.tag = "v0.82.0";
  writeFileSync(targetLockPath, `${JSON.stringify(targetLock, null, 2)}\n`);
  setReleaseFixtureVersion(targetRelease, "0.3.0", { supportedUpgradeFrom: "0.2.0" });
  const targetRecordPath = join(targetRelease, "release", "v0.3.0.json");
  const targetRecord = JSON.parse(readFileSync(targetRecordPath, "utf8"));
  targetRecord.piBase = { repository: targetLock.repository, tag: targetLock.tag, commit: targetLock.commit };
  writeFileSync(targetRecordPath, `${JSON.stringify(targetRecord, null, 2)}\n`);
  const targetArtifact = packRelease(targetRelease, targetRoot);
  const server = serveReleaseStatus(root);
  server.setVersion("0.3.0");

  const managedRoot = dataRoot(home);
  const activationBefore = readFileSync(join(managedRoot, "state", "activation.json"));
  const selectionsBefore = readFileSync(join(managedRoot, "state", "selections.json"));
  const framesPath = join(root, "blocked-readiness.jsonl");
  const result = runManagedTui(home, framesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
    PI_FIXTURE_TUI_WAIT_MS: "2000",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rows = readFrames(framesPath).map(releaseStatusLine);
  assert.ok(rows.some((row) => /checking compatibility/i.test(row)));
  assert.ok(rows.some((row) => /PorcuPi 0\.3\.0 blocked/i.test(row)
    && /npx --yes porcupi@0\.3\.0/.test(row)
    && /outside/i.test(row)), JSON.stringify(rows));
  assert.deepEqual(readFileSync(join(managedRoot, "state", "activation.json")), activationBefore);
  assert.deepEqual(readFileSync(join(managedRoot, "state", "selections.json")), selectionsBefore);

  const status = runPorcuPiProcess(home, ["status"]);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /Upgrade Readiness: blocked/);
  assert.match(status.stdout, /Blocker: selected Patch Series .* does not support target Pi Base v0\.82\.0/);

  const cachedFramesPath = join(root, "blocked-readiness-cached.jsonl");
  const cached = runManagedTui(home, cachedFramesPath, {
    PORCUPI_TEST_RELEASE_STATUS_URL: server.url,
    PORCUPI_TEST_READINESS_PACKAGE: targetArtifact,
  });
  assert.equal(cached.status, 0, cached.stderr || cached.stdout);
  const cachedBlockedRow = releaseStatusLine(readFrames(cachedFramesPath)[0]);
  assert.match(cachedBlockedRow, /PorcuPi 0\.3\.0 blocked/i);
  assert.match(cachedBlockedRow, /npx --yes porcupi@0\.3\.0/);
  assert.match(cachedBlockedRow, /outside/i);
});

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
  const { artifact, historicalRelease, home, root } = createUpgradeFixture();
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
  assert.match(upgraded.stdout, /Selection Intent: empty/);
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

test("the public exact-version installer recovers an interrupted upgrade after candidate publication", () => {
  const { artifact, historicalRelease, home } = createUpgradeFixture();

  const historicalInstall = runInstaller(historicalRelease, home, "0d790d0d");
  assert.equal(historicalInstall.status, 0, historicalInstall.stderr || historicalInstall.stdout);
  const interrupted = runPackedInstaller(artifact, home, "0d0d0d", {
    PORCUPI_TEST_FAULT: "upgrade-candidate-published",
    PTY_WAIT_FOR: "1 of 3 — Upgrade",
  });
  assert.notEqual(interrupted.status, 0, "the upgrade fault did not interrupt publication");

  const oldLaunch = runPorcuPiProcess(home, ["--version"]);
  assert.equal(oldLaunch.status, 0, oldLaunch.stderr || oldLaunch.stdout);
  assert.equal(oldLaunch.stdout.trim(), "0.81.1");
  const oldVerify = runPorcuPiProcess(home, ["verify"]);
  assert.equal(oldVerify.status, 0, oldVerify.stderr || oldVerify.stdout);

  const retry = runPackedInstaller(artifact, home, "", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.match(retry.stdout, /Recovered interrupted PorcuPi upgrade|Verified installed PorcuPi 0\.2\.0/);
  assert.equal(runPorcuPiProcess(home, ["verify"]).status, 0);
  assert.equal(existsSync(join(home, ".local", "bin", "pi")), true);
  const uninstall = runPorcuPi(home, ["uninstall"], "0d0d0d");
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.equal(existsSync(dataRoot(home)), false);
});

test("the packed release upgrades payloads with lexical prefix paths", () => {
  const { artifact, historicalRelease, home } = createUpgradeFixture();
  assert.equal(runInstaller(historicalRelease, home).status, 0);

  const upgraded = runPackedInstaller(artifact, home, "0d0d0d", {
    PI_FIXTURE_LEXICAL_PREFIX_PATHS: "1",
    PTY_WAIT_FOR: "1 of 3 — Upgrade",
  });
  assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout);
  assert.match(upgraded.stdout, /Upgraded PorcuPi from 0\.1\.0 to 0\.2\.0/);
});

test("modified upgrade transaction targets are refused and left untouched", () => {
  const { artifact, historicalRelease, home, root } = createUpgradeFixture();
  assert.equal(runInstaller(historicalRelease, home).status, 0);
  const interrupted = runPackedInstaller(artifact, home, "0d0d0d", {
    PORCUPI_TEST_FAULT: "upgrade-candidate-published",
    PTY_WAIT_FOR: "1 of 3 — Upgrade",
  });
  assert.notEqual(interrupted.status, 0);
  const temporary = join(dataRoot(home), "tmp");
  const stage = join(temporary, readdirSync(temporary).find((name) => name.startsWith("upgrade-")));
  const transactionPath = join(stage, "transaction.json");
  const transactionBytes = readFileSync(transactionPath);
  writeFileSync(transactionPath, "{ malformed\n");
  const malformed = runPackedInstaller(artifact, home, "");
  assert.notEqual(malformed.status, 0);
  assert.match(`${malformed.stdout}${malformed.stderr}`, /Malformed PorcuPi upgrade transaction/);
  assert.equal(readFileSync(transactionPath, "utf8"), "{ malformed\n");

  const transaction = JSON.parse(transactionBytes);
  transaction.stage = resolve(stage, "..", "escaping-upgrade-stage");
  writeFileSync(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
  const escaping = runPackedInstaller(artifact, home, "");
  assert.notEqual(escaping.status, 0);
  assert.match(`${escaping.stdout}${escaping.stderr}`, /Foreign PorcuPi upgrade transaction requires manual inspection/);
  assert.equal(JSON.parse(readFileSync(transactionPath, "utf8")).stage, transaction.stage);

  writeFileSync(transactionPath, transactionBytes);
  const foreignStagePath = join(stage, "foreign-file");
  writeFileSync(foreignStagePath, "foreign\n");
  const foreignStage = runPackedInstaller(artifact, home, "");
  assert.notEqual(foreignStage.status, 0);
  assert.match(`${foreignStage.stdout}${foreignStage.stderr}`, /Foreign PorcuPi upgrade transaction requires manual inspection/);
  assert.equal(readFileSync(foreignStagePath, "utf8"), "foreign\n");
  unlinkSync(foreignStagePath);

  const targetRuntime = join(stage, "target-runtime");
  const savedRuntime = join(stage, "saved-target-runtime");
  renameSync(targetRuntime, savedRuntime);
  symlinkSync(savedRuntime, targetRuntime);
  const symbolic = runPackedInstaller(artifact, home, "");
  assert.notEqual(symbolic.status, 0);
  assert.match(`${symbolic.stdout}${symbolic.stderr}`, /malformed|Foreign PorcuPi upgrade transaction/i);
  assert.equal(lstatSync(targetRuntime).isSymbolicLink(), true);
  unlinkSync(targetRuntime);
  renameSync(savedRuntime, targetRuntime);

  const stableRuntime = join(dataRoot(home), "runtime");
  const escapedRuntime = join(root, "escaped-runtime");
  renameSync(stableRuntime, escapedRuntime);
  symlinkSync(escapedRuntime, stableRuntime);
  const escapedRuntimeBefore = treeDigest(escapedRuntime);
  const substituted = runPackedInstaller(artifact, home, "");
  assert.notEqual(substituted.status, 0);
  assert.match(`${substituted.stdout}${substituted.stderr}`, /malformed.*runtime|runtime.*malformed|Foreign PorcuPi upgrade transaction/i);
  assert.equal(lstatSync(stableRuntime).isSymbolicLink(), true);
  assert.equal(realpathSync(stableRuntime), realpathSync(escapedRuntime));
  assert.equal(treeDigest(escapedRuntime), escapedRuntimeBefore);
  unlinkSync(stableRuntime);
  renameSync(escapedRuntime, stableRuntime);

  const stableState = join(dataRoot(home), "state");
  const escapedState = join(root, "escaped-state");
  renameSync(stableState, escapedState);
  symlinkSync(escapedState, stableState);
  const escapedStateBefore = treeDigest(escapedState);
  const escapedControlState = runPackedInstaller(artifact, home, "");
  assert.notEqual(escapedControlState.status, 0);
  assert.match(`${escapedControlState.stdout}${escapedControlState.stderr}`, /Malformed PorcuPi (?:upgrade recovery root|state directory)/);
  assert.equal(lstatSync(stableState).isSymbolicLink(), true);
  assert.equal(realpathSync(stableState), realpathSync(escapedState));
  assert.equal(treeDigest(escapedState), escapedStateBefore);
  unlinkSync(stableState);
  renameSync(escapedState, stableState);

  const escapedTemporary = join(root, "escaped-temporary");
  renameSync(temporary, escapedTemporary);
  symlinkSync(escapedTemporary, temporary);
  const escapedTemporaryBefore = treeDigest(escapedTemporary);
  const escapedTemporaryRetry = runPackedInstaller(artifact, home, "");
  assert.notEqual(escapedTemporaryRetry.status, 0);
  assert.match(`${escapedTemporaryRetry.stdout}${escapedTemporaryRetry.stderr}`, /Malformed PorcuPi upgrade recovery root/);
  assert.equal(lstatSync(temporary).isSymbolicLink(), true);
  assert.equal(treeDigest(escapedTemporary), escapedTemporaryBefore);
  unlinkSync(temporary);
  renameSync(escapedTemporary, temporary);

  const publishedCli = join(stage, "published-runtime", "cli.mjs");
  const publishedCliBefore = readFileSync(publishedCli);
  writeFileSync(publishedCli, "\n// foreign publication modification\n", { flag: "a" });
  const modifiedPublication = readFileSync(publishedCli);
  const publicationRetry = runPackedInstaller(artifact, home, "");
  assert.notEqual(publicationRetry.status, 0);
  assert.match(`${publicationRetry.stdout}${publicationRetry.stderr}`, /Prepared target PorcuPi runtime inventory mismatch|Foreign PorcuPi upgrade transaction/);
  assert.deepEqual(readFileSync(publishedCli), modifiedPublication);
  writeFileSync(publishedCli, publishedCliBefore);

  const targetCli = join(targetRuntime, "cli.mjs");
  writeFileSync(targetCli, "\n// foreign modification\n", { flag: "a" });
  const modified = readFileSync(targetCli);
  const retry = runPackedInstaller(artifact, home, "");
  assert.notEqual(retry.status, 0);
  assert.match(`${retry.stdout}${retry.stderr}`, /Staged target PorcuPi runtime inventory mismatch|Foreign PorcuPi upgrade transaction/);
  assert.deepEqual(readFileSync(targetCli), modified);
  const launch = runPorcuPiProcess(home, ["--version"]);
  assert.equal(launch.status, 0, launch.stderr || launch.stdout);
  assert.equal(launch.stdout.trim(), "0.81.1");
  assert.equal(runPorcuPiProcess(home, ["verify"]).status, 0);
});

test("modified previous runtimes are refused after target Activation", () => {
  const { artifact, historicalRelease, home } = createUpgradeFixture();
  assert.equal(runInstaller(historicalRelease, home).status, 0);
  const interrupted = runPackedInstaller(artifact, home, "0d0d0d", {
    PORCUPI_TEST_FAULT: "upgrade-activation-written",
    PTY_WAIT_FOR: "1 of 3 — Upgrade",
  });
  assert.notEqual(interrupted.status, 0);
  const temporary = join(dataRoot(home), "tmp");
  const stage = join(temporary, readdirSync(temporary).find((name) => name.startsWith("upgrade-")));
  const previousCli = join(stage, "previous-runtime", "cli.mjs");
  writeFileSync(previousCli, "\n// foreign previous runtime modification\n", { flag: "a" });
  const modifiedPreviousRuntime = readFileSync(previousCli);

  const retry = runPackedInstaller(artifact, home, "");
  assert.notEqual(retry.status, 0);
  assert.match(`${retry.stdout}${retry.stderr}`, /Previous PorcuPi runtime inventory mismatch/);
  assert.deepEqual(readFileSync(previousCli), modifiedPreviousRuntime);
});

test("modified retired upgrade cleanup stages are reported and left untouched", () => {
  const { artifact, historicalRelease, home } = createUpgradeFixture();
  assert.equal(runInstaller(historicalRelease, home).status, 0);
  const interrupted = runPackedInstaller(artifact, home, "0d0d0d", {
    PORCUPI_TEST_FAULT: "upgrade-cleanup-retired",
    PTY_WAIT_FOR: "1 of 3 — Upgrade",
  });
  assert.notEqual(interrupted.status, 0);
  const temporary = join(dataRoot(home), "tmp");
  const retiredName = readdirSync(temporary).find((name) => name.startsWith("upgrade-retired-"));
  assert.ok(retiredName);
  const retired = join(temporary, retiredName);
  const foreign = join(retired, "foreign-file");
  writeFileSync(foreign, "foreign\n");

  const retry = runPackedInstaller(artifact, home, "");
  assert.notEqual(retry.status, 0);
  assert.match(`${retry.stdout}${retry.stderr}`, /Retired PorcuPi upgrade stage changed during cleanup/);
  assert.equal(readFileSync(foreign, "utf8"), "foreign\n");

  unlinkSync(foreign);
  unlinkSync(join(retired, "transaction.json"));
  const truncated = runPackedInstaller(artifact, home, "");
  assert.notEqual(truncated.status, 0);
  assert.match(`${truncated.stdout}${truncated.stderr}`, /Retired PorcuPi upgrade stage changed during cleanup/);
  assert.equal(existsSync(retired), true);
});

test("public launch, verify, and installer retry converge across upgrade publication interruptions", () => {
  const boundaries = [
    "upgrade-state-migrated",
    "upgrade-candidate-directory-published",
    "upgrade-candidate-published",
    "upgrade-transition-launcher-published",
    "upgrade-transition-launcher-receipt-written",
    "upgrade-optional-alias-verified",
    "upgrade-source-runtime-retired",
    "upgrade-target-runtime-published",
    "upgrade-target-runtime-receipt-written",
    "upgrade-selection-intent-written",
    "upgrade-activation-written",
    "upgrade-stable-launcher-published",
    "upgrade-stable-launcher-receipt-written",
    "upgrade-cleanup-started",
    "upgrade-composition-cleanup-complete",
    "upgrade-cleanup-marker-written",
    "upgrade-previous-runtime-removed",
    "upgrade-cleanup-retired",
    "upgrade-cleanup-complete",
  ];
  const interruptAt = (artifact, home, boundary) => runPackedInstaller(artifact, home, "0d0d0d", {
    PORCUPI_TEST_FAULT: boundary,
    PTY_WAIT_FOR: "1 of 3 — Upgrade",
  });
  const assertPublicCommands = (home, boundary) => {
    const launch = runPorcuPiProcess(home, ["--version"]);
    assert.equal(launch.status, 0, `${boundary}: ${launch.stderr || launch.stdout}`);
    assert.equal(launch.stdout.trim(), "0.81.1", boundary);
    const verified = runPorcuPiProcess(home, ["verify"]);
    assert.equal(verified.status, 0, `${boundary}: ${verified.stderr || verified.stdout}`);
    assert.equal(existsSync(join(home, ".local", "bin", "pi")), true, boundary);
  };
  const assertUninstall = (home, boundary) => {
    const uninstall = runPorcuPi(home, ["uninstall"], "0d0d0d");
    assert.equal(uninstall.status, 0, `${boundary}: ${uninstall.stderr || uninstall.stdout}`);
    assert.equal(existsSync(dataRoot(home)), false, boundary);
  };

  for (const boundary of boundaries) {
    const { artifact, historicalRelease, home: publicHome, root } = createUpgradeFixture();
    assert.equal(runInstaller(historicalRelease, publicHome, "0d790d0d").status, 0, boundary);
    const publicInterruption = interruptAt(artifact, publicHome, boundary);
    assert.notEqual(publicInterruption.status, 0, `${boundary}: the public-command fault did not interrupt publication`);
    assertPublicCommands(publicHome, boundary);
    const publicRetry = runPackedInstaller(artifact, publicHome, "", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });
    assert.equal(publicRetry.status, 0, `${boundary}: ${publicRetry.stderr || publicRetry.stdout}`);
    assert.match(publicRetry.stdout, /Recovered interrupted PorcuPi upgrade|Verified installed PorcuPi 0\.2\.0/, boundary);
    assertUninstall(publicHome, boundary);

    const installerHome = join(root, "installer-home");
    mkdirSync(installerHome);
    assert.equal(runInstaller(historicalRelease, installerHome, "0d790d0d").status, 0, boundary);
    const installerInterruption = interruptAt(artifact, installerHome, boundary);
    assert.notEqual(installerInterruption.status, 0, `${boundary}: the installer-retry fault did not interrupt publication`);
    const retry = runPackedInstaller(artifact, installerHome, "", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });
    assert.equal(retry.status, 0, `${boundary}: ${retry.stderr || retry.stdout}`);
    assert.match(retry.stdout, /Recovered interrupted PorcuPi upgrade|Verified installed PorcuPi 0\.2\.0/, boundary);
    assertPublicCommands(installerHome, boundary);
    assertUninstall(installerHome, boundary);
  }
});

test("release upgrade refuses a competing live lifecycle owner without changing state", async () => {
  const { artifact, historicalRelease, home } = createUpgradeFixture();
  assert.equal(runInstaller(historicalRelease, home, "0d790d0d").status, 0);
  const managedRoot = dataRoot(home);
  const before = treeDigest(managedRoot);
  const lock = `${managedRoot}.lifecycle-lock`;
  const holder = spawn(join(home, ".local", "bin", "porcupi"), ["pi", "enable"], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      PORCUPI_TEST_HOLD_LOCK_MS: "10000",
    },
  });
  childProcesses.push(holder);
  for (let attempt = 0; attempt < 100 && !existsSync(lock); attempt += 1) await delay(20);
  assert.equal(existsSync(lock), true, "the competing lifecycle owner did not acquire the lock");

  const contended = runPackedInstaller(artifact, home, "");
  assert.notEqual(contended.status, 0);
  assert.match(`${contended.stdout}${contended.stderr}`, /lifecycle operation is already in progress: pi enable/);
  assert.equal(treeDigest(managedRoot), before);
  holder.kill("SIGKILL");
  await new Promise((resolvePromise) => holder.once("close", resolvePromise));

  const retry = runPackedInstaller(artifact, home, "0d0d0d", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.equal(runPorcuPiProcess(home, ["verify"]).status, 0);
});

test("ordinary launch waits through a live upgrade launcher transition and observes the new installation", async () => {
  const { artifact, historicalRelease, home, root } = createUpgradeFixture();
  assert.equal(runInstaller(historicalRelease, home).status, 0);
  const boundaryFile = join(root, "upgrade-boundary");
  const installer = spawn("python3", [
    join(repositoryRoot, "test", "support", "pty-driver.py"),
    "0d0d0d",
    "npm",
    "exec",
    "--yes",
    "--offline",
    "--package",
    artifact,
    "--",
    "porcupi",
  ], {
    cwd: dirname(artifact),
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      PTY_WAIT_FOR: "1 of 3 — Upgrade",
      PORCUPI_TEST_HOLD_UPGRADE_BOUNDARY: "upgrade-transition-launcher-receipt-written",
      PORCUPI_TEST_HOLD_UPGRADE_BOUNDARY_MS: "1500",
      PORCUPI_TEST_UPGRADE_BOUNDARY_FILE: boundaryFile,
    },
  });
  childProcesses.push(installer);
  let installerOutput = "";
  installer.stdout.on("data", (chunk) => { installerOutput += chunk; });
  installer.stderr.on("data", (chunk) => { installerOutput += chunk; });
  for (let attempt = 0; attempt < 300 && !existsSync(boundaryFile); attempt += 1) await delay(20);
  assert.equal(existsSync(boundaryFile), true, "the upgrade did not reach its launcher transition");

  const launch = runPorcuPiProcess(home, ["--version"]);
  assert.equal(launch.status, 0, launch.stderr || launch.stdout);
  assert.equal(launch.stdout.trim(), "0.81.1");
  const installerResult = await new Promise((resolvePromise) => installer.once("close", (code, signal) => {
    resolvePromise({ code, signal });
  }));
  assert.equal(installerResult.code, 0, installerOutput);
  assert.equal(installerResult.signal, null);
  assert.equal(runPorcuPiProcess(home, ["verify"]).status, 0);
});

test("release upgrade defers cleanup of an unreferenced Composition with a live lease", async () => {
  const { artifact, historicalRelease, home, root } = createUpgradeFixture();
  assert.equal(runInstaller(historicalRelease, home).status, 0);
  const managedRoot = dataRoot(home);
  const activationPath = join(managedRoot, "state", "activation.json");
  const leasedId = JSON.parse(readFileSync(activationPath, "utf8")).active.compositionId;
  const launchLog = join(root, "held-upgrade-launch.log");
  const held = spawn(join(home, ".local", "bin", "porcupi"), ["held"], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      PI_FIXTURE_LAUNCH_LOG: launchLog,
      PI_FIXTURE_HOLD_MS: "60000",
    },
  });
  childProcesses.push(held);
  for (let attempt = 0; attempt < 100 && !existsSync(launchLog); attempt += 1) await delay(20);
  assert.equal(existsSync(launchLog), true, "the Managed Pi lease holder did not start");
  assert.ok(readdirSync(join(managedRoot, "leases", leasedId)).some((name) => name !== "owner.json"));

  const repository = createApplicablePatchRepository(join(root, "selected-source"), [[
    "patches/selected.patch",
    textPatch("series.txt", "base", "selected"),
  ]]);
  const locator = await serveGitRepository(root, repository);
  assert.equal(runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d").status, 0);
  const applied = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const preUpgradeActiveId = JSON.parse(readFileSync(activationPath, "utf8")).active.compositionId;
  assert.notEqual(preUpgradeActiveId, leasedId);

  const upgraded = runPackedInstaller(artifact, home, "0d0d0d", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });
  assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout);
  assert.match(upgraded.stdout, new RegExp(`Deferred cleanup of Managed Pi Composition ${leasedId}: a process lease is live or foreign`));
  assert.equal(held.exitCode, null, "release upgrade terminated the live Managed Pi process");
  const targetActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.equal(targetActivation.previous.compositionId, preUpgradeActiveId);
  assert.notEqual(targetActivation.active.compositionId, leasedId);
  assert.equal(existsSync(join(managedRoot, "compositions", leasedId)), true);
  assert.ok(readdirSync(join(managedRoot, "leases", leasedId)).some((name) => name !== "owner.json"));

  held.kill("SIGTERM");
  await new Promise((resolvePromise) => held.once("exit", resolvePromise));
  const cleanup = runPorcuPi(home, ["rollback"], "0d", { PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
  assert.equal(existsSync(join(managedRoot, "compositions", leasedId)), false);
  assert.equal(existsSync(join(managedRoot, "leases", leasedId)), false);
  assert.equal(runPorcuPiProcess(home, ["verify"]).status, 0);
});

test("the packed release preserves active Patches and scoped Pi resources through upgrade", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const base = createPiBase(root);
  const historicalRelease = createReleaseFixture(root, base, "0.81.1", { historicalRef: "v0.1.0" });
  const targetRoot = join(root, "target-release");
  mkdirSync(targetRoot);
  const targetRelease = createReleaseFixture(targetRoot, base);
  const artifact = packRelease(targetRelease, targetRoot);

  const repository = createApplicablePatchRepository(join(root, "selected-source"), [[
    "patches/selected.patch",
    textPatch("series.txt", "base", "selected"),
  ]]);
  mkdirSync(join(repository.source, "extensions"));
  mkdirSync(join(repository.source, "skills", "upgrade-skill"), { recursive: true });
  writeFileSync(join(repository.source, "extensions", "upgrade.ts"), "export default function upgrade() {}\n");
  writeFileSync(join(repository.source, "skills", "upgrade-skill", "SKILL.md"), "---\nname: upgrade-skill\ndescription: Upgrade fixture.\n---\nUpgrade.\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add upgrade resources");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const packageLog = join(root, "package.log");
  const environment = { PI_FIXTURE_PACKAGE_LOG: packageLog };

  const historicalInstall = runInstaller(historicalRelease, home, "0d790d0d", environment);
  assert.equal(historicalInstall.status, 0, historicalInstall.stderr || historicalInstall.stdout);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e206e0d", environment, project);
  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /1 global, 1 project Pi resource\(s\), 1 Patch\(es\)/);
  const apply = runPorcuPi(home, ["apply"], "0d", { ...environment, PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);

  const managedRoot = dataRoot(home);
  const activationPath = join(managedRoot, "state", "activation.json");
  const historicalActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  const selectionsBefore = readFileSync(join(managedRoot, "state", "selections.json"));
  const globalSettingsBefore = readFileSync(join(home, ".pi", "agent", "settings.json"));
  const projectSettingsBefore = readFileSync(join(project, ".pi", "settings.json"));
  const packageLogBefore = readFileSync(packageLog);
  writeFileSync(join(home, ".pi", "agent", "credentials.json"), "credential-sentinel\n");
  mkdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "sessions", "session"), "session-sentinel\n");
  mkdirSync(join(project, ".pi", "resources"), { recursive: true });
  writeFileSync(join(project, ".pi", "resources", "trusted"), "project-sentinel\n");
  const sharedBefore = treeDigest(join(home, ".pi"));
  const projectSharedBefore = treeDigest(join(project, ".pi"));

  const upgraded = runPackedInstaller(artifact, home, "0d0d0d", {
    ...environment,
    PTY_WAIT_FOR: "1 of 3 — Upgrade",
  });

  assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout);
  assert.match(upgraded.stdout, /Patch Selection Intent: current — matches the active Patch selection/);
  assert.match(upgraded.stdout, /Active Patches \(1\):/);
  assert.match(upgraded.stdout, /Selected Patches \(1\):/);
  assert.match(upgraded.stdout, /Patch .*:patches\/selected\.patch/);
  const canonicalProject = realpathSync(project);
  assert.match(upgraded.stdout, new RegExp(`Extension .*:extensions/upgrade\\.ts \\[project: ${canonicalProject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
  assert.match(upgraded.stdout, /Skill .*:skills\/upgrade-skill\/SKILL\.md \[global\]/);
  assert.match(upgraded.stdout, /Pi package lifecycle: retained under Pi ownership/);
  const migratedSelections = JSON.parse(readFileSync(join(managedRoot, "state", "selections.json"), "utf8"));
  assert.equal(JSON.parse(selectionsBefore).schemaVersion, 1);
  assert.equal(migratedSelections.schemaVersion, 2);
  assert.equal(Object.hasOwn(migratedSelections.sources[0], "trackedBranch"), false);
  const migratedManage = runPorcuPi(home, ["manage"], "1b", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" }, project);
  assert.equal(migratedManage.status, 0, migratedManage.stderr || migratedManage.stdout);
  assert.match(migratedManage.stdout, /Pinned source/);
  assert.match(migratedManage.stdout, new RegExp(`Accepted exact commit: ${repository.commit}`));
  const migratedSeries = migratedSelections.sources[0].artifacts.find((artifact) => artifact.kind === "PatchSeries");
  assert.deepEqual(migratedSeries, {
    kind: "PatchSeries",
    id: "patches/selected.patch",
    members: [{
      commit: repository.commit,
      path: "patches/selected.patch",
      sha256: migratedSeries.members[0].sha256,
    }],
  });
  assert.deepEqual(readFileSync(join(home, ".pi", "agent", "settings.json")), globalSettingsBefore);
  assert.deepEqual(readFileSync(join(project, ".pi", "settings.json")), projectSettingsBefore);
  assert.deepEqual(readFileSync(packageLog), packageLogBefore);
  assert.equal(treeDigest(join(home, ".pi")), sharedBefore);
  assert.equal(treeDigest(join(project, ".pi")), projectSharedBefore);
  assert.equal(existsSync(join(home, ".local", "bin", "pi")), true);

  const targetActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.deepEqual(targetActivation.previous, historicalActivation.active);
  assert.deepEqual(targetActivation.active.patches, historicalActivation.active.patches.map((patch) => ({
    ...patch,
    seriesId: patch.path,
  })));
  const targetReceipt = JSON.parse(readFileSync(
    join(managedRoot, "receipts", `${targetActivation.active.compositionId}.json`),
    "utf8",
  ));
  assert.equal(targetReceipt.porcupiVersion, "0.2.0");
  assert.deepEqual(targetReceipt.patches, targetActivation.active.patches);
  assert.equal(readFileSync(join(managedRoot, "compositions", targetActivation.active.compositionId, "payload", "series.txt"), "utf8"), "selected\n");
  assert.equal(runPorcuPiProcess(home, ["verify"], environment).status, 0);
});

test("the packed release activates preserved pending Patch Selection Intent", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const historicalRelease = createReleaseFixture(root, base, "0.81.1", { historicalRef: "v0.1.0" });
  const targetRoot = join(root, "target-release");
  mkdirSync(targetRoot);
  const targetRelease = createReleaseFixture(targetRoot, base);
  const artifact = packRelease(targetRelease, targetRoot);
  const repository = createApplicablePatchRepository(join(root, "pending-source"), [[
    "patches/pending.patch",
    textPatch("series.txt", "base", "pending"),
  ]]);
  const locator = await serveGitRepository(root, repository);

  const historicalInstall = runInstaller(historicalRelease, home);
  assert.equal(historicalInstall.status, 0, historicalInstall.stderr || historicalInstall.stdout);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /Patch Selection Intent is pending `porcupi apply`/);

  const managedRoot = dataRoot(home);
  const activationPath = join(managedRoot, "state", "activation.json");
  const historicalActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.deepEqual(historicalActivation.active.patches, []);
  const selectionsBefore = readFileSync(join(managedRoot, "state", "selections.json"));
  const beforeCancellation = treeDigest(managedRoot);

  const cancelled = runPackedInstaller(artifact, home, "0d0d1b", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, /Patch Selection Intent: pending — differs from the active Patch selection/);
  assert.match(cancelled.stdout, /Active Patches \(0\):/);
  assert.match(cancelled.stdout, /Selected Patches \(1\):/);
  assert.equal(treeDigest(managedRoot), beforeCancellation);

  const interrupted = runPackedInstaller(artifact, home, "0d0d0d", {
    PTY_WAIT_FOR: "1 of 3 — Upgrade",
    PORCUPI_TEST_FAULT: "upgrade-selection-intent-written",
  });
  assert.equal(interrupted.signal, "SIGKILL");
  assert.deepEqual(JSON.parse(readFileSync(activationPath, "utf8")), historicalActivation);
  const migratedDuringInterruption = JSON.parse(readFileSync(join(managedRoot, "state", "selections.json"), "utf8"));
  assert.equal(migratedDuringInterruption.schemaVersion, 2);

  const upgraded = runPackedInstaller(artifact, home, "", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });
  assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout);
  assert.match(upgraded.stdout, /Recovered interrupted PorcuPi upgrade/);
  const migratedSelections = JSON.parse(readFileSync(join(managedRoot, "state", "selections.json"), "utf8"));
  assert.equal(JSON.parse(selectionsBefore).schemaVersion, 1);
  assert.equal(migratedSelections.schemaVersion, 2);
  assert.deepEqual(migratedSelections.sources[0].artifacts[0], {
    kind: "PatchSeries",
    id: "patches/pending.patch",
    members: [{
      commit: repository.commit,
      path: "patches/pending.patch",
      sha256: migratedSelections.sources[0].artifacts[0].members[0].sha256,
    }],
  });
  const targetActivation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.deepEqual(targetActivation.previous, historicalActivation.active);
  assert.equal(targetActivation.active.patches.length, 1);
  assert.match(targetActivation.active.patches[0].path, /patches\/pending\.patch/);
  assert.equal(readFileSync(join(managedRoot, "compositions", targetActivation.active.compositionId, "payload", "series.txt"), "utf8"), "pending\n");
});

test("upgrade readiness counts Pi resources independently of Patch Series members", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const historicalRelease = createReleaseFixture(root, base, "0.81.1", { historicalRef: "v0.1.0" });
  const targetRoot = join(root, "target-release");
  mkdirSync(targetRoot);
  const targetRelease = createReleaseFixture(targetRoot, base);
  const artifact = packRelease(targetRelease, targetRoot);
  const repository = createApplicablePatchRepository(join(root, "selected-source"), [
    ["patches/one.patch", textPatch("series.txt", "base", "first")],
    ["patches/two.patch", textPatch("series.txt", "first", "second")],
  ]);
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    patchSeries: [{ id: "coordinated-change", members: ["patches/one.patch", "patches/two.patch"] }],
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Declare coordinated Patch Series");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);

  assert.equal(runInstaller(historicalRelease, home).status, 0);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const legacySelections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  const source = legacySelections.sources[0];
  const members = ["patches/one.patch", "patches/two.patch"].map((path) => {
    const patch = source.artifacts.find((candidate) => candidate.path === path);
    return { commit: source.commit, path, sha256: patch.sha256 };
  });
  writeFileSync(selectionsPath, `${JSON.stringify({
    schemaVersion: 2,
    sources: [{
      locator: source.locator,
      commit: source.commit,
      packageSource: source.packageSource,
      artifacts: [{ kind: "PatchSeries", id: "coordinated-change", members }],
    }],
  }, null, 2)}\n`);

  const cancelled = runPackedInstaller(artifact, home, "0d0d1b", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });

  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, /2 selected Patches passed Patch preflight/);
  assert.match(cancelled.stdout, /0 selected Pi resources remained discoverable/);
  assert.doesNotMatch(cancelled.stdout, /-1 selected Pi resources/);
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

test("a selected Patch readiness blocker names the exact Patch and leaves the installation unchanged", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const historicalBase = createPiBase(root);
  const historicalRelease = createReleaseFixture(root, historicalBase, "0.81.1", { historicalRef: "v0.1.0" });
  const historicalInstall = runInstaller(historicalRelease, home);
  assert.equal(historicalInstall.status, 0, historicalInstall.stderr || historicalInstall.stdout);

  const repository = createApplicablePatchRepository(join(root, "blocked-source"), [[
    "patches/blocked.patch",
    textPatch("series.txt", "base", "patched"),
  ]]);
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const targetRoot = join(root, "target");
  mkdirSync(targetRoot);
  const targetBase = createPiBase(targetRoot);
  writeFileSync(join(targetBase.source, "series.txt"), "target\n");
  git(targetBase.source, "add", "series.txt");
  git(targetBase.source, "commit", "-m", "Change target Patch context");
  git(targetBase.source, "tag", "--force", "v0.81.1");
  targetBase.commit = git(targetBase.source, "rev-parse", "HEAD");
  const targetRelease = createReleaseFixture(targetRoot, targetBase);
  const artifact = packRelease(targetRelease, targetRoot);
  const managedRoot = dataRoot(home);
  const before = treeDigest(managedRoot);
  const selections = JSON.parse(readFileSync(join(managedRoot, "state", "selections.json"), "utf8"));
  const selectedArtifact = selections.sources[0].artifacts.find((candidate) => (
    candidate.kind === "Patch" || candidate.kind === "PatchSeries"
  ));
  const selectedPatch = selectedArtifact.kind === "Patch" ? selectedArtifact : selectedArtifact.members[0];

  const failed = runPackedInstaller(artifact, home, "", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });

  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, new RegExp(`Patch preflight blocked by .*:patches/blocked\\.patch \\(sha256 ${selectedPatch.sha256}\\)`));
  assert.match(failed.stdout, new RegExp(`target Pi Base: v0\\.81\\.1 \\(${targetBase.commit}\\)`));
  assert.equal(treeDigest(managedRoot), before);
  assert.equal(runPorcuPiProcess(home, ["--version"]).stdout.trim(), "0.81.1");
});

test("a selected resource compatibility mismatch blocks release advancement before mutation", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const historicalRelease = createReleaseFixture(root, base, "0.81.1", { historicalRef: "v0.1.0" });
  const historicalInstall = runInstaller(historicalRelease, home);
  assert.equal(historicalInstall.status, 0, historicalInstall.stderr || historicalInstall.stdout);

  const repository = createResourceRepository(join(root, "blocked-resource"));
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    supportedPiBaseCommits: ["f".repeat(40)],
  }, null, 2)}\n`);
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Declare incompatible resources");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const targetRoot = join(root, "target");
  mkdirSync(targetRoot);
  const targetRelease = createReleaseFixture(targetRoot, base);
  const artifact = packRelease(targetRelease, targetRoot);
  const managedRoot = dataRoot(home);
  const before = treeDigest(managedRoot);

  const failed = runPackedInstaller(artifact, home, "", { PTY_WAIT_FOR: "1 of 3 — Upgrade" });

  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /selected Extension .*:extensions\/fixture\.ts does not support target Pi Base v0\.81\.1/);
  assert.equal(treeDigest(managedRoot), before);
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
  const repository = createMixedArtifactRepository(root);
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
  assert.match(uninstall.stdout, /Patch Selection Intent entries: 1/);
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
        { locator: "example.test/owner/source", commit: "a".repeat(40), path: "patches/../escape.patch", sha256: "b".repeat(64) },
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
        { locator: "example.test/owner/source", commit: "a".repeat(40), path: "patches/one.patch", sha256: "b".repeat(64) },
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

test("strict Composition receipts reject validly rebound identity, source-snapshot, and payload mismatches", () => {
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
    {
      name: "unsafe-patch-series-identity",
      mutate: (receipt) => {
        receipt.patches = [{
          locator: "example.test/owner/source",
          seriesId: "patches/unsafe\n.patch",
          commit: "a".repeat(40),
          path: "patches/member.patch",
          sha256: "b".repeat(64),
        }];
      },
      expected: /Malformed Managed Pi Composition receipt/,
    },
    {
      name: "uppercase-source-host",
      mutate: (receipt) => {
        receipt.patches = [{
          locator: "EXAMPLE.test/owner/source",
          seriesId: "coordinated-change",
          commit: "a".repeat(40),
          path: "patches/member.patch",
          sha256: "b".repeat(64),
        }];
      },
      expected: /Malformed Managed Pi Composition receipt/,
    },
    {
      name: "noncanonical-source-path",
      mutate: (receipt) => {
        receipt.patches = [{
          locator: "example.test/source",
          seriesId: "coordinated-change",
          commit: "a".repeat(40),
          path: "patches/member.patch",
          sha256: "b".repeat(64),
        }];
      },
      expected: /Malformed Managed Pi Composition receipt/,
    },
    {
      name: "mixed-source-commits",
      mutate: (receipt) => {
        receipt.patches = [
          {
            locator: "example.test/owner/source",
            seriesId: "coordinated-change",
            commit: "a".repeat(40),
            path: "patches/one.patch",
            sha256: "b".repeat(64),
          },
          {
            locator: "example.test/owner/source",
            seriesId: "coordinated-change",
            commit: "c".repeat(40),
            path: "patches/two.patch",
            sha256: "d".repeat(64),
          },
        ];
      },
      expected: /Malformed Managed Pi Composition receipt/,
    },
    {
      name: "mixed-implicit-and-declared-series-identity",
      mutate: (receipt) => {
        receipt.patches = [
          {
            locator: "example.test/owner/source",
            seriesId: "patches/implicit.patch",
            commit: "a".repeat(40),
            path: "patches/declared-member.patch",
            sha256: "b".repeat(64),
          },
          {
            locator: "example.test/owner/source",
            commit: "a".repeat(40),
            path: "patches/implicit.patch",
            sha256: "c".repeat(64),
          },
        ];
      },
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
  assert.equal(selections.schemaVersion, 2);
  assert.deepEqual(selections.sources, [{
    locator: canonicalLocator,
    commit: repository.commit,
    packageSource,
    trackedBranch: "refs/heads/main",
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
  assert.match(add.stdout, /4 Pi resource\(s\), 1 Patch Series selected/);
  const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(settings.packages[0].extensions, ["extensions/fixture.ts"]);
  assert.deepEqual(settings.packages[0].skills, ["skills/fixture-skill/SKILL.md"]);
  assert.deepEqual(settings.packages[0].prompts, ["prompts/fixture.md"]);
  assert.deepEqual(settings.packages[0].themes, ["themes/fixture.json"]);
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.equal(selections.sources[0].artifacts.length, 5);
  const patch = selections.sources[0].artifacts.find((artifact) => artifact.kind === "PatchSeries");
  assert.deepEqual(patch, {
    kind: "PatchSeries",
    id: "patches/nested/mixed.patch",
    members: [{
      commit: repository.commit,
      path: "patches/nested/mixed.patch",
      sha256: patch.members[0].sha256,
    }],
  });
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
  assert.match(add.stdout, /Patch Series\s+patches\/alpha\.patch/);
  assert.match(add.stdout, /Patch Series\s+patches\/nested\/beta\.patch/);
  assert.match(add.stdout, /Rejected patches\/symbolic\.patch: Patch candidate is symbolic/);
  assert.match(add.stdout, /Rejected patches\/submodule: Patch candidate is a Git submodule/);
  assert.doesNotMatch(add.stdout, /not-a-patch\.txt/);
  assert.match(add.stdout, /2 Patch Series selected.*no Installation Scope|Patch Series do not have an Installation Scope/);
  assert.match(add.stdout, /Patch Selection Intent is pending `porcupi apply`/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  assert.equal(existsSync(join(home, ".pi", "agent", "settings.json")), false);

  const canonicalLocator = `127.0.0.1:${new URL(locator).port}/owner/resources`;
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.equal(selections.schemaVersion, 2);
  assert.deepEqual(selections.sources, [{
    locator: canonicalLocator,
    commit: repository.commit,
    packageSource: `git:${locator}@${repository.commit}`,
    trackedBranch: "refs/heads/main",
    artifacts: [
      {
        kind: "PatchSeries",
        id: "patches/alpha.patch",
        members: [{
          commit: repository.commit,
          path: "patches/alpha.patch",
          sha256: "15adc195c931723b85b314beb297d55a1cab3becf2ed2f2e8cca653297c45d8f",
        }],
      },
      {
        kind: "PatchSeries",
        id: "patches/nested/beta.patch",
        members: [{
          commit: repository.commit,
          path: "patches/nested/beta.patch",
          sha256: "fa01de4182e25ce6287e9f1bfda7196c0f36438b19b244c3938497a8f970bf03",
        }],
      },
    ],
  }]);
});

test("declared single- and multi-file Patch Series complete add, manage, apply, verify, and rollback journeys", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createApplicablePatchRepository(root, [
    ["patches/020-first.patch", textPatch("series.txt", "base", "first")],
    ["patches/010-second.patch", textPatch("series.txt", "first", "second")],
    ["patches/030-single.patch", newFilePatch("single-series.txt", "single")],
  ]);
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    patches: [{ path: "patches/020-first.patch" }],
    patchSeries: [
      {
        id: "coordinated-change",
        displayName: "Coordinated change",
        description: "Two dependent reviewable Patch Files.",
        members: ["patches/020-first.patch", "patches/010-second.patch"],
      },
      {
        id: "single-change",
        displayName: "Single declared change",
        members: ["patches/030-single.patch"],
      },
    ],
  }, null, 2)}\n`);
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Declare coordinated Patch Series");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /Patch Series\s+Coordinated change — coordinated-change/);
  assert.match(add.stdout, /Two dependent reviewable Patch Files/);
  assert.match(add.stdout, /Patch metadata entry patches\/020-first\.patch is ignored because the Patch File belongs to a declared Patch Series/);
  assert.match(add.stdout, /2 Patch Series selected/);
  const managedRoot = dataRoot(home);
  const selections = JSON.parse(readFileSync(join(managedRoot, "state", "selections.json"), "utf8"));
  assert.deepEqual(selections.sources[0].artifacts, [
    {
      kind: "PatchSeries",
      id: "coordinated-change",
      members: [
        {
          commit: repository.commit,
          path: "patches/020-first.patch",
          sha256: createHash("sha256").update(readFileSync(join(repository.source, "patches/020-first.patch"))).digest("hex"),
        },
        {
          commit: repository.commit,
          path: "patches/010-second.patch",
          sha256: createHash("sha256").update(readFileSync(join(repository.source, "patches/010-second.patch"))).digest("hex"),
        },
      ],
    },
    {
      kind: "PatchSeries",
      id: "single-change",
      members: [{
        commit: repository.commit,
        path: "patches/030-single.patch",
        sha256: createHash("sha256").update(readFileSync(join(repository.source, "patches/030-single.patch"))).digest("hex"),
      }],
    },
  ]);

  const apply = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  assert.ok(apply.stdout.indexOf("patches/020-first.patch") < apply.stdout.indexOf("patches/010-second.patch"));
  const activation = JSON.parse(readFileSync(join(managedRoot, "state", "activation.json"), "utf8"));
  assert.deepEqual(activation.active.patches.map(({ seriesId, path }) => ({ seriesId, path })), [
    { seriesId: "coordinated-change", path: "patches/020-first.patch" },
    { seriesId: "coordinated-change", path: "patches/010-second.patch" },
    { seriesId: "single-change", path: "patches/030-single.patch" },
  ]);
  assert.equal(readFileSync(join(managedRoot, "compositions", activation.active.compositionId, "payload", "series.txt"), "utf8"), "second\n");
  assert.equal(readFileSync(join(managedRoot, "compositions", activation.active.compositionId, "payload", "single-series.txt"), "utf8"), "single\n");

  const verify = runPorcuPiProcess(home, ["verify"]);
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /Verified Managed Pi Composition/);
  const rollback = runPorcuPi(home, ["rollback"], "0d", { PTY_WAIT_FOR: "Roll back Managed Pi" });
  assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
  assert.match(rollback.stdout, /Activated retained Managed Pi Composition/);
  const rolledBack = JSON.parse(readFileSync(join(managedRoot, "state", "activation.json"), "utf8"));
  assert.equal(readFileSync(join(managedRoot, "compositions", rolledBack.active.compositionId, "payload", "series.txt"), "utf8"), "base\n");

  const manage = runPorcuPi(home, ["manage"], "6a206e6e0d", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(manage.status, 0, manage.stderr || manage.stdout);
  assert.match(manage.stdout, /Patch Series\s+.*coordinated-change/);
  assert.match(manage.stdout, /Patch Series\s+.*single-change/);
  assert.match(manage.stdout, /2 Patch Files in retained order/);
  assert.match(manage.stdout, /1 Patch File in retained order/);
  assert.match(manage.stdout, /Remove Patch Series: .* :: single-change/);
  assert.match(manage.stdout, /Saved 0 Pi resource and 1 Patch Series selection/);
  const managedSelections = JSON.parse(readFileSync(join(managedRoot, "state", "selections.json"), "utf8"));
  assert.deepEqual(managedSelections.sources[0].artifacts.map((artifact) => artifact.id), ["coordinated-change"]);
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
  const secondAdd = runPorcuPi(home, ["add", `${secondLocator}@main`], "616e6e0d");
  assert.equal(secondAdd.status, 0, secondAdd.stderr || secondAdd.stdout);
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
    `${canonicalLocator}@${repository.commit} · patches/0002-first.patch`,
    `${canonicalLocator}@${repository.commit} · patches/nested/0001-second.patch`,
    `${canonicalSecondLocator}@${secondRepository.commit} · patches/independent.patch`,
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
      PI_FIXTURE_HOLD_MS: "60000",
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

  heldLaunch.kill("SIGTERM");
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
  for (const series of selections.sources[0].artifacts.filter((artifact) => artifact.kind === "PatchSeries")) {
    for (const member of series.members) member.commit = missingCommit;
  }
  writeFileSync(selectionsPath, `${JSON.stringify(selections, null, 2)}\n`);
  const missingSource = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.notEqual(missingSource.status, 0);
  assert.match(missingSource.stdout, /Git could not resolve the requested Source Repository/);
  assert.doesNotMatch(missingSource.stdout, /git apply --check|npm ci/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  selections.sources[0].commit = originalCommit;
  selections.sources[0].packageSource = originalPackageSource;
  for (const series of selections.sources[0].artifacts.filter((artifact) => artifact.kind === "PatchSeries")) {
    for (const member of series.members) member.commit = originalCommit;
  }
  const originalDigest = selections.sources[0].artifacts[0].members[0].sha256;
  selections.sources[0].artifacts[0].members[0].sha256 = "0".repeat(64);
  writeFileSync(selectionsPath, `${JSON.stringify(selections, null, 2)}\n`);

  const mismatch = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stdout, /Selected Patch digest mismatch/);
  assert.doesNotMatch(mismatch.stdout, /git apply --check|npm ci/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  selections.sources[0].artifacts[0].members[0].sha256 = originalDigest;
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
  assert.match(manage.stdout, /Patch Series do not have an Installation Scope and are not listed on this page/);
  assert.match(manage.stdout, /Remove Patch Series.*patches\/nested\/beta\.patch/);
  assert.match(manage.stdout, /Patch Selection Intent is pending `porcupi apply`/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  assert.equal(existsSync(join(home, ".pi", "agent", "settings.json")), false);
  let selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  assert.deepEqual(selections.sources[0].artifacts, [{
    kind: "PatchSeries",
    id: "patches/alpha.patch",
    members: [{
      commit: repository.commit,
      path: "patches/alpha.patch",
      sha256: "15adc195c931723b85b314beb297d55a1cab3becf2ed2f2e8cca653297c45d8f",
    }],
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
  assert.equal(selections.sources[0].artifacts.find((artifact) => artifact.id === "patches/alpha.patch").members[0].sha256, "a56651b16b4c629952286285ac23b9a490bd10e88bcf2430b079bbc917b3b449");
  const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.match(settings.packages[0].source, new RegExp(`@${repository.commit}$`));
  assert.deepEqual(settings.packages[0].extensions, ["extensions/alongside.ts"]);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  const patchIndex = selections.sources[0].artifacts.findIndex((artifact) => artifact.id === "patches/alpha.patch");
  selections.sources[0].artifacts[patchIndex].members[0].sha256 = "0".repeat(64);
  writeFileSync(selectionsPath, `${JSON.stringify(selections, null, 2)}\n`);
  const mismatch = runPorcuPi(home, ["add", `${locator}@main`], "");
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stdout, /saved Patch digest does not match its exact Source Repository commit/i);
  assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].artifacts[patchIndex].members[0].sha256, "0".repeat(64));
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("re-adding declared Patch Series reviews its complete inventory while display metadata leaves identity stable", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createApplicablePatchRepository(root, [
    ["patches/one.patch", "first revision\n"],
    ["patches/two.patch", "second revision\n"],
  ]);
  const metadataPath = join(repository.source, "porcupi.json");
  writeFileSync(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    patchSeries: [{ id: "stable-series", displayName: "Original display", members: ["patches/one.patch", "patches/two.patch"] }],
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Declare original series");
  const originalCommit = git(repository.source, "rev-parse", "HEAD");
  git(repository.source, "tag", "original-series");

  git(repository.source, "mv", "patches/two.patch", "patches/renamed.patch");
  writeFileSync(join(repository.source, "patches", "one.patch"), "first revision changed\n");
  writeFileSync(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    patchSeries: [{ id: "stable-series", displayName: "Improved display", members: ["patches/renamed.patch", "patches/one.patch"] }],
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Revise series display and inventory");
  const updatedCommit = git(repository.source, "rev-parse", "HEAD");
  git(repository.source, "tag", "updated-series");

  writeFileSync(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    patchSeries: [{ id: "replacement-series", displayName: "Replacement identity", members: ["patches/renamed.patch", "patches/one.patch"] }],
  }, null, 2)}\n`);
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Publish a different series identity");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  assert.equal(runPorcuPi(home, ["add", `${locator}@original-series`], "616e6e0d").status, 0);

  const update = runPorcuPi(home, ["add", `${locator}@updated-series`], "6e6e0d");

  assert.equal(update.status, 0, update.stderr || update.stdout);
  assert.match(update.stdout, /Improved display — stable-series/);
  assert.match(update.stdout, new RegExp(`Source-wide change: ${originalCommit} → ${updatedCommit}`));
  assert.match(update.stdout, /Patch Series changed: stable-series/);
  assert.match(update.stdout, /Previous: patches\/one\.patch@sha256:.* → patches\/two\.patch@sha256:/);
  assert.match(update.stdout, /Next: patches\/renamed\.patch@sha256:.* → patches\/one\.patch@sha256:/);
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  assert.equal(selections.sources[0].artifacts[0].id, "stable-series");
  assert.deepEqual(selections.sources[0].artifacts[0].members.map((member) => member.path), [
    "patches/renamed.patch",
    "patches/one.patch",
  ]);

  const savedBeforeIdentityChange = readFileSync(selectionsPath);
  const differentIdentity = runPorcuPi(home, ["add", `${locator}@main`], "1b");
  assert.equal(differentIdentity.status, 0, differentIdentity.stderr || differentIdentity.stdout);
  assert.match(differentIdentity.stdout, /\[ \] Patch Series Replacement identity — replacement-series/);
  assert.deepEqual(readFileSync(selectionsPath), savedBeforeIdentityChange);
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
  git(repository.source, "tag", "contradictory-metadata");
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    supportedPiBaseVersions: [">=0.81.1"],
  })}\n`);
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Malformed compatibility");
  git(repository.source, "tag", "malformed-compatibility");
  const mustNotRun = join(root, "source-metadata-must-not-run");
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    hooks: [{ command: ["touch", mustNotRun] }],
  })}\n`);
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Attempt source behavior");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);

  const malformed = runPorcuPi(home, ["add", `${locator}@malformed-metadata`], "1b");
  const unsupported = runPorcuPi(home, ["add", `${locator}@unsupported-metadata`], "1b");
  const contradictory = runPorcuPi(home, ["add", `${locator}@contradictory-metadata`], "1b");
  const malformedCompatibility = runPorcuPi(home, ["add", `${locator}@malformed-compatibility`], "1b");
  const sourceBehavior = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");

  assert.equal(malformed.status, 0, malformed.stderr || malformed.stdout);
  assert.match(malformed.stdout, /Source metadata is invalid and ignored as a whole: malformed JSON/);
  assert.equal(unsupported.status, 0, unsupported.stderr || unsupported.stdout);
  assert.match(unsupported.stdout, /unsupported field or unsafe Patch path/);
  assert.equal(contradictory.status, 0, contradictory.stderr || contradictory.stdout);
  assert.match(contradictory.stdout, /duplicate Patch entry patches\/alpha\.patch/);
  assert.doesNotMatch(contradictory.stdout, /First claim|Contradictory claim/);
  assert.equal(malformedCompatibility.status, 0, malformedCompatibility.stderr || malformedCompatibility.stdout);
  assert.match(malformedCompatibility.stdout, /supportedPiBaseVersions for Source Repository default must contain unique exact values/);
  assert.equal(sourceBehavior.status, 0, sourceBehavior.stderr || sourceBehavior.stdout);
  assert.match(sourceBehavior.stdout, /Source metadata is invalid and ignored as a whole/);
  assert.equal(existsSync(mustNotRun), false);
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.deepEqual(selections.sources[0].artifacts.map((artifact) => artifact.id), [
    "patches/alpha.patch",
    "patches/nested/beta.patch",
  ]);
});

test("invalid declared Patch Series members are diagnosed without ambiguous or suppressed implicit series", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createPatchRepository(root);
  for (const path of ["patches/cascade-alpha.patch", "patches/cascade-beta.patch", "patches/cascade-gamma.patch"]) {
    writeFileSync(join(repository.source, path), `${path}\n`);
  }
  mkdirSync(join(repository.source, "patches/non-regular.patch"));
  writeFileSync(join(repository.source, "patches/non-regular.patch/member.txt"), "directory member\n");
  const gitlinkCommit = git(repository.source, "rev-parse", "HEAD");
  git(repository.source, "update-index", "--add", "--cacheinfo", `160000,${gitlinkCommit},patches/submodule.patch`);
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    patchSeries: [
      { id: "duplicate-members", members: ["patches/alpha.patch", "patches/alpha.patch"] },
      { id: "overlap-one", members: ["patches/alpha.patch"] },
      { id: "overlap-two", members: ["patches/alpha.patch"] },
      { id: "boundary-escaping-member", members: ["patches/../outside.patch"] },
      { id: "missing-member", members: ["patches/missing.patch"] },
      { id: "non-regular-member", members: ["patches/non-regular.patch"] },
      { id: "symbolic-member", members: ["patches/symbolic.patch"] },
      { id: "submodule-member", members: ["patches/submodule.patch"] },
      { id: "control-member", members: ["patches/control\n.patch"] },
      { id: "patches/cascade-beta.patch", members: ["patches/cascade-alpha.patch"] },
      { id: "patches/cascade-gamma.patch", members: ["patches/cascade-beta.patch"] },
    ],
  }, null, 2)}\n`);
  git(
    repository.source,
    "add",
    "porcupi.json",
    "patches/cascade-alpha.patch",
    "patches/cascade-beta.patch",
    "patches/cascade-gamma.patch",
    "patches/non-regular.patch/member.txt",
  );
  git(repository.source, "commit", "-m", "Declare invalid Patch Series fixtures");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /Declared Patch Series duplicate-members is invalid.*duplicate member patches\/alpha\.patch/);
  assert.match(add.stdout, /Declared Patch Series overlap-one is invalid.*also declared by Patch Series/);
  assert.match(add.stdout, /Declared Patch Series overlap-two is invalid.*also declared by Patch Series/);
  assert.match(add.stdout, /Declared Patch Series boundary-escaping-member is invalid.*unsafe member path/);
  assert.match(add.stdout, /Declared Patch Series missing-member is invalid.*missing member/);
  assert.match(add.stdout, /Declared Patch Series non-regular-member is invalid.*missing member patches\/non-regular\.patch/);
  assert.match(add.stdout, /Declared Patch Series symbolic-member is invalid.*symbolic/);
  assert.match(add.stdout, /Declared Patch Series submodule-member is invalid.*Git submodule/);
  assert.match(add.stdout, /Declared Patch Series control-member is invalid.*unsafe member path/);
  assert.match(add.stdout, /Declared Patch Series patches\/cascade-gamma\.patch is invalid.*conflicts with an implicit Patch Series/);
  assert.match(add.stdout, /Declared Patch Series patches\/cascade-beta\.patch is invalid.*conflicts with an implicit Patch Series/);
  assert.doesNotMatch(add.stdout, /Patch metadata is invalid and ignored as a whole/);
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.deepEqual(selections.sources[0].artifacts.map((artifact) => artifact.id), [
    "patches/alpha.patch",
    "patches/cascade-alpha.patch",
    "patches/cascade-beta.patch",
    "patches/cascade-gamma.patch",
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
    kind: "PatchSeries",
    id: "patches/alpha.patch",
    members: [{
      commit: repository.commit,
      path: "patches/alpha.patch",
      sha256: "15adc195c931723b85b314beb297d55a1cab3becf2ed2f2e8cca653297c45d8f",
    }],
  }]);
});

test("source compatibility defaults and per-Artifact overrides filter mixed resources and preserve fixed Patch verification", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  mkdirSync(join(repository.source, "patches"));
  writeFileSync(join(repository.source, "patches", "selected.patch"), newFilePatch("compatible-selection.txt", "selected"));
  writeFileSync(join(repository.source, "patches", "default-blocked.patch"), newFilePatch("must-not-exist.txt", "blocked"));
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    supportedPiBaseVersions: ["v9.9.9"],
    supportedPiBaseCommits: ["f".repeat(40)],
    resources: [
      {
        kind: "Extension",
        path: "extensions/fixture.ts",
        supportedPiBaseVersions: ["v0.81.1"],
        supportedPiBaseCommits: [base.commit],
      },
      {
        kind: "Skill",
        path: "skills/fixture-skill/SKILL.md",
        supportedPiBaseVersions: ["v0.81.1"],
      },
      {
        kind: "Prompt",
        path: "prompts/fixture.md",
        supportedPiBaseVersions: ["v0.81.1"],
        supportedPiBaseCommits: ["e".repeat(40)],
      },
      {
        kind: "Theme",
        path: "themes/fixture.json",
        supportedPiBaseCommits: [base.commit],
      },
    ],
    patchSeries: [{
      id: "compatible-series",
      members: ["patches/selected.patch"],
      supportedPiBaseVersions: ["v0.81.1"],
      supportedPiBaseCommits: [base.commit],
    }],
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Declare Artifact compatibility");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);

  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");

  assert.equal(add.status, 0, add.stderr || add.stdout);
  assert.match(add.stdout, /Extension\s+extensions\/fixture\.ts/);
  assert.match(add.stdout, /Skill\s+skills\/fixture-skill\/SKILL\.md/);
  assert.match(add.stdout, /Theme\s+themes\/fixture\.json/);
  assert.match(add.stdout, /Prompt\s+prompts\/fixture\.md \[not supported by this Pi Base\]/);
  assert.match(add.stdout, /Patch Series\s+patches\/default-blocked\.patch \[not supported by this Pi Base\]/);
  assert.match(add.stdout, /Patch Series\s+compatible-series/);
  const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(settings.packages[0].extensions, ["extensions/fixture.ts"]);
  assert.deepEqual(settings.packages[0].skills, ["skills/fixture-skill/SKILL.md"]);
  assert.deepEqual(settings.packages[0].prompts, []);
  assert.deepEqual(settings.packages[0].themes, ["themes/fixture.json"]);
  const selections = JSON.parse(readFileSync(join(dataRoot(home), "state", "selections.json"), "utf8"));
  assert.deepEqual(selections.sources[0].artifacts.map((artifact) => artifact.kind === "PatchSeries" ? artifact.id : `${artifact.kind}:${artifact.path}`), [
    "Extension:extensions/fixture.ts",
    "compatible-series",
    "Skill:skills/fixture-skill/SKILL.md",
    "Theme:themes/fixture.json",
  ]);

  const apply = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  assert.match(apply.stdout, /git apply --check --whitespace=error-all/);
  assert.match(apply.stdout, /npm ci --ignore-scripts/);
  assert.match(apply.stdout, /check:model-data/);
  assert.match(apply.stdout, /build:offline/);
  assert.match(apply.stdout, /cli\.js --help/);
  assert.match(apply.stdout, /cli\.js --version/);
  assert.match(apply.stdout, /cli\.js --list-models/);
  const activation = JSON.parse(readFileSync(join(dataRoot(home), "state", "activation.json"), "utf8"));
  const payload = join(dataRoot(home), "compositions", activation.active.compositionId, "payload");
  assert.equal(readFileSync(join(payload, "compatible-selection.txt"), "utf8"), "selected\n");
  assert.equal(existsSync(join(payload, "must-not-exist.txt")), false);
});

test("re-adding a source cannot advance selected Artifacts into a declared Pi Base mismatch", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const metadataPath = join(repository.source, "porcupi.json");
  writeFileSync(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    supportedPiBaseVersions: ["v0.81.1"],
    supportedPiBaseCommits: [base.commit],
  }, null, 2)}\n`);
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Support current Pi Base");
  git(repository.source, "tag", "compatible");
  const compatibleCommit = git(repository.source, "rev-parse", "HEAD");
  writeFileSync(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    supportedPiBaseVersions: ["v9.9.9"],
  }, null, 2)}\n`);
  git(repository.source, "add", "porcupi.json");
  git(repository.source, "commit", "-m", "Drop current Pi Base support");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const initial = runPorcuPi(home, ["add", `${locator}@compatible`], "616e6e0d");
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].commit, compatibleCommit);

  const incompatible = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");

  assert.equal(incompatible.status, 0, incompatible.stderr || incompatible.stdout);
  assert.match(incompatible.stdout, new RegExp(`Source-wide change: ${compatibleCommit} → ${repository.commit}`));
  assert.match(incompatible.stdout, /Extension\s+extensions\/fixture\.ts \[not supported by this Pi Base\]/);
  assert.match(incompatible.stdout, /0 Pi resource\(s\), 0 Patch Series selected/);
  assert.deepEqual(JSON.parse(readFileSync(selectionsPath, "utf8")).sources, []);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8")).packages, []);
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
    PI_FIXTURE_PACKAGE_FAIL_ONCE_SCOPE: "project",
    PI_FIXTURE_PACKAGE_FAIL_ONCE_STATE: join(root, "manage-package-failure"),
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

test("named and default branches retain canonical channels while tags and commits stay pinned", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  git(repository.source, "branch", "release/stable");
  git(repository.source, "tag", "snapshot");
  const locator = await serveGitRepository(root, repository);
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const settingsPath = join(home, ".pi", "agent", "settings.json");

  const named = runPorcuPi(home, ["add", `${locator}@origin/release/stable`], "206e6e0d");
  assert.equal(named.status, 0, named.stderr || named.stdout);
  let source = JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0];
  assert.equal(source.trackedBranch, "refs/heads/release/stable");
  assert.equal(source.commit, repository.commit);
  assert.match(source.packageSource, new RegExp(`@${repository.commit}$`));
  assert.match(JSON.stringify(JSON.parse(readFileSync(settingsPath, "utf8"))), new RegExp(`@${repository.commit}`));
  const trackedManage = runPorcuPi(home, ["manage"], "1b", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(trackedManage.status, 0, trackedManage.stderr || trackedManage.stdout);
  assert.match(trackedManage.stdout, /Tracked Branch: refs\/heads\/release\/stable/);
  assert.match(trackedManage.stdout, new RegExp(`Accepted exact commit: ${repository.commit}`));

  const namedRemoval = runPorcuPi(home, ["add", `${locator}@origin/release/stable`], "646e6e0d");
  assert.equal(namedRemoval.status, 0, namedRemoval.stderr || namedRemoval.stdout);
  assert.deepEqual(JSON.parse(readFileSync(selectionsPath, "utf8")).sources, []);

  const defaultBranch = runPorcuPi(home, ["add", locator], "206e6e0d");
  assert.equal(defaultBranch.status, 0, defaultBranch.stderr || defaultBranch.stdout);
  source = JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0];
  assert.equal(source.trackedBranch, "refs/heads/main");
  assert.equal(source.commit, repository.commit);

  const acceptedDefault = readFileSync(selectionsPath);
  const remote = join(root, "git-daemon", "owner", "resources.git");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/release/stable");
  const changedDefault = runPorcuPi(home, ["add", locator], "");
  assert.notEqual(changedDefault.status, 0);
  assert.match(changedDefault.stdout, new RegExp(`Tracked Branch identity changed unexpectedly from refs/heads/main to refs/heads/release/stable; accepted exact snapshot ${repository.commit} is preserved`));
  assert.deepEqual(readFileSync(selectionsPath), acceptedDefault);
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

  const removal = runPorcuPi(home, ["add", locator], "646e6e0d");
  assert.equal(removal.status, 0, removal.stderr || removal.stdout);
  assert.deepEqual(JSON.parse(readFileSync(selectionsPath, "utf8")).sources, []);

  const tagged = runPorcuPi(home, ["add", `${locator}@refs/tags/snapshot`], "206e6e0d");
  assert.equal(tagged.status, 0, tagged.stderr || tagged.stdout);
  source = JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0];
  assert.equal(Object.hasOwn(source, "trackedBranch"), false);
  assert.equal(source.commit, repository.commit);
  const pinnedManage = runPorcuPi(home, ["manage"], "1b", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(pinnedManage.status, 0, pinnedManage.stderr || pinnedManage.stdout);
  assert.match(pinnedManage.stdout, /Pinned source/);
  assert.match(pinnedManage.stdout, new RegExp(`Accepted exact commit: ${repository.commit}`));

  const committed = runPorcuPi(home, ["add", `${locator}@${repository.commit}`], "6e6e0d");
  assert.equal(committed.status, 0, committed.stderr || committed.stdout);
  source = JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0];
  assert.equal(Object.hasOwn(source, "trackedBranch"), false);
  assert.equal(source.commit, repository.commit);
});

test("branch movement and ref failures preserve the accepted exact snapshot", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  git(repository.source, "branch", "deleted-later");
  git(repository.source, "branch", "collision");
  git(repository.source, "tag", "collision");
  const locator = await serveGitRepository(root, repository);
  const remote = join(root, "git-daemon", "owner", "resources.git");
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  const activationPath = join(dataRoot(home), "state", "activation.json");

  const added = runPorcuPi(home, ["add", `${locator}@main`], "206e6e0d");
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const acceptedCommit = repository.commit;
  const selectionsBefore = readFileSync(selectionsPath);
  const settingsBefore = readFileSync(settingsPath);
  const activationBefore = readFileSync(activationPath);

  repository.commit = git(repository.source, "commit-tree", "HEAD^{tree}", "-m", "Rewrite tracked branch");
  git(repository.source, "push", "--force", remote, `${repository.commit}:main`);
  git(remote, "update-ref", "-d", "refs/heads/deleted-later");

  const manage = runPorcuPiProcess(home, ["manage"]);
  assert.notEqual(manage.status, 0);
  assert.match(
    `${manage.stdout}${manage.stderr}`,
    new RegExp(`Tracked Branch refs/heads/main moved non-fast-forward; accepted exact snapshot ${acceptedCommit} is preserved`),
  );
  assert.doesNotMatch(`${manage.stdout}${manage.stderr}`, /requires an interactive terminal/);

  const unexpectedlyMoved = runPorcuPi(home, ["add", `${locator}@main`], "");
  const missing = runPorcuPi(home, ["add", `${locator}@does-not-exist`], "");
  const deleted = runPorcuPi(home, ["add", `${locator}@deleted-later`], "");
  const ambiguous = runPorcuPi(home, ["add", `${locator}@collision`], "");

  assert.notEqual(unexpectedlyMoved.status, 0);
  assert.match(unexpectedlyMoved.stdout, new RegExp(`Tracked Branch refs/heads/main moved unexpectedly; accepted exact snapshot ${acceptedCommit} is preserved`));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /does-not-exist.*does not exist/);
  assert.notEqual(deleted.status, 0);
  assert.match(deleted.stdout, /deleted-later.*does not exist/);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stdout, /collision.*ambiguous between a branch and tag/);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
  assert.deepEqual(readFileSync(settingsPath), settingsBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("porcupi manage reviews and accepts one compatible resource-only Inter-release Source Update", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const locator = await serveGitRepository(root, repository);
  const packageLog = join(root, "package.log");
  const launchLog = join(root, "launch.log");
  const environment = { PI_FIXTURE_PACKAGE_LOG: packageLog, PI_FIXTURE_LAUNCH_LOG: launchLog };
  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d", environment);
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const forwardedUpdate = runPorcuPiProcess(home, ["update", "fixture-package"], environment);
  assert.equal(forwardedUpdate.status, 0, forwardedUpdate.stderr || forwardedUpdate.stdout);
  assert.deepEqual(JSON.parse(readFileSync(launchLog, "utf8").trim()), ["update", "fixture-package"]);

  const managedRoot = dataRoot(home);
  const selectionsPath = join(managedRoot, "state", "selections.json");
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  const activationPath = join(managedRoot, "state", "activation.json");
  const acceptedCommit = repository.commit;
  for (const path of [
    "extensions/fixture.ts",
    "skills/fixture-skill/SKILL.md",
    "prompts/fixture.md",
  ]) writeFileSync(join(repository.source, path), `${readFileSync(join(repository.source, path), "utf8")}\nCandidate resource change.\n`);
  const candidateTheme = JSON.parse(readFileSync(join(repository.source, "themes", "fixture.json"), "utf8"));
  candidateTheme.name = "fixture-theme-candidate";
  writeFileSync(join(repository.source, "themes", "fixture.json"), `${JSON.stringify(candidateTheme, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Advance every selected Pi resource");
  const candidateCommit = publishRepositoryHead(root, repository);

  const selectionsBefore = readFileSync(selectionsPath);
  const settingsBefore = readFileSync(settingsPath);
  const packageLogBefore = readFileSync(packageLog);
  const activationBefore = readFileSync(activationPath);
  const cancelled = runPorcuPi(home, ["manage"], "6e1b", {
    ...environment,
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, new RegExp(`Accepted exact commit: ${acceptedCommit}`));
  assert.match(cancelled.stdout, new RegExp(`Candidate exact commit: ${candidateCommit}`));
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
  assert.deepEqual(readFileSync(settingsPath), settingsBefore);
  assert.deepEqual(readFileSync(packageLog), packageLogBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  const accepted = runPorcuPi(home, ["manage"], "6e6e0d", {
    ...environment,
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.match(accepted.stdout, /Extension.*changed.*extensions\/fixture\.ts/);
  assert.match(accepted.stdout, /Skill.*changed.*skills\/fixture-skill\/SKILL\.md/);
  assert.match(accepted.stdout, /Prompt.*changed.*prompts\/fixture\.md/);
  assert.match(accepted.stdout, /Theme.*changed.*themes\/fixture\.json/);
  assert.match(accepted.stdout, new RegExp(`Current PorcuPi release: ${porcupiVersion}`));
  assert.match(accepted.stdout, new RegExp(`Current Pi Base: .*${base.commit}`));
  assert.match(accepted.stdout, /Pi retains project trust authority; PorcuPi never approves a project/);
  assert.match(accepted.stdout, /Immediately reconciled 4 Pi resources through Pi's public package lifecycle/);
  assert.match(accepted.stdout, /No changed Patch Series await `porcupi apply`/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  const selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  assert.equal(selections.sources[0].commit, candidateCommit);
  assert.ok(selections.sources[0].artifacts.every((artifact) => artifact.kind !== "PatchSeries"));
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.match(settings.packages[0].source, new RegExp(`@${candidateCommit}$`));
  const calls = readFileSync(packageLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.at(-1), ["install", selections.sources[0].packageSource]);

  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    supportedPiBaseCommits: ["f".repeat(40)],
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Publish incompatible resource candidate");
  const incompatibleCommit = publishRepositoryHead(root, repository);
  const acceptedSelections = readFileSync(selectionsPath);
  const acceptedSettings = readFileSync(settingsPath);
  const incompatible = runPorcuPiProcess(home, ["manage"], environment);
  assert.notEqual(incompatible.status, 0);
  assert.match(`${incompatible.stdout}${incompatible.stderr}`, new RegExp(`Inter-release Source Update blocked:.*${incompatibleCommit}.*does not support current Pi Base`));
  assert.deepEqual(readFileSync(selectionsPath), acceptedSelections);
  assert.deepEqual(readFileSync(settingsPath), acceptedSettings);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("a Patch-only Inter-release Source Update stays pending until explicit apply", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createApplicablePatchRepository(root, [[
    "patches/series.patch",
    textPatch("series.txt", "base", "accepted"),
  ]]);
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "206e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const initialApply = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(initialApply.status, 0, initialApply.stderr || initialApply.stdout);

  const managedRoot = dataRoot(home);
  const selectionsPath = join(managedRoot, "state", "selections.json");
  const activationPath = join(managedRoot, "state", "activation.json");
  const activeBefore = readFileSync(activationPath);
  writeFileSync(join(repository.source, "patches", "series.patch"), textPatch("series.txt", "base", "candidate"));
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Advance selected Patch Series");
  const candidateCommit = publishRepositoryHead(root, repository);
  const selectionBefore = readFileSync(selectionsPath);
  const cancelled = runPorcuPi(home, ["manage"], "6e6e1b", {
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, /pending Patches, and Managed Pi activation are unchanged/);
  assert.deepEqual(readFileSync(selectionsPath), selectionBefore);
  assert.deepEqual(readFileSync(activationPath), activeBefore);

  const update = runPorcuPi(home, ["manage"], "6e6e0d", {
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  assert.match(update.stdout, /Patch Series.*changed.*patches\/series\.patch/);
  assert.match(update.stdout, /Immediately reconciled 0 Pi resources/);
  assert.match(update.stdout, /Recorded 1 Patch Series.*await `porcupi apply`/);
  assert.match(update.stdout, /Patch Selection Intent is pending `porcupi apply`/);
  assert.deepEqual(readFileSync(activationPath), activeBefore);
  const selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  assert.equal(selections.sources[0].commit, candidateCommit);
  assert.equal(selections.sources[0].artifacts[0].members[0].commit, candidateCommit);
  assert.equal(
    selections.sources[0].artifacts[0].members[0].sha256,
    createHash("sha256").update(readFileSync(join(repository.source, "patches", "series.patch"))).digest("hex"),
  );

  const applied = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const activation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.equal(
    readFileSync(join(managedRoot, "compositions", activation.active.compositionId, "payload", "series.txt"), "utf8"),
    "candidate\n",
  );
  assert.match(applied.stdout, /Patch Selection Intent matches the active Managed Pi Composition/);
});

test("a mixed Inter-release Source Update reconciles Pi resources now and applies Patches later", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  mkdirSync(join(repository.source, "patches"));
  writeFileSync(join(repository.source, "patches", "mixed.patch"), textPatch("series.txt", "base", "mixed-accepted"));
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    supportedPiBaseVersions: ["v0.81.1"],
    supportedPiBaseCommits: [base.commit],
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add compatible Patch Series");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "616e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const initialApply = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(initialApply.status, 0, initialApply.stderr || initialApply.stdout);

  const managedRoot = dataRoot(home);
  const selectionsPath = join(managedRoot, "state", "selections.json");
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  const activationPath = join(managedRoot, "state", "activation.json");
  const activeBefore = readFileSync(activationPath);
  writeFileSync(join(repository.source, "extensions", "fixture.ts"), "export default function candidateFixture() {}\n");
  writeFileSync(join(repository.source, "patches", "mixed.patch"), textPatch("series.txt", "base", "mixed-candidate"));
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Advance mixed selected content");
  const candidateCommit = publishRepositoryHead(root, repository);

  const update = runPorcuPi(home, ["manage"], "6e6e0d", {
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  assert.match(update.stdout, /Extension.*changed.*extensions\/fixture\.ts/);
  assert.match(update.stdout, /Patch Series.*changed.*patches\/mixed\.patch/);
  assert.match(update.stdout, /author declaration matches this exact Pi Base/);
  assert.match(update.stdout, /Immediately reconciled 4 Pi resources/);
  assert.match(update.stdout, /Recorded 1 Patch Series.*await `porcupi apply`/);
  assert.deepEqual(readFileSync(activationPath), activeBefore);
  const selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  assert.equal(selections.sources[0].commit, candidateCommit);
  assert.ok(selections.sources[0].artifacts.every((artifact) => (
    artifact.kind !== "PatchSeries" || artifact.members.every((member) => member.commit === candidateCommit)
  )));
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.match(settings.packages[0].source, new RegExp(`@${candidateCommit}$`));

  const applied = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const activation = JSON.parse(readFileSync(activationPath, "utf8"));
  assert.equal(
    readFileSync(join(managedRoot, "compositions", activation.active.compositionId, "payload", "series.txt"), "utf8"),
    "mixed-candidate\n",
  );
});

test("Tracked Branch updates filter structural inventory changes and allow forced exact-commit review", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  mkdirSync(join(repository.source, "extensions", "directory"));
  writeFileSync(join(repository.source, "extensions", "directory", "index.ts"), "export default function directoryExtension() {}\n");
  writeFileSync(join(repository.source, "extensions", "directory", "helper.ts"), "export const acceptedHelper = true;\n");
  writeFileSync(join(repository.source, "extensions", "directory", "package.json"), `${JSON.stringify({
    name: "empty-extension-manifest",
    pi: { extensions: [] },
  }, null, 2)}\n`);
  writeFileSync(join(repository.source, "skills", "fixture-skill", "helper.txt"), "accepted helper\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add selected Skill helper");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "206a6a6a206e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const acceptedCommit = JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].commit;
  writeFileSync(join(repository.source, "unrelated", "documentation.md"), "irrelevant\n");
  writeFileSync(join(repository.source, "extensions", "independent.ts"), "export default function independent() {}\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Change only unselected content");
  const irrelevantCommit = publishRepositoryHead(root, repository);

  const quiet = runPorcuPi(home, ["manage"], "1b", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(quiet.status, 0, quiet.stderr || quiet.stdout);
  assert.doesNotMatch(quiet.stdout, /Review Tracked Branch candidate/);
  assert.match(quiet.stdout, new RegExp(`Latest exact commit ${irrelevantCommit} has unchanged selected structural content`));
  assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].commit, acceptedCommit);

  const forced = runPorcuPi(home, ["manage"], "756e6e0d", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(forced.status, 0, forced.stderr || forced.stdout);
  assert.match(forced.stdout, /Review Tracked Branch candidate/);
  assert.match(forced.stdout, /explicit latest-commit review/);
  assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].commit, irrelevantCommit);

  writeFileSync(join(repository.source, "skills", "fixture-skill", "helper.txt"), "changed selected helper\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Change selected Skill helper");
  const relevantCommit = publishRepositoryHead(root, repository);
  const relevant = runPorcuPi(home, ["manage"], "6a6e6e0d", {
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(relevant.status, 0, relevant.stderr || relevant.stdout);
  assert.match(relevant.stdout, /Skill.*changed.*skills\/fixture-skill\/SKILL\.md/);
  assert.match(relevant.stdout, /2 tracked regular files/);
  assert.match(relevant.stdout, /Content file changed: skills\/fixture-skill\/helper\.txt/);
  assert.match(relevant.stdout, /accepted 100644 sha256:[a-f0-9]{64} → candidate 100644 sha256:[a-f0-9]{64}/);
  assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].commit, relevantCommit);

  writeFileSync(join(repository.source, "extensions", "directory", "new-helper.ts"), "export const addedHelper = true;\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add file beneath selected directory Extension");
  const extensionCommit = publishRepositoryHead(root, repository);
  const extension = runPorcuPi(home, ["manage"], "6e6e0d", {
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(extension.status, 0, extension.stderr || extension.stdout);
  assert.match(extension.stdout, /Extension.*changed.*extensions\/directory\/index\.ts/);
  assert.match(extension.stdout, /4 tracked regular files/);
  assert.match(extension.stdout, /Content file added: extensions\/directory\/new-helper\.ts · 100644 sha256:[a-f0-9]{64}/);
  assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].commit, extensionCommit);
});

test("unrelated ancestor package manifests stay outside a conventional Skill inventory", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const manifestPath = join(repository.source, "skills", "package.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    name: "unrelated-skill-parent",
    dependencies: { unrelated: "1.0.0" },
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add unrelated parent manifest");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "6a6a206e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies.unrelated = "2.0.0";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Change unrelated parent manifest");
  const candidateCommit = publishRepositoryHead(root, repository);

  const manage = runPorcuPi(home, ["manage"], "1b");
  assert.equal(manage.status, 0, manage.stderr || manage.stdout);
  assert.doesNotMatch(manage.stdout, /Review Tracked Branch candidate/);
  assert.match(manage.stdout, new RegExp(`Latest exact commit ${candidateCommit} has unchanged selected structural content`));
});

test("a malformed root package manifest blocks a Tracked Branch candidate", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const manifestPath = join(repository.source, "package.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    name: "root-package",
    dependencies: { runtime: "1.0.0" },
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add root package manifest");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "6a6a206e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const selectionsBefore = readFileSync(selectionsPath);

  writeFileSync(manifestPath, "{ malformed\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Break root package manifest");
  publishRepositoryHead(root, repository);

  const manage = runPorcuPi(home, ["manage"], "1b");
  assert.notEqual(manage.status, 0);
  assert.match(`${manage.stdout}${manage.stderr}`, /Inter-release Source Update blocked: Applicable package manifest is malformed: package\.json/);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
});

test("root package manifest mode alone does not change bounded package inputs", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const manifestPath = join(repository.source, "package.json");
  writeFileSync(manifestPath, `${JSON.stringify({ name: "root-package" }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add root package manifest");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "6a6a206e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);

  chmodSync(manifestPath, 0o755);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Change only root package manifest mode");
  const candidateCommit = publishRepositoryHead(root, repository);

  const manage = runPorcuPi(home, ["manage"], "1b");
  assert.equal(manage.status, 0, manage.stderr || manage.stdout);
  assert.doesNotMatch(manage.stdout, /Review Tracked Branch candidate/);
  assert.match(manage.stdout, new RegExp(`Latest exact commit ${candidateCommit} has unchanged selected structural content`));
});

test("the root package manifest remains authoritative for nested-manifest Extension discovery", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const rootManifestPath = join(repository.source, "package.json");
  writeFileSync(rootManifestPath, `${JSON.stringify({
    name: "root-package",
    dependencies: { runtime: "1.0.0" },
  }, null, 2)}\n`);
  const extensionDirectory = join(repository.source, "extensions", "nested");
  mkdirSync(extensionDirectory);
  writeFileSync(join(extensionDirectory, "index.ts"), "export default function nested() {}\n");
  const nestedManifestPath = join(extensionDirectory, "package.json");
  writeFileSync(nestedManifestPath, `${JSON.stringify({
    name: "nested-extension",
    dependencies: { unrelated: "1.0.0" },
    pi: { extensions: ["index.ts"] },
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add manifest-discovered Extension");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "6a206e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const nestedManifest = JSON.parse(readFileSync(nestedManifestPath, "utf8"));
  nestedManifest.dependencies.unrelated = "2.0.0";
  writeFileSync(nestedManifestPath, `${JSON.stringify(nestedManifest, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Change discovery-only nested manifest dependency");
  const nestedCommit = publishRepositoryHead(root, repository);

  const quiet = runPorcuPi(home, ["manage"], "1b");
  assert.equal(quiet.status, 0, quiet.stderr || quiet.stdout);
  assert.doesNotMatch(quiet.stdout, /Review Tracked Branch candidate/);
  assert.match(quiet.stdout, new RegExp(`Latest exact commit ${nestedCommit} has unchanged selected structural content`));

  const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
  rootManifest.dependencies.runtime = "2.0.0";
  writeFileSync(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Change root package dependency");
  publishRepositoryHead(root, repository);

  const changed = runPorcuPi(home, ["manage"], "1b");
  assert.equal(changed.status, 0, changed.stderr || changed.stdout);
  assert.match(changed.stdout, /Review Tracked Branch candidate/);
  assert.match(changed.stdout, /Dependency declarations changed: accepted \{"dependencies":\{"runtime":"1\.0\.0"\}\} → candidate \{"dependencies":\{"runtime":"2\.0\.0"\}\}/);
});

test("npm dependencies lifecycle changes remain bounded package inputs", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const manifestPath = join(repository.source, "package.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    name: "lifecycle-fixture",
    scripts: { dependencies: "node accepted-dependencies.mjs" },
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Declare dependencies lifecycle");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "6a6a206e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.scripts.dependencies = "node candidate-dependencies.mjs";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Change dependencies lifecycle");
  publishRepositoryHead(root, repository);

  const manage = runPorcuPi(home, ["manage"], "1b");
  assert.equal(manage.status, 0, manage.stderr || manage.stdout);
  assert.match(manage.stdout, /Review Tracked Branch candidate/);
  assert.match(manage.stdout, /Install-lifecycle scripts changed: accepted \{"dependencies":"node accepted-dependencies\.mjs"\} → candidate \{"dependencies":"node candidate-dependencies\.mjs"\}/);
});

test("declared resource content and bounded package inputs conservatively produce candidates", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  mkdirSync(join(repository.source, "shared"));
  writeFileSync(join(repository.source, "shared", "helper.txt"), "accepted helper\n");
  writeFileSync(join(repository.source, "package.json"), `${JSON.stringify({
    name: "structural-fixture",
    dependencies: { fixture: "1.0.0" },
    scripts: { test: "ignored-test", postinstall: "accepted-install" },
    pi: { extensions: ["extensions/fixture.ts"] },
  }, null, 2)}\n`);
  writeFileSync(join(repository.source, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  writeFileSync(join(repository.source, "extensions", "package.json"), `${JSON.stringify({
    name: "nested-nonauthoritative-fixture",
    dependencies: { nested: "1.0.0" },
  }, null, 2)}\n`);
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    resources: [{
      kind: "Extension",
      path: "extensions/fixture.ts",
      content: ["extensions/fixture.ts", "shared"],
    }],
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Declare selected Extension content");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "206e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const selectionsPath = join(dataRoot(home), "state", "selections.json");

  const acceptCandidate = (message) => {
    git(repository.source, "add", ".");
    git(repository.source, "commit", "-m", message);
    const commit = publishRepositoryHead(root, repository);
    const result = runPorcuPi(home, ["manage"], "6e6e0d", {
      PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].commit, commit);
    return result;
  };

  const nestedManifestPath = join(repository.source, "extensions", "package.json");
  const nestedManifest = JSON.parse(readFileSync(nestedManifestPath, "utf8"));
  nestedManifest.dependencies.nested = "2.0.0";
  writeFileSync(nestedManifestPath, `${JSON.stringify(nestedManifest, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Change nonauthoritative nested package input");
  const nestedCommit = publishRepositoryHead(root, repository);
  const nestedChange = runPorcuPi(home, ["manage"], "1b", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(nestedChange.status, 0, nestedChange.stderr || nestedChange.stdout);
  assert.match(nestedChange.stdout, new RegExp(`Latest exact commit ${nestedCommit} has unchanged selected structural content`));
  assert.doesNotMatch(nestedChange.stdout, /Review Tracked Branch candidate/);

  const forcedNested = runPorcuPi(home, ["manage"], "756e6e0d", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(forcedNested.status, 0, forcedNested.stderr || forcedNested.stdout);
  assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].commit, nestedCommit);

  writeFileSync(join(repository.source, "shared", "added.txt"), "declared additive content\n");
  const content = acceptCandidate("Add file beneath declared content directory");
  assert.match(content.stdout, /Extension.*changed.*extensions\/fixture\.ts/);
  assert.match(content.stdout, /3 tracked regular files/);
  assert.match(content.stdout, /Content file added: shared\/added\.txt · 100644 sha256:[a-f0-9]{64}/);

  const metadata = JSON.parse(readFileSync(join(repository.source, "porcupi.json"), "utf8"));
  metadata.resources[0].content = ["extensions/fixture.ts", "shared/helper.txt", "shared/added.txt"];
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  const declaration = acceptCandidate("Change selected-content declaration without changing file inventory");
  assert.match(declaration.stdout, /Content declaration changed:/);
  assert.match(declaration.stdout, /accepted \["extensions\/fixture\.ts","shared"\]/);
  assert.match(declaration.stdout, /candidate \["extensions\/fixture\.ts","shared\/helper\.txt","shared\/added\.txt"\]/);

  const manifest = JSON.parse(readFileSync(join(repository.source, "package.json"), "utf8"));
  manifest.dependencies.fixture = "2.0.0";
  writeFileSync(join(repository.source, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const dependency = acceptCandidate("Change bounded dependency declaration");
  assert.match(dependency.stdout, /Dependency declarations changed:/);
  assert.match(dependency.stdout, /accepted \{"dependencies":\{"fixture":"1\.0\.0"\}\}/);
  assert.match(dependency.stdout, /candidate \{"dependencies":\{"fixture":"2\.0\.0"\}\}/);

  manifest.scripts.test = "still ignored";
  writeFileSync(join(repository.source, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Change unrelated package script");
  const ignoredScriptCommit = publishRepositoryHead(root, repository);
  const ignoredScript = runPorcuPi(home, ["manage"], "1b", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(ignoredScript.status, 0, ignoredScript.stderr || ignoredScript.stdout);
  assert.match(ignoredScript.stdout, new RegExp(`Latest exact commit ${ignoredScriptCommit} has unchanged selected structural content`));

  manifest.scripts.postinstall = "changed-install";
  writeFileSync(join(repository.source, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const lifecycle = acceptCandidate("Change install lifecycle declaration");
  assert.match(lifecycle.stdout, /Install-lifecycle scripts changed:/);
  assert.match(lifecycle.stdout, /accepted \{"postinstall":"accepted-install"\}/);
  assert.match(lifecycle.stdout, /candidate \{"postinstall":"changed-install"\}/);

  writeFileSync(join(repository.source, "package-lock.json"), "{\"lockfileVersion\":3,\"changed\":true}\n");
  const lock = acceptCandidate("Change applicable committed package lock");
  assert.match(lock.stdout, /Package lock changed: accepted package-lock\.json · 100644 sha256:[a-f0-9]{64} → candidate package-lock\.json · 100644 sha256:[a-f0-9]{64}/);
});

test("selected declared Patch Series coalesce latest membership while standalone additions stay quiet", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createApplicablePatchRepository(root, [
    ["patches/one.patch", textPatch("series.txt", "base", "one")],
    ["patches/unselected.patch", newFilePatch("unselected.txt", "unselected")],
  ]);
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify({
    schemaVersion: 1,
    patchSeries: [{ id: "selected-series", members: ["patches/one.patch"] }],
  }, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Declare selected series");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "6a206e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const managedRoot = dataRoot(home);
  const selectionsPath = join(managedRoot, "state", "selections.json");
  const activationBefore = readFileSync(join(managedRoot, "state", "activation.json"));

  writeFileSync(join(repository.source, "patches", "two.patch"), textPatch("series.txt", "one", "two"));
  const metadata = JSON.parse(readFileSync(join(repository.source, "porcupi.json"), "utf8"));
  metadata.patchSeries[0].members.push("patches/two.patch");
  writeFileSync(join(repository.source, "porcupi.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add selected series member");
  publishRepositoryHead(root, repository);
  const additive = runPorcuPi(home, ["manage"], "6e6e0d", {
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(additive.status, 0, additive.stderr || additive.stdout);
  assert.match(additive.stdout, /Patch Series.*changed.*selected-series/);
  assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].artifacts[0].members.length, 2);
  assert.deepEqual(readFileSync(join(managedRoot, "state", "activation.json")), activationBefore);

  writeFileSync(join(repository.source, "patches", "independent.patch"), newFilePatch("independent.txt", "independent"));
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add unselected standalone Patch File");
  const standaloneCommit = publishRepositoryHead(root, repository);
  const quiet = runPorcuPi(home, ["manage"], "1b", { PTY_WAIT_FOR: "1 of 3 — Keep or remove" });
  assert.equal(quiet.status, 0, quiet.stderr || quiet.stdout);
  assert.match(quiet.stdout, new RegExp(`Latest exact commit ${standaloneCommit} has unchanged selected structural content`));

  writeFileSync(join(repository.source, "patches", "two.patch"), textPatch("series.txt", "one", "latest"));
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Replace pending selected member bytes");
  const latestCommit = publishRepositoryHead(root, repository);
  const repeated = runPorcuPi(home, ["manage"], "6e6e0d", {
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  const latest = JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0];
  assert.equal(latest.commit, latestCommit);
  assert.ok(latest.artifacts[0].members.every((member) => member.commit === latestCommit));
  assert.equal(latest.artifacts[0].members[1].sha256, createHash("sha256").update(readFileSync(join(repository.source, "patches", "two.patch"))).digest("hex"));
  assert.deepEqual(readFileSync(join(managedRoot, "state", "activation.json")), activationBefore);
});

test("final acceptance rejects Tracked Branch movement and removed selected Artifacts", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);
  const repository = createResourceRepository(root);
  const locator = await serveGitRepository(root, repository);
  const add = runPorcuPi(home, ["add", `${locator}@main`], "6a6a206e6e0d");
  assert.equal(add.status, 0, add.stderr || add.stdout);
  const selectionsPath = join(dataRoot(home), "state", "selections.json");
  const selectionsBefore = readFileSync(selectionsPath);

  writeFileSync(join(repository.source, "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Reviewed candidate.\n---\nReviewed.\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Publish reviewed candidate");
  const reviewedCommit = publishRepositoryHead(root, repository);
  writeFileSync(join(repository.source, "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Moved candidate.\n---\nMoved.\n");
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Move branch during review");
  const movedCommit = git(repository.source, "rev-parse", "HEAD");
  const bare = join(root, "git-daemon", "owner", "resources.git");
  git(repository.source, "push", bare, `${movedCommit}:refs/heads/future`);

  const moved = runPorcuPi(home, ["manage"], "6e6e0d", {
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
    PTY_BEFORE_INPUT_COMMAND: `git --git-dir=${JSON.stringify(bare)} update-ref refs/heads/main ${movedCommit}`,
  });
  assert.notEqual(moved.status, 0);
  assert.match(`${moved.stdout}${moved.stderr}`, new RegExp(`Candidate exact commit: ${reviewedCommit}`));
  assert.match(`${moved.stdout}${moved.stderr}`, new RegExp(`Tracked Branch moved after review; reviewed exact commit ${reviewedCommit} was not accepted`));
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);

  const latest = runPorcuPi(home, ["manage"], "6e6e0d", {
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(latest.status, 0, latest.stderr || latest.stdout);
  assert.match(latest.stdout, new RegExp(`Candidate exact commit: ${movedCommit}`));
  assert.equal(JSON.parse(readFileSync(selectionsPath, "utf8")).sources[0].commit, movedCommit);
  const validSelections = readFileSync(selectionsPath);

  rmSync(join(repository.source, "skills", "fixture-skill", "SKILL.md"));
  git(repository.source, "add", "--all");
  git(repository.source, "commit", "-m", "Remove selected Skill");
  const removalCommit = publishRepositoryHead(root, repository);
  const removed = runPorcuPiProcess(home, ["manage"]);
  assert.notEqual(removed.status, 0);
  assert.match(`${removed.stdout}${removed.stderr}`, new RegExp(`Inter-release Source Update blocked:.*${removalCommit}.*is not discoverable`));
  assert.deepEqual(readFileSync(selectionsPath), validSelections);
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

test("multiple Tracked Branch Patch updates remain independently reviewable and apply as one latest snapshot", async () => {
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
  const repositoryA = createApplicablePatchRepository(sourceRootA, [[
    "patches/source-a.patch",
    newFilePatch("source-a.txt", "accepted-a"),
  ]]);
  const repositoryB = createApplicablePatchRepository(sourceRootB, [[
    "patches/source-b.patch",
    newFilePatch("source-b.txt", "accepted-b"),
  ]]);
  const locatorA = await serveGitRepository(serverRootA, repositoryA);
  const locatorB = await serveGitRepository(serverRootB, repositoryB);
  assert.equal(runPorcuPi(home, ["add", `${locatorA}@main`], "206e6e0d").status, 0);
  assert.equal(runPorcuPi(home, ["add", `${locatorB}@main`], "206e6e0d").status, 0);
  const initialApply = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(initialApply.status, 0, initialApply.stderr || initialApply.stdout);

  const managedRoot = dataRoot(home);
  const selectionsPath = join(managedRoot, "state", "selections.json");
  const activationPath = join(managedRoot, "state", "activation.json");
  const accepted = JSON.parse(readFileSync(selectionsPath, "utf8"));
  const acceptedByLocator = new Map(accepted.sources.map((source) => [source.locator, source.commit]));
  const activeBefore = readFileSync(activationPath);

  writeFileSync(join(repositoryA.source, "patches", "source-a.patch"), newFilePatch("source-a.txt", "candidate-a"));
  git(repositoryA.source, "add", ".");
  git(repositoryA.source, "commit", "-m", "Advance source A");
  const candidateA = publishRepositoryHead(serverRootA, repositoryA);
  writeFileSync(join(repositoryB.source, "patches", "source-b.patch"), newFilePatch("source-b.txt", "candidate-b"));
  git(repositoryB.source, "add", ".");
  git(repositoryB.source, "commit", "-m", "Advance source B");
  const candidateB = publishRepositoryHead(serverRootB, repositoryB);

  const orderedLocators = [...acceptedByLocator.keys()].sort();
  const reviewedLocator = orderedLocators[1];
  const reviewedCommit = reviewedLocator === accepted.sources.find((source) => source.locator.includes(new URL(locatorA).port)).locator
    ? candidateA
    : candidateB;
  const otherLocator = orderedLocators[0];
  const cancelled = runPorcuPi(home, ["manage"], "1b", {
    PTY_WAIT_FOR: "Choose one Source Repository update",
  });
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.match(cancelled.stdout, /Source update selection cancelled/);
  assert.deepEqual(readFileSync(selectionsPath), Buffer.from(`${JSON.stringify(accepted, null, 2)}\n`));
  assert.deepEqual(readFileSync(activationPath), activeBefore);

  const firstUpdate = runPorcuPi(home, ["manage"], "6a0d6e6e0d", {
    PTY_WAIT_FOR: "Choose one Source Repository update",
  });
  assert.equal(firstUpdate.status, 0, firstUpdate.stderr || firstUpdate.stdout);
  assert.match(firstUpdate.stdout, new RegExp(`Accepted Tracked Branch candidate ${reviewedCommit}`));
  let selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  assert.equal(selections.sources.find((source) => source.locator === reviewedLocator).commit, reviewedCommit);
  assert.equal(selections.sources.find((source) => source.locator === otherLocator).commit, acceptedByLocator.get(otherLocator));
  assert.deepEqual(readFileSync(activationPath), activeBefore);

  const secondUpdate = runPorcuPi(home, ["manage"], "6e6e0d", {
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  });
  assert.equal(secondUpdate.status, 0, secondUpdate.stderr || secondUpdate.stdout);
  selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  assert.deepEqual(new Map(selections.sources.map((source) => [source.locator, source.commit])), new Map([
    [accepted.sources.find((source) => source.locator.includes(new URL(locatorA).port)).locator, candidateA],
    [accepted.sources.find((source) => source.locator.includes(new URL(locatorB).port)).locator, candidateB],
  ]));
  assert.deepEqual(readFileSync(activationPath), activeBefore);

  const latestIntent = readFileSync(selectionsPath);
  const failedApply = runPorcuPi(home, ["apply"], "0d", {
    PORCUPI_TEST_FAILURE: "apply-activation-write",
    PTY_WAIT_FOR: "Apply selected Patches",
  });
  assert.notEqual(failedApply.status, 0);
  assert.deepEqual(readFileSync(selectionsPath), latestIntent);
  assert.deepEqual(readFileSync(activationPath), activeBefore);

  const applied = runPorcuPi(home, ["apply"], "0d", { PTY_WAIT_FOR: "Apply selected Patches" });
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const activation = JSON.parse(readFileSync(activationPath, "utf8"));
  const payload = join(managedRoot, "compositions", activation.active.compositionId, "payload");
  assert.equal(readFileSync(join(payload, "source-a.txt"), "utf8"), "candidate-a\n");
  assert.equal(readFileSync(join(payload, "source-b.txt"), "utf8"), "candidate-b\n");
});

test("multiple blocked Tracked Branches remain visible together without mutation", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);

  const sourceRootA = join(root, "blocked-source-a");
  const sourceRootB = join(root, "blocked-source-b");
  const serverRootA = join(root, "blocked-server-a");
  const serverRootB = join(root, "blocked-server-b");
  for (const path of [sourceRootA, sourceRootB, serverRootA, serverRootB]) mkdirSync(path);
  const repositoryA = createResourceRepository(sourceRootA);
  const repositoryB = createResourceRepository(sourceRootB);
  const locatorA = await serveGitRepository(serverRootA, repositoryA);
  const locatorB = await serveGitRepository(serverRootB, repositoryB);
  assert.equal(runPorcuPi(home, ["add", `${locatorA}@main`], "616e6e0d").status, 0);
  assert.equal(runPorcuPi(home, ["add", `${locatorB}@main`], "616e6e0d").status, 0);

  const managedRoot = dataRoot(home);
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  const selectionsPath = join(managedRoot, "state", "selections.json");
  const activationPath = join(managedRoot, "state", "activation.json");
  const settingsBefore = readFileSync(settingsPath);
  const selectionsBefore = readFileSync(selectionsPath);
  const activationBefore = readFileSync(activationPath);

  for (const [serverRoot, repository] of [[serverRootA, repositoryA], [serverRootB, repositoryB]]) {
    rmSync(join(repository.source, "skills", "fixture-skill", "SKILL.md"));
    git(repository.source, "add", "--all");
    git(repository.source, "commit", "-m", "Remove selected Skill");
    publishRepositoryHead(serverRoot, repository);
  }

  const blocked = runPorcuPi(home, ["manage"], "1b", {
    PTY_WAIT_FOR: "Choose one Source Repository update",
  });
  assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout);
  assert.match(blocked.stdout, new RegExp(`127\\.0\\.0\\.1:${new URL(locatorA).port}/owner/resources`));
  assert.match(blocked.stdout, new RegExp(`127\\.0\\.0\\.1:${new URL(locatorB).port}/owner/resources`));
  assert.equal((blocked.stdout.match(/\[blocked\]/g) ?? []).length >= 2, true);
  assert.match(blocked.stdout, /Source update selection cancelled/);
  assert.deepEqual(readFileSync(settingsPath), settingsBefore);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("mixed-scope source reconciliation rolls back package and aggregate intent on failure or trust denial", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);

  const repository = createResourceRepository(root);
  mkdirSync(join(repository.source, "patches"));
  writeFileSync(join(repository.source, "patches", "mixed.patch"), newFilePatch("mixed-scope.txt", "accepted"));
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Add mixed-scope Patch");
  repository.commit = git(repository.source, "rev-parse", "HEAD");
  const locator = await serveGitRepository(root, repository);
  const packageLog = join(root, "package.log");
  const packageSnapshots = join(root, "package-snapshots");
  const trustLog = join(root, "trust.log");
  const added = runPorcuPi(home, ["add", `${locator}@main`], "616e206e0d", {
    PI_FIXTURE_PACKAGE_LOG: packageLog,
    PI_FIXTURE_PACKAGE_SNAPSHOT_ROOT: packageSnapshots,
  }, project);
  assert.equal(added.status, 0, added.stderr || added.stdout);

  const managedRoot = dataRoot(home);
  const selectionsPath = join(managedRoot, "state", "selections.json");
  const activationPath = join(managedRoot, "state", "activation.json");
  const globalSettingsPath = join(home, ".pi", "agent", "settings.json");
  const projectSettingsPath = join(project, ".pi", "settings.json");
  const selectionsBefore = readFileSync(selectionsPath);
  const activationBefore = readFileSync(activationPath);
  const globalBefore = readFileSync(globalSettingsPath);
  const projectBefore = readFileSync(projectSettingsPath);
  const globalPackageBefore = readFileSync(join(packageSnapshots, "global.txt"));
  const projectPackageBefore = readFileSync(join(packageSnapshots, "project.txt"));
  const acceptedCommit = JSON.parse(selectionsBefore).sources[0].commit;

  writeFileSync(join(repository.source, "extensions", "fixture.ts"), "export default function candidateFixture() {}\n");
  writeFileSync(join(repository.source, "prompts", "fixture.md"), "Candidate global prompt.\n");
  writeFileSync(join(repository.source, "patches", "mixed.patch"), newFilePatch("mixed-scope.txt", "candidate"));
  git(repository.source, "add", ".");
  git(repository.source, "commit", "-m", "Advance mixed scopes");
  const candidateCommit = publishRepositoryHead(root, repository);
  const packageCallsBeforeFailure = readFileSync(packageLog, "utf8").trim().split("\n").length;

  const packageFailure = runPorcuPi(home, ["manage"], "6e6e0d", {
    PI_FIXTURE_PACKAGE_LOG: packageLog,
    PI_FIXTURE_PACKAGE_SNAPSHOT_ROOT: packageSnapshots,
    PI_FIXTURE_PACKAGE_FAIL_AFTER_SNAPSHOT_SCOPE: "project",
    PI_FIXTURE_PACKAGE_FAIL_AFTER_SNAPSHOT_SOURCE: candidateCommit,
    PI_FIXTURE_PACKAGE_FAIL_AFTER_SNAPSHOT_STATE: join(root, "mixed-package-failure"),
    PI_FIXTURE_PACKAGE_FAIL_ATTEMPTS_SOURCE: acceptedCommit,
    PI_FIXTURE_PACKAGE_FAIL_ATTEMPTS: "4",
    PI_FIXTURE_PACKAGE_FAIL_ATTEMPTS_STATE: join(root, "package-compensation-failures"),
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  }, project);
  assert.notEqual(packageFailure.status, 0);
  assert.match(`${packageFailure.stdout}${packageFailure.stderr}`, /fixture Pi package install failed after changing its source snapshot/);
  assert.deepEqual(readFileSync(globalSettingsPath), globalBefore);
  assert.deepEqual(readFileSync(projectSettingsPath), projectBefore);
  assert.deepEqual(readFileSync(join(packageSnapshots, "global.txt")), globalPackageBefore);
  assert.deepEqual(readFileSync(join(packageSnapshots, "project.txt")), projectPackageBefore);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
  const compensationCalls = readFileSync(packageLog, "utf8").trim().split("\n").map(JSON.parse).slice(packageCallsBeforeFailure);
  assert.deepEqual(compensationCalls.map((args) => [args[0], args[1].endsWith(candidateCommit), args.includes("-l")]), [
    ["install", true, false],
    ["install", true, true],
    ["install", false, false],
    ["install", false, true],
    ["install", false, false],
    ["install", false, true],
    ["install", false, false],
    ["install", false, true],
  ]);

  const trustDenial = runPorcuPi(home, ["manage"], "6e6e0d", {
    PI_FIXTURE_PACKAGE_LOG: packageLog,
    PI_FIXTURE_PACKAGE_SNAPSHOT_ROOT: packageSnapshots,
    PI_FIXTURE_PROJECT_TRUST: "deny",
    PI_FIXTURE_PROJECT_TRUST_DENY_SOURCE: candidateCommit,
    PI_FIXTURE_PROJECT_TRUST_LOG: trustLog,
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  }, project);
  assert.notEqual(trustDenial.status, 0);
  assert.match(trustDenial.stdout, /Project is not trusted/);
  assert.match(readFileSync(trustLog, "utf8"), /Pi decided project trust/);
  assert.deepEqual(readFileSync(globalSettingsPath), globalBefore);
  assert.deepEqual(readFileSync(projectSettingsPath), projectBefore);
  assert.deepEqual(readFileSync(join(packageSnapshots, "global.txt")), globalPackageBefore);
  assert.deepEqual(readFileSync(join(packageSnapshots, "project.txt")), projectPackageBefore);
  assert.deepEqual(readFileSync(selectionsPath), selectionsBefore);
  assert.deepEqual(readFileSync(activationPath), activationBefore);

  const accepted = runPorcuPi(home, ["manage"], "6e6e0d", {
    PI_FIXTURE_PACKAGE_LOG: packageLog,
    PI_FIXTURE_PACKAGE_SNAPSHOT_ROOT: packageSnapshots,
    PTY_WAIT_FOR: "1 of 3 — Review Tracked Branch candidate",
  }, project);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const selections = JSON.parse(readFileSync(selectionsPath, "utf8"));
  const source = selections.sources[0];
  assert.equal(source.commit, candidateCommit);
  assert.notEqual(source.commit, acceptedCommit);
  assert.deepEqual(source.artifacts.filter((artifact) => artifact.kind !== "PatchSeries").map((artifact) => ({
    kind: artifact.kind,
    scope: artifact.scope,
    ...(artifact.projectRoot ? { projectRoot: artifact.projectRoot } : {}),
  })), [
    { kind: "Extension", scope: "project", projectRoot: realpathSync(project) },
    { kind: "Prompt", scope: "global" },
    { kind: "Skill", scope: "global" },
    { kind: "Theme", scope: "global" },
  ]);
  assert.match(JSON.parse(readFileSync(globalSettingsPath, "utf8")).packages[0].source, new RegExp(`@${candidateCommit}$`));
  assert.match(JSON.parse(readFileSync(projectSettingsPath, "utf8")).packages[0].source, new RegExp(`@${candidateCommit}$`));
  assert.match(accepted.stdout, /Patch Selection Intent is pending `porcupi apply`/);
  assert.deepEqual(readFileSync(activationPath), activationBefore);
});

test("source mutation through manage and add contends with the shared lifecycle", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const base = createPiBase(root);
  const release = createReleaseFixture(root, base);
  assert.equal(runInstaller(release, home).status, 0);

  const child = spawn(join(home, ".local", "bin", "porcupi"), ["manage"], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      PORCUPI_TEST_HOLD_LOCK_MS: "1500",
    },
  });
  childProcesses.push(child);
  const lifecycleLock = `${dataRoot(home)}.lifecycle-lock`;
  for (let attempt = 0; attempt < 50 && !existsSync(lifecycleLock); attempt += 1) await delay(20);
  assert.equal(existsSync(lifecycleLock), true, "source update lifecycle lock was not acquired");

  const contention = runPorcuPiProcess(home, ["apply"]);
  assert.notEqual(contention.status, 0);
  assert.match(`${contention.stdout}${contention.stderr}`, /lifecycle operation is already in progress: manage/);

  await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", resolvePromise);
  });

  const addChild = spawn(join(home, ".local", "bin", "porcupi"), ["add"], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      NODE_ENV: "test",
      PORCUPI_TEST_HOLD_LOCK_MS: "1500",
    },
  });
  childProcesses.push(addChild);
  for (let attempt = 0; attempt < 50 && !existsSync(lifecycleLock); attempt += 1) await delay(20);
  assert.equal(existsSync(lifecycleLock), true, "add lifecycle lock was not acquired");

  const addContention = runPorcuPiProcess(home, ["apply"]);
  assert.notEqual(addContention.status, 0);
  assert.match(`${addContention.stdout}${addContention.stderr}`, /lifecycle operation is already in progress: add/);

  await new Promise((resolvePromise, rejectPromise) => {
    addChild.once("error", rejectPromise);
    addChild.once("exit", resolvePromise);
  });
});
