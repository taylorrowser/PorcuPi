import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(readFileSync(join(root, "test", "fixtures", "real-handoff.json"), "utf8"));

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

test("release gate remains a separate external-process matrix on both supported platforms", () => {
  const script = readFileSync(join(root, "scripts", "real-handoff-gate.mjs"), "utf8");
  assert.doesNotMatch(script, /from ["']\.\.\/src\//);
  assert.match(script, /install\.sh/);
  assert.match(script, /join\(commandBin, "porcupi"\)/);
  assert.match(script, /join\(commandBin, "pi"\)/);
  assert.match(script, /inputHex/);
  const workflow = readFileSync(join(root, ".github", "workflows", "real-handoff-release-gate.yml"), "utf8");
  assert.match(workflow, /os: \[macos-14, ubuntu-24\.04\]/);
  assert.match(workflow, /stock_pi: \[absent, present\]/);
  assert.match(workflow, /npm run test:real-handoff/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts["test:real-handoff"], "node scripts/real-handoff-gate.mjs");
});

test("real handoff runner rejects unsupported Stock Pi scenarios before running the gate", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "real-handoff-gate.mjs"), "--stock-pi=unknown"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /--stock-pi=absent\|present/);
});
