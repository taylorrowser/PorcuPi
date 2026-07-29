import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { atomicWrite, canonicalJson, defaultDataRoot, fail, managedLayout, readActiveComposition } from "./runtime.mjs";
import { discoverPiArtifacts, parseRequestedGitSource, resolveSourceRepository } from "./source-repository.mjs";

const resourceKeys = {
  Extension: "extensions",
  Skill: "skills",
  Prompt: "prompts",
  Theme: "themes",
};

function selectionStatePath(dataRoot) {
  return join(managedLayout(dataRoot).state, "selections.json");
}

function emptySelections() {
  return { schemaVersion: 1, sources: [] };
}

function readSelections(dataRoot) {
  const path = selectionStatePath(dataRoot);
  if (!existsSync(path)) return emptySelections();
  let value;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("Malformed PorcuPi Selection Intent");
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === "Malformed PorcuPi Selection Intent") throw error;
    fail("Malformed PorcuPi Selection Intent");
  }
  if (
    value.schemaVersion !== 1
    || !Array.isArray(value.sources)
    || value.sources.some((source) => (
      typeof source?.locator !== "string"
      || !/^[a-f0-9]{40}$/.test(source.commit || "")
      || typeof source.packageSource !== "string"
      || !Array.isArray(source.artifacts)
      || source.artifacts.some((artifact) => (
        !Object.hasOwn(resourceKeys, artifact?.kind)
        || typeof artifact.path !== "string"
        || artifact.path.startsWith("/")
        || artifact.path.includes("\\")
        || /[\x00-\x1f\x7f]/.test(artifact.path)
        || artifact.path.split("/").some((part) => part === "" || part === "." || part === "..")
        || artifact.scope !== "global"
      ))
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
    const artifactKeys = source.artifacts.map((artifact) => `${artifact.kind}\0${artifact.path}`);
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
  return value;
}

function packageEntry(packageSource, artifacts) {
  const entry = { source: packageSource };
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

function readPiSettings(environment, { allowMissing = true } = {}) {
  const path = join(agentDirectory(environment), "settings.json");
  if (!existsSync(path)) {
    if (allowMissing) return { path, settings: {}, packages: [], existed: false };
    fail("Pi package installation did not create global package settings");
  }
  try {
    const stat = lstatSync(path);
    const contents = readFileSync(path, "utf8");
    const settings = JSON.parse(contents);
    if (!stat.isFile() || stat.isSymbolicLink() || settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      fail("Pi global package settings are malformed");
    }
    const packages = settings.packages ?? [];
    if (!Array.isArray(packages)) fail("Pi global package settings are malformed");
    return { path, settings, packages, contents, existed: true };
  } catch (error) {
    if (error instanceof Error && error.message === "Pi global package settings are malformed") throw error;
    fail("Pi global package settings are malformed");
  }
}

function matchingPackageIndexes(packages, locator) {
  return packages.flatMap((value, index) => packageIdentity(value) === locator ? [index] : []);
}

function preflightPiPackageOwnership(environment, source, previous) {
  const current = readPiSettings(environment);
  const matches = matchingPackageIndexes(current.packages, source.locator);
  if (matches.length > 1) fail(`Pi has ambiguous package configuration for ${source.locator}`);
  if (!previous && matches.length > 0) {
    fail(`Pi already has a package for ${source.locator} that PorcuPi does not own`);
  }
  if (previous) {
    if (matches.length !== 1) fail(`PorcuPi's prior Pi package entry for ${source.locator} is missing`);
    const expected = packageEntry(previous.packageSource, previous.artifacts);
    if (canonicalJson(current.packages[matches[0]]) !== canonicalJson(expected)) {
      fail(`PorcuPi's prior Pi package entry for ${source.locator} was changed outside PorcuPi`);
    }
  }
  return current;
}

async function runManagedPi(executable, args, environment) {
  const child = spawn(process.execPath, [executable, ...args], { stdio: "inherit", env: environment });
  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.signal) fail(`Pi package lifecycle was interrupted by ${result.signal}`);
  if (result.code !== 0) fail(`Pi package lifecycle failed with status ${String(result.code)}`);
}

function stageFilteredPackage(current, source, artifacts) {
  const packages = [...current.packages];
  const matches = matchingPackageIndexes(packages, source.locator);
  const entry = packageEntry(source.packageSource, artifacts);
  if (matches.length === 0) packages.push(entry);
  else packages[matches[0]] = entry;
  atomicWrite(current.path, { ...current.settings, packages });
}

function verifyFilteredPackage(environment, source, artifacts) {
  const current = readPiSettings(environment, { allowMissing: false });
  const matches = matchingPackageIndexes(current.packages, source.locator);
  if (matches.length !== 1 || canonicalJson(current.packages[matches[0]]) !== canonicalJson(packageEntry(source.packageSource, artifacts))) {
    fail(`Pi did not retain the reviewed package filters for ${source.locator}`);
  }
}

function restorePiSettings(snapshot) {
  if (snapshot.existed) atomicWrite(snapshot.path, snapshot.contents);
  else rmSync(snapshot.path, { force: true });
}

async function restorePreviousPiPackage({ settings, executable, previous, environment, locator, operation }) {
  restorePiSettings(settings);
  if (!previous) return;
  try {
    await runManagedPi(executable, ["install", previous.packageSource], environment);
  } catch {
    fail(`Pi package ${operation} failed and the prior checkout for ${locator} could not be restored`);
  }
}

function saveSelections(dataRoot, selections, source, artifacts) {
  const withoutSource = selections.sources.filter((candidate) => candidate.locator !== source.locator);
  const sources = artifacts.length === 0
    ? withoutSource
    : [...withoutSource, {
        locator: source.locator,
        commit: source.commit,
        packageSource: source.packageSource,
        artifacts: artifacts.map((artifact) => ({ ...artifact, scope: "global" })),
      }];
  sources.sort((left, right) => left.locator.localeCompare(right.locator));
  atomicWrite(selectionStatePath(dataRoot), { schemaVersion: 1, sources });
}

async function promptForSource(input, output) {
  const readline = createInterface({ input, output });
  try {
    return (await readline.question("Git source: ")).trim();
  } finally {
    readline.close();
  }
}

function runAddWizard({ source, artifacts, diagnostics, currentPaths, previousCommit, input, output }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    fail("porcupi add requires an interactive terminal");
  }
  const selected = new Set(currentPaths.filter((path) => artifacts.some((artifact) => artifact.path === path)));
  let page = 0;
  let artifactCursor = 0;
  let reviewCursor = 0;

  return new Promise((resolvePromise, rejectPromise) => {
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      input.off("keypress", onKeypress);
      input.off("error", onError);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      try {
        input.setRawMode(false);
      } catch {
        // Continue restoring listeners and cursor when raw-mode teardown is unavailable.
      }
      input.pause();
      output.write("\x1b[?25h");
    };
    const finish = (value) => {
      restore();
      resolvePromise(value);
    };
    const onError = (error) => {
      restore();
      rejectPromise(error);
    };
    const onSignal = (signal) => {
      restore();
      process.kill(process.pid, signal);
    };
    const onSigint = () => onSignal("SIGINT");
    const onSigterm = () => onSignal("SIGTERM");
    const chosen = () => artifacts.filter((artifact) => selected.has(artifact.path));
    const truncate = (value) => {
      const width = Math.max(20, (output.columns || 100) - 1);
      return value.length > width ? `${value.slice(0, width - 1)}…` : value;
    };
    const windowAround = (cursor, count, reservedRows) => {
      const available = Math.max(4, (output.rows || 24) - reservedRows);
      const start = Math.max(0, Math.min(cursor - Math.floor(available / 2), Math.max(0, count - available)));
      return { start, end: Math.min(count, start + available) };
    };
    const render = () => {
      output.write("\x1b[2J\x1b[H");
      if (page === 0) {
        output.write("1 of 3 — Select Artifacts\n");
        output.write(`Repository: ${source.locator}\nExact commit: ${source.commit}\n\n`);
        if (artifacts.length === 0) output.write("  No selectable Pi resources were discovered.\n");
        const artifactWindow = windowAround(artifactCursor, artifacts.length, 13 + Math.min(5, diagnostics.length));
        for (let index = artifactWindow.start; index < artifactWindow.end; index += 1) {
          const artifact = artifacts[index];
          const pointer = index === artifactCursor ? "›" : " ";
          const mark = selected.has(artifact.path) ? "x" : " ";
          output.write(`${truncate(`${pointer} [${mark}] ${artifact.kind.padEnd(9)} ${artifact.path}`)}\n`);
        }
        if (artifacts.length > 0) output.write(`  ${artifactWindow.start} above · ${artifacts.length - artifactWindow.end} below\n`);
        for (const diagnostic of diagnostics.slice(0, 5)) output.write(`${truncate(`  Rejected ${diagnostic.path}: ${diagnostic.reason}`)}\n`);
        if (diagnostics.length > 5) output.write(`  … ${diagnostics.length - 5} more rejected candidates\n`);
        output.write("\n[↑/↓ j/k] move  [Space/Enter] toggle  [a] select all  [d] deselect all\n[n → l] Next  [Esc] cancel\n");
      } else if (page === 1) {
        output.write("2 of 3 — Choose Installation Scope\n");
        output.write(`${chosen().length} Pi resource(s) selected.\n\n`);
        output.write("› (x) global — available to your user across projects\n");
        output.write("\nProject Installation Scope is added by the next lifecycle slice.\n");
        output.write("[n → l] Next  [← h] Back  [Esc] cancel\n");
      } else {
        const selectedArtifacts = chosen();
        reviewCursor = Math.min(reviewCursor, Math.max(0, selectedArtifacts.length - 1));
        output.write("3 of 3 — Review and save\n");
        output.write(`Repository: ${source.locator}\nExact commit: ${source.commit}\n`);
        if (previousCommit && previousCommit !== source.commit) output.write(`Source-wide change: ${previousCommit} → ${source.commit}\n`);
        output.write(`Selections: ${selectedArtifacts.length} global Pi resource(s)\n\n`);
        const reviewWindow = windowAround(reviewCursor, selectedArtifacts.length, 16);
        for (let index = reviewWindow.start; index < reviewWindow.end; index += 1) {
          const artifact = selectedArtifacts[index];
          output.write(`${truncate(`${index === reviewCursor ? "›" : " "} ${artifact.kind.padEnd(9)} ${artifact.path}`)}\n`);
        }
        if (selectedArtifacts.length > 0) output.write(`  ${reviewWindow.start} above · ${selectedArtifacts.length - reviewWindow.end} below\n`);
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
        else if (page === 2) reviewCursor = Math.max(0, reviewCursor - 1);
      } else if (key.name === "down" || key.name === "j") {
        if (page === 0) artifactCursor = Math.min(Math.max(0, artifacts.length - 1), artifactCursor + 1);
        else if (page === 2) reviewCursor = Math.min(Math.max(0, chosen().length - 1), reviewCursor + 1);
      } else if (key.name === "space" || key.name === "return") {
        if (page === 0 && artifacts[artifactCursor]) {
          const path = artifacts[artifactCursor].path;
          if (selected.has(path)) selected.delete(path);
          else selected.add(path);
        } else if (page === 2) return finish(chosen());
      } else if (page === 0 && key.name === "a") {
        for (const artifact of artifacts) selected.add(artifact.path);
      } else if (page === 0 && key.name === "d") selected.clear();
      render();
    };
    const onKeypress = (...args) => {
      try {
        handleKeypress(...args);
      } catch (error) {
        restore();
        rejectPromise(error);
      }
    };

    try {
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", onKeypress);
      input.once("error", onError);
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      output.write("\x1b[?25l");
      render();
    } catch (error) {
      restore();
      rejectPromise(error);
    }
  });
}

