import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { canonicalJson, fail, sha256File } from "./runtime.mjs";

const regularGitModes = new Set(["100644", "100755"]);
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
  "bundleDependencies",
];
const installLifecycleScripts = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "dependencies",
];

function safePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.includes("\\")
    && !/[\x00-\x1f\x7f]/.test(value)
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function gitInventory(checkout, structuralPath) {
  const result = spawnSync("git", ["ls-files", "--stage", "-z", "--", `:(literal)${structuralPath}`], {
    cwd: checkout,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`Selected content inventory could not read tracked path ${structuralPath}`);
  return result.stdout.split("\0").filter(Boolean).map((record) => {
    const match = record.match(/^([0-9]{6}) [a-f0-9]+ [0-9]\t(.+)$/);
    if (!match || !safePath(match[2])) fail(`Selected content inventory contains an unsafe tracked path beneath ${structuralPath}`);
    return { mode: match[1], path: match[2] };
  });
}

function exactTrackedFiles(checkout, rootPath) {
  if (!safePath(rootPath)) fail(`Selected content declaration has unsafe path ${JSON.stringify(rootPath)}`);
  const absolute = join(checkout, rootPath);
  let rootStat;
  try {
    rootStat = lstatSync(absolute);
  } catch {
    fail(`Selected content path is missing: ${rootPath}`);
  }
  if (rootStat.isSymbolicLink() || (!rootStat.isFile() && !rootStat.isDirectory())) {
    fail(`Selected content path is not a regular file or directory: ${rootPath}`);
  }
  const checkoutReal = realpathSync(checkout);
  const rootReal = realpathSync(absolute);
  if (rootReal !== checkoutReal && !rootReal.startsWith(`${checkoutReal}${sep}`)) {
    fail(`Selected content path escapes its Source Repository: ${rootPath}`);
  }
  const inventory = gitInventory(checkout, rootPath);
  const records = rootStat.isFile()
    ? inventory.filter((entry) => entry.path === rootPath)
    : inventory.filter((entry) => entry.path.startsWith(`${rootPath}/`));
  if (records.length === 0) fail(`Selected content path has no tracked regular files: ${rootPath}`);
  const files = records.map(({ mode, path }) => {
    if (!regularGitModes.has(mode)) fail(`Selected content path has unsupported tracked mode ${mode}: ${path}`);
    const file = join(checkout, path);
    try {
      const stat = lstatSync(file);
      const real = realpathSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !real.startsWith(`${checkoutReal}${sep}`)) throw new Error();
    } catch {
      fail(`Selected content path is not a repository-bounded regular file: ${path}`);
    }
    return { path, mode, sha256: sha256File(file) };
  });
  return { directory: rootStat.isDirectory(), files };
}

