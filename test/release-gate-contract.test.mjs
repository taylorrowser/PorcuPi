import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(readFileSync(join(root, "test", "fixtures", "real-handoff.json"), "utf8"));

function releaseGateRepository(t, tagState) {
  const repository = mkdtempSync(join(tmpdir(), "porcupi-release-gate-tag-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  for (const path of ["scripts", "release", "upstream"]) mkdirSync(join(repository, path), { recursive: true });
  writeFileSync(
    join(repository, "scripts", "release-installation-gate.mjs"),
    readFileSync(join(root, "scripts", "release-installation-gate.mjs")),
  );
  writeFileSync(join(repository, "scripts", "install.mjs"), "#!/usr/bin/env node\n");
  writeFileSync(join(repository, ".gitignore"), "artifacts/\n");
  writeFileSync(join(repository, "package.json"), `${JSON.stringify({
    name: "porcupi",
    version: "0.2.0",
    type: "module",
    bin: { porcupi: "scripts/install.mjs" },
  }, null, 2)}\n`);
  const piBase = { repository: "https://example.test/pi.git", tag: "v1.0.0", commit: "a".repeat(40) };
  writeFileSync(join(repository, "upstream", "pi-base.json"), `${JSON.stringify(piBase, null, 2)}\n`);
  writeFileSync(join(repository, "release", "v0.2.0.json"), `${JSON.stringify({
    porcupiVersion: "0.2.0",
    tag: "v0.2.0",
    source: { repository: "https://example.test/PorcuPi.git", tag: "v0.2.0" },
    npmArtifact: { name: "porcupi", version: "0.2.0", executable: "porcupi", packageInputsSha256: "fixture" },
    supportedOperatingSystems: ["macOS", "Linux"],
    piBase,
    recipeId: "fixture-recipe",
    packageInputsSha256: "fixture",
    acceptanceEvidence: {},
  }, null, 2)}\n`);
  const commit = (message) => execFileSync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", message,
  ], { cwd: repository });
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  execFileSync("git", ["add", "."], { cwd: repository });
  commit("fixture");
  if (tagState === "mismatched") {
    execFileSync("git", ["tag", "v0.2.0"], { cwd: repository });
    writeFileSync(join(repository, "candidate-marker"), "new candidate\n");
    execFileSync("git", ["add", "candidate-marker"], { cwd: repository });
    commit("candidate");
  }
  return repository;
}

test("real handoff fixture pins only the exact source identities and canonical 20-Patch inventory", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.piBase, {
    tag: "v0.81.1",
    commit: "20be4b18d4c57487f8993d2762bace129f0cf7c6",
  });
  assert.equal(fixture.source.repository, "https://github.com/taylorrowser/pi-wait-for-user.git");
  assert.equal(fixture.source.commit, "1a987bca79a4f9475dd2037c18b2d6d7b7f68f25");
  assert.deepEqual(fixture.source.questionTool, {
    path: "packages/question-tool/extensions/question-tool.ts",
    packagePath: "packages/question-tool/package.json",
    packageName: "@taylorrowser/pi-question-tool",
    version: "0.1.5",
  });
  assert.equal(fixture.source.patches.length, 20);
  assert.deepEqual(
    fixture.source.patches.map((patch) => patch.path),
    [...fixture.source.patches.map((patch) => patch.path)].sort(),
  );
  for (const [index, patch] of fixture.source.patches.entries()) {
    assert.match(patch.path, new RegExp(`^patches/active/${String(index + 1).padStart(4, "0")}-.*\\.patch$`));
    assert.match(patch.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(existsSync(join(root, "patches")), false, "PorcuPi must not contain copied source Patches");
});

