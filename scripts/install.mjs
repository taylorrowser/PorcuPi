#!/usr/bin/env node

import { installManagedPi } from "../src/install.mjs";

try {
  await installManagedPi();
} catch (error) {
  process.stdout.write("\x1b[?25h");
  console.error(`porcupi install: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
