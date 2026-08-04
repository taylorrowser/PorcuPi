import { spawn } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { atomicWrite, canonicalJson, fail, managedLayout, sha256File } from "./runtime.mjs";
import {
  discoverPiArtifacts,
  isFullGitCommit,
  parseRequestedGitSource,
  resolveSourceRepository,
} from "./source-repository.mjs";

const installationScopes = new Set(["global", "project"]);
const selectionRootFields = new Set(["schemaVersion", "sources"]);
const selectionSourceFields = new Set(["locator", "commit", "packageSource", "artifacts"]);
const legacyPatchFields = new Set(["kind", "path", "sha256"]);
const patchSeriesFields = new Set(["kind", "id", "members"]);
const patchMemberFields = new Set(["commit", "path", "sha256"]);
const globalResourceFields = new Set(["kind", "path", "scope"]);
const projectResourceFields = new Set(["kind", "path", "scope", "projectRoot"]);
const resourceKeys = {
  Extension: "extensions",
  Skill: "skills",
  Prompt: "prompts",
  Theme: "themes",
};

function lexicalCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function isPatchSeries(artifact) {
  return artifact?.kind === "PatchSeries";
}

export function artifactKey(artifact) {
  return `${artifact.kind}\0${isPatchSeries(artifact) ? artifact.id : artifact.path}`;
}

export function artifactStructuralIdentity(artifact) {
  return isPatchSeries(artifact) ? artifact.id : artifact.path;
}

function expandedPatchIdentity(patch) {
  return Object.hasOwn(patch, "seriesId") ? patch : { ...patch, seriesId: patch.path };
}

export function expandedPatchSnapshot(patches) {
  return (patches ?? []).map(expandedPatchIdentity);
}

export function patchSelectionSnapshot(sources) {
  return sources.flatMap((source) => source.artifacts
    .filter(isPatchSeries)
    .flatMap((series) => series.members.map((member) => ({
      locator: source.locator,
      seriesId: series.id,
      commit: member.commit,
      path: member.path,
      sha256: member.sha256,
    }))))
    .sort((left, right) => lexicalCompare(
      `${left.locator}\0${left.seriesId}\0${left.path}`,
      `${right.locator}\0${right.seriesId}\0${right.path}`,
    ));
}

export function patchIntentPending(sources, activePatches) {
  return canonicalJson(patchSelectionSnapshot(sources)) !== canonicalJson(expandedPatchSnapshot(activePatches));
}

export function patchPendingMessage(pending) {
  return pending
    ? "Patch Selection Intent is pending `porcupi apply`; active Managed Pi Composition is unchanged.\n"
    : "Patch Selection Intent matches the active Managed Pi Composition.\n";
}

class SelectionStagingError extends Error {}

function selectionStagingFailure(prefix, message) {
  throw new SelectionStagingError(`${prefix}${message}`);
}

function patchIdentityKey(patch) {
  return `${patch.locator}\0${patch.seriesId}\0${patch.commit}\0${patch.path}`;
}

