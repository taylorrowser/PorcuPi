#!/usr/bin/env node

import { spawn } from "node:child_process";
import { join } from "node:path";
import { addResources } from "./add.mjs";
import { applyPatches } from "./apply.mjs";
import { verifyManagedInstallation } from "./composition.mjs";
import { rollbackComposition } from "./rollback.mjs";
import { recoverInterruptedUpgrade } from "./install.mjs";
import { defaultBinDirectory, defaultDataRoot, fail, readLeasedActiveComposition, verifyLauncher } from "./runtime.mjs";
import { manageResources } from "./manage.mjs";
import { setPiOwnership } from "./pi-ownership.mjs";
import { uninstallManagedPi } from "./uninstall.mjs";

async function runChild(command, args) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

async function launch(args) {
  const active = readLeasedActiveComposition(defaultDataRoot());
  try {
    verifyLauncher(active.paths);
    await runChild(process.execPath, [active.executable, ...args]);
  } finally {
    active.lease.release();
  }
}

let launching = false;
try {
  const args = process.argv.slice(2);
  const recovery = await recoverInterruptedUpgrade({ output: process.stderr });
  if (recovery.restartRequired) {
    await runChild(join(defaultBinDirectory(), "porcupi"), args);
  } else if (args[0] === "add") {
    if (args.length > 2) fail("Usage: porcupi add [git-source]");
    await addResources(args[1]);
  } else if (args[0] === "manage") {
    if (args.length !== 1) fail("Usage: porcupi manage");
    await manageResources();
  } else if (args[0] === "apply") {
    if (args.length !== 1) fail("Usage: porcupi apply");
    await applyPatches();
  } else if (args[0] === "pi") {
    if (args.length !== 2 || !new Set(["enable", "disable"]).has(args[1])) fail("Usage: porcupi pi enable|disable");
    await setPiOwnership(args[1] === "enable");
  } else if (args[0] === "rollback") {
    if (args.length !== 1) fail("Usage: porcupi rollback");
    await rollbackComposition();
  } else if (args[0] === "uninstall") {
    if (args.length !== 1) fail("Usage: porcupi uninstall");
    await uninstallManagedPi();
  } else if (args[0] === "verify") {
    if (args.length !== 1) fail("Usage: porcupi verify");
    const receipt = verifyManagedInstallation();
    process.stdout.write(`Verified Managed Pi Composition ${receipt.compositionId}.\n`);
    process.stdout.write("Complete payload inventory, executable, version, public conformance, isolated-home smoke, and launcher ownership checks passed.\n");
  } else {
    launching = true;
    await launch(args);
  }
} catch (error) {
  console.error(`porcupi: ${error instanceof Error ? error.message : String(error)}`);
  if (launching) {
    console.error("Managed Pi launch was refused; neither the previous Composition nor Stock Pi was run.");
    console.error("Run `porcupi verify` for a complete integrity check.");
    console.error("Run `porcupi rollback` to request the retained previous Composition.");
    console.error("Run `porcupi pi disable` to remove an unchanged PorcuPi-owned `pi` alias.");
    console.error("For direct recovery, use your independently managed Stock Pi path; `pi` may currently resolve to PorcuPi.");
  }
  process.exitCode = 1;
}
