import { runGuidedTerminal, truncateForTerminal, windowAround } from "./guided-terminal.mjs";
import { createInterface } from "node:readline/promises";
import { defaultDataRoot, fail, readActiveComposition } from "./runtime.mjs";
import { discoverPiArtifacts, resolveSourceRepository } from "./source-repository.mjs";
import {
  artifactKey,
  patchIntentPending,
  patchPendingMessage,
  readSelections,
  realizeResourceChanges,
  resolveProjectContext,
  saveSelectionSources,
} from "./resource-intent.mjs";

function replacementSources(selections, source, artifacts) {
  const withoutSource = selections.sources.filter((candidate) => candidate.locator !== source.locator);
  return artifacts.length === 0
    ? withoutSource
    : [...withoutSource, {
        locator: source.locator,
        commit: source.commit,
        packageSource: source.packageSource,
        artifacts,
      }];
}

async function promptForSource(input, output) {
  const readline = createInterface({ input, output });
  try {
    return (await readline.question("Git source: ")).trim();
  } finally {
    readline.close();
  }
}

function runAddWizard({ source, artifacts, diagnostics, currentArtifacts, previousCommit, project, input, output }) {
  const availableKeys = new Set(artifacts.filter((artifact) => artifact.compatible !== false).map(artifactKey));
  const selected = new Set(currentArtifacts.map(artifactKey).filter((key) => availableKeys.has(key)));
  const scopes = new Map(currentArtifacts.filter((artifact) => artifact.kind !== "Patch").map((artifact) => [artifactKey(artifact), {
    scope: artifact.scope,
    ...(artifact.scope === "project" ? { projectRoot: artifact.projectRoot } : {}),
  }]));
  for (const artifact of artifacts.filter((candidate) => candidate.kind !== "Patch")) {
    if (!scopes.has(artifactKey(artifact))) scopes.set(artifactKey(artifact), { scope: "global" });
  }
  let page = 0;
  let artifactCursor = 0;
  let scopeCursor = 0;
  let reviewCursor = 0;

  return runGuidedTerminal({
    command: "porcupi add",
    input,
    output,
    createController: ({ finish }) => {
      const previousPatches = new Map(currentArtifacts.filter((artifact) => artifact.kind === "Patch").map((artifact) => [artifact.path, artifact]));
      const chosen = () => artifacts.filter((artifact) => selected.has(artifactKey(artifact)));
      const chosenWithScopes = () => chosen().map((artifact) => artifact.kind === "Patch"
        ? { kind: artifact.kind, path: artifact.path, sha256: artifact.sha256 }
        : ({ kind: artifact.kind, path: artifact.path, ...scopes.get(artifactKey(artifact)) }));
      const render = () => {
        output.write("\x1b[2J\x1b[H");
        if (page === 0) {
          output.write("1 of 3 — Select Artifacts\n");
          output.write(`Repository: ${source.locator}\nExact commit: ${source.commit}\n\n`);
          if (artifacts.length === 0) output.write("  No selectable Artifacts were discovered.\n");
          const artifactWindow = windowAround(output, artifactCursor, artifacts.length, 15 + Math.min(5, diagnostics.length));
          for (let index = artifactWindow.start; index < artifactWindow.end; index += 1) {
            const artifact = artifacts[index];
            const pointer = index === artifactCursor ? "›" : " ";
            const mark = selected.has(artifactKey(artifact)) ? "x" : " ";
            const label = artifact.displayName ? `${artifact.displayName} — ${artifact.path}` : artifact.path;
            const compatibility = artifact.compatible === false ? " [not supported by this Pi Base]" : "";
            output.write(`${truncateForTerminal(output, `${pointer} [${mark}] ${artifact.kind.padEnd(9)} ${label}${compatibility}`)}\n`);
          }
          if (artifacts.length > 0) {
            output.write(`  ${artifactWindow.start} above · ${artifacts.length - artifactWindow.end} below\n`);
            const focused = artifacts[artifactCursor];
            if (focused.description) output.write(`${truncateForTerminal(output, `  Details: ${focused.description}`)}\n`);
            if (focused.kind === "Patch") {
              const compatibility = focused.compatibilityDeclared
                ? focused.compatible ? "supports this exact Pi Base" : "does not support this exact Pi Base"
                : "has no compatibility declaration; the fixed pipeline remains authoritative";
              output.write(`${truncateForTerminal(output, `  Compatibility: ${compatibility}`)}\n`);
            }
          }
          const orderedDiagnostics = [
            ...diagnostics.filter((diagnostic) => diagnostic.path === "porcupi.json"),
            ...diagnostics.filter((diagnostic) => diagnostic.path !== "porcupi.json"),
          ];
          for (const diagnostic of orderedDiagnostics.slice(0, 5)) {
            if (diagnostic.path === "porcupi.json") output.write(`${truncateForTerminal(output, `  ${diagnostic.reason} (porcupi.json)`)}\n`);
            else output.write(`${truncateForTerminal(output, `  Rejected ${diagnostic.path}: ${diagnostic.reason}`)}\n`);
          }
          if (diagnostics.length > 5) output.write(`  … ${diagnostics.length - 5} more rejected candidates\n`);
          output.write("\n[↑/↓ j/k] move  [Space/Enter] toggle  [a] select all  [d] deselect all\n[n → l] Next  [Esc] cancel\n");
        } else if (page === 1) {
          const selectedArtifacts = chosenWithScopes();
          const scopedArtifacts = selectedArtifacts.filter((artifact) => artifact.kind !== "Patch");
          const patchCount = selectedArtifacts.length - scopedArtifacts.length;
          scopeCursor = Math.min(scopeCursor, Math.max(0, scopedArtifacts.length - 1));
          output.write("2 of 3 — Choose Installation Scope\n");
          output.write(`${scopedArtifacts.length} Pi resource(s), ${patchCount} Patch(es) selected.\n`);
          output.write("Patches do not have an Installation Scope and affect only Managed Pi.\n");
          if (project.available) output.write(`Project context: ${project.root}\n\n`);
          else output.write(`Project scope unavailable: ${project.reason}.\n\n`);
          const scopeWindow = windowAround(output, scopeCursor, scopedArtifacts.length, 14);
          for (let index = scopeWindow.start; index < scopeWindow.end; index += 1) {
            const artifact = scopedArtifacts[index];
            const context = artifact.scope === "project" ? `project — ${artifact.projectRoot}` : "global";
            output.write(`${truncateForTerminal(output, `${index === scopeCursor ? "›" : " "} [${context}] ${artifact.kind.padEnd(9)} ${artifact.path}`)}\n`);
          }
          if (scopedArtifacts.length === 0) output.write("  No selected Pi resources.\n");
          output.write("\n[↑/↓ j/k] move  [Space/Enter] toggle scope\n[n → l] Next  [← h] Back  [Esc] cancel\n");
        } else {
          const selectedArtifacts = chosenWithScopes();
          reviewCursor = Math.min(reviewCursor, Math.max(0, selectedArtifacts.length - 1));
          output.write("3 of 3 — Review and save\n");
          output.write(`Repository: ${source.locator}\nExact commit: ${source.commit}\n`);
          if (previousCommit && previousCommit !== source.commit) output.write(`Source-wide change: ${previousCommit} → ${source.commit}\n`);
          const digestChanges = new Map(selectedArtifacts.filter((artifact) => {
            const previousPatch = previousPatches.get(artifact.path);
            return artifact.kind === "Patch" && previousPatch && previousPatch.sha256 !== artifact.sha256;
          }).map((artifact) => [artifact.path, { previous: previousPatches.get(artifact.path).sha256, next: artifact.sha256 }]));
          if (digestChanges.size > 0) output.write(`Patch byte changes: ${digestChanges.size}; focus each changed Patch to review its digests.\n`);
          const globalCount = selectedArtifacts.filter((artifact) => artifact.scope === "global").length;
          const projectCount = selectedArtifacts.filter((artifact) => artifact.scope === "project").length;
          const patchCount = selectedArtifacts.filter((artifact) => artifact.kind === "Patch").length;
          output.write(`Selections: ${globalCount} global, ${projectCount} project Pi resource(s), ${patchCount} Patch(es)\n\n`);
          const reviewWindow = windowAround(output, reviewCursor, selectedArtifacts.length, 18);
          for (let index = reviewWindow.start; index < reviewWindow.end; index += 1) {
            const artifact = selectedArtifacts[index];
            const context = artifact.kind === "Patch"
              ? `Managed Pi · sha256:${artifact.sha256.slice(0, 12)}`
              : artifact.scope === "project" ? `project — ${artifact.projectRoot}` : "global";
            output.write(`${truncateForTerminal(output, `${index === reviewCursor ? "›" : " "} [${context}] ${artifact.kind.padEnd(9)} ${artifact.path}`)}\n`);
          }
          if (selectedArtifacts.length > 0) {
            output.write(`  ${reviewWindow.start} above · ${selectedArtifacts.length - reviewWindow.end} below\n`);
            const focused = selectedArtifacts[reviewCursor];
            const digestChange = digestChanges.get(focused.path);
            if (digestChange) output.write(`Patch bytes changed: ${focused.path} sha256:${digestChange.previous.slice(0, 12)} → sha256:${digestChange.next.slice(0, 12)}\n`);
          }
          if (selectedArtifacts.length === 0) output.write("  Saving removes this Source Repository's prior PorcuPi selections.\n");
          output.write("\nSelecting this source trusts its code and dependencies with your user authority.\n");
          output.write("The exact commit supports reproducibility; it does not prove publisher identity.\n");
          output.write("Neither Pi nor PorcuPi is a sandbox. Use an external OS/VM/container boundary if needed.\n\n");
          output.write("[↑/↓ j/k] review  [← h] Back  [Esc] cancel\n[Space/Enter] Save selections\n");
        }
      };
      const handleKeypress = (_character, key) => {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(null);
        if (key.name === "left" || key.name === "h") page = Math.max(0, page - 1);
        else if (key.name === "right" || key.name === "l" || key.name === "n") page = Math.min(2, page + 1);
        else if (key.name === "up" || key.name === "k") {
          if (page === 0) artifactCursor = Math.max(0, artifactCursor - 1);
          else if (page === 1) scopeCursor = Math.max(0, scopeCursor - 1);
          else if (page === 2) reviewCursor = Math.max(0, reviewCursor - 1);
        } else if (key.name === "down" || key.name === "j") {
          if (page === 0) artifactCursor = Math.min(Math.max(0, artifacts.length - 1), artifactCursor + 1);
          else if (page === 1) scopeCursor = Math.min(Math.max(0, chosen().filter((artifact) => artifact.kind !== "Patch").length - 1), scopeCursor + 1);
          else if (page === 2) reviewCursor = Math.min(Math.max(0, chosen().length - 1), reviewCursor + 1);
        } else if (key.name === "space" || key.name === "return") {
          if (page === 0 && artifacts[artifactCursor]) {
            const keyValue = artifactKey(artifacts[artifactCursor]);
            if (!availableKeys.has(keyValue)) return render();
            if (selected.has(keyValue)) selected.delete(keyValue);
            else selected.add(keyValue);
          } else if (page === 1) {
            const artifact = chosen().filter((candidate) => candidate.kind !== "Patch")[scopeCursor];
            if (artifact) {
              const keyValue = artifactKey(artifact);
              const current = scopes.get(keyValue);
              if (current.scope === "project") scopes.set(keyValue, { scope: "global" });
              else if (project.available) scopes.set(keyValue, { scope: "project", projectRoot: project.root });
            }
          } else if (page === 2) return finish(chosenWithScopes());
        } else if (page === 0 && key.name === "a") {
          for (const artifact of artifacts) {
            const keyValue = artifactKey(artifact);
            if (availableKeys.has(keyValue)) selected.add(keyValue);
          }
        } else if (page === 0 && key.name === "d") selected.clear();
        render();
      };
      return { render, handleKeypress };
    },
  });
}

