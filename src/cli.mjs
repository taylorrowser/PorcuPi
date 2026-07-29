#!/usr/bin/env node

import { spawn } from "node:child_process";
import { addResources } from "./add.mjs";
import { applyPatches } from "./apply.mjs";
import { defaultDataRoot, fail, readActiveComposition } from "./runtime.mjs";
import { manageResources } from "./manage.mjs";

async function launch(args) {
  const { executable } = readActiveComposition(defaultDataRoot());
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
  } else {
    await launch(args);
  }
} catch (error) {
  console.error(`porcupi: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
