#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(readFileSync(join(repositoryRoot, "test", "fixtures", "real-handoff.json"), "utf8"));
const stockArgument = process.argv.find((argument) => argument.startsWith("--stock-pi="))?.split("=")[1] ?? "absent";
if (!new Set(["absent", "present"]).has(stockArgument)) throw new Error("Usage: real-handoff-gate.mjs [--stock-pi=absent|present]");
if (!new Set(["darwin", "linux"]).has(process.platform)) throw new Error(`The real handoff gate supports macOS and Linux, not ${process.platform}`);

const runRoot = process.env.PORCUPI_ACCEPTANCE_ROOT
  ? join(process.env.PORCUPI_ACCEPTANCE_ROOT, `${process.platform}-${process.arch}-${stockArgument}`)
  : mkdtempSync(join(tmpdir(), "porcupi-real-handoff-"));
const home = join(runRoot, "home");
const project = join(runRoot, "project");
const stockBin = join(runRoot, "stock", "bin");
const commandBin = join(home, ".local", "bin");
const outputRoot = join(repositoryRoot, "artifacts", "acceptance", `${process.platform}-${process.arch}-${stockArgument}`);
const logRoot = join(outputRoot, "logs");
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(logRoot, { recursive: true });

const environment = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: join(home, ".local", "share"),
  PATH: `${commandBin}:${stockArgument === "present" ? `${stockBin}:` : ""}${process.env.PATH || ""}`,
  CI: "1",
};
delete environment.NODE_ENV;
delete environment.PORCUPI_TEST_FAULT;
delete environment.PORCUPI_TEST_FAILURE;

const steps = [];
let logIndex = 0;
let heldPi;
let failureServer;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function dataRoot() {
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "porcupi")
    : join(home, ".local", "share", "porcupi");
}

function treeDigest(root) {
  const entries = [];
  function visit(path) {
    const name = relative(root, path).split("\\").join("/");
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      entries.push([name, "directory", stat.mode & 0o777]);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else if (stat.isSymbolicLink()) entries.push([name, "symlink", readlinkSync(path)]);
    else entries.push([name, "file", stat.mode & 0o777, stat.size, sha256(readFileSync(path))]);
  }
  visit(root);
  return sha256(JSON.stringify(entries));
}

function recordStep(name, started, result, detail = "") {
  const durationSeconds = Number(((Date.now() - started) / 1000).toFixed(3));
  steps.push({ name, status: result, durationSeconds, detail });
}

