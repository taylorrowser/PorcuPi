import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readText = (path) => readFileSync(join(root, path), "utf8");

test("the source guide covers consuming and authoring every PorcuPi artifact kind", () => {
  const guide = readText("docs/source-guide.md");

  for (const heading of [
    "Use a Source Repository",
    "Prepare a Source Repository",
    "Extensions",
    "Skills",
    "Prompt templates",
    "Themes",
    "Patch Series and Patch Files",
    "Validate the source",
    "Publish and update",
    "Trust and project scope",
  ]) {
    assert.match(guide, new RegExp(`^#{2,3} ${heading}$`, "m"));
  }

  assert.match(guide, /package\.json.*"pi"/s);
  assert.match(guide, /patches\/.*\.patch/s);
  assert.match(guide, /git apply --check --whitespace=error-all/);
  assert.match(guide, /"schemaVersion": 1/);
  assert.match(guide, /supportedPiBaseVersions/);
  assert.match(guide, /supportedPiBaseCommits/);
  assert.match(guide, /porcupi add/);
  assert.match(guide, /porcupi manage/);
  assert.match(guide, /porcupi apply/);
  assert.match(guide, /exact commit/i);
  assert.match(guide, /pending Patch intent/i);
  assert.match(guide, /implicit one-file Patch Series/i);
  assert.match(guide, /stable source identity is the Patch File's full structural path/i);
  assert.match(guide, /"patchSeries"/);
  assert.match(guide, /"id": "example-capability"/);
  assert.match(guide, /"members"/);
  assert.match(guide, /preserves each series' declared member order/i);
  assert.match(guide, /changing its stable `id` creates a different Artifact/i);
});

test("the primary user documentation links the source guide", () => {
  const readme = readText("README.md");
  const operations = readText("docs/operations.md");

  assert.match(readme, /\[Source Repository guide\]\(docs\/source-guide\.md\)/);
  assert.match(operations, /\[Source Repository guide\]\(source-guide\.md\)/);
});
