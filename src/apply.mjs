import { randomUUID } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import {
  buildComposition,
  compositionRecipe,
  loadBaseLock,
  porcupiVersion,
  publishComposition,
  removePreparedTree,
  verifyHostNode,
  verifyPublishedComposition,
} from "./composition.mjs";
import { runGuidedTerminal, truncateForTerminal, windowAround } from "./guided-terminal.mjs";
import { cleanupRetainedCompositions, withLifecycleLock } from "./lifecycle.mjs";
import { patchPendingMessage, patchSelectionSnapshot, readSelections } from "./resource-intent.mjs";
import {
  atomicWrite,
  canonicalJson,
  defaultDataRoot,
  ensureCompositionLeaseDirectory,
  fail,
  managedLayout,
  platformIdentity,
  readActiveComposition,
  readJson,
  sha256File,
} from "./runtime.mjs";
import { discoverPiArtifacts, resolveSourceRepository } from "./source-repository.mjs";

const applyOwner = Object.freeze({ schemaVersion: 1, type: "porcupi-apply-stage" });

function checkpoint(name) {
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAULT === name) process.kill(process.pid, "SIGKILL");
}

function failAtCheckpoint(name) {
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAILURE === name) fail(`Injected failure at ${name}`);
}

function recoverApplyStages(paths) {
  for (const name of readdirSync(paths.temporary)) {
    if (!name.startsWith("apply-")) continue;
    const stage = join(paths.temporary, name);
    let owner;
    try {
      const stat = lstatSync(stage);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Foreign apply stage requires manual inspection: ${stage}`);
      owner = readJson(join(stage, "owner.json"), "apply stage ownership");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Foreign apply stage")) throw error;
      fail(`Foreign apply stage requires manual inspection: ${stage}`);
    }
    if (canonicalJson(owner) !== canonicalJson(applyOwner)) fail(`Foreign apply stage requires manual inspection: ${stage}`);
    removePreparedTree(stage);
  }
}

function confirmApply(patches, input, output) {
  let cursor = 0;
  return runGuidedTerminal({
    command: "porcupi apply",
    input,
    output,
    createController: ({ finish }) => {
      const render = () => {
        output.write("\x1b[2J\x1b[H");
        output.write("Apply selected Patches\n\n");
        output.write(`Deterministic series: ${patches.length} Patch${patches.length === 1 ? "" : "es"}\n`);
        if (patches.length === 0) output.write("  (zero Patches — compose the exact Pi Base alone)\n");
        const visible = windowAround(output, cursor, patches.length, 13);
        for (let index = visible.start; index < visible.end; index += 1) {
          const patch = patches[index];
          output.write(`${truncateForTerminal(output, `${index === cursor ? "›" : " "} ${patch.locator} · ${patch.path} · sha256:${patch.sha256.slice(0, 12)}`)}\n`);
        }
        if (patches.length > 0) output.write(`  ${visible.start} above · ${patches.length - visible.end} below\n`);
        output.write("\nThe fixed build commands and Patch-modified source run with your user authority.\n");
        output.write("Commits and digests bind selected bytes; they do not prove publisher identity or provide a sandbox.\n\n");
        output.write("[↑/↓ j/k] inspect  [Space/Enter] Apply  [Esc] cancel\n");
      };
      const handleKeypress = (_character, key) => {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(false);
        if (key.name === "up" || key.name === "k") cursor = Math.max(0, cursor - 1);
        else if (key.name === "down" || key.name === "j") cursor = Math.min(Math.max(0, patches.length - 1), cursor + 1);
        else if (key.name === "space" || key.name === "return") return finish(true);
        render();
      };
      return { render, handleKeypress };
    },
  });
}

function materializeSelectedPatches(stageRoot, sources, patches) {
  const stagedRoot = join(stageRoot, "patches");
  mkdirSync(stagedRoot, { mode: 0o700 });
  const stagedByIdentity = new Map();
  for (const source of sources.filter((candidate) => patches.some((patch) => patch.locator === candidate.locator))) {
    const sourcePatches = patches.filter((patch) => patch.locator === source.locator);
    if (sourcePatches.some((patch) => patch.commit !== source.commit)) {
      fail(`Selected Patch Source Repository identity mismatch: ${source.locator}`);
    }
    const resolved = resolveSourceRepository(source.packageSource, { temporaryParent: stageRoot });
    try {
      if (resolved.locator !== source.locator || resolved.commit !== source.commit) {
        fail(`Selected Patch Source Repository changed: ${source.locator}@${source.commit}`);
      }
      const discovered = new Map(discoverPiArtifacts(resolved.checkout).artifacts
        .filter((artifact) => artifact.kind === "Patch")
        .map((artifact) => [artifact.path, artifact]));
      const realCheckout = realpathSync(resolved.checkout);
      for (const patch of sourcePatches) {
        const selected = discovered.get(patch.path);
        if (!selected) fail(`Selected Patch is no longer a regular file at its exact source commit: ${patch.locator} · ${patch.path}`);
        if (selected.sha256 !== patch.sha256) fail(`Selected Patch digest mismatch: ${patch.locator} · ${patch.path}`);
        const sourcePath = join(resolved.checkout, patch.path);
        const realPatch = realpathSync(sourcePath);
        if (!realPatch.startsWith(`${realCheckout}${sep}`)) fail(`Selected Patch escapes its exact Source Repository: ${patch.path}`);
        const index = patches.indexOf(patch);
        const stagedPath = join(stagedRoot, `${String(index).padStart(6, "0")}.patch`);
        cpSync(sourcePath, stagedPath, { errorOnExist: true });
        if (sha256File(stagedPath) !== patch.sha256) fail(`Staged Patch digest mismatch: ${patch.locator} · ${patch.path}`);
        stagedByIdentity.set(`${patch.locator}\0${patch.path}`, { ...patch, stagedPath });
      }
    } finally {
      resolved.dispose();
    }
  }
  return patches.map((patch) => stagedByIdentity.get(`${patch.locator}\0${patch.path}`)
    ?? fail(`Selected Patch Source Repository is missing: ${patch.locator}`));
}

function receiptMatchesApply(receipt, lock, patches) {
  return receipt.porcupiVersion === porcupiVersion
    && canonicalJson(receipt.piBase) === canonicalJson(lock)
    && canonicalJson(receipt.recipe) === canonicalJson(compositionRecipe)
    && receipt.platform === platformIdentity()
    && canonicalJson(receipt.patches) === canonicalJson(patches);
}

async function applyPatchesLocked({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  dataRoot = defaultDataRoot(environment),
} = {}) {
  verifyHostNode();
  const paths = managedLayout(dataRoot);
  const active = readActiveComposition(dataRoot);
  cleanupRetainedCompositions(paths, active.activation, output);
  recoverApplyStages(paths);
  const lock = loadBaseLock();
  if (canonicalJson(active.receipt.piBase) !== canonicalJson(lock)) fail("Active Managed Pi uses a different Pi Base than this PorcuPi release");
  const selections = readSelections(dataRoot);
  const patches = patchSelectionSnapshot(selections.sources);
  const confirmed = await confirmApply(patches, input, output);
  if (!confirmed) {
    output.write("\nApply cancelled; Selection Intent and Managed Pi activation are unchanged.\n");
    return { applied: false, cancelled: true };
  }

  if (canonicalJson(active.activation.active.patches) === canonicalJson(patches)) {
    const receipt = verifyPublishedComposition(paths, active.activation.active.compositionId);
    if (!receiptMatchesApply(receipt, lock, patches)) fail("Active Managed Pi Composition does not match the current fixed apply identity");
    output.write(`\nVerified active Managed Pi Composition ${receipt.compositionId}; no rebuild was needed.\n`);
    output.write(patchPendingMessage(false));
    return { applied: false, noOp: true, compositionId: receipt.compositionId };
  }

  const stageRoot = join(paths.temporary, `apply-${randomUUID()}`);
  mkdirSync(stageRoot, { mode: 0o700 });
  writeFileSync(join(stageRoot, "owner.json"), `${JSON.stringify(applyOwner)}\n`, { mode: 0o600 });
  try {
    const stagedPatches = materializeSelectedPatches(stageRoot, selections.sources, patches);
    const candidateRoot = join(stageRoot, "composition");
    mkdirSync(candidateRoot, { mode: 0o700 });
    const receipt = buildComposition({ candidateRoot, stageRoot, patches: stagedPatches, lock });
    publishComposition(paths, candidateRoot, receipt);
    ensureCompositionLeaseDirectory(paths, receipt.compositionId);
    checkpoint("apply-composition-published");
    failAtCheckpoint("apply-activation-write");
    const activation = {
      schemaVersion: 1,
      active: { compositionId: receipt.compositionId, patches: receipt.patches },
      previous: active.activation.active,
    };
    atomicWrite(paths.activation, activation);
    checkpoint("apply-activation-written");
    removePreparedTree(stageRoot);
    cleanupRetainedCompositions(paths, activation, output);
    output.write(`\nActivated Managed Pi Composition ${receipt.compositionId}.\n`);
    output.write(`Retained previous Managed Pi Composition ${active.activation.active.compositionId}.\n`);
    output.write(patchPendingMessage(false));
    return { applied: true, compositionId: receipt.compositionId };
  } catch (error) {
    removePreparedTree(stageRoot);
    throw error;
  }
}

export async function applyPatches(options = {}) {
  const environment = options.environment ?? process.env;
  const dataRoot = options.dataRoot ?? defaultDataRoot(environment);
  return withLifecycleLock(dataRoot, "apply", () => applyPatchesLocked({ ...options, environment, dataRoot }));
}
