import { canonicalJson, defaultDataRoot, readActiveComposition } from "./runtime.mjs";
import {
  artifactKey,
  readSelections,
  realizeResourceChanges,
  resolveProjectContext,
  saveSelectionSources,
} from "./resource-intent.mjs";
import { runGuidedTerminal, truncateForTerminal, windowAround } from "./guided-terminal.mjs";

function managedArtifactKey(item) {
  return `${item.locator}\0${artifactKey(item)}`;
}

function flattenedSelections(selections) {
  return selections.sources.flatMap((source) => source.artifacts.map((artifact) => ({
    ...artifact,
    locator: source.locator,
    commit: source.commit,
    packageSource: source.packageSource,
  }))).sort((left, right) => managedArtifactKey(left).localeCompare(managedArtifactKey(right)));
}

function runManageWizard({ items, project, input, output }) {
  const kept = new Set(items.map(managedArtifactKey));
  const scopes = new Map(items.map((item) => [managedArtifactKey(item), {
    scope: item.scope,
    ...(item.scope === "project" ? { projectRoot: item.projectRoot } : {}),
  }]));
  let page = 0;
  let itemCursor = 0;
  let scopeCursor = 0;
  let reviewCursor = 0;

  return runGuidedTerminal({
    command: "porcupi manage",
    input,
    output,
    createController: ({ finish }) => {
      const retained = () => items.filter((item) => kept.has(managedArtifactKey(item)));
      const retainedWithScopes = () => retained().map((item) => ({ ...item, ...scopes.get(managedArtifactKey(item)) }));
      const changes = () => items.flatMap((item) => {
        const key = managedArtifactKey(item);
        if (!kept.has(key)) return [`Remove ${item.kind}: ${item.locator} :: ${item.path}`];
        const next = scopes.get(key);
        if (next.scope === item.scope && next.projectRoot === item.projectRoot) return [];
        const context = next.scope === "project" ? `project — ${next.projectRoot}` : "global";
        return [`Move ${item.kind} to ${context}: ${item.locator} :: ${item.path}`];
      });
      const render = () => {
        output.write("\x1b[2J\x1b[H");
        if (page === 0) {
          output.write("1 of 3 — Keep or remove current selections\n");
          output.write(`${kept.size} kept; ${items.length - kept.size} marked for removal.\n\n`);
          const itemWindow = windowAround(output, itemCursor, items.length, 12);
          for (let index = itemWindow.start; index < itemWindow.end; index += 1) {
            const item = items[index];
            const pointer = index === itemCursor ? "›" : " ";
            const mark = kept.has(managedArtifactKey(item)) ? "x" : " ";
            output.write(`${truncateForTerminal(output, `${pointer} [${mark}] ${item.kind.padEnd(9)} ${item.locator} :: ${item.path}`)}\n`);
          }
          output.write(`  ${itemWindow.start} above · ${items.length - itemWindow.end} below\n`);
          if (items[itemCursor]) output.write(`Focused exact source: ${items[itemCursor].locator}@${items[itemCursor].commit}\n`);
          output.write("\n[↑/↓ j/k] move  [Space/Enter] keep/remove  [a] keep all  [d] remove all\n[n → l] Next  [Esc] cancel\n");
        } else if (page === 1) {
          const selectedItems = retainedWithScopes();
          scopeCursor = Math.min(scopeCursor, Math.max(0, selectedItems.length - 1));
          output.write("2 of 3 — Choose Installation Scope\n");
          if (project.available) output.write(`Current project context: ${project.root}\n\n`);
          else output.write(`Project scope unavailable: ${project.reason}.\n\n`);
          const scopeWindow = windowAround(output, scopeCursor, selectedItems.length, 13);
          for (let index = scopeWindow.start; index < scopeWindow.end; index += 1) {
            const item = selectedItems[index];
            const context = item.scope === "project" ? `project — ${item.projectRoot}` : "global";
            output.write(`${truncateForTerminal(output, `${index === scopeCursor ? "›" : " "} [${context}] ${item.kind.padEnd(9)} ${item.locator} :: ${item.path}`)}\n`);
          }
          if (selectedItems.length === 0) output.write("  No retained Pi resources.\n");
          else output.write(`Focused exact source: ${selectedItems[scopeCursor].locator}@${selectedItems[scopeCursor].commit}\n`);
          output.write("\n[↑/↓ j/k] move  [Space/Enter] toggle scope\n[n → l] Next  [← h] Back  [Esc] cancel\n");
        } else {
          const pending = changes();
          reviewCursor = Math.min(reviewCursor, Math.max(0, pending.length - 1));
          output.write("3 of 3 — Review and save\n");
          output.write(`Result: keep ${kept.size}, remove ${items.length - kept.size}.\n`);
          output.write("Pi resource changes take effect through Pi. Managed Pi activation is unchanged.\n\n");
          const reviewWindow = windowAround(output, reviewCursor, pending.length, 13);
          for (let index = reviewWindow.start; index < reviewWindow.end; index += 1) {
            output.write(`${truncateForTerminal(output, `${index === reviewCursor ? "›" : " "} ${pending[index]}`)}\n`);
          }
          if (pending.length === 0) output.write("  No changes.\n");
          output.write("\nExact source commits remain pinned; advancing one requires `porcupi add` and review.\n");
          output.write("Pi retains project trust authority; PorcuPi never approves a project.\n");
          output.write("[↑/↓ j/k] review  [← h] Back  [Esc] cancel\n[Space/Enter] Save changes\n");
        }
      };
      const handleKeypress = (_character, key) => {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(null);
        if (key.name === "left" || key.name === "h") page = Math.max(0, page - 1);
        else if (key.name === "right" || key.name === "l" || key.name === "n") page = Math.min(2, page + 1);
        else if (key.name === "up" || key.name === "k") {
          if (page === 0) itemCursor = Math.max(0, itemCursor - 1);
          else if (page === 1) scopeCursor = Math.max(0, scopeCursor - 1);
          else reviewCursor = Math.max(0, reviewCursor - 1);
        } else if (key.name === "down" || key.name === "j") {
          if (page === 0) itemCursor = Math.min(Math.max(0, items.length - 1), itemCursor + 1);
          else if (page === 1) scopeCursor = Math.min(Math.max(0, retained().length - 1), scopeCursor + 1);
          else reviewCursor = Math.min(Math.max(0, changes().length - 1), reviewCursor + 1);
        } else if (key.name === "space" || key.name === "return") {
          if (page === 0) {
            const keyValue = managedArtifactKey(items[itemCursor]);
            if (kept.has(keyValue)) kept.delete(keyValue);
            else kept.add(keyValue);
          } else if (page === 1) {
            const item = retained()[scopeCursor];
            if (item) {
              const keyValue = managedArtifactKey(item);
              const current = scopes.get(keyValue);
              if (current.scope === "project") scopes.set(keyValue, { scope: "global" });
              else if (project.available) scopes.set(keyValue, { scope: "project", projectRoot: project.root });
            }
          } else return finish(retainedWithScopes());
        } else if (page === 0 && key.name === "a") {
          for (const item of items) kept.add(managedArtifactKey(item));
        } else if (page === 0 && key.name === "d") kept.clear();
        render();
      };
      return { render, handleKeypress };
    },
  });
}

