import fs from "node:fs";
import { cli, info, fatal, outputJson, EXIT } from "./output.js";
import { getPidFilePath } from "../paths.js";

export interface PidFileData {
  pid: number;
  port: number;
  graphsDir?: string;
}

export function readPidFile(): PidFileData | null {
  const pidFile = getPidFilePath();
  if (!fs.existsSync(pidFile)) return null;
  const raw = fs.readFileSync(pidFile, "utf-8").trim();
  try {
    const data = JSON.parse(raw) as PidFileData;
    return { pid: data.pid, port: data.port, graphsDir: data.graphsDir };
  } catch {
    return null;
  }
}

/**
 * Check if a daemon is already running. Returns PID info if alive, null otherwise.
 * Cleans up stale PID files.
 */
export function checkRunningDaemon(): PidFileData | null {
  const pidInfo = readPidFile();
  if (!pidInfo) return null;

  try {
    process.kill(pidInfo.pid, 0);
    return pidInfo; // Process is alive
  } catch {
    // Stale PID file — clean up
    try { fs.unlinkSync(getPidFilePath()); } catch {}
    return null;
  }
}

export function daemonStop(): void {
  const pidInfo = readPidFile();
  if (!pidInfo) {
    fatal(
      "No daemon PID file found.\n\n  Is the daemon running? Check with: freelance daemon status",
      EXIT.DAEMON_ERROR
    );
  }

  const { pid } = pidInfo;
  try {
    process.kill(pid, "SIGTERM");
    if (cli.json) {
      outputJson({ stopped: true, pid });
    } else {
      info(`Sent SIGTERM to daemon (PID ${pid})`);
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const pidFile = getPidFilePath();
    if (err.code === "ESRCH") {
      fs.unlinkSync(pidFile);
      fatal(
        `Daemon process (PID ${pid}) not found. Cleaned up stale PID file.`,
        EXIT.DAEMON_ERROR
      );
    }
    fatal(`Failed to stop daemon: ${err.message}`, EXIT.DAEMON_ERROR);
  }
}

export function daemonStatus(): void {
  const pidInfo = readPidFile();
  if (!pidInfo) {
    if (cli.json) {
      outputJson({ running: false });
    } else {
      info("Daemon: not running (no PID file)");
    }
    return;
  }

  const { pid, port, graphsDir } = pidInfo;
  try {
    process.kill(pid, 0);
    if (cli.json) {
      outputJson({ running: true, pid, port, graphsDir });
    } else {
      let msg = `Daemon: running (PID ${pid}, port ${port})`;
      if (graphsDir) msg += `\n  Graphs: ${graphsDir}`;
      info(msg);
    }
  } catch {
    if (cli.json) {
      outputJson({ running: false, stalePid: pid });
    } else {
      info(`Daemon: not running (stale PID file for ${pid})`);
    }
  }
}
