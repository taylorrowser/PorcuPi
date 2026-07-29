#!/usr/bin/env node

import { spawn } from "node:child_process";
import { defaultDataRoot, readActiveComposition } from "./runtime.mjs";

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
  await launch(process.argv.slice(2));
} catch (error) {
  console.error(`porcupi: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