function stageSelectedArtifacts({ stageRoot, sources, piBase, artifactsForSource, failurePrefix }) {
  const patches = patchSelectionSnapshot(sources);
  const patchIndexes = new Map(patches.map((patch, index) => [patchIdentityKey(patch), index]));
  const patchesRoot = join(stageRoot, "patches");
  mkdirSync(patchesRoot, { mode: 0o700 });
  const stagedPatches = new Map();

  for (const source of sources) {
    const selectedArtifacts = artifactsForSource(source);
    if (selectedArtifacts.length === 0) continue;
    let resolved;
    try {
      resolved = resolveSourceRepository(source.packageSource, { temporaryParent: stageRoot });
      if (resolved.locator !== source.locator || resolved.commit !== source.commit) {
        selectionStagingFailure(failurePrefix, `Source Repository changed: ${source.locator}@${source.commit}`);
      }
      const discovered = new Map(discoverPiArtifacts(resolved.checkout, { piBase }).artifacts
        .map((artifact) => [artifactKey(artifact), artifact]));
      const realCheckout = realpathSync(resolved.checkout);
      for (const artifact of selectedArtifacts) {
        const structuralIdentity = artifactStructuralIdentity(artifact);
        const identity = `${source.locator}@${source.commit}:${structuralIdentity}`;
        const candidate = discovered.get(artifactKey(artifact));
        if (!candidate) {
          selectionStagingFailure(failurePrefix, `selected ${isPatchSeries(artifact) ? "Patch Series" : artifact.kind} ${identity} is no longer discoverable at its exact source commit`);
        }
        if (!isPatchSeries(artifact)) continue;
        if (candidate.compatible === false) {
          selectionStagingFailure(failurePrefix, `selected Patch Series ${identity} does not support target Pi Base ${piBase.tag} (${piBase.commit})`);
        }
        if (candidate.members.length !== artifact.members.length) {
          selectionStagingFailure(failurePrefix, `selected Patch Series ${identity} membership changed at its exact source commit`);
        }
        for (let memberIndex = 0; memberIndex < artifact.members.length; memberIndex += 1) {
          const member = artifact.members[memberIndex];
          const candidateMember = candidate.members[memberIndex];
          const memberIdentity = `${source.locator}@${member.commit}:${member.path}`;
          if (member.commit !== source.commit || candidateMember?.path !== member.path) {
            selectionStagingFailure(failurePrefix, `selected Patch Series member ${memberIdentity} is no longer discoverable in its retained order`);
          }
          if (candidateMember.sha256 !== member.sha256) {
            selectionStagingFailure(failurePrefix, `Selected Patch digest mismatch: ${source.locator} · ${member.path}; expected sha256 ${member.sha256}, found ${candidateMember.sha256}`);
          }
          const sourcePath = join(resolved.checkout, member.path);
          const realPatch = realpathSync(sourcePath);
          if (!realPatch.startsWith(`${realCheckout}${sep}`)) {
            selectionStagingFailure(failurePrefix, `selected Patch ${memberIdentity} escapes its exact Source Repository`);
          }
          const patchIdentity = {
            locator: source.locator,
            seriesId: artifact.id,
            commit: member.commit,
            path: member.path,
          };
          const index = patchIndexes.get(patchIdentityKey(patchIdentity));
          if (index === undefined) selectionStagingFailure(failurePrefix, `selected Patch ${memberIdentity} is absent from the canonical Patch selection`);
          const stagedPath = join(patchesRoot, `${String(index).padStart(6, "0")}.patch`);
          cpSync(sourcePath, stagedPath, { errorOnExist: true });
          if (sha256File(stagedPath) !== member.sha256) {
            selectionStagingFailure(failurePrefix, `staged bytes for selected Patch ${memberIdentity} do not match sha256 ${member.sha256}`);
          }
          stagedPatches.set(patchIdentityKey(patchIdentity), {
            ...patchIdentity,
            sha256: member.sha256,
            stagedPath,
          });
        }
      }
    } catch (error) {
      if (error instanceof SelectionStagingError) throw error;
      selectionStagingFailure(failurePrefix, `Source Repository ${source.locator}@${source.commit} could not be staged: ${error.message}`);
    } finally {
      resolved?.dispose();
    }
  }

  return patches.map((patch) => stagedPatches.get(patchIdentityKey(patch))
    ?? selectionStagingFailure(failurePrefix, `selected Patch ${patch.locator}@${patch.commit}:${patch.path} has no staged bytes`));
}

export function stagePatchSelection({ stageRoot, sources, piBase }) {
  return stageSelectedArtifacts({
    stageRoot,
    sources,
    piBase,
    artifactsForSource: (source) => source.artifacts.filter(isPatchSeries),
    failurePrefix: "",
  });
}

export function stageSelectionIntent({ stageRoot, sources, piBase }) {
  return stageSelectedArtifacts({
    stageRoot,
    sources,
    piBase,
    artifactsForSource: (source) => source.artifacts,
    failurePrefix: "Upgrade Readiness Check blocked by ",
  });
}

