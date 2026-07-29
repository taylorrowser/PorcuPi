import { spawnSync } from "node:child_process";
import { globSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fail, sha256File } from "./runtime.mjs";

const artifactKinds = ["Extension", "Prompt", "Skill", "Theme"];
const regularGitModes = new Set(["100644", "100755"]);
const fullCommitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
export function isFullGitCommit(value) {
  return typeof value === "string" && fullCommitPattern.test(value);
}

const themeColors = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText",
  "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading",
  "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr",
  "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];

function normalizeRepositoryPath(value) {
  let path = value.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  if (
    !path
    || path.split("/").length < 2
    || path.includes("\\")
    || /[\x00-\x1f\x7f]/.test(path)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("Git source has an unsafe or missing repository path");
  }
  return path;
}

function splitPathRef(value) {
  const index = value.indexOf("@");
  if (index < 0) return { path: value };
  const path = value.slice(0, index);
  const ref = value.slice(index + 1);
  if (!path || !ref) fail("Git source has an empty repository path or ref");
  return { path, ref };
}

export function parseRequestedGitSource(requested) {
  const trimmed = requested.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed) || trimmed.startsWith("-")) fail("A valid Git source is required");
  const hasGitPrefix = trimmed.startsWith("git:") && !trimmed.startsWith("git://");
  const value = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

  const scp = hasGitPrefix ? value.match(/^(git)@([^:]+):(.+)$/) : null;
  if (scp) {
    const { path: rawPath, ref } = splitPathRef(scp[3]);
    const path = normalizeRepositoryPath(rawPath);
    const host = scp[2];
    if (!host || /[\\/\x00-\x1f\x7f]/.test(host)) fail("Git source has an unsafe host");
    return {
      cloneRepository: `${scp[1]}@${host}:${rawPath.replace(/\/+$/, "")}`,
      packageRepository: `${scp[1]}@${host}:${rawPath.replace(/\/+$/, "")}`,
      locator: `${host.toLowerCase()}/${path}`,
      ref,
    };
  }

  if (/^(https?|ssh|git):\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      fail("Git source URL is malformed");
    }
    const { path: rawPath, ref } = splitPathRef(parsed.pathname);
    const path = normalizeRepositoryPath(rawPath);
    const host = parsed.host.toLowerCase();
    if (!host) fail("Git source URL has no host");
    parsed.pathname = `/${rawPath.replace(/^\/+/, "").replace(/\/+$/, "")}`;
    parsed.hash = "";
    parsed.search = "";
    const cloneRepository = parsed.toString().replace(/\/$/, "");
    parsed.username = "";
    parsed.password = "";
    parsed.pathname = `/${rawPath.replace(/^\/+/, "").replace(/\/+$/, "")}`;
    const packageRepository = parsed.toString().replace(/\/$/, "");
    return { cloneRepository, packageRepository, locator: `${host}/${path}`, ref };
  }

  if (!hasGitPrefix) fail("Git sources without a git: prefix must use an explicit Git protocol URL");
  const slash = value.indexOf("/");
  if (slash < 1) fail("Git source shorthand must include host and repository path");
  const host = value.slice(0, slash);
  const { path: rawPath, ref } = splitPathRef(value.slice(slash + 1));
  const path = normalizeRepositoryPath(rawPath);
  if (!host.includes(".") && host !== "localhost") fail("Git source shorthand has an invalid host");
  return {
    cloneRepository: `https://${host}/${rawPath.replace(/\/+$/, "")}`,
    packageRepository: `https://${host}/${rawPath.replace(/\/+$/, "")}`,
    locator: `${host.toLowerCase()}/${path}`,
    ref,
  };
}

function git(args, { cwd } = {}) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail("Git could not resolve the requested Source Repository");
  }
  return result.stdout.trim();
}

function refExists(checkout, ref) {
  return spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: checkout }).status === 0;
}

function peelCommit(checkout, ref) {
  const commit = git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: checkout });
  if (!isFullGitCommit(commit)) fail("Git ref did not resolve to one full commit");
  return commit;
}

