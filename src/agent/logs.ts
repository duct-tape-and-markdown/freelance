import fs from "node:fs";
import path from "node:path";
import { getLogPath } from "./spawner.js";

/**
 * Read the last N lines of an agent's log file.
 */
export function tailLog(traversalId: string, lines: number = 20): string[] {
  const logPath = getLogPath(traversalId);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, "utf-8");
  const allLines = content.split("\n");
  return allLines.slice(-lines).filter((l) => l.length > 0);
}

/**
 * Get the log directory path.
 */
export function getLogsDir(): string {
  const userHome = process.env.HOME || process.env.USERPROFILE || "~";
  return path.resolve(userHome, ".freelance", "logs");
}

/**
 * Clean up log files older than the given number of days.
 */
export function cleanOldLogs(maxAgeDays: number = 30): number {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const file of fs.readdirSync(logsDir)) {
    const filePath = path.join(logsDir, file);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      cleaned++;
    }
  }

  return cleaned;
}
