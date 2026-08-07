import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathExists, removePreparedTree, verifyPublishedComposition } from "./composition.mjs";
import { runGuidedTerminal, truncateForTerminal, windowAround } from "./guided-terminal.mjs";
import {
  durableUnlink,
  inspectCompositionLeases,
  inspectStagedCompositionLeases,
  preflightCompositionCleanup,
  recoverCompositionCleanup,
  withLifecycleLock,
} from "./lifecycle.mjs";
import { summarizeRetainedPiResources } from "./resource-intent.mjs";
import { verifyReleaseStatusState } from "./release-status.mjs";
import {
  atomicWrite,
  canonicalJson,
  createLauncherReceipt,
  createPayloadInventory,
  defaultBinDirectory,
  defaultDataRoot,
  fail,
  managedLayout,
  managedRootOwner,
  readActivation,
  readJson,
  sha256Bytes,
  shellLauncherContents,
  shellPiLauncherContents,
  validateLauncherReceipt,
  validateManagedRoot,
  verifyLauncher,
  verifyLauncherReceipt,
  verifyOptionalPiLauncher,
  verifyRuntime,
} from "./runtime.mjs";

const compositionIdPattern = /^[a-f0-9]{64}$/;
const preparationFields = new Set(["schemaVersion", "type", "dataRoot", "stage"]);
const tombstoneFields = new Set([
  "schemaVersion", "type", "dataRoot", "originalLauncher", "piLauncher", "recoveryLauncher",
  "runtimeInventorySha256", "stateInventorySha256", "temporaryInventorySha256", "compositionIds", "resourceSummary",
]);
const resourceSummaryFields = new Set(["resources", "patchCount"]);
const resourceFields = new Set(["locator", "scope", "projectRoot", "artifacts", "configured"]);
const artifactFields = new Set(["kind", "path"]);
const progressFields = new Set(["schemaVersion", "type", "phase"]);
const progressPhases = new Set(["prepared", "recovery-launcher-published", "root-removed", "launcher-removed"]);
const temporaryOwners = new Map([
  ["install-", { schemaVersion: 1, type: "porcupi-install-stage" }],
  ["apply-", { schemaVersion: 1, type: "porcupi-apply-stage" }],
  ["verify-", { schemaVersion: 1, type: "porcupi-verify-stage" }],
]);

function exactObject(value, fields) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function validText(value) {
  return typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function validRelativePath(value) {
  return validText(value)
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function checkpoint(name) {
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAULT === name) process.kill(process.pid, "SIGKILL");
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAILURE === name) fail(`Injected failure at ${name}`);
}