test("release gates expose the public packed-artifact and exact-source parity journeys", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "release-installation-gate.mjs"), "--describe"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const contract = JSON.parse(result.stdout);
  assert.deepEqual(contract.supportedPlatforms, ["darwin", "linux"]);
  assert.deepEqual(contract.journeys["packed-release"].stockPi, ["absent", "present"]);
  assert.deepEqual(contract.journeys["packed-release"].publicProcesses, [
    "pack", "collision-refusal", "fresh-install", "launch", "verify", "rollback", "uninstall",
    "v0.1.0-install", "v0.1.0-upgrade", "launch", "verify", "rollback", "uninstall",
  ]);
  assert.deepEqual(contract.journeys["source-parity"].publicProcesses, [
    "exact-source-install", "packed-install", "compare-installed-state", "launch", "verify", "uninstall",
  ]);
  assert.deepEqual(contract.reportIdentities, [
    "package", "packedIntegrity", "repository", "piBase", "fixture", "platform", "command", "outcome", "duration",
  ]);

  const workflow = readFileSync(join(root, ".github", "workflows", "release-installation-gate.yml"), "utf8");
  assert.match(workflow, /os: \[macos-14, ubuntu-24\.04\]/);
  assert.match(workflow, /stock_pi: \[absent, present\]/);
  assert.match(workflow, /--journey=packed-release/);
  assert.match(workflow, /--journey=source-parity/);
  assert.match(workflow, /actions\/upload-artifact@v4/);

  const gate = readFileSync(join(root, "scripts", "release-installation-gate.mjs"), "utf8");
  assert.doesNotMatch(gate, /"--offline"/, "the networked gate must not force nested installs offline");
  assert.match(gate, /if \(name === "pi"\) continue;/, "the absent fixture must remove ambient pi commands from PATH");
  assert.match(gate, /assert\.equal\(resolvePathCommand\("pi", result\.PATH\), expectedPi\)/);

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts["test:release-installation"], "node scripts/release-installation-gate.mjs");
});

test("release gate runners reject unsupported journey and Stock Pi inputs before running", () => {
  for (const argument of ["--journey=unknown", "--stock-pi=unknown"]) {
    const result = spawnSync(process.execPath, [join(root, "scripts", "release-installation-gate.mjs"), argument], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /--journey=packed-release\|source-parity|--stock-pi=absent\|present/);
  }
});

test("packed release tag enforcement rejects a missing or mismatched exact tag", (t) => {
  for (const tagState of ["missing", "mismatched"]) {
    const repository = releaseGateRepository(t, tagState);
    const result = spawnSync(process.execPath, [
      join(repository, "scripts", "release-installation-gate.mjs"),
      "--journey=packed-release",
      "--require-tag",
    ], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, PORCUPI_ACCEPTANCE_ROOT: join(repository, "acceptance-tmp") },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /v0\.2\.0 must resolve to the tested revision/);
  }
});

test("Release Installation documentation leads with one exact npm version and preserves historical boundaries", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const install = readFileSync(join(root, "docs", "release-installation.md"), "utf8");
  const checklist = readFileSync(join(root, "docs", "releases", "release-checklist.md"), "utf8");
  const historicalInstall = readFileSync(join(root, "docs", "install.md"), "utf8");
  const release = JSON.parse(readFileSync(join(root, "release", "v0.2.0.json"), "utf8"));

  for (const document of [readme, install]) {
    assert.match(document, /npx --yes porcupi@0\.2\.0/);
    assert.match(document, /exact version/i);
    assert.match(document, /networked/i);
    assert.match(document, /interactive/i);
    assert.match(document, /macOS.*Linux/is);
    assert.match(document, /Git.*npm.*Node\.js/is);
    assert.match(document, /pi-wait-for-user/);
    assert.match(document, /git clone --branch v0\.2\.0/);
    assert.match(document, /audit.*fallback|fallback.*audit/is);
  }
  assert.match(historicalInstall, /^# Install PorcuPi v0\.1\.0/m);
  assert.match(checklist, /claim.*`porcupi`.*npm/i);
  assert.match(checklist, /do not publish.*test|tests.*do not publish/is);
  assert.match(checklist, /packed integrity/i);
  assert.deepEqual(release.npmArtifact, {
    name: "porcupi",
    version: "0.2.0",
    executable: "porcupi",
    packageInputsSha256: release.packageInputsSha256,
  });
  assert.equal(release.source.repository, "https://github.com/taylorrowser/PorcuPi.git");
  assert.equal(release.source.tag, "v0.2.0");
  assert.equal(release.acceptanceEvidence.workflow, ".github/workflows/release-installation-gate.yml");
  assert.equal(release.acceptanceEvidence.reportSchemaVersion, 1);
});
