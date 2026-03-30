import path from "node:path";
import fs from "node:fs";
import { loadGraphs, loadGraphsLayered } from "./loader.js";
import { fatal, EXIT } from "./cli/output.js";
import type { ValidatedGraph } from "./types.js";

/**
 * Resolve graph directories in precedence order:
 * 1. Environment variable (colon-separated on Unix, semicolon on Windows)
 * 2. Project-level: ./.freelance (if exists)
 * 3. User-level: ~/.freelance (if exists)
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

  return dirs;
}

/**
 * Parse CLI --workflows options (repeatable) and merge with defaults.
 * Returns array of resolved directory paths.
 */
export function resolveGraphsDirs(cliGraphs?: string | string[] | null): string[] {
  if (cliGraphs && (Array.isArray(cliGraphs) ? cliGraphs.length > 0 : true)) {
    const dirs = Array.isArray(cliGraphs) ? cliGraphs : [cliGraphs];
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

/**
 * Resolve graph directories, load all graphs, and exit on failure.
 */
export function loadGraphsOrFatal(graphsDirs?: string | string[] | null) {
  const dirs = resolveGraphsDirs(graphsDirs);

  if (dirs.length === 0) {
    fatal(
      "No graph directories found or provided.\n\n" +
        "Specify with: --workflows <directory>\n" +
        "Or set: FREELANCE_WORKFLOWS_DIR=dir1:dir2\n" +
        "Or create: ./.freelance/ or ~/.freelance/",
      EXIT.INVALID_USAGE
    );
  }

  try {
    return dirs.length === 1 ? loadGraphs(dirs[0]) : loadGraphsLayered(dirs);
  } catch (err) {
    fatal(
      `Graph loading failed: ${err instanceof Error ? err.message : err}`,
      EXIT.GRAPH_ERROR
    );
  }
}

/**
 * Load graphs gracefully — returns an empty map on failure instead of exiting.
 * Warnings/errors go to stderr. Suitable for long-running servers that should
 * start even without valid graphs (the watcher can pick them up later).
 */
export function loadGraphsGraceful(graphsDirs?: string | string[] | null): Map<string, ValidatedGraph> {
  const dirs = resolveGraphsDirs(graphsDirs);

  if (dirs.length === 0) {
    process.stderr.write(
      "No graph directories found. The server will start with zero graphs.\n" +
        "Create ./.freelance/ or ~/.freelance/ and add *.workflow.yaml files.\n"
    );
    return new Map();
  }

  try {
    return dirs.length === 1 ? loadGraphs(dirs[0]) : loadGraphsLayered(dirs);
  } catch (err) {
    process.stderr.write(
      `Graph loading failed: ${err instanceof Error ? err.message : err}\n` +
        "The server will start with zero graphs. Fix the errors and graphs will reload automatically.\n"
    );
    return new Map();
  }
}