function fsyncDirectory(path) {
  try {
    const descriptor = openSync(path, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Atomic rename still provides a complete old or new directory entry.
  }
}

function tombstonePath(dataRoot) {
  return `${resolve(dataRoot)}.uninstall-tombstone`;
}

function preparationPrefix(dataRoot) {
  return `.${basename(resolve(dataRoot))}.uninstall-stage-`;
}

function expectedLauncherReceipt(path, type, contents, mode = 0o755) {
  return {
    schemaVersion: 1,
    type,
    path,
    kind: "file",
    mode,
    size: Buffer.byteLength(contents),
    sha256: sha256Bytes(contents),
  };
}

function validateResourceSummary(value) {
  if (
    !exactObject(value, resourceSummaryFields)
    || !Array.isArray(value.resources)
    || !Number.isSafeInteger(value.patchCount)
    || value.patchCount < 0
  ) fail("Malformed PorcuPi uninstall resource summary");
  let previousResourceKey;
  for (const resource of value.resources) {
    if (
      !exactObject(resource, resourceFields)
      || !validText(resource.locator)
      || !new Set(["global", "project"]).has(resource.scope)
      || (resource.scope === "global" ? resource.projectRoot !== null : (
        !validText(resource.projectRoot) || resolve(resource.projectRoot) !== resource.projectRoot
      ))
      || typeof resource.configured !== "boolean"
      || !Array.isArray(resource.artifacts)
      || resource.artifacts.length === 0
      || resource.artifacts.some((artifact) => (
        !exactObject(artifact, artifactFields)
        || !new Set(["Extension", "Skill", "Prompt", "Theme"]).has(artifact.kind)
        || !validRelativePath(artifact.path)
      ))
    ) fail("Malformed PorcuPi uninstall resource summary");
    const artifactKeys = resource.artifacts.map((artifact) => `${artifact.kind}\0${artifact.path}`);
    const resourceKey = `${resource.locator}\0${resource.scope}\0${resource.projectRoot || ""}`;
    if (
      new Set(artifactKeys).size !== artifactKeys.length
      || canonicalJson(artifactKeys) !== canonicalJson([...artifactKeys].sort())
      || (previousResourceKey !== undefined && resourceKey <= previousResourceKey)
    ) fail("Malformed PorcuPi uninstall resource summary");
    previousResourceKey = resourceKey;
  }
  return value;
}

function recoveryRuntimeInventory(tombstone) {
  const runtime = join(tombstone, "runtime");
  const stat = lstatSync(runtime);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Malformed PorcuPi uninstall tombstone: ${tombstone}`);
  return createPayloadInventory(runtime);
}

function validateTombstone(dataRoot, environment) {
  const tombstone = tombstonePath(dataRoot);
  const stat = lstatSync(tombstone);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Foreign PorcuPi uninstall tombstone requires manual inspection: ${tombstone}`);
  const names = readdirSync(tombstone);
  if (names.some((name) => !new Set(["owner.json", "progress.json", "runtime", "lease-gates", "preparation-owner.json"]).has(name))) {
    fail(`Foreign PorcuPi uninstall tombstone requires manual inspection: ${tombstone}`);
  }
  if (names.includes("preparation-owner.json")) {
    const preparation = readJson(join(tombstone, "preparation-owner.json"), "PorcuPi uninstall stage ownership");
    if (
      !exactObject(preparation, preparationFields)
      || preparation.schemaVersion !== 1
      || preparation.type !== "porcupi-uninstall-preparation"
      || preparation.dataRoot !== resolve(dataRoot)
      || typeof preparation.stage !== "string"
      || dirname(preparation.stage) !== dirname(tombstone)
      || !basename(preparation.stage).startsWith(preparationPrefix(dataRoot))
    ) fail(`Foreign PorcuPi uninstall tombstone requires manual inspection: ${tombstone}`);
  }
  const owner = readJson(join(tombstone, "owner.json"), "PorcuPi uninstall tombstone ownership");
  const binDirectory = defaultBinDirectory(environment);
  const launcher = join(binDirectory, "porcupi");
  const piLauncher = join(binDirectory, "pi");
  if (
    !exactObject(owner, tombstoneFields)
    || owner.schemaVersion !== 1
    || owner.type !== "porcupi-uninstall-tombstone"
    || owner.dataRoot !== resolve(dataRoot)
    || !Array.isArray(owner.compositionIds)
    || owner.compositionIds.some((id) => !compositionIdPattern.test(id))
    || new Set(owner.compositionIds).size !== owner.compositionIds.length
    || canonicalJson(owner.compositionIds) !== canonicalJson([...owner.compositionIds].sort())
    || typeof owner.runtimeInventorySha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(owner.runtimeInventorySha256)
    || !/^[a-f0-9]{64}$/.test(owner.stateInventorySha256 || "")
    || !/^[a-f0-9]{64}$/.test(owner.temporaryInventorySha256 || "")
  ) fail(`Foreign PorcuPi uninstall tombstone requires manual inspection: ${tombstone}`);
  validateLauncherReceipt(owner.originalLauncher, {
    type: "porcupi-launcher", path: launcher, label: "PorcuPi uninstall original launcher receipt",
  });
  if (owner.piLauncher !== null) validateLauncherReceipt(owner.piLauncher, {
    type: "porcupi-pi-launcher", path: piLauncher, label: "PorcuPi uninstall pi launcher receipt",
  });
  validateLauncherReceipt(owner.recoveryLauncher, {
    type: "porcupi-uninstall-launcher", path: launcher, label: "PorcuPi uninstall recovery launcher receipt",
  });
  validateResourceSummary(owner.resourceSummary);
  const inventory = recoveryRuntimeInventory(tombstone);
  if (sha256Bytes(canonicalJson(inventory)) !== owner.runtimeInventorySha256) {
    fail(`PorcuPi uninstall tombstone runtime changed: ${tombstone}`);
  }
  const expectedRecovery = shellLauncherContents(join(tombstone, "runtime", "cli.mjs"));
  if (canonicalJson(owner.recoveryLauncher) !== canonicalJson(expectedLauncherReceipt(
    launcher, "porcupi-uninstall-launcher", expectedRecovery,
  ))) fail(`Malformed PorcuPi uninstall tombstone: ${tombstone}`);
  const progress = readJson(join(tombstone, "progress.json"), "PorcuPi uninstall progress");
  if (
    !exactObject(progress, progressFields)
    || progress.schemaVersion !== 1
    || progress.type !== "porcupi-uninstall-progress"
    || !progressPhases.has(progress.phase)
  ) fail(`Malformed PorcuPi uninstall tombstone: ${tombstone}`);
  return { tombstone, owner, progress, launcher, piLauncher, expectedRecovery };
}

