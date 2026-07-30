import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathExists } from "./composition.mjs";
import { cleanupRetainedCompositions, durableUnlink, withLifecycleLock } from "./lifecycle.mjs";
import {
  atomicWrite,
  canonicalJson,
  createLauncherReceipt,
  defaultBinDirectory,
  defaultDataRoot,
  fail,
  managedLayout,
  readActiveComposition,
  readJson,
  shellPiLauncherContents,
  validateLauncherReceipt,
  validateManagedRoot,
  verifyLauncher,
  verifyLauncherReceipt,
  verifyPiLauncher,
} from "./runtime.mjs";

const transitionFields = new Set(["schemaVersion", "type", "action", "launcher", "temporary"]);
const actions = new Set(["enable", "disable"]);

function exactObject(value, fields) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function checkpoint(name) {
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAULT === name) process.kill(process.pid, "SIGKILL");
  if (process.env.NODE_ENV === "test" && process.env.PORCUPI_TEST_FAILURE === name) fail(`Injected failure at ${name}`);
}

function piPaths(paths, environment) {
  const binDirectory = defaultBinDirectory(environment);
  return {
    binDirectory,
    porcupi: join(binDirectory, "porcupi"),
    pi: join(binDirectory, "pi"),
    receipt: paths.piLauncherReceipt,
    transition: paths.piTransition,
  };
}

function validatePiReceipt(receipt, expectedPath) {
  return validateLauncherReceipt(receipt, {
    type: "porcupi-pi-launcher",
    path: expectedPath,
    label: "PorcuPi pi launcher receipt",
  });
}

function readTransition(paths, environment) {
  if (!pathExists(paths.piTransition)) return null;
  const locations = piPaths(paths, environment);
  const transition = readJson(paths.piTransition, "PorcuPi pi ownership transition");
  if (
    !exactObject(transition, transitionFields)
    || transition.schemaVersion !== 1
    || transition.type !== "porcupi-pi-ownership-transition"
    || !actions.has(transition.action)
    || (transition.action === "disable" && transition.temporary !== null)
    || (transition.action === "enable" && (
      typeof transition.temporary !== "string"
      || dirname(transition.temporary) !== locations.binDirectory
      || !basename(transition.temporary).startsWith(".pi.tmp-")
      || resolve(transition.temporary) !== transition.temporary
    ))
  ) fail("Malformed PorcuPi pi ownership transition");
  validatePiReceipt(transition.launcher, locations.pi);
  return transition;
}

function writeTransition(paths, action, launcher, temporary = null) {
  const transition = {
    schemaVersion: 1,
    type: "porcupi-pi-ownership-transition",
    action,
    launcher,
    temporary,
  };
  atomicWrite(paths.piTransition, transition);
  return transition;
}

function exactReceipt(path, expected) {
  const receipt = validatePiReceipt(readJson(path, "PorcuPi pi launcher receipt"), expected.path);
  if (canonicalJson(receipt) !== canonicalJson(expected)) fail("PorcuPi pi ownership receipt changed during transition");
  return receipt;
}

