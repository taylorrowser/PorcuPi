import { emitKeypressEvents } from "node:readline";
import { fail } from "./runtime.mjs";

export function truncateForTerminal(output, value) {
  const width = Math.max(20, (output.columns || 100) - 1);
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

export function windowAround(output, cursor, count, reservedRows) {
  const available = Math.max(4, (output.rows || 24) - reservedRows);
  const start = Math.max(0, Math.min(cursor - Math.floor(available / 2), Math.max(0, count - available)));
  return { start, end: Math.min(count, start + available) };
}

export function runGuidedTerminal({ command, input, output, createController }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    fail(`${command} requires an interactive terminal`);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let restored = false;
    let onKeypress;
    const restore = () => {
      if (restored) return;
      restored = true;
      if (onKeypress) input.off("keypress", onKeypress);
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

    try {
      const controller = createController({ finish });
      onKeypress = (...args) => {
        try {
          controller.handleKeypress(...args);
        } catch (error) {
          restore();
          rejectPromise(error);
        }
      };
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", onKeypress);
      input.once("error", onError);
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      output.write("\x1b[?25l");
      controller.render();
    } catch (error) {
      restore();
      rejectPromise(error);
    }
  });
}