function resolveRequestedCommit(checkout, requestedRef) {
  if (!requestedRef) return peelCommit(checkout, "refs/remotes/origin/HEAD");
  if (isFullGitCommit(requestedRef)) return peelCommit(checkout, requestedRef);

  let candidates;
  if (requestedRef === "HEAD") candidates = ["refs/remotes/origin/HEAD"];
  else if (requestedRef.startsWith("refs/heads/")) candidates = [`refs/remotes/origin/${requestedRef.slice(11)}`];
  else if (requestedRef.startsWith("refs/tags/")) candidates = [requestedRef];
  else if (requestedRef.startsWith("refs/remotes/origin/")) candidates = [requestedRef];
  else if (requestedRef.startsWith("origin/")) candidates = [`refs/remotes/${requestedRef}`];
  else candidates = [`refs/remotes/origin/${requestedRef}`, `refs/tags/${requestedRef}`];

  const matches = candidates.filter((candidate) => refExists(checkout, candidate));
  if (matches.length === 0 && /^[a-fA-F0-9]{4,63}$/.test(requestedRef)) {
    fail("Abbreviated commit IDs are ambiguous; provide the full commit");
  }
  if (matches.length === 0) fail(`Git ref '${requestedRef}' does not exist`);
  if (matches.length > 1) fail(`Git ref '${requestedRef}' is ambiguous between a branch and tag`);
  return peelCommit(checkout, matches[0]);
}

