#!/usr/bin/env node

import { spawn } from "node:child_process";
import { addResources } from "./add.mjs";
import { applyPatches } from "./apply.mjs";
import { verifyManagedInstallation } from "./composition.mjs";
import { defaultDataRoot, fail, readActiveComposition, verifyLauncher } from "./runtime.mjs";
import { manageResources } from "./manage.mjs";

async function launch(args) {
  const active = readActiveComposition(defaultDataRoot());
  verifyLauncher(active.paths);
  const { executable } = active;
  const child = spawn(process.execPath, [executable, ...args], {
    stdio: "inherit",
    env: process.env,
  });
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

let launching = false;
try {
  const args = process.argv.slice(2);
  if (args[0] === "add") {
    if (args.length > 2) fail("Usage: porcupi add [git-source]");
    await addResources(args[1]);
  } else if (args[0] === "manage") {
    if (args.length !== 1) fail("Usage: porcupi manage");
    await manageResources();
  } else if (args[0] === "apply") {
    if (args.length !== 1) fail("Usage: porcupi apply");
    await applyPatches();
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
    console.error("For direct recovery, run your independently installed Stock Pi command (`pi`) outside PorcuPi.");
  }
  process.exitCode = 1;
}
