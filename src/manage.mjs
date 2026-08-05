import { join } from "node:path";
import { canonicalJson, defaultDataRoot, fail, readActiveComposition, sha256File } from "./runtime.mjs";
import {
  artifactKey,
  artifactStructuralIdentity,
  isPatchSeries,
  patchIntentPending,
  patchPendingMessage,
  readSelections,
  realizeResourceChanges,
  resolveProjectContext,
  saveSelectionSources,
} from "./resource-intent.mjs";
import { runGuidedTerminal, truncateForTerminal, windowAround } from "./guided-terminal.mjs";
import {
  branchContainsAcceptedCommit,
  discoverPiArtifacts,
  resolveSourceRepository,
  resolveTrackedSourceRepository,
  sourceSnapshotSummary,
} from "./source-repository.mjs";

function managedArtifactKey(item) {
  return `${item.source.locator}\0${artifactKey(item.artifact)}`;
}

function managedSelections(selections) {
  return selections.sources.flatMap((source) => source.artifacts.map((artifact) => ({ source, artifact })))
    .sort((left, right) => managedArtifactKey(left).localeCompare(managedArtifactKey(right)));
}

function runManageWizard({ items, project, patchPending, input, output }) {
  const kept = new Set(items.map(managedArtifactKey));
  const scopes = new Map(items.filter((item) => !isPatchSeries(item.artifact)).map((item) => [managedArtifactKey(item), {
    scope: item.artifact.scope,
    ...(item.artifact.scope === "project" ? { projectRoot: item.artifact.projectRoot } : {}),
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
      const retainedResources = () => retained().filter((item) => !isPatchSeries(item.artifact));
      const retainedWithScopes = () => retained().map((item) => isPatchSeries(item.artifact)
        ? item
        : ({ ...item, artifact: { ...item.artifact, ...scopes.get(managedArtifactKey(item)) } }));
      const changes = () => items.flatMap((item) => {
        const key = managedArtifactKey(item);
        const kind = isPatchSeries(item.artifact) ? "Patch Series" : item.artifact.kind;
        if (!kept.has(key)) return [`Remove ${kind}: ${item.source.locator} :: ${artifactStructuralIdentity(item.artifact)}`];
        if (isPatchSeries(item.artifact)) return [];
        const next = scopes.get(key);
        if (next.scope === item.artifact.scope && next.projectRoot === item.artifact.projectRoot) return [];
        const context = next.scope === "project" ? `project — ${next.projectRoot}` : "global";
        return [`Move ${item.artifact.kind} to ${context}: ${item.source.locator} :: ${item.artifact.path}`];
      });
      const render = () => {
        output.write("\x1b[2J\x1b[H");
        if (page === 0) {
          output.write("1 of 3 — Keep or remove current selections\n");
          output.write(`${kept.size} kept; ${items.length - kept.size} marked for removal.\n\n`);
          const itemWindow = windowAround(output, itemCursor, items.length, 13);
          for (let index = itemWindow.start; index < itemWindow.end; index += 1) {
            const item = items[index];
            const pointer = index === itemCursor ? "›" : " ";
            const mark = kept.has(managedArtifactKey(item)) ? "x" : " ";
            const kind = isPatchSeries(item.artifact) ? "Patch Series" : item.artifact.kind;
            output.write(`${truncateForTerminal(output, `${pointer} [${mark}] ${kind.padEnd(12)} ${item.source.locator} :: ${artifactStructuralIdentity(item.artifact)}`)}\n`);
          }
          output.write(`  ${itemWindow.start} above · ${items.length - itemWindow.end} below\n`);
          if (items[itemCursor]) {
            const focused = items[itemCursor];
            output.write(sourceSnapshotSummary(focused.source, "Accepted"));
            if (isPatchSeries(focused.artifact)) {
              output.write(`Focused inventory: ${focused.artifact.members.length} Patch File${focused.artifact.members.length === 1 ? "" : "s"} in retained order\n`);
              for (const [memberIndex, member] of focused.artifact.members.entries()) {
                output.write(`  ${memberIndex + 1}. ${member.path} · sha256:${member.sha256}\n`);
              }
            }
          }
          output.write("\n[↑/↓ j/k] move  [Space/Enter] keep/remove  [a] keep all  [d] remove all\n[n → l] Next  [Esc] cancel\n");
        } else if (page === 1) {
          const selectedItems = retainedResources().map((item) => ({
            ...item,
            artifact: { ...item.artifact, ...scopes.get(managedArtifactKey(item)) },
          }));
          scopeCursor = Math.min(scopeCursor, Math.max(0, selectedItems.length - 1));
          output.write("2 of 3 — Choose Installation Scope\n");
          output.write("Patch Series do not have an Installation Scope and are not listed on this page.\n");
          if (project.available) output.write(`Current project context: ${project.root}\n\n`);
          else output.write(`Project scope unavailable: ${project.reason}.\n\n`);
          const scopeWindow = windowAround(output, scopeCursor, selectedItems.length, 13);
          for (let index = scopeWindow.start; index < scopeWindow.end; index += 1) {
            const item = selectedItems[index];
            const context = item.artifact.scope === "project" ? `project — ${item.artifact.projectRoot}` : "global";
            output.write(`${truncateForTerminal(output, `${index === scopeCursor ? "›" : " "} [${context}] ${item.artifact.kind.padEnd(9)} ${item.source.locator} :: ${item.artifact.path}`)}\n`);
          }
          if (selectedItems.length === 0) output.write("  No retained Pi resources.\n");
          else {
            const focused = selectedItems[scopeCursor];
            output.write(sourceSnapshotSummary(focused.source, "Accepted"));
          }
          output.write("\n[↑/↓ j/k] move  [Space/Enter] toggle scope\n[n → l] Next  [← h] Back  [Esc] cancel\n");
        } else {
          const pending = changes();
          reviewCursor = Math.min(reviewCursor, Math.max(0, pending.length - 1));
          output.write("3 of 3 — Review and save\n");
          output.write(`Result: keep ${kept.size}, remove ${items.length - kept.size}.\n`);
          output.write("Pi resource changes take effect through Pi; Patch changes remain pending until apply.\n");
          output.write("Managed Pi activation is unchanged.\n");
          output.write(patchPendingMessage(patchPending));
          output.write("\n");
          const reviewWindow = windowAround(output, reviewCursor, pending.length, 14);
          for (let index = reviewWindow.start; index < reviewWindow.end; index += 1) {
            output.write(`${truncateForTerminal(output, `${index === reviewCursor ? "›" : " "} ${pending[index]}`)}\n`);
          }
          if (pending.length === 0) output.write("  No changes.\n");
          output.write("\nAccepted source commits remain exact snapshots; Tracked Branch movement never advances them without review.\n");
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
          else if (page === 1) scopeCursor = Math.min(Math.max(0, retainedResources().length - 1), scopeCursor + 1);
          else reviewCursor = Math.min(Math.max(0, changes().length - 1), reviewCursor + 1);
        } else if (key.name === "space" || key.name === "return") {
          if (page === 0) {
            const keyValue = managedArtifactKey(items[itemCursor]);
            if (kept.has(keyValue)) kept.delete(keyValue);
            else kept.add(keyValue);
          } else if (page === 1) {
            const item = retainedResources()[scopeCursor];
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

function candidateSelectionSource(previous, resolved, artifacts) {
  return {
    locator: resolved.locator,
    commit: resolved.commit,
    packageSource: resolved.packageSource,
    trackedBranch: resolved.trackedBranch,
    artifacts: artifacts.map((artifact) => isPatchSeries(artifact) ? {
      kind: "PatchSeries",
      id: artifact.id,
      members: artifact.members.map((member) => ({
        commit: resolved.commit,
        path: member.path,
        sha256: member.sha256,
      })),
    } : {
      kind: artifact.kind,
      path: artifact.path,
      scope: previous.artifacts.find((selected) => artifactKey(selected) === artifactKey(artifact)).scope,
      ...(previous.artifacts.find((selected) => artifactKey(selected) === artifactKey(artifact)).projectRoot
        ? { projectRoot: previous.artifacts.find((selected) => artifactKey(selected) === artifactKey(artifact)).projectRoot }
        : {}),
    }),
  };
}

function artifactReview({ selected, accepted, candidate, acceptedCheckout, candidateCheckout }) {
  const compatibilityBefore = accepted?.compatibility ?? null;
  const compatibilityAfter = candidate.compatibility ?? null;
  if (isPatchSeries(selected)) {
    const previousMembers = selected.members.map(({ path, sha256 }) => ({ path, sha256 }));
    const candidateMembers = candidate.members.map(({ path, sha256 }) => ({ path, sha256 }));
    return {
      selected,
      candidate,
      changed: canonicalJson(previousMembers) !== canonicalJson(candidateMembers)
        || canonicalJson(compatibilityBefore) !== canonicalJson(compatibilityAfter),
      previous: previousMembers.map((member) => `${member.path}@sha256:${member.sha256}`).join(" → "),
      next: candidateMembers.map((member) => `${member.path}@sha256:${member.sha256}`).join(" → "),
      compatibilityBefore,
      compatibilityAfter,
    };
  }
  const previousDigest = sha256File(join(acceptedCheckout, selected.path));
  const candidateDigest = sha256File(join(candidateCheckout, selected.path));
  return {
    selected,
    candidate,
    changed: previousDigest !== candidateDigest
      || canonicalJson(compatibilityBefore) !== canonicalJson(compatibilityAfter),
    previous: `sha256:${previousDigest}`,
    next: `sha256:${candidateDigest}`,
    compatibilityBefore,
    compatibilityAfter,
  };
}

function compatibilityReview(value) {
  return value === null ? "no author-declared restriction" : canonicalJson(value);
}

function runSourceUpdateWizard({ previous, candidate, reviews, active, input, output }) {
  let page = 0;
  let cursor = 0;
  return runGuidedTerminal({
    command: "porcupi manage",
    input,
    output,
    createController: ({ finish }) => {
      const render = () => {
        output.write("\x1b[2J\x1b[H");
        if (page === 0) {
          output.write("1 of 3 — Review Tracked Branch candidate\n");
          output.write(`Source Repository: ${previous.locator}\nTracked Branch: ${previous.trackedBranch}\n`);
          output.write(`Accepted exact commit: ${previous.commit}\nCandidate exact commit: ${candidate.commit}\n\n`);
          const visible = windowAround(output, cursor, reviews.length, 12);
          for (let index = visible.start; index < visible.end; index += 1) {
            const review = reviews[index];
            const kind = isPatchSeries(review.selected) ? "Patch Series" : review.selected.kind;
            output.write(`${truncateForTerminal(output, `${index === cursor ? "›" : " "} ${kind.padEnd(12)} [${review.changed ? "changed" : "unchanged"}] ${artifactStructuralIdentity(review.selected)}`)}\n`);
          }
          if (reviews.length > 0) {
            const focused = reviews[cursor];
            output.write(`  Accepted: ${focused.previous}\n  Candidate: ${focused.next}\n`);
            if (canonicalJson(focused.compatibilityBefore) !== canonicalJson(focused.compatibilityAfter)) {
              output.write(`  Compatibility changed: ${compatibilityReview(focused.compatibilityBefore)} → ${compatibilityReview(focused.compatibilityAfter)}\n`);
            }
          }
          output.write("\n[↑/↓ j/k] inspect every selected Artifact change  [n → l] Next  [Esc] cancel\n");
        } else if (page === 1) {
          output.write("2 of 3 — Check current release and Pi Base\n\n");
          output.write(`Current PorcuPi release: ${active.receipt.porcupiVersion}\n`);
          output.write(`Current Pi Base: ${active.receipt.piBase.tag} (${active.receipt.piBase.commit})\n`);
          output.write(`Candidate exact commit: ${candidate.commit}\n\n`);
          for (const review of reviews) {
            const kind = isPatchSeries(review.selected) ? "Patch Series" : review.selected.kind;
            const declaration = review.candidate.compatibilityDeclared
              ? "author declaration matches this exact Pi Base"
              : "no author-declared restriction; PorcuPi's fixed checks remain authoritative";
            output.write(`${truncateForTerminal(output, `  ✓ ${kind} ${artifactStructuralIdentity(review.selected)} — ${declaration}`)}\n`);
          }
          output.write("\nAll selected Artifacts are discoverable and eligible for this release-pinned Pi Base.\n");
          output.write("Patch Series will still pass the fixed preflight, build, conformance, and smoke pipeline only during explicit `porcupi apply`.\n");
          output.write("\n[n → l] Next  [← h] Back  [Esc] cancel\n");
        } else {
          const resourceCount = reviews.filter((review) => !isPatchSeries(review.selected)).length;
          const patchCount = reviews.length - resourceCount;
          output.write("3 of 3 — Accept exact source snapshot\n\n");
          output.write(`Advance all ${reviews.length} selected Artifacts from ${previous.commit} to ${candidate.commit}.\n`);
          output.write(`Pi resources reconciled now: ${resourceCount}. Patch Series recorded as pending: ${patchCount}.\n`);
          output.write("The active Managed Pi Composition remains unchanged until explicit `porcupi apply`.\n\n");
          output.write("Selecting this candidate trusts its code and dependencies with your user authority.\n");
          output.write("Pi retains project trust authority; PorcuPi never approves a project.\n");
          output.write("Neither Pi nor PorcuPi is a sandbox.\n\n");
          output.write("[← h] Back  [Esc] cancel\n[Space/Enter] Accept candidate\n");
        }
      };
      const handleKeypress = (_character, key) => {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(false);
        if (key.name === "left" || key.name === "h") page = Math.max(0, page - 1);
        else if (key.name === "right" || key.name === "l" || key.name === "n") page = Math.min(2, page + 1);
        else if (page === 0 && (key.name === "up" || key.name === "k")) cursor = Math.max(0, cursor - 1);
        else if (page === 0 && (key.name === "down" || key.name === "j")) cursor = Math.min(Math.max(0, reviews.length - 1), cursor + 1);
        else if (page === 2 && (key.name === "space" || key.name === "return")) return finish(true);
        render();
      };
      return { render, handleKeypress };
    },
  });
}

function trackedCandidate(selections, active) {
  for (const previous of selections.sources.filter((source) => source.trackedBranch)) {
    const resolved = resolveTrackedSourceRepository(previous);
    if (resolved.commit === previous.commit) {
      resolved.dispose();
      continue;
    }
    if (!branchContainsAcceptedCommit(resolved.checkout, previous.commit, resolved.commit)) {
      resolved.dispose();
      continue;
    }
    let accepted;
    try {
      accepted = resolveSourceRepository(previous.packageSource);
      const acceptedDiscovery = discoverPiArtifacts(accepted.checkout, { piBase: active.receipt.piBase });
      const candidateDiscovery = discoverPiArtifacts(resolved.checkout, { piBase: active.receipt.piBase });
      const acceptedByKey = new Map(acceptedDiscovery.artifacts.map((artifact) => [artifactKey(artifact), artifact]));
      const candidateByKey = new Map(candidateDiscovery.artifacts.map((artifact) => [artifactKey(artifact), artifact]));
      const selectedCandidates = previous.artifacts.map((selected) => {
        const candidate = candidateByKey.get(artifactKey(selected));
        const identity = `${previous.locator}@${resolved.commit}:${artifactStructuralIdentity(selected)}`;
        if (!candidate) fail(`Inter-release Source Update blocked: selected ${isPatchSeries(selected) ? "Patch Series" : selected.kind} ${identity} is not discoverable at the candidate exact commit`);
        if (candidate.compatible === false) {
          fail(`Inter-release Source Update blocked: selected ${isPatchSeries(selected) ? "Patch Series" : selected.kind} ${identity} does not support current Pi Base ${active.receipt.piBase.tag} (${active.receipt.piBase.commit})`);
        }
        return candidate;
      });
      const candidateSource = candidateSelectionSource(previous, resolved, selectedCandidates);
      const reviews = previous.artifacts.map((selected, index) => artifactReview({
        selected,
        accepted: acceptedByKey.get(artifactKey(selected)),
        candidate: selectedCandidates[index],
        acceptedCheckout: accepted.checkout,
        candidateCheckout: resolved.checkout,
      }));
      return { previous, candidateSource, reviews, resolved, accepted };
    } catch (error) {
      accepted?.dispose();
      resolved.dispose();
      throw error;
    }
  }
  return undefined;
}

async function adoptTrackedCandidate({ candidate, selections, active, input, output, environment, dataRoot }) {
  try {
    const confirmed = await runSourceUpdateWizard({
      previous: candidate.previous,
      candidate: candidate.candidateSource,
      reviews: candidate.reviews,
      active,
      input,
      output,
    });
    if (!confirmed) {
      output.write("\nSource update cancelled; Selection Intent, Pi package settings/checkouts, pending Patches, and Managed Pi activation are unchanged.\n");
      return { saved: false, cancelled: true };
    }
    const sources = selections.sources.map((source) => (
      source.locator === candidate.previous.locator ? candidate.candidateSource : source
    ));
    const previousResources = candidate.previous.artifacts.filter((artifact) => !isPatchSeries(artifact));
    const nextResources = candidate.candidateSource.artifacts.filter((artifact) => !isPatchSeries(artifact));
    await realizeResourceChanges({
      executable: active.executable,
      environment,
      changes: previousResources.length > 0 || nextResources.length > 0 ? [{
        source: candidate.candidateSource,
        previous: { ...candidate.previous, artifacts: previousResources },
        nextArtifacts: nextResources,
      }] : [],
      save: () => saveSelectionSources(dataRoot, sources),
    });
    const patchCount = candidate.candidateSource.artifacts.filter(isPatchSeries).length;
    output.write(`\nAccepted Tracked Branch candidate ${candidate.candidateSource.commit} for ${candidate.candidateSource.locator}.\n`);
    output.write(`Immediately reconciled ${nextResources.length} Pi resources through Pi's public package lifecycle.\n`);
    output.write(patchCount > 0
      ? `Recorded ${patchCount} Patch Series at the accepted exact snapshot; they await \`porcupi apply\`.\n`
      : "No changed Patch Series await `porcupi apply`.\n");
    output.write("Managed Pi activation is unchanged.\n");
    output.write(patchPendingMessage(patchIntentPending(sources, active.activation.active.patches)));
    return { saved: true, updated: true, count: candidate.candidateSource.artifacts.length };
  } finally {
    candidate.accepted.dispose();
    candidate.resolved.dispose();
  }
}

function nextSourcesFromItems(selections, items) {
  return selections.sources.flatMap((source) => {
    const artifacts = items
      .filter((item) => item.source.locator === source.locator)
      .map((item) => item.artifact);
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
  const candidate = trackedCandidate(selections, active);
  if (candidate) {
    return adoptTrackedCandidate({ candidate, selections, active, input, output, environment, dataRoot });
  }
  const items = managedSelections(selections);
  if (items.length === 0) {
    output.write("There are no retained Artifact selections to manage. Use `porcupi add [git-source]` first.\n");
    return { saved: false, count: 0 };
  }
  const project = resolveProjectContext(cwd);
  const patchPending = patchIntentPending(selections.sources, active.activation.active.patches);
  const result = await runManageWizard({ items, project, patchPending, input, output });
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
    output.write(patchPendingMessage(patchPending));
    return { saved: false, count: result.length };
  }

  const resourceChanges = changes.flatMap((change) => {
    const previousArtifacts = change.previous.artifacts.filter((artifact) => !isPatchSeries(artifact));
    const nextArtifacts = change.nextArtifacts.filter((artifact) => !isPatchSeries(artifact));
    return canonicalJson(previousArtifacts) === canonicalJson(nextArtifacts)
      ? []
      : [{ ...change, previous: { ...change.previous, artifacts: previousArtifacts }, nextArtifacts }];
  });
  await realizeResourceChanges({
    executable: active.executable,
    environment,
    changes: resourceChanges,
    save: () => saveSelectionSources(dataRoot, nextSources),
  });
  const resourceCount = result.filter((item) => !isPatchSeries(item.artifact)).length;
  const patchCount = result.length - resourceCount;
  output.write(`\nSaved ${resourceCount} Pi resource and ${patchCount} Patch Series selection${patchCount === 1 ? "" : "s"}. Pi owns package lifecycle and project trust.\n`);  output.write("Managed Pi activation is unchanged.\n");
  output.write(patchPendingMessage(patchIntentPending(nextSources, active.activation.active.patches)));
  return { saved: true, count: result.length };
}