/** Validate and inventory exact declared or conventional structural roots. */
export function inventoryStructuralContent({ checkout, roots, structuralPath, declared = false }) {
  const files = new Map();
  let coversStructuralPath = !declared;
  for (const root of roots) {
    const inventory = exactTrackedFiles(checkout, root);
    coversStructuralPath ||= inventory.directory ? structuralPath.startsWith(`${root}/`) : structuralPath === root;
    for (const file of inventory.files) files.set(file.path, file);
  }
  if (!coversStructuralPath) fail(`Selected content declaration does not cover ${structuralPath}`);
  return {
    declaration: declared ? [...roots] : null,
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function defaultContentRoots(artifact) {
  if (artifact.kind === "Skill" && basename(artifact.path) === "SKILL.md" && dirname(artifact.path) !== ".") {
    return [dirname(artifact.path)];
  }
  if (artifact.kind === "Extension" && artifact.structuralDirectory) {
    return [artifact.structuralDirectory];
  }
  return [artifact.path];
}

function selectedContent(checkout, artifact) {
  return inventoryStructuralContent({
    checkout,
    roots: artifact.content ?? defaultContentRoots(artifact),
    structuralPath: artifact.path,
    declared: artifact.content !== undefined,
  });
}

function trackedFile(checkout, path) {
  const records = gitInventory(checkout, path);
  if (records.length !== 1 || records[0].path !== path || !regularGitModes.has(records[0].mode)) {
    fail(`Bounded package input is not one tracked regular file: ${path}`);
  }
  const absolute = join(checkout, path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`Bounded package input is not one tracked regular file: ${path}`);
  return { path, mode: records[0].mode, sha256: sha256File(absolute) };
}

function applicableRootLock(checkout) {
  for (const path of ["npm-shrinkwrap.json", "package-lock.json"]) {
    try {
      lstatSync(join(checkout, path));
      return trackedFile(checkout, path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return null;
}

function boundedPackageInputs(checkout, artifact) {
  const manifestPath = artifact.packageManifest;
  if (!manifestPath) return {
    manifest: { dependencies: {}, installLifecycleScripts: {} },
    lock: null,
  };
  if (manifestPath !== "package.json") fail(`Applicable package manifest is not the Source Repository root: ${manifestPath}`);
  trackedFile(checkout, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(checkout, manifestPath), "utf8"));
  } catch {
    fail(`Applicable package manifest is malformed: ${manifestPath}`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(`Applicable package manifest is malformed: ${manifestPath}`);
  }
  const dependencies = Object.fromEntries(dependencyFields.flatMap((field) => (
    Object.hasOwn(manifest, field) ? [[field, manifest[field]]] : []
  )));
  const scripts = manifest.scripts !== null && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts)
    ? Object.fromEntries(installLifecycleScripts.flatMap((name) => (
        Object.hasOwn(manifest.scripts, name) ? [[name, manifest.scripts[name]]] : []
      )))
    : {};
  return {
    manifest: { dependencies, installLifecycleScripts: scripts },
    lock: applicableRootLock(checkout),
  };
}

function fingerprintRecord(checkout, selected, discovered) {
  const identity = selected.kind === "PatchSeries" ? selected.id : selected.path;
  if (discovered.inventoryError) fail(`Selected ${selected.kind} ${identity} has invalid structural metadata: ${discovered.inventoryError}`);
  if (selected.kind === "PatchSeries") {
    const files = discovered.members.map((member) => {
      const { files: [file] } = exactTrackedFiles(checkout, member.path);
      if (!file || file.path !== member.path || file.sha256 !== member.sha256) {
        fail(`Selected Patch Series inventory changed while reading ${identity}`);
      }
      return file;
    });
    const value = {
      kind: selected.kind,
      identity,
      compatibility: discovered.compatibility ?? null,
      members: files,
    };
    return {
      value,
      fingerprint: canonicalJson(value),
      summary: `${files.length} ordered Patch File${files.length === 1 ? "" : "s"}`,
    };
  }
  const content = selectedContent(checkout, discovered);
  const value = {
    kind: selected.kind,
    identity,
    compatibility: discovered.compatibility ?? null,
    content,
    packageInputs: boundedPackageInputs(checkout, discovered),
  };
  return {
    value,
    fingerprint: canonicalJson(value),
    summary: `${content.files.length} tracked regular file${content.files.length === 1 ? "" : "s"}`,
  };
}

/**
 * Build the bounded structural identity for already-selected Artifacts at one
 * exact Source Repository checkout. Discovery remains authoritative for
 * whether each stable identity exists and is compatible.
 */
export function fingerprintSelectedArtifacts({ checkout, selectedArtifacts, discoveredArtifacts }) {
  const discoveredByIdentity = new Map(discoveredArtifacts.map((artifact) => [
    `${artifact.kind}\0${artifact.kind === "PatchSeries" ? artifact.id : artifact.path}`,
    artifact,
  ]));
  const artifacts = selectedArtifacts.map((selected) => {
    const key = `${selected.kind}\0${selected.kind === "PatchSeries" ? selected.id : selected.path}`;
    const discovered = discoveredByIdentity.get(key);
    if (!discovered) fail(`Selected ${selected.kind === "PatchSeries" ? "Patch Series" : selected.kind} is no longer structurally discoverable: ${selected.kind === "PatchSeries" ? selected.id : selected.path}`);
    const record = fingerprintRecord(checkout, selected, discovered);
    return { key, discovered, ...record };
  });
  const sourceFingerprint = canonicalJson(artifacts.map(({ value }) => value));
  return {
    fingerprint: createHash("sha256").update(sourceFingerprint).digest("hex"),
    artifacts,
  };
}
