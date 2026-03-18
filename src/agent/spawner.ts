import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentDefinition, AgentSpawnOptions } from "./registry.js";

export interface SpawnResult {
  pid: number;
  process: ChildProcess;
  logFile?: string;
}

/**
 * Get the log file path for a traversal's agent output.
 */
export function getLogPath(traversalId: string): string {
  const userHome = process.env.HOME || process.env.USERPROFILE || "~";
  return path.resolve(userHome, ".freelance", "logs", `${traversalId}.log`);
}

/**
 * Spawn an agent process.
 *
 * - attach mode: agent stdio connected to terminal (interactive)
 * - detach mode: agent output piped to log file
 */
export function spawnAgent(
  agent: AgentDefinition,
  options: AgentSpawnOptions & { attach?: boolean; traversalId: string }
): SpawnResult {
  const args = agent.buildArgs(options);

  if (options.attach) {
    const child = spawn(agent.command, args, {
      cwd: options.cwd,
      stdio: "inherit",
      shell: true,
    });

    return { pid: child.pid!, process: child };
  }

  // Detach mode — pipe to log file
  const logFile = getLogPath(options.traversalId);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logStream = fs.createWriteStream(logFile, { flags: "a" });

  const child = spawn(agent.command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    detached: true,
  });

  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  // Allow parent to exit without waiting for child
  child.unref();

  return { pid: child.pid!, process: child, logFile };
}