function readPreparationOwner(stage, dataRoot) {
  const stat = lstatSync(stage);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Foreign PorcuPi uninstall stage requires manual inspection: ${stage}`);
  const owner = readJson(join(stage, "preparation-owner.json"), "PorcuPi uninstall stage ownership");
  if (
    !exactObject(owner, preparationFields)
    || owner.schemaVersion !== 1
    || owner.type !== "porcupi-uninstall-preparation"
    || owner.dataRoot !== resolve(dataRoot)
    || owner.stage !== stage
  ) fail(`Foreign PorcuPi uninstall stage requires manual inspection: ${stage}`);
  return owner;
}

function recoverPreparationStages(dataRoot) {
  const parent = dirname(resolve(dataRoot));
  const prefix = preparationPrefix(dataRoot);
  let names = [];
  try {
    names = readdirSync(parent).filter((name) => name.startsWith(prefix));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const stage = join(parent, name);
    readPreparationOwner(stage, dataRoot);
    removePreparedTree(stage);
  }
}

function validateTemporaryState(paths, activation) {
  const cleanupCompositionIds = preflightCompositionCleanup(paths, activation);
  for (const name of readdirSync(paths.temporary)) {
    if (name.startsWith("cleanup-")) continue;
    const match = [...temporaryOwners.entries()].find(([prefix]) => name.startsWith(prefix));
    const stage = join(paths.temporary, name);
    if (!match) fail(`Foreign PorcuPi temporary path requires manual inspection: ${stage}`);
    const stat = lstatSync(stage);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Foreign PorcuPi temporary path requires manual inspection: ${stage}`);
    const owner = readJson(join(stage, "owner.json"), "PorcuPi temporary ownership");
    if (canonicalJson(owner) !== canonicalJson(match[1])) fail(`Foreign PorcuPi temporary path requires manual inspection: ${stage}`);
  }
  return cleanupCompositionIds;
}

function validateRootDirectorySchema(paths) {
  const expectedRootNames = ["compositions", "leases", "owner.json", "receipts", "runtime", "state", "tmp"];
  if (canonicalJson(readdirSync(paths.root).sort()) !== canonicalJson(expectedRootNames)) {
    fail(`Foreign PorcuPi data-root path requires manual inspection: ${paths.root}`);
  }
}

function validateCompositionDirectorySchema(paths, compositionId) {
  const compositionRoot = join(paths.compositions, compositionId);
  if (canonicalJson(readdirSync(compositionRoot).sort()) !== canonicalJson(["payload", "receipt.json"])) {
    fail(`Foreign Managed Pi Composition path requires manual inspection: ${compositionRoot}`);
  }
}

