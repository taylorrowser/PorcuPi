#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contract = {
  supportedPlatforms: ["darwin", "linux"],
  journeys: {
    "packed-release": {
      stockPi: ["absent", "present"],
      publicProcesses: [
        "pack", "collision-refusal", "fresh-install", "launch", "verify", "rollback", "uninstall",
        "v0.1.0-install", "v0.1.0-upgrade", "launch", "verify", "rollback", "uninstall",
      ],
    },
    "source-parity": {
      stockPi: ["absent"],
      publicProcesses: [
        "exact-source-install", "packed-install", "compare-installed-state", "launch", "verify", "uninstall",
      ],
    },
  },
  reportIdentities: [
    "package", "packedIntegrity", "repository", "piBase", "fixture", "platform", "command", "outcome", "duration",
  ],
};

if (process.argv.includes("--describe")) {
  process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
  process.exit(0);
}

const valueArgument = (name, fallback) => process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const journey = valueArgument("--journey", "packed-release");
const stockPi = valueArgument("--stock-pi", "absent");
const requireTag = process.argv.includes("--require-tag");
if (!Object.hasOwn(contract.journeys, journey)) throw new Error("Usage: release-installation-gate.mjs --journey=packed-release|source-parity [--stock-pi=absent|present] [--require-tag]");
if (!contract.journeys[journey].stockPi.includes(stockPi)) throw new Error(`Usage for ${journey}: --stock-pi=${contract.journeys[journey].stockPi.join("|")}`);
if (!contract.supportedPlatforms.includes(process.platform)) throw new Error(`The Release Installation gate supports macOS and Linux, not ${process.platform}`);

const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const release = JSON.parse(readFileSync(join(repositoryRoot, "release", `v${manifest.version}.json`), "utf8"));
const piBase = JSON.parse(readFileSync(join(repositoryRoot, "upstream", "pi-base.json"), "utf8"));
const runRoot = process.env.PORCUPI_ACCEPTANCE_ROOT
  ? join(process.env.PORCUPI_ACCEPTANCE_ROOT, `${journey}-${process.platform}-${process.arch}-stock-${stockPi}`)
  : mkdtempSync(join(tmpdir(), "porcupi-release-installation-"));
const outputRoot = join(repositoryRoot, "artifacts", "acceptance", "release-installation", `${journey}-${process.platform}-${process.arch}-stock-${stockPi}`);
const logRoot = join(outputRoot, "logs");
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(logRoot, { recursive: true });
mkdirSync(runRoot, { recursive: true });

const steps = [];
let logIndex = 0;
let packageEvidence;
let stockEvidence;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function optionalGit(cwd, ...args) {
  try { return git(cwd, ...args); } catch { return null; }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha512Integrity(value) {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

function dataRoot(home) {
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "porcupi")
    : join(home, ".local", "share", "porcupi");
}

function environment(home, commandBin, stockBin) {
  const result = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: `${commandBin}:${stockPi === "present" ? `${stockBin}:` : ""}${process.env.PATH || ""}`,
    CI: "1",
  };
  delete result.NODE_ENV;
  delete result.PORCUPI_TEST_FAULT;
  delete result.PORCUPI_TEST_FAILURE;
  delete result.PORCUPI_TEST_HOLD_UPGRADE_BOUNDARY;
  return result;
}

function recordObservation(name, started, detail) {
  steps.push({
    name,
    command: { executable: "(acceptance observation)", arguments: [], cwd: repositoryRoot },
    outcome: "PASS",
    durationMilliseconds: Date.now() - started,
    evidence: detail,
  });
}