function selectionStatePath(dataRoot) {
  return join(managedLayout(dataRoot).state, "selections.json");
}

function emptySelections() {
  return { schemaVersion: 2, sources: [] };
}

function hasOnlyKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.has(key));
}

export function readSelections(dataRoot) {
  const path = selectionStatePath(dataRoot);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return emptySelections();
    fail("Malformed PorcuPi Selection Intent");
  }
  let value;
  try {
    if (!stat.isFile() || stat.isSymbolicLink()) fail("Malformed PorcuPi Selection Intent");
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === "Malformed PorcuPi Selection Intent") throw error;
    fail("Malformed PorcuPi Selection Intent");
  }
  const legacy = value?.schemaVersion === 1;
  if (
    !hasOnlyKeys(value, selectionRootFields)
    || (!legacy && value.schemaVersion !== 2)
    || !Array.isArray(value.sources)
    || value.sources.some((source) => (
      !hasOnlyKeys(source, selectionSourceFields)
      || typeof source.locator !== "string"
      || !isFullGitCommit(source.commit)
      || typeof source.packageSource !== "string"
      || !Array.isArray(source.artifacts)
      || source.artifacts.length === 0
      || source.artifacts.some((artifact) => {
        const invalidPath = !isPatchSeries(artifact) && (
          typeof artifact?.path !== "string"
          || artifact.path.startsWith("/")
          || artifact.path.includes("\\")
          || /[\x00-\x1f\x7f]/.test(artifact.path)
          || artifact.path.split("/").some((part) => part === "" || part === "." || part === "..")
        );
        if (invalidPath) return true;
        if (legacy && artifact.kind === "Patch") {
          return !hasOnlyKeys(artifact, legacyPatchFields)
            || !artifact.path.startsWith("patches/")
            || !artifact.path.endsWith(".patch")
            || !/^[a-f0-9]{64}$/.test(artifact.sha256 || "")
            || artifact.scope !== undefined
            || artifact.projectRoot !== undefined;
        }
        if (!legacy && isPatchSeries(artifact)) {
          return !hasOnlyKeys(artifact, patchSeriesFields)
            || typeof artifact.id !== "string"
            || !artifact.id.startsWith("patches/")
            || !artifact.id.endsWith(".patch")
            || artifact.id.includes("\\")
            || /[\x00-\x1f\x7f]/.test(artifact.id)
            || artifact.id.split("/").some((part) => part === "" || part === "." || part === "..")
            || !Array.isArray(artifact.members)
            || artifact.members.length !== 1
            || artifact.members.some((member) => (
              !hasOnlyKeys(member, patchMemberFields)
              || member.commit !== source.commit
              || typeof member.path !== "string"
              || member.path !== artifact.id
              || !member.path.startsWith("patches/")
              || !member.path.endsWith(".patch")
              || !/^[a-f0-9]{64}$/.test(member.sha256 || "")
            ));
        }
        const resourceFields = artifact.scope === "project" ? projectResourceFields : globalResourceFields;
        return !hasOnlyKeys(artifact, resourceFields)
          || !Object.hasOwn(resourceKeys, artifact.kind)
          || !installationScopes.has(artifact.scope)
          || (artifact.scope === "global" && artifact.projectRoot !== undefined)
          || (artifact.scope === "project" && (
            typeof artifact.projectRoot !== "string"
            || !isAbsolute(artifact.projectRoot)
            || resolve(artifact.projectRoot) !== artifact.projectRoot
            || /[\x00-\x1f\x7f]/.test(artifact.projectRoot)
          ));
      })
    ))
  ) {
    fail("Malformed PorcuPi Selection Intent");
  }
  const locators = new Set();
  for (const source of value.sources) {
    let packageSource;
    try {
      packageSource = parseRequestedGitSource(source.packageSource);
    } catch {
      fail("Malformed PorcuPi Selection Intent");
    }
    const artifactKeys = source.artifacts.map(artifactKey);
    if (
      locators.has(source.locator)
      || packageSource.locator !== source.locator
      || packageSource.ref !== source.commit
      || new Set(artifactKeys).size !== artifactKeys.length
    ) {
      fail("Malformed PorcuPi Selection Intent");
    }
    locators.add(source.locator);
  }
  if (!legacy) return value;
  return {
    schemaVersion: 2,
    sources: value.sources.map((source) => ({
      ...source,
      artifacts: source.artifacts.map((artifact) => artifact.kind === "Patch" ? {
        kind: "PatchSeries",
        id: artifact.path,
        members: [{ commit: source.commit, path: artifact.path, sha256: artifact.sha256 }],
      } : artifact),
    })),
  };
}