function external(name, command, args, {
  cwd = repositoryRoot,
  env = {},
  inputHex,
  waitFor,
  expect = 0,
  timeout = 90 * 60 * 1000,
} = {}) {
  const started = Date.now();
  const invocationEnvironment = { ...environment, ...env };
  let executable = command;
  let invocationArgs = args;
  if (inputHex !== undefined) {
    executable = "python3";
    invocationArgs = [join(repositoryRoot, "test", "support", "pty-driver.py"), inputHex, command, ...args];
    invocationEnvironment.PTY_WAIT_FOR = waitFor ?? "";
  }
  const result = spawnSync(executable, invocationArgs, {
    cwd,
    env: invocationEnvironment,
    encoding: "utf8",
    timeout,
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const logName = `${String(++logIndex).padStart(2, "0")}-${name.replaceAll(/[^a-zA-Z0-9_-]+/g, "-")}.log`;
  writeFileSync(join(logRoot, logName), `$ ${command} ${args.join(" ")}\n\n${output}`);
  const status = result.status ?? (result.signal ? `signal ${result.signal}` : "no status");
  if (expect === "nonzero" ? result.status === 0 : result.status !== expect) {
    recordStep(name, started, "FAIL", `status ${status}; ${logName}`);
    throw new Error(`${name}: expected ${expect}, received ${status}\n${output.slice(-8000)}`);
  }
  recordStep(name, started, "PASS", `status ${status}; ${logName}`);
  return { ...result, output, logName };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readActivation() {
  return JSON.parse(readFileSync(join(dataRoot(), "state", "activation.json"), "utf8"));
}

function readSelections() {
  return JSON.parse(readFileSync(join(dataRoot(), "state", "selections.json"), "utf8"));
}

function createSharedPiState() {
  const sharedGlobalPackage = join(runRoot, "shared-global-package");
  const sharedProjectPackage = join(runRoot, "shared-project-package");
  for (const [path, name] of [[sharedGlobalPackage, "shared-global-sentinel"], [sharedProjectPackage, "shared-project-sentinel"]]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), `${JSON.stringify({ name, version: "1.0.0", private: true }, null, 2)}\n`);
  }
  const agent = join(home, ".pi", "agent");
  mkdirSync(join(agent, "sessions"), { recursive: true });
  mkdirSync(join(agent, "packages", "shared-sentinel"), { recursive: true });
  writeFileSync(join(agent, "settings.json"), `${JSON.stringify({ packages: [sharedGlobalPackage], theme: "dark" }, null, 2)}\n`);
  writeFileSync(join(agent, "credentials.json"), "{\"sentinel\":\"credential\"}\n");
  writeFileSync(join(agent, "sessions", "session.json"), "session-sentinel\n");
  writeFileSync(join(agent, "trust.json"), "{\"/porcupi/shared-sentinel\":false}\n");
  writeFileSync(join(agent, "packages", "shared-sentinel", "asset"), "package-sentinel\n");
  mkdirSync(join(project, ".pi", "resources"), { recursive: true });
  writeFileSync(join(project, ".pi", "settings.json"), `${JSON.stringify({ packages: [sharedProjectPackage], quietStartup: true }, null, 2)}\n`);
  writeFileSync(join(project, ".pi", "trust.json"), "project-trust-sentinel\n");
  writeFileSync(join(project, ".pi", "resources", "asset"), "project-resource-sentinel\n");
}

async function createFailureSource() {
  const source = join(runRoot, "failure-source");
  mkdirSync(join(source, "patches"), { recursive: true });
  writeFileSync(join(source, "patches", "9999-release-gate-failure.patch"), [
    "diff --git a/porcupi-release-gate-missing.txt b/porcupi-release-gate-missing.txt",
    "--- a/porcupi-release-gate-missing.txt",
    "+++ b/porcupi-release-gate-missing.txt",
    "@@ -1 +1 @@",
    "-missing",
    "+still-missing",
    "",
  ].join("\n"));
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "PorcuPi Release Gate");
  git(source, "config", "user.email", "porcupi-release-gate@example.test");
  git(source, "add", ".");
  git(source, "commit", "-m", "Add intentional preflight failure");
  const commit = git(source, "rev-parse", "HEAD");
  const serverRoot = join(runRoot, "failure-http");
  mkdirSync(join(serverRoot, "porcupi-gate"), { recursive: true });
  const bare = join(serverRoot, "porcupi-gate", "failure.git");
  external("prepare-intentional-failure-source", "git", ["clone", "--bare", source, bare]);
  external("prepare-intentional-failure-http", "git", ["--git-dir", bare, "update-server-info"]);
  const port = Number(execFileSync("python3", ["-c", "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"], { encoding: "utf8" }).trim());
  failureServer = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", serverRoot], { stdio: "ignore" });
  const repository = `http://127.0.0.1:${port}/porcupi-gate/failure.git`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnSync("git", ["ls-remote", repository], { stdio: "ignore" }).status === 0) return { repository, commit };
    await delay(50);
  }
  throw new Error("Intentional failure Git server did not start");
}

async function waitForLease(compositionId) {
  const directory = join(dataRoot(), "leases", compositionId);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (existsSync(directory) && readdirSync(directory).some((name) => name !== "owner.json")) return;
    if (heldPi.exitCode !== null) throw new Error(`Managed Pi lease holder exited early with ${heldPi.exitCode}`);
    await delay(100);
  }
  throw new Error("Timed out waiting for the public Managed Pi process lease");
}

async function stopLeaseHolder() {
  if (!heldPi || heldPi.exitCode !== null) return;
  try {
    process.kill(-heldPi.pid, "SIGTERM");
  } catch {
    heldPi.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolvePromise) => heldPi.once("exit", resolvePromise)),
    delay(10_000).then(() => { throw new Error("Managed Pi lease holder did not exit"); }),
  ]);
}

function startLeaseHolder() {
  const started = Date.now();
  heldPi = spawn(
    "python3",
    [join(repositoryRoot, "test", "support", "pty-driver.py"), "", join(commandBin, "porcupi")],
    { cwd: project, env: environment, detached: true, stdio: "ignore" },
  );
  steps.push({ name: "launch-held-managed-pi", status: "PASS", durationSeconds: 0, detail: `pid ${heldPi.pid}; started ${new Date(started).toISOString()}` });
}