function strictCompositionInventory(paths, activation, stagedIds = new Set()) {
  const compositionIds = readdirSync(paths.compositions).sort();
  const receiptIds = readdirSync(paths.receipts).map((name) => {
    if (!name.endsWith(".json") || !compositionIdPattern.test(name.slice(0, -5))) {
      fail(`Foreign Composition receipt path requires manual inspection: ${join(paths.receipts, name)}`);
    }
    return name.slice(0, -5);
  }).sort();
  const leaseIds = readdirSync(paths.leases).sort();
  for (const id of [...compositionIds, ...leaseIds]) {
    if (!compositionIdPattern.test(id)) fail(`Foreign Composition path requires manual inspection: ${id}`);
  }
  const available = new Set([...compositionIds, ...stagedIds]);
  for (const id of [activation.active.compositionId, activation.previous?.compositionId].filter(Boolean)) {
    if (!available.has(id)) fail(`Activated Managed Pi Composition is missing: ${id}`);
  }
  const topIds = new Set(compositionIds);
  for (const id of compositionIds) {
    validateCompositionDirectorySchema(paths, id);
    verifyPublishedComposition(paths, id);
  }
  for (const id of receiptIds) {
    if (!topIds.has(id) && !stagedIds.has(id)) fail(`Unbound central Composition receipt requires manual inspection: ${id}`);
  }
  for (const id of leaseIds) {
    if (!topIds.has(id) && !stagedIds.has(id)) fail(`Unbound Composition lease directory requires manual inspection: ${id}`);
  }
  for (const id of compositionIds) {
    if (!receiptIds.includes(id) || !leaseIds.includes(id)) fail(`Incomplete Managed Pi Composition ownership evidence: ${id}`);
  }
  const leases = compositionIds.flatMap((id) => inspectCompositionLeases(paths, id).map((lease) => ({ ...lease, compositionId: id })));
  return { compositionIds: [...new Set([...compositionIds, ...stagedIds])].sort(), leases };
}

function preflightInstalled(dataRoot, environment) {
  const paths = validateManagedRoot(managedLayout(dataRoot));
  validateRootDirectorySchema(paths);
  const stateNames = readdirSync(paths.state).sort();
  const requiredState = new Set(["activation.json", "launcher.json", "runtime.json"]);
  const allowedState = new Set([
    ...requiredState,
    "pi-launcher.json",
    "release-status.json",
    "selections.json",
    "source-updates.json",
    "upgrade-readiness.json",
  ]);
  if (stateNames.some((name) => !allowedState.has(name)) || [...requiredState].some((name) => !stateNames.includes(name))) {
    fail(`Foreign PorcuPi state path requires manual inspection: ${paths.state}`);
  }
  const activation = readActivation(paths);
  verifyRuntime(paths);
  verifyReleaseStatusState(paths);
  const originalLauncher = verifyLauncher(paths, environment);
  const piLauncher = verifyOptionalPiLauncher(paths, environment);
  const stagedIds = validateTemporaryState(paths, activation);
  const inventory = strictCompositionInventory(paths, activation, stagedIds);
  const resourceSummary = summarizeRetainedPiResources(dataRoot, environment);
  return { paths, activation, originalLauncher, piLauncher, inventory, resourceSummary };
}

function resourceLabel(resource) {
  const scope = resource.scope === "global" ? "global" : `project ${resource.projectRoot}`;
  const status = resource.configured ? "retained in Pi configuration" : "Pi configuration differs; left untouched";
  const artifacts = resource.artifacts.map((artifact) => `${artifact.kind} ${artifact.path}`).join(", ");
  return `${resource.locator} · ${scope} · ${artifacts} · ${status}`;
}

