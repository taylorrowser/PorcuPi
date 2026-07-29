import { atomicWrite, canonicalJson, defaultDataRoot, fail, readActiveComposition } from "./runtime.mjs";
import { verifyPublishedComposition } from "./composition.mjs";
import { runGuidedTerminal, truncateForTerminal } from "./guided-terminal.mjs";
import { cleanupRetainedCompositions, withLifecycleLock } from "./lifecycle.mjs";

function checkpoint(name) {
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAULT === name) process.kill(process.pid, "SIGKILL");
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAILURE === name) fail(`Injected failure at ${name}`);
}

function patchSummary(entry) {
  return `${entry.patches.length} Patch${entry.patches.length === 1 ? "" : "es"}`;
}

function confirmRollback(activation, input, output) {
  const target = activation.previous;
  return runGuidedTerminal({
    command: "porcupi rollback",
    input,
    output,
    createController: ({ finish }) => {
      const render = () => {
        output.write("\x1b[2J\x1b[H");
        output.write("Roll back Managed Pi\n\n");
        output.write(truncateForTerminal(output, `Active:   ${activation.active.compositionId} · ${patchSummary(activation.active)}`));
        output.write("\n");
        if (target) {
          output.write(truncateForTerminal(output, `Previous: ${target.compositionId} · ${patchSummary(target)}`));
          output.write("\n\nRollback uses only this retained local Composition; it performs no fetch or build.\n");
          output.write("Patch Selection Intent remains unchanged.\n\n");
          output.write("[Space/Enter] Roll back  [Esc] cancel\n");
        } else {
          output.write("Previous: (none retained)\n\nThere is no Managed Pi Composition available to roll back to.\n\n");
          output.write("[Space/Enter/Esc] Close\n");
        }
      };
      const handleKeypress = (_character, key) => {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(false);
        if (key.name === "space" || key.name === "return") return finish(Boolean(target));
      };
      return { render, handleKeypress };
    },
  });
}

async function rollbackLocked({ input, output, dataRoot }) {
  const current = readActiveComposition(dataRoot);
  const confirmed = await confirmRollback(current.activation, input, output);
  if (!current.activation.previous) {
    output.write("\nNo previous Managed Pi Composition is retained; activation and Selection Intent are unchanged.\n");
    return { rolledBack: false, noTarget: true };
  }
  if (!confirmed) {
    output.write("\nRollback cancelled; activation and Selection Intent are unchanged.\n");
    return { rolledBack: false, cancelled: true };
  }

  const target = current.activation.previous;
  const receipt = verifyPublishedComposition(current.paths, target.compositionId);
  if (canonicalJson(receipt.patches) !== canonicalJson(target.patches)) {
    fail("Retained rollback target and Composition Patch receipts disagree");
  }
  const activation = {
    schemaVersion: 1,
    active: target,
    previous: current.activation.active,
  };
  checkpoint("rollback-activation-write");
  atomicWrite(current.paths.activation, activation);
  checkpoint("rollback-activation-written");
  cleanupRetainedCompositions(current.paths, activation, output);
  output.write(`\nActivated retained Managed Pi Composition ${target.compositionId}.\n`);
  output.write(`Previous is now ${current.activation.active.compositionId}.\n`);
  output.write("Patch Selection Intent is unchanged; run `porcupi apply` to restore pending intent.\n");
  return { rolledBack: true, compositionId: target.compositionId };
}

export async function rollbackComposition(options = {}) {
  const environment = options.environment ?? process.env;
  const dataRoot = options.dataRoot ?? defaultDataRoot(environment);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  return withLifecycleLock(dataRoot, "rollback", () => rollbackLocked({ input, output, dataRoot }));
}