function nextSourcesFromItems(selections, items) {
  return selections.sources.flatMap((source) => {
    const artifacts = items.filter((item) => item.locator === source.locator).map((item) => {
      const { locator: _locator, commit: _commit, packageSource: _packageSource, ...artifact } = item;
      return artifact;
    });
    return artifacts.length > 0 ? [{ ...source, artifacts }] : [];
  });
}

export async function manageResources({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  dataRoot = defaultDataRoot(environment),
  cwd,
} = {}) {
  const active = readActiveComposition(dataRoot);
  const selections = readSelections(dataRoot);
  const items = flattenedSelections(selections);
  if (items.length === 0) {
    output.write("There are no retained Pi resource selections to manage. Use `porcupi add [git-source]` first.\n");
    return { saved: false, count: 0 };
  }
  const project = resolveProjectContext(cwd);
  const result = await runManageWizard({ items, project, input, output });
  if (result === null) {
    output.write("\nManagement cancelled; saved Selection Intent, Pi configuration, and Managed Pi activation are unchanged.\n");
    return { saved: false, cancelled: true };
  }

  const nextSources = nextSourcesFromItems(selections, result);
  const nextByLocator = new Map(nextSources.map((source) => [source.locator, source]));
  const changes = selections.sources.flatMap((previous) => {
    const next = nextByLocator.get(previous.locator);
    const nextArtifacts = next?.artifacts ?? [];
    return canonicalJson(previous.artifacts) === canonicalJson(nextArtifacts)
      ? []
      : [{ source: previous, previous, nextArtifacts }];
  });
  if (changes.length === 0) {
    output.write("\nNo reviewed Selection Intent changes; Pi configuration and Managed Pi activation are unchanged.\n");
    return { saved: false, count: result.length };
  }

  await realizeResourceChanges({
    executable: active.executable,
    environment,
    changes,
    save: () => saveSelectionSources(dataRoot, nextSources),
  });
  output.write(`\nSaved ${result.length} retained Pi resource selections. Pi owns package lifecycle and project trust.\n`);
  output.write("Managed Pi activation is unchanged.\n");
  return { saved: true, count: result.length };
}