function packageEntry(packageSource, artifacts, scope, projectDelta = false) {
  const entry = { source: packageSource, ...(scope === "project" && projectDelta ? { autoload: false } : {}) };
  for (const [kind, key] of Object.entries(resourceKeys)) {
    entry[key] = artifacts
      .filter((artifact) => artifact.kind === kind)
      .map((artifact) => artifact.path)
      .sort();
  }
  return entry;
}

function packageIdentity(value) {
  const source = typeof value === "string" ? value : value?.source;
  if (typeof source !== "string") return undefined;
  try {
    return parseRequestedGitSource(source).locator;
  } catch {
    return undefined;
  }
}

function agentDirectory(environment) {
  const home = environment.HOME || homedir();
  if (!home) fail("HOME is required to select Pi's global package settings");
  return environment.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
}

function contextKey(context) {
  return context.scope === "global" ? "global" : `project\0${context.projectRoot}`;
}

function artifactContext(artifact) {
  return artifact.scope === "project"
    ? { scope: "project", projectRoot: artifact.projectRoot }
    : { scope: "global" };
}

function groupByContext(artifacts) {
  const groups = new Map();
  for (const artifact of artifacts) {
    const context = artifactContext(artifact);
    const key = contextKey(context);
    if (!groups.has(key)) groups.set(key, { context, artifacts: [] });
    groups.get(key).artifacts.push(artifact);
  }
  return groups;
}

function settingsPathForContext(environment, context) {
  return context.scope === "global"
    ? join(agentDirectory(environment), "settings.json")
    : join(context.projectRoot, ".pi", "settings.json");
}

function contextLabel(context) {
  return context.scope === "global" ? "global" : `project (${context.projectRoot})`;
}

function readPiSettings(environment, context, { allowMissing = true } = {}) {
  const path = settingsPathForContext(environment, context);
  const label = contextLabel(context);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") fail(`Pi ${label} package settings are malformed`);
    if (allowMissing) return { context, path, settings: {}, packages: [], existed: false };
    fail(`Pi package installation did not create ${label} package settings`);
  }
  try {
    const contents = readFileSync(path, "utf8");
    const settings = JSON.parse(contents);
    if (!stat.isFile() || stat.isSymbolicLink() || settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      fail(`Pi ${label} package settings are malformed`);
    }
    const packages = settings.packages ?? [];
    if (!Array.isArray(packages)) fail(`Pi ${label} package settings are malformed`);
    return { context, path, settings, packages, contents, existed: true };
  } catch (error) {
    if (error instanceof Error && error.message === `Pi ${label} package settings are malformed`) throw error;
    fail(`Pi ${label} package settings are malformed`);
  }
}

function matchingPackageIndexes(packages, locator) {
  return packages.flatMap((value, index) => packageIdentity(value) === locator ? [index] : []);
}

function packageArgs(command, packageSource, context) {
  return [command, packageSource, ...(context.scope === "project" ? ["-l"] : [])];
}

async function runManagedPi(executable, args, environment, context = { scope: "global" }) {
  const cwd = context.scope === "project" ? context.projectRoot : agentDirectory(environment);
  const child = spawn(process.execPath, [executable, ...args], { cwd, stdio: "inherit", env: environment });
  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.signal) fail(`Pi package lifecycle was interrupted by ${result.signal}`);
  if (result.code !== 0) fail(`Pi package lifecycle failed with status ${String(result.code)}`);
}