function confirmUninstall(preflight, input, output) {
  let page = 0;
  let cursor = 0;
  return runGuidedTerminal({
    command: "porcupi uninstall",
    input,
    output,
    createController: ({ finish }) => {
      const render = () => {
        output.write("\x1b[2J\x1b[H");
        output.write(`Uninstall PorcuPi — ${page + 1} of 3 — ${["Owned state", "Pi resources", "Review"][page]}\n\n`);
        if (page === 0) {
          output.write(`Managed root: ${preflight.paths.root}\n`);
          output.write(`Stable launcher: ${preflight.originalLauncher.path}\n`);
          output.write(`Optional pi launcher: ${preflight.piLauncher?.path ?? "not owned"}\n`);
          output.write(`Managed Pi Compositions: ${preflight.inventory.compositionIds.length}\n`);
          for (const compositionId of preflight.inventory.compositionIds) output.write(`  ${compositionId}\n`);
          output.write(`Patch Selection Intent entries: ${preflight.resourceSummary.patchCount}\n`);
          output.write("Activation, receipts, leases, runtime, and proven temporary state will also be removed.\n\n");
          output.write("[Enter/→] Continue  [Esc] cancel\n");
        } else if (page === 1) {
          output.write(`Pi-owned resource groups that will remain: ${preflight.resourceSummary.resources.length}\n`);
          if (preflight.resourceSummary.resources.length === 0) output.write("  (none recorded)\n");
          const visible = windowAround(output, cursor, preflight.resourceSummary.resources.length, 12);
          for (let index = visible.start; index < visible.end; index += 1) {
            output.write(`${truncateForTerminal(output, `${index === cursor ? "›" : " "} ${resourceLabel(preflight.resourceSummary.resources[index])}`)}\n`);
          }
          output.write("\nPi settings, packages, credentials, sessions, project trust/resources, and Stock Pi are untouched.\n\n");
          output.write("[↑/↓ j/k] inspect  [Enter/→] Continue  [←] back  [Esc] cancel\n");
        } else {
          output.write("Remove only the validated PorcuPi-owned state shown above?\n");
          output.write("Pi-owned resources and every shared or Stock Pi asset remain untouched.\n\n");
          output.write("[Enter] Uninstall  [←] back  [Esc] cancel\n");
        }
      };
      const handleKeypress = (_character, key) => {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(false);
        if (key.name === "left" || key.name === "h") page = Math.max(0, page - 1);
        else if (page === 0 && (key.name === "right" || key.name === "return" || key.name === "l")) page = 1;
        else if (page === 1 && (key.name === "up" || key.name === "k")) cursor = Math.max(0, cursor - 1);
        else if (page === 1 && (key.name === "down" || key.name === "j")) {
          cursor = Math.min(Math.max(0, preflight.resourceSummary.resources.length - 1), cursor + 1);
        } else if (page === 1 && (key.name === "right" || key.name === "return" || key.name === "l")) page = 2;
        else if (page === 2 && key.name === "return") return finish(true);
        render();
      };
      return { render, handleKeypress };
    },
  });
}