export async function addResources(requestedSource, {
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  dataRoot = defaultDataRoot(environment),
} = {}) {
  const sourceInput = requestedSource || await promptForSource(input, output);
  if (!sourceInput) fail("A Git source is required");
  const active = readActiveComposition(dataRoot);
  const selections = readSelections(dataRoot);
  const resolved = resolveSourceRepository(sourceInput);
  try {
    const discovery = discoverPiArtifacts(resolved.checkout);
    const previous = selections.sources.find((source) => source.locator === resolved.locator);
    const result = await runAddWizard({
      source: resolved,
      artifacts: discovery.artifacts,
      diagnostics: discovery.diagnostics,
      currentPaths: previous?.artifacts.map((artifact) => artifact.path) ?? [],
      previousCommit: previous?.commit,
      input,
      output,
    });
    if (result === null) {
      output.write("\nSelection cancelled; saved Selection Intent, Pi configuration, and Managed Pi activation are unchanged.\n");
      return { saved: false, cancelled: true };
    }

    const piSettings = preflightPiPackageOwnership(environment, resolved, previous);
    if (result.length === 0) {
      try {
        if (previous) await runManagedPi(active.executable, ["remove", previous.packageSource], environment);
        saveSelections(dataRoot, selections, resolved, []);
      } catch (error) {
        if (previous) {
          await restorePreviousPiPackage({
            settings: piSettings,
            executable: active.executable,
            previous,
            environment,
            locator: resolved.locator,
            operation: "removal",
          });
        }
        throw error;
      }
      output.write("\nSaved 0 global Pi resource selections. Managed Pi activation is unchanged.\n");
      return { saved: true, count: 0 };
    }

    stageFilteredPackage(piSettings, resolved, result);
    try {
      await runManagedPi(active.executable, ["install", resolved.packageSource], environment);
      verifyFilteredPackage(environment, resolved, result);
      saveSelections(dataRoot, selections, resolved, result);
    } catch (error) {
      await restorePreviousPiPackage({
        settings: piSettings,
        executable: active.executable,
        previous,
        environment,
        locator: resolved.locator,
        operation: "update",
      });
      throw error;
    }
    output.write(`\nSaved ${result.length} global Pi resource selections from ${resolved.locator}@${resolved.commit}.\n`);
    output.write("Pi owns package checkout, dependencies, updates, and loading. Managed Pi activation is unchanged.\n");
    return { saved: true, count: result.length };
  } finally {
    resolved.dispose();
  }
}
