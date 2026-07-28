// PROTOTYPE: pure in-memory state model for PorcuPi issue #9.

import { createHash } from "node:crypto";

export const PI_BASE_COMMIT = "20be4b18d4c57487f8993d2762bace129f0cf7c6";
export const PI_BASE = `earendil-works/pi@v0.81.1 (exact commit ${PI_BASE_COMMIT.slice(0, 12)})`;

export function artifactKey(artifact) {
  return `${artifact.source}\0${artifact.kind}\0${artifact.path}`;
}

export function initialState() {
  return {
    installed: false,
    piEntrypoint: "Stock Pi (/opt/homebrew/bin/pi)",
    packageSelections: [],
    patchSelections: [],
    active: null,
    previous: null,
    requiredExecutable: "valid",
    nextApply: "success",
    lastResult: "Ready. Start with the bootstrap installer.",
  };
}

export function patchOrder(patches) {
  return [...patches].sort((left, right) =>
    `${left.source}\0${left.path}`.localeCompare(`${right.source}\0${right.path}`),
  );
}

function compositionFor(patches) {
  const ordered = patchOrder(patches);
  const input = ordered.map((patch) => `${patch.source}@${patch.commit}:${patch.path}:${patch.sha256}`).join("\n");
  const id = createHash("sha256").update(`${PI_BASE}\n${input}`).digest("hex").slice(0, 12);
  return { id, patches: ordered.map((patch) => patch.path) };
}

export function install(state, { claimPi }) {
  if (state.installed) return { ...state, lastResult: "Already installed; nothing changed." };
  return {
    ...state,
    installed: true,
    piEntrypoint: claimPi ? "Managed Pi (PorcuPi-owned)" : state.piEntrypoint,
    active: compositionFor([]),
    previous: null,
    requiredExecutable: "valid",
    lastResult: claimPi
      ? "Installed Managed Pi and explicitly claimed `pi`. Stock Pi remains independently installed."
      : "Installed Managed Pi as `porcupi`; Stock Pi still owns `pi`.",
  };
}

export function setSourceSelections(state, { source, commit, artifacts, selectedPaths, scopes }) {
  const selected = new Set(selectedPaths);
  const withoutSourcePackages = state.packageSelections.filter((item) => item.source !== source);
  const withoutSourcePatches = state.patchSelections.filter((item) => item.source !== source);
  const packageSelections = artifacts
    .filter((artifact) => artifact.kind !== "Patch" && selected.has(artifact.path))
    .map((artifact) => ({ ...artifact, source, commit, scope: scopes[artifact.path] }));
  const patchSelections = artifacts
    .filter((artifact) => artifact.kind === "Patch" && selected.has(artifact.path))
    .map((artifact) => ({ ...artifact, source, commit }));

  return {
    ...state,
    packageSelections: [...withoutSourcePackages, ...packageSelections],
    patchSelections: patchOrder([...withoutSourcePatches, ...patchSelections]),
    lastResult: `Saved ${packageSelections.length} Pi resource(s) and ${patchSelections.length} Patch(es) from the fixed repository version. Managed Pi was not rebuilt.`,
  };
}

export function manageSelections(state, { keptKeys, resourceScopes }) {
  const kept = new Set(keptKeys);
  const packageSelections = state.packageSelections
    .filter((artifact) => kept.has(artifactKey(artifact)))
    .map((artifact) => ({ ...artifact, scope: resourceScopes[artifactKey(artifact)] ?? artifact.scope }));
  const patchSelections = state.patchSelections.filter((artifact) => kept.has(artifactKey(artifact)));
  const removed = state.packageSelections.length + state.patchSelections.length - packageSelections.length - patchSelections.length;
  const patchChanged = patchSelections.length !== state.patchSelections.length;
  return {
    ...state,
    packageSelections,
    patchSelections,
    lastResult: `Saved current selections; removed ${removed}. Resource changes now belong to Pi.${patchChanged ? " Patch changes are pending `porcupi apply`." : ""}`,
  };
}

export function setNextApply(state, outcome) {
  return { ...state, nextApply: outcome, lastResult: `Next apply will ${outcome}.` };
}

export function applyPatches(state) {
  if (!state.installed) return { ...state, lastResult: "Apply refused: PorcuPi is not installed." };
  if (state.nextApply === "fail") {
    return {
      ...state,
      lastResult: `Apply failed during Patch preflight. Active ${state.active.id} and previous composition are unchanged.`,
    };
  }
  const candidate = compositionFor(state.patchSelections);
  if (candidate.id === state.active?.id) {
    return { ...state, lastResult: `Active ${candidate.id} already matches Patch intent; no build was needed.` };
  }
  return {
    ...state,
    active: candidate,
    previous: state.active,
    requiredExecutable: "valid",
    lastResult: `Built, verified, and atomically activated ${candidate.id}; retained exactly one previous composition.`,
  };
}

export function rollback(state) {
  if (!state.installed) return { ...state, lastResult: "Rollback refused: PorcuPi is not installed." };
  if (!state.previous) return { ...state, lastResult: "Rollback refused: no previous composition is retained." };
  if (state.requiredExecutable !== "valid") {
    return { ...state, lastResult: "Rollback refused: local composition verification failed; activation is unchanged." };
  }
  return {
    ...state,
    active: state.previous,
    previous: state.active,
    lastResult: `Verified and atomically rolled back to ${state.previous.id}. Patch Selection Intent did not change.`,
  };
}

export function verify(state) {
  if (!state.installed) return { ...state, lastResult: "Verify refused: PorcuPi is not installed." };
  return {
    ...state,
    lastResult:
      state.requiredExecutable === "valid"
        ? `Verified active ${state.active.id}: receipt, full payload inventory, executable, and smoke checks pass.`
        : `Verification failed closed for active ${state.active.id}: required executable digest mismatch.`,
  };
}

export function launch(state) {
  if (!state.installed) return { ...state, lastResult: "`porcupi` is absent because PorcuPi is not installed." };
  if (state.requiredExecutable !== "valid") {
    return { ...state, lastResult: "Launch refused: required executable identity mismatch. No fallback was launched." };
  }
  return { ...state, lastResult: `Launched active Managed Pi ${state.active.id} through \`porcupi\`.` };
}

export function setRequiredExecutable(state, status) {
  return { ...state, requiredExecutable: status, lastResult: `Required executable is now ${status} (simulation only).` };
}

export function setPiOwnership(state, enabled) {
  if (!state.installed) return { ...state, lastResult: "`pi` ownership change refused: PorcuPi is not installed." };
  return {
    ...state,
    piEntrypoint: enabled ? "Managed Pi (PorcuPi-owned)" : "Stock Pi (/opt/homebrew/bin/pi)",
    lastResult: enabled
      ? "PorcuPi now owns `pi`; Stock Pi remains independently installed."
      : "PorcuPi released `pi`; Stock Pi resolves normally. `porcupi` still launches Managed Pi.",
  };
}

export function uninstall(state) {
  if (!state.installed) return { ...state, lastResult: "PorcuPi is already absent; nothing changed." };
  const retained = state.packageSelections.length;
  return {
    ...state,
    installed: false,
    piEntrypoint: "Stock Pi (/opt/homebrew/bin/pi)",
    patchSelections: [],
    active: null,
    previous: null,
    requiredExecutable: "valid",
    lastResult: `Removed PorcuPi-owned launchers, Patch intent, receipts, and Managed Pi payloads. Left ${retained} resource selection(s) in Pi package settings.`,
  };
}