function prepareTombstone(preflight, dataRoot, environment) {
  const tombstone = tombstonePath(dataRoot);
  if (pathExists(tombstone)) fail(`Foreign PorcuPi uninstall tombstone requires manual inspection: ${tombstone}`);
  const parent = dirname(tombstone);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = join(parent, `${preparationPrefix(dataRoot)}${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  writeFileSync(join(stage, "preparation-owner.json"), `${JSON.stringify({
    schemaVersion: 1, type: "porcupi-uninstall-preparation", dataRoot: resolve(dataRoot), stage,
  }, null, 2)}\n`, { mode: 0o600 });
  try {
    cpSync(preflight.paths.runtime, join(stage, "runtime"), { recursive: true, errorOnExist: true });
    const runtimeInventory = createPayloadInventory(join(stage, "runtime"));
    const launcher = join(defaultBinDirectory(environment), "porcupi");
    const expectedRecovery = shellLauncherContents(join(tombstone, "runtime", "cli.mjs"));
    const owner = {
      schemaVersion: 1,
      type: "porcupi-uninstall-tombstone",
      dataRoot: resolve(dataRoot),
      originalLauncher: preflight.originalLauncher,
      piLauncher: preflight.piLauncher,
      recoveryLauncher: expectedLauncherReceipt(launcher, "porcupi-uninstall-launcher", expectedRecovery),
      runtimeInventorySha256: sha256Bytes(canonicalJson(runtimeInventory)),
      stateInventorySha256: sha256Bytes(canonicalJson(createPayloadInventory(preflight.paths.state))),
      temporaryInventorySha256: sha256Bytes(canonicalJson(createPayloadInventory(preflight.paths.temporary))),
      compositionIds: preflight.inventory.compositionIds,
      resourceSummary: preflight.resourceSummary,
    };
    writeFileSync(join(stage, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(stage, "progress.json"), `${JSON.stringify({
      schemaVersion: 1, type: "porcupi-uninstall-progress", phase: "prepared",
    }, null, 2)}\n`, { mode: 0o600 });
    renameSync(stage, tombstone);
    fsyncDirectory(parent);
    durableUnlink(join(tombstone, "preparation-owner.json"));
    return validateTombstone(dataRoot, environment);
  } catch (error) {
    if (pathExists(stage)) removePreparedTree(stage);
    throw error;
  }
}

function writeProgress(recovery, phase) {
  if (!progressPhases.has(phase)) fail(`Invalid PorcuPi uninstall progress: ${phase}`);
  atomicWrite(join(recovery.tombstone, "progress.json"), {
    schemaVersion: 1,
    type: "porcupi-uninstall-progress",
    phase,
  });
  recovery.progress = { schemaVersion: 1, type: "porcupi-uninstall-progress", phase };
}

function currentLauncherKind(recovery) {
  if (!pathExists(recovery.launcher)) return "missing";
  try {
    verifyLauncherReceipt(recovery.owner.recoveryLauncher, recovery.expectedRecovery, "PorcuPi uninstall recovery launcher");
    return "recovery";
  } catch {
    verifyLauncherReceipt(
      recovery.owner.originalLauncher,
      shellLauncherContents(join(recovery.owner.dataRoot, "runtime", "cli.mjs")),
      "PorcuPi launcher",
    );
    return "original";
  }
}

function removeOwnedPiAlias(recovery) {
  if (recovery.owner.piLauncher === null) return;
  if (!pathExists(recovery.piLauncher)) return;
  verifyLauncherReceipt(
    recovery.owner.piLauncher,
    shellPiLauncherContents(recovery.launcher),
    "PorcuPi-owned pi launcher",
  );
  durableUnlink(recovery.piLauncher);
}

function publishRecoveryLauncher(recovery) {
  const kind = currentLauncherKind(recovery);
  if (kind === "recovery") {
    if (recovery.progress.phase === "prepared") writeProgress(recovery, "recovery-launcher-published");
    return;
  }
  if (kind !== "original") fail(`PorcuPi launcher is missing during uninstall recovery: ${recovery.launcher}`);
  if (recovery.progress.phase !== "prepared") fail(`PorcuPi uninstall launcher regressed after publication: ${recovery.launcher}`);
  if (!pathExists(recovery.owner.dataRoot)) fail(`Foreign PorcuPi launcher appeared after root removal: ${recovery.launcher}`);
  const temporary = join(dirname(recovery.launcher), `.${basename(recovery.launcher)}.uninstall-${randomUUID()}`);
  try {
    writeFileSync(temporary, recovery.expectedRecovery, { flag: "wx", mode: 0o755 });
    chmodSync(temporary, 0o755);
    const prepared = { ...createLauncherReceipt(temporary, "porcupi-uninstall-launcher"), path: recovery.launcher };
    if (canonicalJson(prepared) !== canonicalJson(recovery.owner.recoveryLauncher)) fail("Prepared PorcuPi uninstall launcher is malformed");
    verifyLauncherReceipt(
      recovery.owner.originalLauncher,
      shellLauncherContents(join(recovery.owner.dataRoot, "runtime", "cli.mjs")),
      "PorcuPi launcher",
    );
    renameSync(temporary, recovery.launcher);
    fsyncDirectory(dirname(recovery.launcher));
  } finally {
    if (pathExists(temporary)) durableUnlink(temporary);
  }
  verifyLauncherReceipt(recovery.owner.recoveryLauncher, recovery.expectedRecovery, "PorcuPi uninstall recovery launcher");
  writeProgress(recovery, "recovery-launcher-published");
}

function gateCompositionLeases(recovery) {
  const gateRoot = join(recovery.tombstone, "lease-gates");
  if (!pathExists(gateRoot)) mkdirSync(gateRoot, { mode: 0o700 });
  else {
    const stat = lstatSync(gateRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Foreign PorcuPi uninstall lease gate: ${gateRoot}`);
  }
  const rootExists = pathExists(recovery.owner.dataRoot);
  const paths = managedLayout(recovery.owner.dataRoot);
  for (const compositionId of recovery.owner.compositionIds) {
    const source = join(paths.leases, compositionId);
    const gate = join(gateRoot, compositionId);
    const sourceExists = rootExists && pathExists(source);
    const gateExists = pathExists(gate);
    if (sourceExists && gateExists) fail(`Composition lease gate collision during uninstall: ${compositionId}`);
    if (sourceExists) renameSync(source, gate);
    else if (!gateExists) fail(`Composition lease ownership is missing during uninstall: ${compositionId}`);
  }
  fsyncDirectory(gateRoot);
  return recovery.owner.compositionIds.flatMap((compositionId) => (
    inspectStagedCompositionLeases(join(gateRoot, compositionId), compositionId)
      .map((lease) => ({ ...lease, compositionId }))
  ));
}

