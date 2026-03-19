import path from "node:path";
import fs from "node:fs";
import { loadGraphs, loadGraphsLayered } from "./loader.js";
import { fatal, EXIT } from "./cli/output.js";

/**
 * Resolve graph directories in precedence order:
 * 1. Environment variable (colon-separated on Unix, semicolon on Windows)
 * 2. Project-level: ./.freelance/graphs (if exists)
 * 3. User-level: ~/.freelance/graphs (if exists)
 */
export function resolveDefaultGraphsDirs(): string[] {
  const envValue = process.env.FREELANCE_GRAPHS_DIR?.trim();
  if (envValue) {
    return envValue.split(path.delimiter);
  }

  const dirs: string[] = [];

  const projectGraphs = path.resolve(".freelance", "graphs");
  if (fs.existsSync(projectGraphs)) {
    dirs.push(projectGraphs);
  }

  const userHome = process.env.HOME || process.env.USERPROFILE || "~";
  const userGraphs = path.resolve(userHome, ".freelance", "graphs");
  if (fs.existsSync(userGraphs)) {
    dirs.push(userGraphs);
  }

  return dirs;
}

/**
 * Parse CLI --graphs options (repeatable) and merge with defaults.
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
 * Resolve graph directories, load all graphs, and exit on failure.
 */
export function loadGraphsOrFatal(graphsDirs?: string | string[] | null) {
  const dirs = resolveGraphsDirs(graphsDirs);

  if (dirs.length === 0) {
    fatal(
      "No graph directories found or provided.\n\n" +
        "Specify with: --graphs <directory>\n" +
        "Or set: FREELANCE_GRAPHS_DIR=dir1:dir2\n" +
        "Or create: ./.freelance/graphs/ or ~/.freelance/graphs/",
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
