import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
import { runGuidedTerminal, windowAround } from "./guided-terminal.mjs";
import { cleanupRetainedCompositions, withLifecycleLock } from "./lifecycle.mjs";
import {
  expandedPatchSnapshot,
  patchPendingMessage,
  patchSelectionSnapshot,
  readSelections,
  stagePatchSelection,
} from "./resource-intent.mjs";
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
} from "./runtime.mjs";

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
        output.write(`Deterministic flattening: ${patches.length} Patch File${patches.length === 1 ? "" : "s"}\n`);
        if (patches.length === 0) output.write("  (zero Patches — compose the exact Pi Base alone)\n");
        const visible = windowAround(output, cursor, patches.length, 13);
        for (let index = visible.start; index < visible.end; index += 1) {
          const patch = patches[index];
          output.write(`${index === cursor ? "›" : " "} ${patch.locator}@${patch.commit} · ${patch.seriesId} · ${patch.path} · sha256:${patch.sha256}\n`);
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

function receiptMatchesApply(receipt, lock, patches) {
  return receipt.porcupiVersion === porcupiVersion
    && canonicalJson(receipt.piBase) === canonicalJson(lock)
    && canonicalJson(receipt.recipe) === canonicalJson(compositionRecipe)
    && receipt.platform === platformIdentity()
    && canonicalJson(expandedPatchSnapshot(receipt.patches)) === canonicalJson(patches);
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

  if (canonicalJson(expandedPatchSnapshot(active.activation.active.patches)) === canonicalJson(patches)) {
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
    const stagedPatches = stagePatchSelection({ stageRoot, sources: selections.sources, piBase: lock });
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