function publishExpectedAlias(locations, expected, temporary) {
  mkdirSync(locations.binDirectory, { recursive: true, mode: 0o755 });
  let created = false;
  try {
    writeFileSync(temporary, shellPiLauncherContents(locations.porcupi), { mode: 0o755, flag: "wx" });
    created = true;
    chmodSync(temporary, expected.mode);
    const actual = { ...createLauncherReceipt(temporary, "porcupi-pi-launcher"), path: locations.pi };
    if (canonicalJson(actual) !== canonicalJson(expected)) fail("Prepared PorcuPi pi launcher changed during recovery");
    linkSync(temporary, locations.pi);
  } finally {
    if (created) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

function verifyPreparedAlias(path, expected, locations) {
  const actual = { ...createLauncherReceipt(path, "porcupi-pi-launcher"), path: locations.pi };
  if (
    canonicalJson(actual) !== canonicalJson(expected)
    || readFileSync(path, "utf8") !== shellPiLauncherContents(locations.porcupi)
  ) fail(`Prepared PorcuPi pi launcher changed during recovery: ${path}`);
}

function recoverTransition(paths, environment) {
  const transition = readTransition(paths, environment);
  if (!transition) return null;
  const locations = piPaths(paths, environment);
  if (transition.action === "enable") {
    if (pathExists(locations.pi)) {
      verifyLauncherReceipt(transition.launcher, shellPiLauncherContents(locations.porcupi), "PorcuPi-owned pi launcher");
    } else if (pathExists(transition.temporary)) {
      verifyPreparedAlias(transition.temporary, transition.launcher, locations);
      linkSync(transition.temporary, locations.pi);
    } else publishExpectedAlias(locations, transition.launcher, transition.temporary);
    if (pathExists(locations.receipt)) exactReceipt(locations.receipt, transition.launcher);
    else atomicWrite(locations.receipt, transition.launcher);
  } else {
    if (pathExists(locations.pi)) {
      verifyLauncherReceipt(transition.launcher, shellPiLauncherContents(locations.porcupi), "PorcuPi-owned pi launcher");
      durableUnlink(locations.pi);
    }
    if (pathExists(locations.receipt)) {
      exactReceipt(locations.receipt, transition.launcher);
      durableUnlink(locations.receipt);
    }
  }
  if (transition.temporary && pathExists(transition.temporary)) {
    verifyPreparedAlias(transition.temporary, transition.launcher, locations);
    durableUnlink(transition.temporary);
  }
  durableUnlink(locations.transition);
  return transition.action;
}

function prepareAlias(locations) {
  mkdirSync(locations.binDirectory, { recursive: true, mode: 0o755 });
  const temporary = join(locations.binDirectory, `.${basename(locations.pi)}.tmp-${randomUUID()}`);
  writeFileSync(temporary, shellPiLauncherContents(locations.porcupi), { mode: 0o755, flag: "wx" });
  chmodSync(temporary, 0o755);
  const launcher = { ...createLauncherReceipt(temporary, "porcupi-pi-launcher"), path: locations.pi };
  return { temporary, launcher };
}

function resolvedCommand(command, environment) {
  for (const entry of (environment.PATH || "").split(":").filter(Boolean)) {
    const candidate = resolve(entry, command);
    try {
      const stat = lstatSync(candidate);
      if ((!stat.isFile() && !stat.isSymbolicLink()) || stat.isDirectory()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  return null;
}

function reportEnabledResolution(locations, environment, output) {
  const resolvedPi = resolvedCommand("pi", environment);
  if (resolvedPi === locations.pi) {
    output.write(`\`pi\` resolves to the PorcuPi-owned launcher at ${locations.pi}.\n`);
  } else if (resolvedPi) {
    output.write(`PATH currently resolves \`pi\` to ${resolvedPi}. Place ${locations.binDirectory} earlier in PATH to use Managed Pi as \`pi\`.\n`);
  } else {
    output.write(`Add ${locations.binDirectory} to PATH to use Managed Pi as \`pi\`.\n`);
  }
}

function reportDisabledResolution(locations, environment, output) {
  const resolvedPi = resolvedCommand("pi", environment);
  if (resolvedPi) output.write(`\`pi\` now resolves independently to ${resolvedPi}.\n`);
  else output.write(`No \`pi\` command is currently available on PATH; \`porcupi\` remains available at ${locations.porcupi}.\n`);
}

function enableLocked(paths, environment, output) {
  const locations = piPaths(paths, environment);
  recoverTransition(paths, environment);
  if (pathExists(locations.receipt)) {
    verifyPiLauncher(paths, environment);
    output.write(`PorcuPi already owns ${locations.pi}; no change was needed.\n`);
    reportEnabledResolution(locations, environment, output);
    return { changed: false, enabled: true };
  }
  if (pathExists(locations.pi)) fail(`Refusing foreign pi command collision: ${locations.pi}`);

  const prepared = prepareAlias(locations);
  let linked = false;
  try {
    writeTransition(paths, "enable", prepared.launcher, prepared.temporary);
    linkSync(prepared.temporary, locations.pi);
    linked = true;
    checkpoint("pi-alias-published");
    atomicWrite(locations.receipt, prepared.launcher);
    checkpoint("pi-alias-receipt-published");
    durableUnlink(locations.transition);
  } finally {
    try {
      unlinkSync(prepared.temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!linked && pathExists(locations.transition)) durableUnlink(locations.transition);
  }
  verifyPiLauncher(paths, environment);
  output.write(`Enabled PorcuPi ownership of ${locations.pi}.\n`);
  reportEnabledResolution(locations, environment, output);
  return { changed: true, enabled: true };
}

function disableLocked(paths, environment, output, { ignoreForeign = false } = {}) {
  const locations = piPaths(paths, environment);
  recoverTransition(paths, environment);
  if (!pathExists(locations.receipt)) {
    if (pathExists(locations.pi) && !ignoreForeign) fail(`Refusing to remove foreign pi command: ${locations.pi}`);
    output.write(`PorcuPi does not own ${locations.pi}; no change was needed.\n`);
    reportDisabledResolution(locations, environment, output);
    return { changed: false, enabled: false };
  }
  const receipt = verifyPiLauncher(paths, environment);
  writeTransition(paths, "disable", receipt);
  checkpoint("pi-disable-prepared");
  durableUnlink(locations.pi);
  checkpoint("pi-alias-removed");
  durableUnlink(locations.receipt);
  checkpoint("pi-alias-receipt-removed");
  durableUnlink(locations.transition);
  output.write(`Disabled PorcuPi ownership of ${locations.pi}; \`porcupi\` remains available.\n`);
  reportDisabledResolution(locations, environment, output);
  return { changed: true, enabled: false };
}

export function reconcilePiOwnershipLocked(paths, enabled, environment = process.env, output = process.stdout) {
  return enabled
    ? enableLocked(paths, environment, output)
    : disableLocked(paths, environment, output, { ignoreForeign: true });
}

export async function setPiOwnership(enabled, {
  environment = process.env,
  dataRoot = defaultDataRoot(environment),
  output = process.stdout,
} = {}) {
  return withLifecycleLock(dataRoot, enabled ? "pi enable" : "pi disable", () => {
    if (!enabled) {
      const paths = validateManagedRoot(managedLayout(dataRoot));
      return disableLocked(paths, environment, output);
    }
    const active = readActiveComposition(dataRoot);
    verifyLauncher(active.paths, environment);
    cleanupRetainedCompositions(active.paths, active.activation, output);
    return enableLocked(active.paths, environment, output);
  });
}