function preparePackageTransaction(environment, changes) {
  const contexts = new Map();
  for (const change of changes) {
    const previousGroups = groupByContext(change.previous?.artifacts ?? []);
    const nextGroups = groupByContext(change.nextArtifacts);
    const keys = [...new Set([...previousGroups.keys(), ...nextGroups.keys()])].sort();
    const previousHasGlobal = previousGroups.has("global");
    const nextHasGlobal = nextGroups.has("global");
    for (const key of keys) {
      const previousGroup = previousGroups.get(key);
      const nextGroup = nextGroups.get(key);
      const context = previousGroup?.context ?? nextGroup.context;
      if (!contexts.has(key)) contexts.set(key, { context, snapshot: readPiSettings(environment, context), operations: [] });
      const record = contexts.get(key);
      const matches = matchingPackageIndexes(record.snapshot.packages, change.source.locator);
      if (matches.length > 1) fail(`Pi has ambiguous ${contextLabel(context)} package configuration for ${change.source.locator}`);
      if (!previousGroup && matches.length > 0) {
        fail(`Pi already has a ${contextLabel(context)} package for ${change.source.locator} that PorcuPi does not own`);
      }
      if (previousGroup) {
        if (matches.length !== 1) fail(`PorcuPi's prior ${contextLabel(context)} Pi package entry for ${change.source.locator} is missing`);
        const expected = packageEntry(change.previous.packageSource, previousGroup.artifacts, context.scope, previousHasGlobal);
        if (canonicalJson(record.snapshot.packages[matches[0]]) !== canonicalJson(expected)) {
          fail(`PorcuPi's prior ${contextLabel(context)} Pi package entry for ${change.source.locator} was changed outside PorcuPi`);
        }
      }
      record.operations.push({
        change,
        previousArtifacts: previousGroup?.artifacts ?? [],
        nextArtifacts: nextGroup?.artifacts ?? [],
        nextProjectDelta: context.scope === "project" && nextHasGlobal,
      });
    }
  }
  return [...contexts.values()].sort((left, right) => contextKey(left.context).localeCompare(contextKey(right.context)));
}

function stagePackageContexts(contexts) {
  for (const record of contexts) {
    const packages = [...record.snapshot.packages];
    let changed = false;
    for (const operation of record.operations.filter((candidate) => candidate.nextArtifacts.length > 0)) {
      const matches = matchingPackageIndexes(packages, operation.change.source.locator);
      const entry = packageEntry(
        operation.change.source.packageSource,
        operation.nextArtifacts,
        record.context.scope,
        operation.nextProjectDelta,
      );
      if (matches.length === 0) packages.push(entry);
      else packages[matches[0]] = entry;
      changed = true;
    }
    if (changed) atomicWrite(record.snapshot.path, { ...record.snapshot.settings, packages });
  }
}

function verifyPackageTransaction(environment, contexts) {
  for (const record of contexts) {
    const current = readPiSettings(environment, record.context);
    for (const operation of record.operations) {
      const matches = matchingPackageIndexes(current.packages, operation.change.source.locator);
      if (operation.nextArtifacts.length === 0) {
        if (matches.length !== 0) fail(`Pi did not remove the reviewed ${contextLabel(record.context)} package for ${operation.change.source.locator}`);
        continue;
      }
      const expected = packageEntry(
        operation.change.source.packageSource,
        operation.nextArtifacts,
        record.context.scope,
        operation.nextProjectDelta,
      );
      if (matches.length !== 1 || canonicalJson(current.packages[matches[0]]) !== canonicalJson(expected)) {
        fail(`Pi did not retain the reviewed ${contextLabel(record.context)} package filters for ${operation.change.source.locator}`);
      }
    }
  }
}

function restorePiSettings(snapshot) {
  if (snapshot.existed) atomicWrite(snapshot.path, snapshot.contents);
  else rmSync(snapshot.path, { force: true });
}