export async function addResources(requestedSource, {
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  dataRoot = defaultDataRoot(environment),
  cwd,
} = {}) {
  const sourceInput = requestedSource || await promptForSource(input, output);
  if (!sourceInput) fail("A Git source is required");
  const active = readActiveComposition(dataRoot);
  const selections = readSelections(dataRoot);
  const project = resolveProjectContext(cwd);
  const resolved = resolveSourceRepository(sourceInput);
  try {
    const discovery = discoverPiArtifacts(resolved.checkout, { piBase: active.receipt.piBase });
    const previous = selections.sources.find((source) => source.locator === resolved.locator);
    if (previous?.commit === resolved.commit) {
      const discoveredPatches = new Map(discovery.artifacts.filter((artifact) => artifact.kind === "Patch").map((artifact) => [artifact.path, artifact]));
      for (const patch of previous.artifacts.filter((artifact) => artifact.kind === "Patch")) {
        if (discoveredPatches.get(patch.path)?.sha256 !== patch.sha256) {
          fail(`Saved Patch digest does not match its exact Source Repository commit: ${patch.path}`);
        }
      }
    }
    const result = await runAddWizard({
      source: resolved,
      artifacts: discovery.artifacts,
      diagnostics: discovery.diagnostics,
      currentArtifacts: previous?.artifacts ?? [],
      previousCommit: previous?.commit,
      project,
      input,
      output,
    });
    if (result === null) {
      output.write("\nSelection cancelled; saved Selection Intent, Pi configuration, and Managed Pi activation are unchanged.\n");
      return { saved: false, cancelled: true };
    }

    const sources = replacementSources(selections, resolved, result);
    const previousResources = previous?.artifacts.filter((artifact) => artifact.kind !== "Patch") ?? [];
    const nextResources = result.filter((artifact) => artifact.kind !== "Patch");
    await realizeResourceChanges({
      executable: active.executable,
      environment,
      changes: previousResources.length > 0 || nextResources.length > 0
        ? [{ source: resolved, previous: previous ? { ...previous, artifacts: previousResources } : undefined, nextArtifacts: nextResources }]
        : [],
      save: () => saveSelectionSources(dataRoot, sources),
    });
    const globalCount = result.filter((artifact) => artifact.scope === "global").length;
    const projectCount = result.filter((artifact) => artifact.scope === "project").length;
    const patchCount = result.filter((artifact) => artifact.kind === "Patch").length;
    const scopeSummary = projectCount === 0
      ? `${globalCount} global Pi resource selections`
      : globalCount === 0
        ? `${projectCount} project Pi resource selections`
        : `${globalCount + projectCount} Pi resource selections (${globalCount} global, ${projectCount} project)`;
    output.write(`\nSaved ${scopeSummary} and ${patchCount} Patch selections from ${resolved.locator}@${resolved.commit}.\n`);
    output.write("Pi owns package checkout, dependencies, updates, and loading. Managed Pi activation is unchanged.\n");
    output.write(patchPendingMessage(patchIntentPending(sources, active.activation.active.patches)));
    return { saved: true, count: result.length };
  } finally {
    resolved.dispose();
  }
}
