import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compositionRecipe } from "../src/composition.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const readText = (path) => readFileSync(join(root, path), "utf8");

const release = readJson("release/v0.1.0.json");
const piBase = readJson("upstream/pi-base.json");
const handoff = readJson("test/fixtures/real-handoff.json");

test("v0.1.0 release record binds the shipped version, fixed recipe, and accepted real-source gate", () => {
  assert.deepEqual(Object.keys(release).sort(), [
    "acceptedGate", "piBase", "porcupiVersion", "recipeId", "schemaVersion", "sourceHandoff", "supportedOperatingSystems", "tag",
  ]);
  assert.equal(release.schemaVersion, 1);
  assert.equal(release.porcupiVersion, "0.1.0");
  assert.equal(release.tag, "v0.1.0");
  assert.deepEqual(release.supportedOperatingSystems, ["macOS", "Linux"]);
  assert.equal(release.recipeId, compositionRecipe.id);
  assert.deepEqual(release.piBase, {
    repository: piBase.repository,
    tag: piBase.tag,
    commit: piBase.commit,
  });
  assert.deepEqual(release.sourceHandoff, {
    repository: handoff.source.repository,
    commit: handoff.source.commit,
  });
  assert.deepEqual(release.acceptedGate, {
    porcupiRevision: "e2bc7c2a0b740376a96ff69f3c8241d89336d305",
    runUrl: "https://github.com/taylorrowser/PorcuPi/actions/runs/30540306698",
    macosStockPiAbsent: "pass",
    macosStockPiPresent: "pass",
    linuxStockPiAbsent: "pass",
    linuxStockPiPresent: "pass",
  });
});

test("first-release documentation covers the supported bootstrap, operation, trust, and migration boundaries", () => {
  const install = readText("docs/install.md");
  const operations = readText("docs/operations.md");
  const migration = readText("docs/migration-from-pi-wait-for-user.md");
  const notes = readText("docs/releases/v0.1.0.md");

  assert.match(install, /git clone --branch v0\.1\.0/);
  assert.match(install, /Stock Pi/);
  assert.match(install, /foreign.*collision/is);
  assert.match(install, /publisher authentication/);
  assert.match(install, /VM or container/);
  for (const command of ["add", "manage", "apply", "verify", "rollback", "pi enable", "pi disable", "uninstall"]) {
    assert.match(operations, new RegExp(`porcupi ${command.replace(" ", "\\s+")}`));
  }
  assert.match(operations, /arguments.*forwarded/is);
  assert.match(operations, /pending Patch intent/i);
  assert.match(migration, /pi managed uninstall/);
  assert.match(migration, /old manager.*before.*PorcuPi/is);
  assert.match(migration, /does not adopt.*legacy/is);
  assert.match(notes, new RegExp(release.acceptedGate.runUrl.replaceAll("/", "\\/")));
  assert.match(notes, /macOS.*Linux/is);
  assert.match(notes, /no release channel/i);
});

test("legacy migration preserves human-owned root entries before receipt-safe uninstall", () => {
  const migration = readText("docs/migration-from-pi-wait-for-user.md");

  assert.match(migration, /Foreign Managed Installation root path/);
  assert.match(migration, /pi managed disable/);
  assert.match(migration, /outside.*managed root/is);
  assert.match(migration, /production-signing-private/);
  assert.match(migration, /pi-wait-for-user managed uninstall/);
  assert.match(migration, /do not delete/i);
});