function restoreCompositionLeaseGates(recovery) {
  if (!pathExists(recovery.owner.dataRoot)) return;
  const paths = managedLayout(recovery.owner.dataRoot);
  const gateRoot = join(recovery.tombstone, "lease-gates");
  for (const compositionId of recovery.owner.compositionIds) {
    const gate = join(gateRoot, compositionId);
    const destination = join(paths.leases, compositionId);
    if (!pathExists(gate)) fail(`Composition lease gate is missing during uninstall deferral: ${compositionId}`);
    if (pathExists(destination)) fail(`Composition lease gate restore collision during uninstall: ${compositionId}`);
    renameSync(gate, destination);
  }
  removePreparedTree(gateRoot);
}

function verifyRootRemovalSnapshot(recovery) {
  if (!pathExists(recovery.owner.dataRoot)) return;
  const paths = validateManagedRoot(managedLayout(recovery.owner.dataRoot));
  validateRootDirectorySchema(paths);
  if (readdirSync(paths.leases).length !== 0) fail(`PorcuPi lease gates changed during uninstall: ${paths.leases}`);
  if (sha256Bytes(canonicalJson(createPayloadInventory(paths.runtime))) !== recovery.owner.runtimeInventorySha256) {
    fail("PorcuPi runtime changed during uninstall");
  }
  if (sha256Bytes(canonicalJson(createPayloadInventory(paths.state))) !== recovery.owner.stateInventorySha256) {
    fail("PorcuPi control state changed during uninstall");
  }
  if (sha256Bytes(canonicalJson(createPayloadInventory(paths.temporary))) !== recovery.owner.temporaryInventorySha256) {
    fail("PorcuPi temporary state changed during uninstall");
  }
  const compositionIds = readdirSync(paths.compositions).sort();
  const receiptIds = readdirSync(paths.receipts).map((name) => name.endsWith(".json") ? name.slice(0, -5) : "").sort();
  if (
    canonicalJson(compositionIds) !== canonicalJson(recovery.owner.compositionIds)
    || canonicalJson(receiptIds) !== canonicalJson(recovery.owner.compositionIds)
  ) fail("Managed Pi Composition inventory changed during uninstall");
  for (const compositionId of compositionIds) {
    validateCompositionDirectorySchema(paths, compositionId);
    verifyPublishedComposition(paths, compositionId);
  }
}

function reportRetainedResources(summary, output) {
  output.write(`Pi-owned resource groups retained: ${summary.resources.length}.\n`);
  for (const resource of summary.resources) {
    const scope = resource.scope === "global" ? "global" : `project ${resource.projectRoot}`;
    output.write(`  ${resource.locator} · ${scope} · ${resource.configured ? "retained in Pi configuration" : "Pi configuration differs; left untouched"}\n`);
    for (const artifact of resource.artifacts) output.write(`    ${artifact.kind}: ${artifact.path}\n`);
  }
  output.write("Pi settings, package directories, credentials, sessions, project trust/resources, and Stock Pi were untouched.\n");
}

