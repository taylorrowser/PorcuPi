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
  assert.match(guide, /"resources"/);
  assert.match(guide, /source-wide compatibility default/i);
  assert.match(guide, /per-Artifact.*override/i);
  assert.match(guide, /omitting.*compatibility.*does not restrict/i);
  assert.match(guide, /cannot declare commands, hooks, dependencies, recipes, force options, custom verifiers, or activation policy/i);
});

test("the source guide defines Tracked Branch publication and exact-snapshot semantics", () => {
  const guide = readText("docs/source-guide.md");

  assert.match(guide, /^This guide explains .* PorcuPi v0\.2\.0/m);
  assert.match(guide, /\[Release Installation guide\]\(release-installation\.md\)/);
  assert.match(guide, /^### Publish a Tracked Branch$/m);
  assert.match(guide, /named branch.*Tracked Branch/i);
  assert.match(guide, /omitted ref.*default branch.*Tracked Branch/i);
  assert.match(guide, /Selection Intent.*exact accepted commit/i);
  assert.match(guide, /tags and full commits remain pinned/i);
  assert.match(guide, /merging selected-content changes.*update candidate/i);
  assert.match(guide, /Selected content comprises selected resource bytes.*Patch Series membership, order, bytes, and compatibility/i);
  assert.match(guide, /Documentation, tests, unrelated files, and new independent unselected Artifacts do not/i);
  assert.match(guide, /Adoption requires review of one resolved exact candidate/i);
  assert.match(guide, /branch movement alone never mutates/i);
  assert.match(guide, /Post-release Compatibility Update.*exact compatibility metadata.*fast-forward/is);
});

test("the Tracked Branch ADR explicitly amends the retained Selection Intent inventory", () => {
  const delegatedPackagesDecision = readText("docs/adr/0003-delegate-filtered-git-packages-to-pi.md");
  const trackedBranchesDecision = readText("docs/adr/0015-retain-tracked-branches-with-exact-snapshots.md");

  assert.match(delegatedPackagesDecision, /amended by ADR 0015.*optional.*Tracked Branch identity/is);
  assert.match(delegatedPackagesDecision, /exact commit, optional canonical Tracked Branch identity, package source/);
  assert.match(trackedBranchesDecision, /amends ADR 0003.*optional canonical Tracked Branch identity/is);
});

test("the primary user documentation links the source guide", () => {
  const readme = readText("README.md");
  const operations = readText("docs/operations.md");

  assert.match(readme, /\[Source Repository guide\]\(docs\/source-guide\.md\)/);
  assert.match(operations, /\[Source Repository guide\]\(source-guide\.md\)/);
});