export function resolveSourceRepository(requested, { temporaryParent = tmpdir() } = {}) {
  const parsed = parseRequestedGitSource(requested);
  const temporaryRoot = mkdtempSync(join(temporaryParent, "porcupi-source-"));
  const checkout = join(temporaryRoot, "checkout");
  try {
    process.stdout.write(`Resolving Source Repository ${parsed.locator}...\n`);
    git(["clone", "--quiet", "--filter=blob:none", "--no-checkout", "--", parsed.cloneRepository, checkout]);
    const commit = resolveRequestedCommit(checkout, parsed.ref);
    git(["checkout", "--quiet", "--detach", commit], { cwd: checkout });
    if (git(["rev-parse", "HEAD"], { cwd: checkout }) !== commit) fail("Git checkout does not match resolved commit");
    if (git(["status", "--porcelain", "--untracked-files=no"], { cwd: checkout })) {
      fail("Resolved Source Repository checkout is not clean");
    }
    return {
      locator: parsed.locator,
      commit,
      checkout,
      packageSource: `git:${parsed.packageRepository}@${commit}`,
      dispose() {
        rmSync(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function relativePath(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || /[\x00-\x1f\x7f]/.test(value)) {
    fail("Resource path escapes the Source Repository or contains terminal control characters");
  }
  return value;
}

function regularFile(root, path, diagnostics, kind) {
  const structuralPath = relativePath(root, path);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      diagnostics.push({ path: structuralPath, reason: `${kind} candidate is not a regular file` });
      return false;
    }
    return true;
  } catch {
    diagnostics.push({ path: structuralPath, reason: `${kind} candidate cannot be read` });
    return false;
  }
}

function ignorePatternMatches(path, pattern) {
  const directoryPattern = pattern.endsWith("/");
  const normalized = pattern.replace(/^\//, "").replace(/\/$/, "");
  if (!normalized) return false;
  if (!normalized.includes("/")) {
    const segments = path.split("/");
    return segments.some((segment, index) => globPatternMatches(segment, normalized) && (!directoryPattern || index < segments.length - 1));
  }
  return globPatternMatches(path, normalized) || (directoryPattern && path.startsWith(`${normalized}/`));
}

function ignoredByRepositoryRules(root, path) {
  const structuralPath = relativePath(root, path);
  let directory;
  try {
    directory = lstatSync(path).isDirectory() ? path : resolve(path, "..");
  } catch {
    directory = resolve(path, "..");
  }
  const relativeDirectory = relative(root, directory).split(sep).join("/");
  const ancestors = relativeDirectory && relativeDirectory !== "." ? relativeDirectory.split("/") : [];
  let ignored = false;
  for (let depth = 0; depth <= ancestors.length; depth += 1) {
    const base = ancestors.slice(0, depth).join("/");
    for (const name of [".gitignore", ".ignore", ".fdignore"]) {
      try {
        const lines = readFileSync(join(root, base, name), "utf8").split(/\r?\n/);
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || (line.startsWith("#") && !line.startsWith("\\#"))) continue;
          const negated = line.startsWith("!") && !line.startsWith("\\!");
          const rule = (negated ? line.slice(1) : line).replace(/^\\([#!])/, "$1");
          const candidate = base ? structuralPath.slice(base.length + 1) : structuralPath;
          if (ignorePatternMatches(candidate, rule)) ignored = !negated;
        }
      } catch {
        // Missing or unreadable ignore files contribute no rules, matching Pi discovery.
      }
    }
  }
  return ignored;
}

function directoryEntries(root, path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => (
      !entry.name.startsWith(".")
      && entry.name !== "node_modules"
      && !ignoredByRepositoryRules(root, join(path, entry.name))
    ));
  } catch {
    return [];
  }
}

function collectExtensions(root, directory, diagnostics) {
  const paths = [];
  for (const entry of directoryEntries(root, directory)) {
    const path = join(directory, entry.name);
    if (entry.isFile() || entry.isSymbolicLink()) {
      if (/\.(ts|js)$/.test(entry.name) && regularFile(root, path, diagnostics, "Extension")) paths.push(path);
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      const packageValue = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      const entries = packageValue?.pi?.extensions;
      if (Array.isArray(entries) && entries.every((value) => typeof value === "string")) {
        const declared = new Set();
        for (const declaredPath of entries.filter((value) => !/^[!+-]/.test(value))) {
          const matches = /[*?]/.test(declaredPath)
            ? globSync(declaredPath, { cwd: path, dot: false }).map((match) => join(path, match))
            : [resolve(path, declaredPath)];
          for (const match of matches) {
            if (match === path || match.startsWith(`${path}${sep}`)) {
              for (const candidate of collectFromPath(root, "Extension", match, diagnostics)) declared.add(relativePath(path, candidate));
            }
          }
        }
        const enabled = applyManifestOverrides([...declared].sort(), entries);
        if (enabled.length > 0) {
          paths.push(...enabled.map((candidate) => join(path, candidate)));
          continue;
        }
      }
    } catch {
      // A missing or malformed nested manifest falls through to Pi's index convention.
    }
    const index = [join(path, "index.ts"), join(path, "index.js")].find((candidate) => {
      try {
        return lstatSync(candidate).isFile() && !lstatSync(candidate).isSymbolicLink();
      } catch {
        return false;
      }
    });
    if (index) paths.push(index);
  }
  return paths;
}

function collectSkills(root, directory, diagnostics, includeRootMarkdown = true) {
  const entries = directoryEntries(root, directory);
  const skillFile = entries.find((entry) => entry.name === "SKILL.md");
  if (skillFile) {
    const path = join(directory, skillFile.name);
    return regularFile(root, path, diagnostics, "Skill") ? [path] : [];
  }
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...collectSkills(root, path, diagnostics, false));
    else if (includeRootMarkdown && entry.name.endsWith(".md") && regularFile(root, path, diagnostics, "Skill")) paths.push(path);
  }
  return paths;
}

function collectRecursiveFiles(root, directory, suffix, diagnostics, kind) {
  const paths = [];
  for (const entry of directoryEntries(root, directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...collectRecursiveFiles(root, path, suffix, diagnostics, kind));
    else if (entry.name.endsWith(suffix) && regularFile(root, path, diagnostics, kind)) paths.push(path);
  }
  return paths;
}

function descriptionPresent(contents) {
  if (!contents.startsWith("---")) return false;
  const end = contents.indexOf("\n---", 3);
  if (end < 0) return false;
  const frontmatter = contents.slice(3, end);
  const match = frontmatter.match(/^description:\s*(.*)$/m);
  if (!match) return false;
  const value = match[1].trim();
  return Boolean(value && value !== "''" && value !== '""');
}