function finishUninstallRecovery(recovery, output) {
  const leases = gateCompositionLeases(recovery);
  checkpoint("uninstall-leases-gated");
  if (leases.some((entry) => entry.live)) {
    restoreCompositionLeaseGates(recovery);
    if (currentLauncherKind(recovery) === "original") removePreparedTree(recovery.tombstone);
    output.write("Uninstall deferred: a Managed Pi Composition has a live process lease. No PorcuPi-owned payload or launcher was removed; retry after it exits.\n");
    return { uninstalled: false, deferred: true };
  }
  verifyRootRemovalSnapshot(recovery);
  removeOwnedPiAlias(recovery);
  checkpoint("uninstall-pi-alias-removed");
  if (!pathExists(recovery.owner.dataRoot) && currentLauncherKind(recovery) === "missing") {
    if (!new Set(["root-removed", "launcher-removed"]).has(recovery.progress.phase)) {
      fail(`PorcuPi uninstall launcher disappeared before root removal: ${recovery.launcher}`);
    }
    removePreparedTree(recovery.tombstone);
    checkpoint("uninstall-tombstone-removed");
    output.write("Completed interrupted removal of receipt-proven PorcuPi state.\n");
    reportRetainedResources(recovery.owner.resourceSummary, output);
    return { uninstalled: true, recovered: true };
  }
  publishRecoveryLauncher(recovery);
  checkpoint("uninstall-recovery-launcher-published");
  if (pathExists(recovery.owner.dataRoot)) {
    const paths = managedLayout(recovery.owner.dataRoot);
    const stat = lstatSync(paths.root);
    const owner = readJson(paths.owner, "PorcuPi root ownership");
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalJson(owner) !== canonicalJson(managedRootOwner)) {
      fail(`PorcuPi data root changed during uninstall: ${paths.root}`);
    }
    removePreparedTree(paths.root);
  }
  writeProgress(recovery, "root-removed");
  checkpoint("uninstall-root-removed");
  const launcherKind = currentLauncherKind(recovery);
  if (launcherKind !== "recovery") fail(`PorcuPi uninstall recovery launcher changed: ${recovery.launcher}`);
  durableUnlink(recovery.launcher);
  writeProgress(recovery, "launcher-removed");
  checkpoint("uninstall-launcher-removed");
  removePreparedTree(recovery.tombstone);
  checkpoint("uninstall-tombstone-removed");
  output.write("Uninstalled receipt-proven PorcuPi state.\n");
  reportRetainedResources(recovery.owner.resourceSummary, output);
  return { uninstalled: true };
}

async function uninstallLocked({ input, output, environment, dataRoot }) {
  recoverPreparationStages(dataRoot);
  if (pathExists(tombstonePath(dataRoot))) {
    const recovery = validateTombstone(dataRoot, environment);
    output.write("Recovering a previously confirmed PorcuPi uninstall.\n");
    return finishUninstallRecovery(recovery, output);
  }
  if (!pathExists(dataRoot)) {
    output.write("PorcuPi is already absent; no change was needed.\n");
    return { uninstalled: false, noOp: true };
  }

  const preflight = preflightInstalled(dataRoot, environment);
  const confirmed = await confirmUninstall(preflight, input, output);
  if (!confirmed) {
    output.write("\nUninstall cancelled; PorcuPi and Pi-owned resources are unchanged.\n");
    return { uninstalled: false, cancelled: true };
  }
  if (preflight.inventory.leases.some((entry) => entry.live)) {
    output.write("\nUninstall deferred: a Managed Pi Composition has a live process lease. No PorcuPi state was removed; retry after it exits.\n");
    return { uninstalled: false, deferred: true };
  }

  recoverCompositionCleanup(preflight.paths, preflight.activation);
  const recovered = preflightInstalled(dataRoot, environment);
  if (recovered.inventory.leases.some((entry) => entry.live)) {
    output.write("\nUninstall deferred: a Managed Pi Composition acquired a live process lease. No PorcuPi state was removed; retry after it exits.\n");
    return { uninstalled: false, deferred: true };
  }
  const recovery = prepareTombstone(recovered, dataRoot, environment);
  checkpoint("uninstall-tombstone-published");
  return finishUninstallRecovery(recovery, output);
}

export async function uninstallManagedPi({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  dataRoot = defaultDataRoot(environment),
} = {}) {
  return withLifecycleLock(dataRoot, "uninstall", () => uninstallLocked({ input, output, environment, dataRoot }));
}