function verifyPinnedReference(reference) {
  assert.equal(git(reference, "rev-parse", "HEAD"), fixture.source.commit);
  assert.equal(git(reference, "status", "--porcelain"), "");
  const actual = fixture.source.patches.map((patch) => ({
    path: patch.path,
    sha256: sha256(readFileSync(join(reference, patch.path))),
  }));
  assert.deepEqual(actual, fixture.source.patches);
  assert.deepEqual(
    readdirSync(join(reference, "patches", "active")).filter((name) => name.endsWith(".patch")).sort()
      .map((name) => `patches/active/${name}`),
    fixture.source.patches.map((patch) => patch.path),
  );
  const manifest = JSON.parse(readFileSync(join(reference, fixture.source.questionTool.packagePath), "utf8"));
  assert.equal(manifest.name, fixture.source.questionTool.packageName);
  assert.equal(manifest.version, fixture.source.questionTool.version);
  assert.deepEqual(manifest.pi?.extensions, ["./extensions/question-tool.ts"]);
  assert.equal(existsSync(join(repositoryRoot, "patches")), false, "PorcuPi must not copy source Patch files");
}

function verifyRealSelections() {
  const selections = readSelections();
  assert.equal(selections.schemaVersion, 2);
  const source = selections.sources.find((entry) => entry.commit === fixture.source.commit);
  assert.ok(source, "exact pi-wait-for-user source was not retained");
  assert.equal(source.locator, "github.com/taylorrowser/pi-wait-for-user");
  const series = source.artifacts.filter((artifact) => artifact.kind === "PatchSeries");
  assert.deepEqual(
    series.map((series) => ({
      id: series.id,
      members: series.members.map(({ commit, path, sha256: digest }) => ({ commit, path, sha256: digest })),
    })),
    fixture.source.patches.map(({ path, sha256: digest }) => ({
      id: path,
      members: [{ commit: fixture.source.commit, path, sha256: digest }],
    })),
  );
  assert.deepEqual(source.artifacts.filter((artifact) => artifact.kind !== "PatchSeries"), []);
}

function verifyQuestionToolPiPackage(reference) {
  const packageRoot = join(reference, "packages", "question-tool");
  const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
  const packageEntry = settings.packages.find((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    return typeof source === "string" && resolve(join(home, ".pi", "agent"), source) === packageRoot;
  });
  assert.ok(packageEntry, "Pi global package configuration is missing the independently versioned Question Tool path");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, fixture.source.questionTool.packageName);
  assert.equal(manifest.version, fixture.source.questionTool.version);
  assert.deepEqual(manifest.pi.extensions, ["./extensions/question-tool.ts"]);
}

function writeReport(status, error) {
  const revision = (() => {
    try { return git(repositoryRoot, "rev-parse", "HEAD"); } catch { return "unknown"; }
  })();
  const workingTree = (() => {
    try { return git(repositoryRoot, "status", "--porcelain") ? "dirty" : "clean"; } catch { return "unknown"; }
  })();
  const report = [
    "# PorcuPi real handoff acceptance report",
    "",
    `- **Result:** ${status}`,
    `- **PorcuPi revision:** \`${revision}\` (${workingTree} working tree)`,
    `- **Pi Base:** \`${fixture.piBase.tag}\` at \`${fixture.piBase.commit}\``,
    `- **Source:** \`${fixture.source.repository}\` at \`${fixture.source.commit}\``,
    `- **Question Tool:** \`${fixture.source.questionTool.packageName}@${fixture.source.questionTool.version}\``,
    `- **Platform:** \`${process.platform}-${process.arch}\``,
    `- **Stock Pi fixture:** \`${stockArgument}\``,
    `- **Node.js:** \`${process.version}\``,
    `- **GitHub Actions run:** ${process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "local run"}`,
    `- **Generated:** ${new Date().toISOString()}`,
    "",
    "## Environment requirements",
    "",
    "- macOS or Linux",
    "- Node.js 22.19 or newer, npm, Git, Python 3, and network access to GitHub/npm",
    "- enough temporary disk space for concurrent exact Pi Base preflight/build checkouts",
    "- no credentials or model-provider API key is required",
    "",
    "## Public-process results",
    "",
    "| Step | Result | Seconds | Evidence |",
    "| --- | --- | ---: | --- |",
    ...steps.map((step) => `| ${step.name} | ${step.status} | ${step.durationSeconds} | ${String(step.detail || "").replaceAll("|", "\\|")} |`),
  ];
  if (error) report.push("", "## Failure", "", "```text", String(error.stack || error), "```");
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, "report.md"), `${report.join("\n")}\n`);
}

