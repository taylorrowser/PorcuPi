#!/usr/bin/env node

import { assessBackgroundUpgradeReadiness, installManagedPi } from "../src/install.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--porcupi-background-upgrade-readiness") {
    await assessBackgroundUpgradeReadiness();
  } else {
    if (args.length !== 0) throw new Error("Usage: porcupi");
    await installManagedPi();
  }
} catch (error) {
  process.stdout.write("\x1b[?25h");
  console.error(`porcupi install: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
