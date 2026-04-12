/**
 * Suppress the `node:sqlite` ExperimentalWarning.
 *
 * `node:sqlite` is stable in recent Node releases but still flagged as
 * experimental in the 22.x LTS line we support. Without this filter, every
 * CLI/MCP invocation prints a warning to stderr that the user can't act on.
 *
 * Importing this module installs a one-time `process.on('warning')` filter.
 * It only swallows the SQLite experimental warning — every other warning
 * is re-emitted in Node's default `(node:PID) Name: message` format so
 * legitimate warnings are still visible.
 */

const previousListeners = process.listeners("warning").slice();
process.removeAllListeners("warning");

process.on("warning", (warning: Error) => {
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message.includes("SQLite")
  ) {
    return;
  }

  if (previousListeners.length > 0) {
    for (const listener of previousListeners) {
      try {
        (listener as (w: Error) => void).call(process, warning);
      } catch {
        /* listener errors must not propagate */
      }
    }
    return;
  }

  // No previous listeners → reproduce Node's default warning printer.
  process.stderr.write(`(node:${process.pid}) ${warning.name}: ${warning.message}\n`);
  if (warning.stack) {
    const lines = warning.stack.split("\n").slice(1);
    if (lines.length > 0) {
      process.stderr.write(lines.join("\n") + "\n");
    }
  }
});