async function main() {
  const piBase = JSON.parse(readFileSync(join(repositoryRoot, "upstream", "pi-base.json"), "utf8"));
  assert.equal(piBase.tag, fixture.piBase.tag);
  assert.equal(piBase.commit, fixture.piBase.commit);
  createSharedPiState();
  if (stockArgument === "present") {
    mkdirSync(stockBin, { recursive: true });
    writeFileSync(join(stockBin, "pi"), "#!/bin/sh\necho stock-pi-release-gate\n", { mode: 0o755 });
    chmodSync(join(stockBin, "pi"), 0o755);
  }
  const stockBefore = stockArgument === "present" ? readFileSync(join(stockBin, "pi")) : null;

  const reference = join(runRoot, "pi-wait-for-user-reference");
  external("clone-pinned-source", "git", ["clone", "--no-checkout", fixture.source.repository, reference]);
  external("checkout-pinned-source", "git", ["checkout", "--detach", fixture.source.commit], { cwd: reference });
  const inventoryStarted = Date.now();
  verifyPinnedReference(reference);
  recordStep("verify-pinned-source-inventory", inventoryStarted, "PASS", "20 exact Patch paths/digests; independent Question Tool manifest");

  mkdirSync(commandBin, { recursive: true });
  const foreignLauncher = join(commandBin, "porcupi");
  writeFileSync(foreignLauncher, "foreign-launcher-sentinel\n");
  const collision = external("bootstrap-foreign-launcher-refusal", join(repositoryRoot, "install.sh"), [], {
    inputHex: "0d0d0d",
    waitFor: "1 of 3 — Installation",
    expect: "nonzero",
  });
  assert.match(collision.output, /Refusing foreign porcupi command collision/);
  assert.equal(readFileSync(foreignLauncher, "utf8"), "foreign-launcher-sentinel\n");
  rmSync(foreignLauncher);

  const install = external("bootstrap-clean-install", join(repositoryRoot, "install.sh"), [], {
    inputHex: "0d0d0d",
    waitFor: "1 of 3 — Installation",
  });
  assert.match(install.output, /Installed zero-Patch Managed Pi v0\.81\.1/);
  if (stockArgument === "present") assert.deepEqual(readFileSync(join(stockBin, "pi")), stockBefore);
  const baseActivation = readActivation();
  assert.equal(baseActivation.active.patches.length, 0);

  const exactSource = `${fixture.source.repository}@${fixture.source.commit}`;
  const add = external("select-real-source-artifacts", join(commandBin, "porcupi"), ["add", exactSource], {
    inputHex: "616e6e0d",
    waitFor: "1 of 3 — Select Artifacts",
  });
  assert.match(add.output, new RegExp(`Exact commit: ${fixture.source.commit}`));
  assert.match(add.output, /0 global Pi resource selections and 20 Patch Series selections/);
  assert.match(add.output, /pending `porcupi apply`/);
  verifyRealSelections();
  const questionToolRoot = join(reference, "packages", "question-tool");
  const questionInstall = external("install-question-tool-through-pi", join(commandBin, "porcupi"), ["install", questionToolRoot]);
  assert.match(questionInstall.output, /Installed|installed/i);
  verifyQuestionToolPiPackage(reference);
  const questionList = external("list-question-tool-through-pi", join(commandBin, "porcupi"), ["list"]);
  assert.match(questionList.output, /pi-wait-for-user-reference[\\/]packages[\\/]question-tool/);

  const failure = await createFailureSource();
  external("select-intentional-failure-patch", join(commandBin, "porcupi"), ["add", `${failure.repository}@${failure.commit}`], {
    inputHex: "616e6e0d",
    waitFor: "1 of 3 — Select Artifacts",
  });
  const activationBeforeFailure = readFileSync(join(dataRoot(), "state", "activation.json"));
  const failedApply = external("failed-apply-preserves-activation", join(commandBin, "porcupi"), ["apply"], {
    inputHex: "0d",
    waitFor: "Apply selected Patches",
    expect: "nonzero",
  });
  assert.match(failedApply.output, /patch does not apply|git exited with status/);
  assert.deepEqual(readFileSync(join(dataRoot(), "state", "activation.json")), activationBeforeFailure);
  external("remove-intentional-failure-patch", join(commandBin, "porcupi"), ["add", `${failure.repository}@${failure.commit}`], {
    inputHex: "646e6e0d",
    waitFor: "1 of 3 — Select Artifacts",
  });
  assert.equal(readSelections().sources.some((source) => source.commit === failure.commit), false);

  startLeaseHolder();
  await waitForLease(baseActivation.active.compositionId);
  const applyAll = external("compose-all-real-patches", join(commandBin, "porcupi"), ["apply"], {
    inputHex: "0d",
    waitFor: "Apply selected Patches",
  });
  assert.match(applyAll.output, /Activated Managed Pi Composition/);
  const fullActivation = readActivation();
  assert.equal(fullActivation.active.patches.length, 20);
  assert.equal(fullActivation.previous.compositionId, baseActivation.active.compositionId);

  const launched = external("launch-managed-pi", join(commandBin, "porcupi"), ["--version"]);
  assert.equal(launched.output.trim(), "0.81.1");
  const verified = external("verify-managed-pi", join(commandBin, "porcupi"), ["verify"]);
  assert.match(verified.output, /Complete payload inventory.*checks passed/s);

  const deselectLastPatch = `${"6a".repeat(19)}206e6e0d`;
  external("select-first-19-real-patches", join(commandBin, "porcupi"), ["add", exactSource], {
    inputHex: deselectLastPatch,
    waitFor: "1 of 3 — Select Artifacts",
  });
  assert.equal(readSelections().sources.find((source) => source.commit === fixture.source.commit).artifacts.filter((artifact) => artifact.kind === "PatchSeries").length, 19);
  const applyNineteen = external("compose-19-patches-with-live-old-lease", join(commandBin, "porcupi"), ["apply"], {
    inputHex: "0d",
    waitFor: "Apply selected Patches",
  });
  assert.match(applyNineteen.output, /Deferred cleanup.*process lease/);
  const nineteenActivation = readActivation();
  assert.equal(nineteenActivation.active.patches.length, 19);
  assert.equal(existsSync(join(dataRoot(), "compositions", baseActivation.active.compositionId)), true);
  await stopLeaseHolder();

  const rollback = external("one-step-rollback", join(commandBin, "porcupi"), ["rollback"], {
    inputHex: "0d",
    waitFor: "Roll back Managed Pi",
  });
  assert.match(rollback.output, new RegExp(`Activated retained Managed Pi Composition ${fullActivation.active.compositionId}`));
  assert.equal(readActivation().active.patches.length, 20);
  assert.equal(existsSync(join(dataRoot(), "compositions", baseActivation.active.compositionId)), false);

  const foreignPi = join(commandBin, "pi");
  writeFileSync(foreignPi, "foreign-pi-sentinel\n");
  const piCollision = external("pi-enable-foreign-collision", join(commandBin, "porcupi"), ["pi", "enable"], { expect: "nonzero" });
  assert.match(piCollision.output, /Refusing foreign pi command collision/);
  assert.equal(readFileSync(foreignPi, "utf8"), "foreign-pi-sentinel\n");
  rmSync(foreignPi);
  external("pi-enable", join(commandBin, "porcupi"), ["pi", "enable"]);
  const piLaunch = external("launch-through-pi-alias", foreignPi, ["--version"]);
  assert.equal(piLaunch.output.trim(), "0.81.1");
  external("pi-disable", join(commandBin, "porcupi"), ["pi", "disable"]);
  assert.equal(existsSync(foreignPi), false);

  const sharedPiBeforeUninstall = treeDigest(join(home, ".pi"));
  const sharedProjectBeforeUninstall = treeDigest(join(project, ".pi"));
  const uninstall = external("guided-uninstall", join(commandBin, "porcupi"), ["uninstall"], {
    inputHex: "0d0d0d",
    waitFor: "1 of 3 — Owned state",
  });
  assert.match(uninstall.output, /Uninstalled receipt-proven PorcuPi state/);
  assert.equal(existsSync(dataRoot()), false);
  assert.equal(existsSync(join(commandBin, "porcupi")), false);
  assert.equal(treeDigest(join(home, ".pi")), sharedPiBeforeUninstall);
  assert.equal(treeDigest(join(project, ".pi")), sharedProjectBeforeUninstall);
  if (stockArgument === "present") assert.deepEqual(readFileSync(join(stockBin, "pi")), stockBefore);

  writeReport("PASS");
}

try {
  await main();
} catch (error) {
  try { await stopLeaseHolder(); } catch {
    // Preserve the original release-gate failure.
  }
  writeReport("FAIL", error);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (failureServer && failureServer.exitCode === null) failureServer.kill("SIGTERM");
  if (!process.env.PORCUPI_KEEP_ACCEPTANCE_ROOT) {
    try { rmSync(runRoot, { recursive: true, force: true }); } catch {
      // The durable report records the failure; a read-only Composition can be cleaned manually.
    }
  }
}
