/**
 * Shared test helpers for temporary directory and environment management.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAndValidateGraph } from "../src/graph-construction.js";
import type { GraphDefinition, ValidatedGraph } from "../src/types.js";

/**
 * Build an in-memory ValidatedGraph map from a single GraphDefinition,
 * running the real construction pipeline so tests exercise the same
 * validation production graphs go through.
 */
export function buildSingleGraphMap(def: GraphDefinition): Map<string, ValidatedGraph> {
  const graph = buildAndValidateGraph(def, "<test>");
  return new Map([[def.id, { definition: def, graph }]]);
}

/** Create a temp directory with a .freelance/ subdirectory. Returns the .freelance/ path. */
export function tmpFreelanceDir(prefix = "test-"): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = path.join(tmp, ".freelance");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run a function with cwd and HOME pointed at a temp directory.
 * Restores both and cleans up the temp dir afterward.
 */
export function withTmpEnv(tmpDir: string, fn: () => void): void {
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  process.chdir(tmpDir);
  process.env.HOME = tmpHome;
  try {
    fn();
  } finally {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}
