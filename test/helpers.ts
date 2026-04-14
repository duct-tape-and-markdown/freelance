/**
 * Shared test helpers for temporary directory and environment management.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HookRunner } from "../src/engine/hooks.js";
import { GraphEngine } from "../src/engine/index.js";
import { loadGraphs } from "../src/loader.js";
import type { ValidatedGraph } from "../src/types.js";

/**
 * Copy fixture workflow files into a temp directory and return the
 * validated graph map. Each caller gets its own temp dir so tests can
 * run in parallel without stepping on each other's state.
 */
export function loadFixtureGraphs(
  fixturesDir: string,
  prefix: string,
  ...files: string[]
): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const f of files) {
    fs.copyFileSync(path.join(fixturesDir, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

/**
 * Build a GraphEngine with a default (memory-less) HookRunner for
 * engine tests that don't care about hooks. User-script hooks still
 * fire normally; built-in memory hooks throw loudly if a test routes
 * through them.
 */
export function makeEngine(fixturesDir: string, prefix: string, ...files: string[]): GraphEngine {
  return new GraphEngine(loadFixtureGraphs(fixturesDir, prefix, ...files), {
    hookRunner: new HookRunner(),
  });
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
