import path from "node:path";
import fs from "node:fs";
import { loadGraphsCollecting } from "./loader.js";
import { loadConfigFromDirs } from "./config.js";
import type { ValidatedGraph } from "./types.js";

/**
 * Resolve graph directories in precedence order:
 * 1. Environment variable (colon-separated on Unix, semicolon on Windows)
 * 2. Project-level: ./.freelance (if exists)
 * 3. User-level: ~/.freelance (if exists)
 * 4. Additional dirs from config.yml / config.local.yml `workflows:` key
 */
export function resolveDefaultGraphsDirs(): string[] {
  const envValue = process.env.FREELANCE_WORKFLOWS_DIR?.trim();
  if (envValue) {
    return envValue.split(path.delimiter);
  }

  const dirs: string[] = [];

  const projectGraphs = path.resolve(".freelance");
  if (fs.existsSync(projectGraphs)) {
    dirs.push(projectGraphs);
  }

  const userHome = process.env.HOME || process.env.USERPROFILE || "~";
  const userGraphs = path.resolve(userHome, ".freelance");
  if (fs.existsSync(userGraphs)) {
    dirs.push(userGraphs);
  }

  // Append workflow directories from config.yml / config.local.yml
  if (dirs.length > 0) {
    const config = loadConfigFromDirs(dirs);
    for (const wd of config.workflows) {
      if (!dirs.includes(wd) && fs.existsSync(wd)) {
        dirs.push(wd);
      }
    }
  }

  return dirs;
}

/**
 * Parse CLI --workflows options (repeatable) and merge with defaults.
 * Returns array of resolved directory paths.
 */
export function resolveGraphsDirs(cliGraphs?: string | string[] | null): string[] {
  const dirs = Array.isArray(cliGraphs) ? cliGraphs : cliGraphs ? [cliGraphs] : [];
  if (dirs.length > 0) {
    return dirs.map((d) => path.resolve(d));
  }
  return resolveDefaultGraphsDirs();
}

/**
 * Derive the source root for resolving relative source paths in graph definitions.
 *
 * Convention: `.freelance/` is a child of the environment whose sources it references.
 * So the parent of the graphsDir is the natural base for source resolution.
 *
 * Examples:
 *   graphsDir = ./codebase/.freelance   → sourceRoot = ./codebase/
 *   graphsDir = ../dev-docs/.freelance  → sourceRoot = ../dev-docs/
 *   graphsDir = ~/.freelance            → sourceRoot = ~/
 *   explicit = /custom/root             → sourceRoot = /custom/root
 *
 * Falls back to undefined (= CWD) when no graphsDirs are available.
 */
export function resolveSourceRoot(
  graphsDirs: string[],
  explicit?: string | null
): string | undefined {
  if (explicit) return path.resolve(explicit);
  if (graphsDirs.length > 0) return path.dirname(graphsDirs[0]);
  return undefined;
}

export interface GracefulLoadResult {
  graphs: Map<string, ValidatedGraph>;
  errors: Array<{ file: string; message: string }>;
}

/**
 * Load graphs gracefully — returns partial results on failure instead of exiting.
 * Always returns both graphs and structured errors. Suitable for long-running
 * servers that should start even without valid graphs (the watcher can pick them up later).
 */
export function loadGraphsGraceful(graphsDirs?: string | string[] | null): GracefulLoadResult {
  const dirs = resolveGraphsDirs(graphsDirs);

  if (dirs.length === 0) {
    return { graphs: new Map(), errors: [] };
  }

  return loadGraphsCollecting(dirs);
}