async function recoverPackageTransaction({ contexts, executable, environment, reconcile }) {
  for (const record of contexts) {
    for (const operation of record.operations.filter((candidate) => candidate.previousArtifacts.length === 0 && candidate.nextArtifacts.length > 0)) {
      try {
        await runManagedPi(
          executable,
          packageArgs("remove", operation.change.source.packageSource, record.context),
          environment,
          record.context,
        );
      } catch {
        // A denied/failed new-scope install may leave no checkout for Pi to remove.
      }
    }
  }
  for (const record of contexts) restorePiSettings(record.snapshot);
  for (const record of contexts) {
    for (const operation of record.operations.filter((candidate) => reconcile.has(candidate))) {
      try {
        await runManagedPi(
          executable,
          packageArgs("install", operation.change.previous.packageSource, record.context),
          environment,
          record.context,
        );
      } catch {
        fail(`Pi package update failed and the prior ${contextLabel(record.context)} checkout for ${operation.change.source.locator} could not be restored`);
      }
    }
  }
}

export async function realizeResourceChanges({ executable, environment, changes, save }) {
  const contexts = preparePackageTransaction(environment, changes);
  const reconcile = new Set();
  stagePackageContexts(contexts);
  try {
    for (const record of contexts) {
      for (const operation of record.operations.filter((candidate) => candidate.nextArtifacts.length > 0)) {
        if (operation.previousArtifacts.length > 0) reconcile.add(operation);
        await runManagedPi(
          executable,
          packageArgs("install", operation.change.source.packageSource, record.context),
          environment,
          record.context,
        );
      }
    }
    for (const record of contexts) {
      for (const operation of record.operations.filter((candidate) => candidate.previousArtifacts.length > 0 && candidate.nextArtifacts.length === 0)) {
        await runManagedPi(
          executable,
          packageArgs("remove", operation.change.previous.packageSource, record.context),
          environment,
          record.context,
        );
        reconcile.add(operation);
      }
    }
    verifyPackageTransaction(environment, contexts);
    save();
  } catch (error) {
    await recoverPackageTransaction({ contexts, executable, environment, reconcile });
    throw error;
  }
}

export function summarizeRetainedPiResources(dataRoot, environment = process.env) {
  const selections = readSelections(dataRoot);
  const summaries = [];
  for (const source of selections.sources) {
    const resources = source.artifacts.filter((artifact) => !isPatchSeries(artifact));
    const groups = groupByContext(resources);
    const hasGlobal = groups.has("global");
    for (const { context, artifacts } of groups.values()) {
      const snapshot = readPiSettings(environment, context);
      const expected = packageEntry(source.packageSource, artifacts, context.scope, context.scope === "project" && hasGlobal);
      const matches = matchingPackageIndexes(snapshot.packages, source.locator);
      summaries.push({
        locator: source.locator,
        scope: context.scope,
        projectRoot: context.scope === "project" ? context.projectRoot : null,
        artifacts: artifacts.map((artifact) => ({ kind: artifact.kind, path: artifact.path }))
          .sort((left, right) => lexicalCompare(artifactKey(left), artifactKey(right))),
        configured: matches.length === 1 && canonicalJson(snapshot.packages[matches[0]]) === canonicalJson(expected),
      });
    }
  }
  return {
    resources: summaries.sort((left, right) => lexicalCompare(
      `${left.locator}\0${left.scope}\0${left.projectRoot || ""}`,
      `${right.locator}\0${right.scope}\0${right.projectRoot || ""}`,
    )),
    patchCount: selections.sources.reduce(
      (count, source) => count + source.artifacts.filter(isPatchSeries).length,
      0,
    ),
  };
}

export function saveSelectionSources(dataRoot, sources) {
  const ordered = [...sources].sort((left, right) => lexicalCompare(left.locator, right.locator));
  atomicWrite(selectionStatePath(dataRoot), { schemaVersion: 2, sources: ordered });
}

export function resolveProjectContext(cwd) {
  try {
    const root = realpathSync(cwd ?? process.cwd());
    if (!lstatSync(root).isDirectory() || /[\x00-\x1f\x7f]/.test(root)) throw new Error("unsafe project directory");
    return { available: true, root };
  } catch {
    return { available: false, reason: "the current working directory is unavailable" };
  }
}