function validTheme(contents) {
  try {
    const value = JSON.parse(contents);
    const variables = value?.vars ?? {};
    const validLiteral = (color) => (
      Number.isInteger(color) && color >= 0 && color <= 255
    ) || (
      typeof color === "string"
      && (color === "" || /^#[a-fA-F0-9]{6}$/.test(color) || Object.hasOwn(variables, color))
    );
    return value !== null
      && typeof value === "object"
      && typeof value.name === "string"
      && value.name.length > 0
      && !value.name.includes("/")
      && variables !== null
      && typeof variables === "object"
      && !Array.isArray(variables)
      && Object.values(variables).every((color) => (Number.isInteger(color) && color >= 0 && color <= 255) || (typeof color === "string" && /^#[a-fA-F0-9]{6}$/.test(color)))
      && value.colors !== null
      && typeof value.colors === "object"
      && !Array.isArray(value.colors)
      && themeColors.every((name) => Object.hasOwn(value.colors, name) && validLiteral(value.colors[name]))
      && (!Object.hasOwn(value.colors, "thinkingMax") || validLiteral(value.colors.thinkingMax));
  } catch {
    return false;
  }
}

function validateArtifact(root, kind, path, diagnostics) {
  const structuralPath = relativePath(root, path);
  const contents = readFileSync(path, "utf8");
  if (kind === "Skill" && !descriptionPresent(contents)) {
    diagnostics.push({ path: structuralPath, reason: "Skill has no loadable description" });
    return false;
  }
  if (kind === "Theme" && !validTheme(contents)) {
    diagnostics.push({ path: structuralPath, reason: "Theme does not satisfy the supported Pi Base format" });
    return false;
  }
  if (kind === "Prompt" && contents.startsWith("---") && !contents.includes("\n---", 3)) {
    diagnostics.push({ path: structuralPath, reason: "Prompt has malformed frontmatter" });
    return false;
  }
  return true;
}

function collectFromPath(root, kind, path, diagnostics) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) {
    diagnostics.push({ path: relativePath(root, path), reason: `${kind} manifest path is symbolic` });
    return [];
  }
  if (stat.isFile()) {
    const suffix = { Extension: /\.(ts|js)$/, Skill: /\.md$/, Prompt: /\.md$/, Theme: /\.json$/ }[kind];
    return suffix.test(path) && regularFile(root, path, diagnostics, kind) ? [path] : [];
  }
  if (!stat.isDirectory()) return [];
  if (kind === "Extension") return collectExtensions(root, path, diagnostics);
  if (kind === "Skill") return collectSkills(root, path, diagnostics);
  return collectRecursiveFiles(root, path, kind === "Prompt" ? ".md" : ".json", diagnostics, kind);
}

function globPatternMatches(path, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function applyManifestOverrides(paths, entries) {
  const overrides = entries.filter((value) => /^[!+-]/.test(value));
  const excludes = overrides.filter((value) => value.startsWith("!")).map((value) => value.slice(1).replace(/^\.\//, ""));
  const forceIncludes = overrides.filter((value) => value.startsWith("+")).map((value) => value.slice(1).replace(/^\.\//, ""));
  const forceExcludes = overrides.filter((value) => value.startsWith("-")).map((value) => value.slice(1).replace(/^\.\//, ""));
  let selected = paths.filter((path) => !excludes.some((pattern) => globPatternMatches(path, pattern)));
  for (const path of forceIncludes) {
    if (paths.includes(path) && !selected.includes(path)) selected.push(path);
  }
  selected = selected.filter((path) => !forceExcludes.includes(path));
  return selected;
}

function manifestArtifacts(root, manifest, diagnostics) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    diagnostics.push({ path: "package.json", reason: "Pi package manifest is not an object" });
    return [];
  }
  const keys = { Extension: "extensions", Skill: "skills", Prompt: "prompts", Theme: "themes" };
  for (const key of Object.values(keys)) {
    if (manifest[key] !== undefined && (!Array.isArray(manifest[key]) || manifest[key].some((entry) => typeof entry !== "string"))) {
      diagnostics.push({ path: "package.json", reason: `Pi package manifest ${key} must be an array of paths` });
      return [];
    }
  }

  const artifacts = [];
  for (const [kind, key] of Object.entries(keys)) {
    const entries = manifest[key] ?? [];
    const paths = new Set();
    for (const entry of entries.filter((value) => !/^[!+-]/.test(value))) {
      const normalized = entry.replace(/^\.\//, "");
      if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
        diagnostics.push({ path: "package.json", reason: `Pi package manifest ${key} path escapes the repository` });
        continue;
      }
      const matches = /[*?]/.test(normalized)
        ? globSync(normalized, { cwd: root, dot: false }).map((match) => join(root, match))
        : [resolve(root, normalized)];
      for (const match of matches) {
        if (match !== root && !match.startsWith(`${root}${sep}`)) continue;
        for (const path of collectFromPath(root, kind, match, diagnostics)) paths.add(relativePath(root, path));
      }
    }
    for (const path of applyManifestOverrides([...paths].sort(), entries)) {
      const absolute = join(root, path);
      if (validateArtifact(root, kind, absolute, diagnostics)) artifacts.push({ kind, path });
    }
  }
  return artifacts;
}

function exactObjectKeys(value, allowed) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function metadataText(value) {
  return typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function exactVersion(value) {
  return typeof value === "string" && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function readPatchMetadata(checkout, patches, piBase, diagnostics) {
  const path = join(checkout, "porcupi.json");
  let value;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("must be a regular file");
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return patches;
    const reason = error instanceof SyntaxError ? "malformed JSON" : "metadata root is not a readable regular file";
    diagnostics.push({ path: "porcupi.json", reason: `Patch metadata is invalid and ignored as a whole: ${reason}` });
    return patches;
  }

  const rootKeys = new Set(["schemaVersion", "patches"]);
  const entryKeys = new Set([
    "path",
    "displayName",
    "description",
    "supportedPiBaseVersions",
    "supportedPiBaseCommits",
  ]);
  const invalid = (reason) => {
    diagnostics.push({ path: "porcupi.json", reason: `Patch metadata is invalid and ignored as a whole: ${reason}` });
    return patches;
  };
  if (!exactObjectKeys(value, rootKeys) || value.schemaVersion !== 1 || !Array.isArray(value.patches)) {
    return invalid("expected only schemaVersion 1 and a patches array");
  }
  const seen = new Set();
  for (const entry of value.patches) {
    if (
      !exactObjectKeys(entry, entryKeys)
      || !metadataText(entry.path)
      || !entry.path.startsWith("patches/")
      || !entry.path.endsWith(".patch")
      || entry.path.includes("\\")
      || entry.path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      return invalid("unsupported field or unsafe Patch path");
    }
    if (seen.has(entry.path)) return invalid(`duplicate Patch entry ${entry.path}`);
    seen.add(entry.path);
    if (entry.displayName !== undefined && !metadataText(entry.displayName)) return invalid(`invalid displayName for ${entry.path}`);
    if (entry.description !== undefined && !metadataText(entry.description)) return invalid(`invalid description for ${entry.path}`);
    for (const [key, validator] of [["supportedPiBaseVersions", exactVersion], ["supportedPiBaseCommits", isFullGitCommit]]) {
      const values = entry[key];
      if (values !== undefined && (
        !Array.isArray(values)
        || values.length === 0
        || values.some((candidate) => !validator(candidate))
        || new Set(values).size !== values.length
      )) return invalid(`${key} for ${entry.path} must contain unique exact values`);
    }
  }

  const entries = new Map(value.patches.map((entry) => [entry.path, entry]));
  const discovered = new Set(patches.map((patch) => patch.path));
  for (const entry of value.patches) {
    if (!discovered.has(entry.path)) diagnostics.push({
      path: "porcupi.json",
      reason: `Patch metadata entry ${entry.path} does not address a discovered regular Patch and is ignored`,
    });
  }
  return patches.map((patch) => {
    const entry = entries.get(patch.path);
    if (!entry) return patch;
    const versionCompatible = entry.supportedPiBaseVersions === undefined
      || entry.supportedPiBaseVersions.includes(piBase?.tag);
    const commitCompatible = entry.supportedPiBaseCommits === undefined
      || entry.supportedPiBaseCommits.includes(piBase?.commit);
    return {
      ...patch,
      ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      compatible: versionCompatible && commitCompatible,
      compatibilityDeclared: entry.supportedPiBaseVersions !== undefined || entry.supportedPiBaseCommits !== undefined,
    };
  });
}

function discoverPatchArtifacts(checkout, diagnostics, piBase) {
  const realCheckout = realpathSync(checkout);
  const inventory = git(["ls-files", "--stage", "-z", "--", "patches"], { cwd: checkout });
  if (!inventory) return [];
  const artifacts = [];
  for (const record of inventory.split("\0").filter(Boolean)) {
    const match = record.match(/^([0-9]{6}) [a-f0-9]+ [0-9]\t(.+)$/);
    if (!match) {
      diagnostics.push({ path: "patches", reason: "Patch Git inventory is malformed" });
      continue;
    }
    const [, mode, path] = match;
    if (/[\x00-\x1f\x7f]/.test(path)) {
      diagnostics.push({ path: "patches/[unsafe path]", reason: "Patch path contains terminal control characters" });
      continue;
    }
    if (mode === "120000") {
      diagnostics.push({ path, reason: "Patch candidate is symbolic" });
      continue;
    }
    if (mode === "160000") {
      diagnostics.push({ path, reason: "Patch candidate is a Git submodule" });
      continue;
    }
    if (!path.endsWith(".patch")) continue;
    const absolute = join(checkout, path);
    try {
      const stat = lstatSync(absolute);
      const real = realpathSync(absolute);
      if (
        !regularGitModes.has(mode)
        || !stat.isFile()
        || stat.isSymbolicLink()
        || (real !== realCheckout && !real.startsWith(`${realCheckout}${sep}`))
      ) {
        throw new Error("not a repository-bounded regular file");
      }
      artifacts.push({ kind: "Patch", path, sha256: sha256File(absolute) });
    } catch {
      diagnostics.push({ path, reason: "Patch candidate is not a repository-bounded regular file" });
    }
  }
  return readPatchMetadata(checkout, artifacts, piBase, diagnostics);
}

export function discoverPiArtifacts(root, { piBase } = {}) {
  const checkout = resolve(root);
  const diagnostics = [];
  let manifest;
  const packageJson = join(checkout, "package.json");
  try {
    const stat = lstatSync(packageJson);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    const packageValue = JSON.parse(readFileSync(packageJson, "utf8"));
    if (Object.hasOwn(packageValue, "pi")) manifest = packageValue.pi;
  } catch (error) {
    if (error?.code !== "ENOENT") diagnostics.push({ path: "package.json", reason: "Package manifest is malformed" });
  }

  let artifacts;
  if (manifest !== undefined) artifacts = manifestArtifacts(checkout, manifest, diagnostics);
  else {
    const paths = {
      Extension: collectExtensions(checkout, join(checkout, "extensions"), diagnostics),
      Skill: collectSkills(checkout, join(checkout, "skills"), diagnostics),
      Prompt: collectRecursiveFiles(checkout, join(checkout, "prompts"), ".md", diagnostics, "Prompt"),
      Theme: collectRecursiveFiles(checkout, join(checkout, "themes"), ".json", diagnostics, "Theme"),
    };
    artifacts = artifactKinds.flatMap((kind) => paths[kind]
      .filter((path) => validateArtifact(checkout, kind, path, diagnostics))
      .map((path) => ({ kind, path: relativePath(checkout, path) })));
  }
  artifacts.push(...discoverPatchArtifacts(checkout, diagnostics, piBase));
  artifacts.sort((left, right) => `${left.kind}\0${left.path}`.localeCompare(`${right.kind}\0${right.path}`));
  diagnostics.sort((left, right) => left.path.localeCompare(right.path));
  return { artifacts, diagnostics };
}
