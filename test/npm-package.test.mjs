import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

const manifest = readJson("package.json");
const release = readJson(`release/v${manifest.version}.json`);
const historicalRelease = readJson("release/v0.1.0.json");
const expectedFiles = ["LICENSE", "README.md", "package.json", ...manifest.files].sort();
const temporaryRoots = [];

after(() => {
  for (const path of temporaryRoots) rmSync(path, { recursive: true, force: true });
});

function packageFixture() {
  const temporary = mkdtempSync(join(tmpdir(), "porcupi-package-test-"));
  temporaryRoots.push(temporary);
  const fixture = join(temporary, "release");
  mkdirSync(fixture);
  for (const path of ["LICENSE", "README.md", "package-lock.json", "package.json", "release", "scripts", "src", "upstream"]) {
    cpSync(join(root, path), join(fixture, path), { recursive: true });
  }
  return fixture;
}

function packFixture(fixture) {
  return spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: fixture,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

test("the public porcupi package declares one exact release installer", () => {
  assert.equal(manifest.name, "porcupi");
  assert.equal(manifest.private, undefined);
  assert.notEqual(manifest.version, historicalRelease.porcupiVersion, "v0.1.0 must remain source-only and immutable");
  assert.deepEqual(manifest.bin, { porcupi: "scripts/install.mjs" });
  assert.equal(manifest.version, release.porcupiVersion);
  assert.equal(release.tag, `v${manifest.version}`);
  assert.match(release.packageInputsSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.files.filter((path) => path.startsWith("release/")), [`release/v${manifest.version}.json`]);
  assert.equal(manifest.scripts.prepack, "node scripts/validate-package.mjs");
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    assert.equal(manifest.scripts[lifecycle], undefined, `npm must not own installation through ${lifecycle}`);
  }
});

test("npm pack contains exactly the declared release-fixed installer inventory", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const packed = JSON.parse(result.stdout)[0];
  assert.equal(packed.name, "porcupi");
  assert.equal(packed.version, manifest.version);
  assert.deepEqual(packed.files.map(({ path }) => path).sort(), expectedFiles);
});

test("release packing refuses the historical source-only v0.1.0 identity", () => {
  const fixture = packageFixture();
  const fixtureManifestPath = join(fixture, "package.json");
  const fixtureManifest = JSON.parse(readFileSync(fixtureManifestPath, "utf8"));
  fixtureManifest.version = historicalRelease.porcupiVersion;
  fixtureManifest.files = fixtureManifest.files.map((path) => path.startsWith("release/") ? "release/v0.1.0.json" : path);
  writeFileSync(fixtureManifestPath, `${JSON.stringify(fixtureManifest, null, 2)}\n`);

  const result = packFixture(fixture);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /v0\.1\.0.*immutable.*not.*npm/i);
});

test("release packing rejects missing declared inputs", () => {
  const fixture = packageFixture();
  rmSync(join(fixture, "src", "install.mjs"));

  const result = packFixture(fixture);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /missing declared package input: src\/install\.mjs/i);
});

test("the npm delivery ADR keeps GitHub canonical and npm lifecycle ownership narrow", () => {
  const adr = readFileSync(join(root, "docs", "adr", "0010-npm-release-installation.md"), "utf8");
  assert.match(adr, /official.*npm.*artifact/is);
  assert.match(adr, /GitHub remains the canonical source and release record/i);
  assert.match(adr, /npm.*does not own.*runtime.*state.*uninstall/is);
  assert.match(adr, /exact-tag source entrance/i);
  assert.match(adr, /v0\.1\.0.*not.*npm/is);
});

test("release packing rejects npm, source, or acceptance evidence split from the release identity", () => {
  const cases = [
    [(releaseRecord) => { releaseRecord.npmArtifact.name = "not-porcupi"; }, /npm artifact identity does not match/i],
    [(releaseRecord) => { releaseRecord.source.tag = "v9.9.9"; }, /source identity does not match/i],
    [(releaseRecord) => { releaseRecord.acceptanceEvidence.sourceRevisionField = "unbound"; }, /acceptance evidence contract does not match/i],
  ];
  for (const [mutate, diagnosis] of cases) {
    const fixture = packageFixture();
    const releasePath = join(fixture, `release/v${manifest.version}.json`);
    const fixtureRelease = JSON.parse(readFileSync(releasePath, "utf8"));
    mutate(fixtureRelease);
    writeFileSync(releasePath, `${JSON.stringify(fixtureRelease, null, 2)}\n`);

    const result = packFixture(fixture);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, diagnosis);
  }
});

test("release packing rejects implementation bytes from a different release identity", () => {
  const fixture = packageFixture();
  writeFileSync(join(fixture, "src", "runtime.mjs"), "\n// changed after the release identity was fixed\n", { flag: "a" });

  const result = packFixture(fixture);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /release record does not match the exact package input bytes/i);
});

test("release packing rejects package manifest bytes from a different release identity", () => {
  const fixture = packageFixture();
  writeFileSync(join(fixture, "package.json"), "\n", { flag: "a" });

  const result = packFixture(fixture);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /release record does not match the exact package input bytes/i);
});

test("release packing rejects undeclared content in release-fixed input roots", () => {
  const fixture = packageFixture();
  writeFileSync(join(fixture, "src", "undeclared.mjs"), "export {};\n");

  const result = packFixture(fixture);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /undeclared package input: src\/undeclared\.mjs/i);
});