function external(name, command, args, {
  cwd = repositoryRoot,
  env = process.env,
  inputHex,
  waitFor = "",
  expect = 0,
  timeout = 90 * 60 * 1000,
} = {}) {
  const started = Date.now();
  let executable = command;
  let invocationArguments = args;
  const invocationEnvironment = { ...env };
  if (inputHex !== undefined) {
    executable = "python3";
    invocationArguments = [join(repositoryRoot, "test", "support", "pty-driver.py"), inputHex, command, ...args];
    invocationEnvironment.PTY_WAIT_FOR = waitFor;
  }
  const result = spawnSync(executable, invocationArguments, {
    cwd,
    env: invocationEnvironment,
    encoding: "utf8",
    timeout,
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const logName = `${String(++logIndex).padStart(2, "0")}-${name.replaceAll(/[^a-zA-Z0-9_-]+/g, "-")}.log`;
  writeFileSync(join(logRoot, logName), `$ ${command} ${args.join(" ")}\n\n${output}`);
  const passed = expect === "nonzero" ? Number.isInteger(result.status) && result.status !== 0 : result.status === expect;
  steps.push({
    name,
    command: { executable: command, arguments: args, cwd },
    outcome: passed ? "PASS" : "FAIL",
    durationMilliseconds: Date.now() - started,
    evidence: logName,
  });
  if (!passed) {
    const actual = result.status ?? (result.signal ? `signal ${result.signal}` : "no status");
    throw new Error(`${name}: expected ${expect}, received ${actual}\n${output.slice(-8000)}`);
  }
  return { ...result, output };
}

function packArtifact() {
  const destination = join(runRoot, "packed");
  mkdirSync(destination, { recursive: true });
  const packed = external("pack-exact-npm-artifact", "npm", ["pack", "--json", "--pack-destination", destination]);
  const [metadata] = JSON.parse(packed.stdout);
  const artifact = join(destination, metadata.filename);
  const bytes = readFileSync(artifact);
  assert.equal(metadata.name, release.npmArtifact.name);
  assert.equal(metadata.version, release.npmArtifact.version);
  assert.equal(metadata.integrity, sha512Integrity(bytes));
  assert.equal(metadata.shasum, createHash("sha1").update(bytes).digest("hex"));
  packageEvidence = {
    name: metadata.name,
    version: metadata.version,
    executable: release.npmArtifact.executable,
    filename: metadata.filename,
    size: metadata.size,
    shasum: metadata.shasum,
    integrity: metadata.integrity,
    packageInputsSha256: release.packageInputsSha256,
  };
  return artifact;
}

function installPacked(name, artifact, home, env, { inputHex = "0d0d0d", waitFor = "1 of 3 — Installation" } = {}) {
  return external(name, "npm", ["exec", "--yes", "--offline", "--package", artifact, "--", "porcupi"], {
    cwd: dirname(artifact), env, inputHex, waitFor,
  });
}

function installSource(name, source, home, env, inputHex = "0d0d0d") {
  return external(name, join(source, "install.sh"), [], {
    cwd: source, env, inputHex, waitFor: "1 of 3 — Installation",
  });
}

function runInstalled(name, home, env, args, { inputHex, waitFor = "" } = {}) {
  return external(name, join(home, ".local", "bin", "porcupi"), args, { cwd: home, env, inputHex, waitFor });
}

function makeHome(name) {
  const home = join(runRoot, name, "home");
  const commandBin = join(home, ".local", "bin");
  const stockBin = join(runRoot, name, "stock", "bin");
  mkdirSync(home, { recursive: true });
  if (stockPi === "present") {
    mkdirSync(stockBin, { recursive: true });
    const path = join(stockBin, "pi");
    writeFileSync(path, "#!/bin/sh\necho porcupi-release-gate-stock-pi\n", { mode: 0o755 });
    chmodSync(path, 0o755);
    stockEvidence ??= { state: "present", path, sha256: sha256(readFileSync(path)) };
  } else stockEvidence ??= { state: "absent", path: null, sha256: null };
  return { home, commandBin, stockBin, env: environment(home, commandBin, stockBin) };
}

function assertStockUnchanged(stockBin) {
  if (stockPi !== "present") return;
  const path = join(stockBin, "pi");
  assert.equal(sha256(readFileSync(path)), stockEvidence.sha256);
}

function historicalSource() {
  const source = join(runRoot, "porcupi-v0.1.0");
  external("clone-historical-v0.1.0-source", "git", ["clone", "--shared", "--no-checkout", repositoryRoot, source]);
  external("checkout-historical-v0.1.0-source", "git", ["checkout", "--detach", "v0.1.0^{commit}"], { cwd: source });
  assert.equal(git(source, "rev-parse", "HEAD"), git(repositoryRoot, "rev-parse", "v0.1.0^{commit}"));
  return source;
}

function exactTargetSource() {
  const head = git(repositoryRoot, "rev-parse", "HEAD");
  const tagRevision = optionalGit(repositoryRoot, "rev-parse", `v${manifest.version}^{commit}`);
  if (requireTag) {
    assert.equal(tagRevision, head, `v${manifest.version} must resolve to the tested revision`);
    assert.equal(git(repositoryRoot, "status", "--porcelain"), "", "the exact release tag must have a clean worktree");
  }
  const source = join(runRoot, `porcupi-v${manifest.version}`);
  external("clone-exact-target-source", "git", ["clone", "--shared", "--no-checkout", repositoryRoot, source]);
  external("checkout-exact-target-source", "git", ["checkout", "--detach", requireTag ? tagRevision : head], { cwd: source });
  return source;
}

function packedReleaseJourney(artifact) {
  const collision = makeHome("collision");
  mkdirSync(collision.commandBin, { recursive: true });
  const collisionPath = join(collision.commandBin, "porcupi");
  writeFileSync(collisionPath, "foreign-release-gate-command\n");
  const refused = external("fresh-foreign-collision-refusal", "npm", ["exec", "--yes", "--offline", "--package", artifact, "--", "porcupi"], {
    cwd: dirname(artifact), env: collision.env, inputHex: "0d0d0d", waitFor: "1 of 3 — Installation", expect: "nonzero",
  });
  assert.match(refused.output, /Refusing foreign porcupi command collision/);
  assert.equal(readFileSync(collisionPath, "utf8"), "foreign-release-gate-command\n");

  const piCollision = makeHome("pi-collision");
  mkdirSync(piCollision.commandBin, { recursive: true });
  const piCollisionPath = join(piCollision.commandBin, "pi");
  writeFileSync(piCollisionPath, "foreign-release-gate-pi-command\n");
  const piRefused = external("fresh-optional-pi-collision-refusal", "npm", ["exec", "--yes", "--offline", "--package", artifact, "--", "porcupi"], {
    cwd: dirname(artifact), env: piCollision.env, inputHex: "0d790d0d", waitFor: "1 of 3 — Installation", expect: "nonzero",
  });
  assert.match(piRefused.output, /Refusing foreign pi command collision/);
  assert.equal(readFileSync(piCollisionPath, "utf8"), "foreign-release-gate-pi-command\n");
  assert.equal(existsSync(dataRoot(piCollision.home)), false);

  const fresh = makeHome("fresh");
  installPacked("fresh-install-from-packed-npm-artifact", artifact, fresh.home, fresh.env);
  assertStockUnchanged(fresh.stockBin);
  const launched = runInstalled("fresh-launch", fresh.home, fresh.env, ["--version"]);
  assert.equal(launched.output.trim(), piBase.tag.slice(1));
  runInstalled("fresh-full-verify", fresh.home, fresh.env, ["verify"]);
  const noTarget = runInstalled("fresh-rollback-no-retained-target", fresh.home, fresh.env, ["rollback"], {
    inputHex: "0d", waitFor: "Roll back Managed Pi",
  });
  assert.match(noTarget.output, /No previous Managed Pi Composition is retained/);
  runInstalled("fresh-uninstall", fresh.home, fresh.env, ["uninstall"], {
    inputHex: "0d0d0d", waitFor: "1 of 3 — Owned state",
  });
  assert.equal(existsSync(dataRoot(fresh.home)), false);
  assertStockUnchanged(fresh.stockBin);

  const upgrade = makeHome("upgrade");
  const historical = historicalSource();
  installSource("install-exact-v0.1.0-fixture", historical, upgrade.home, upgrade.env, "0d790d0d");
  const beforeUpgrade = JSON.parse(readFileSync(join(dataRoot(upgrade.home), "state", "activation.json"), "utf8"));
  assertStockUnchanged(upgrade.stockBin);
  const upgraded = installPacked("upgrade-v0.1.0-from-packed-npm-artifact", artifact, upgrade.home, upgrade.env, {
    inputHex: "0d0d0d", waitFor: "1 of 3 — Upgrade",
  });
  assert.match(upgraded.output, new RegExp(`Upgraded PorcuPi from 0\\.1\\.0 to ${manifest.version.replaceAll(".", "\\.")}`));
  runInstalled("upgraded-launch", upgrade.home, upgrade.env, ["--version"]);
  runInstalled("upgraded-full-verify", upgrade.home, upgrade.env, ["verify"]);
  runInstalled("upgraded-rollback", upgrade.home, upgrade.env, ["rollback"], {
    inputHex: "0d", waitFor: "Roll back Managed Pi",
  });
  const afterRollback = JSON.parse(readFileSync(join(dataRoot(upgrade.home), "state", "activation.json"), "utf8"));
  assert.equal(afterRollback.active.compositionId, beforeUpgrade.active.compositionId);
  runInstalled("upgraded-uninstall", upgrade.home, upgrade.env, ["uninstall"], {
    inputHex: "0d0d0d", waitFor: "1 of 3 — Owned state",
  });
  assert.equal(existsSync(dataRoot(upgrade.home)), false);
  assertStockUnchanged(upgrade.stockBin);
}

function sourceParityJourney(artifact) {
  const sourceFixture = makeHome("source-parity-source");
  const packedFixture = makeHome("source-parity-packed");
  const source = exactTargetSource();
  installSource("exact-source-install", source, sourceFixture.home, sourceFixture.env);
  installPacked("packed-install", artifact, packedFixture.home, packedFixture.env);

  const observed = Date.now();
  const sourceActivation = readFileSync(join(dataRoot(sourceFixture.home), "state", "activation.json"));
  const packedActivation = readFileSync(join(dataRoot(packedFixture.home), "state", "activation.json"));
  assert.deepEqual(packedActivation, sourceActivation);
  const active = JSON.parse(sourceActivation).active.compositionId;
  assert.deepEqual(
    readFileSync(join(dataRoot(packedFixture.home), "receipts", `${active}.json`)),
    readFileSync(join(dataRoot(sourceFixture.home), "receipts", `${active}.json`)),
  );
  recordObservation("compare-installed-state", observed, `matching Activation and active Composition receipt ${active}`);

  for (const [label, fixture] of [["source", sourceFixture], ["packed", packedFixture]]) {
    runInstalled(`${label}-parity-launch`, fixture.home, fixture.env, ["--version"]);
    runInstalled(`${label}-parity-verify`, fixture.home, fixture.env, ["verify"]);
    runInstalled(`${label}-parity-uninstall`, fixture.home, fixture.env, ["uninstall"], {
      inputHex: "0d0d0d", waitFor: "1 of 3 — Owned state",
    });
  }
}

function report(status, error) {
  const revision = optionalGit(repositoryRoot, "rev-parse", "HEAD") ?? "unknown";
  const tagRevision = optionalGit(repositoryRoot, "rev-parse", `v${manifest.version}^{commit}`);
  const historicalRevision = optionalGit(repositoryRoot, "rev-parse", "v0.1.0^{commit}");
  const record = {
    schemaVersion: 1,
    status,
    generatedAt: new Date().toISOString(),
    package: packageEvidence ?? {
      name: manifest.name,
      version: manifest.version,
      executable: manifest.bin?.porcupi ? "porcupi" : null,
      packageInputsSha256: release.packageInputsSha256,
    },
    packedIntegrity: packageEvidence ? { shasum: packageEvidence.shasum, integrity: packageEvidence.integrity, size: packageEvidence.size } : null,
    repository: {
      url: release.source.repository,
      revision,
      tag: release.source.tag,
      tagRevision,
      workingTree: optionalGit(repositoryRoot, "status", "--porcelain") ? "dirty" : "clean",
    },
    release: {
      tag: release.tag,
      recipeId: release.recipeId,
      supportedOperatingSystems: release.supportedOperatingSystems,
      acceptanceEvidence: release.acceptanceEvidence,
    },
    piBase: release.piBase,
    fixture: {
      journey,
      stockPi: stockEvidence ?? { state: stockPi, path: null, sha256: null },
      historicalRelease: { tag: "v0.1.0", revision: historicalRevision },
    },
    platform: { os: process.platform, architecture: process.arch, node: process.version },
    steps,
    error: error ? String(error.stack || error) : null,
  };
  writeFileSync(join(outputRoot, "report.json"), `${JSON.stringify(record, null, 2)}\n`);
  const lines = [
    "# PorcuPi Release Installation acceptance report",
    "",
    `- **Result:** ${status}`,
    `- **Journey:** \`${journey}\``,
    `- **Package:** \`${record.package.name}@${record.package.version}\``,
    `- **Packed integrity:** \`${record.packedIntegrity?.integrity ?? "unavailable"}\``,
    `- **Repository:** \`${record.repository.url}\` at \`${record.repository.revision}\` (tag \`${record.repository.tag}\`: \`${record.repository.tagRevision ?? "not present in candidate run"}\`)`,
    `- **Pi Base:** \`${record.piBase.tag}\` at \`${record.piBase.commit}\``,
    `- **Fixture:** Stock Pi \`${stockPi}\`; historical \`v0.1.0\` at \`${historicalRevision}\``,
    `- **Platform:** \`${process.platform}-${process.arch}\` with \`${process.version}\``,
    "",
    "## Public-process results",
    "",
    "| Step | Outcome | Milliseconds | Exact command | Evidence |",
    "| --- | --- | ---: | --- | --- |",
    ...steps.map((step) => `| ${step.name} | ${step.outcome} | ${step.durationMilliseconds} | \`${[step.command.executable, ...step.command.arguments].join(" ").replaceAll("|", "\\|")}\` | ${step.evidence} |`),
  ];
  if (error) lines.push("", "## Failure", "", "```text", String(error.stack || error), "```");
  writeFileSync(join(outputRoot, "report.md"), `${lines.join("\n")}\n`);
}

try {
  assert.equal(manifest.name, release.npmArtifact.name);
  assert.equal(manifest.version, release.npmArtifact.version);
  assert.equal(release.packageInputsSha256, release.npmArtifact.packageInputsSha256);
  assert.deepEqual(release.piBase, { repository: piBase.repository, tag: piBase.tag, commit: piBase.commit });
  const artifact = packArtifact();
  if (journey === "packed-release") packedReleaseJourney(artifact);
  else sourceParityJourney(artifact);
  report("PASS");
} catch (error) {
  report("FAIL", error);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!process.env.PORCUPI_KEEP_ACCEPTANCE_ROOT) {
    try { rmSync(runRoot, { recursive: true, force: true }); } catch {
      // The durable report records the failure; a read-only build tree can be cleaned manually.
    }
  }
}
