/**
 * CLI handlers for `freelance config` subcommands — JSON-only.
 *
 * Per docs/decisions.md § "CLI is the execution surface for agents",
 * every CLI verb is agent-driven. These handlers emit structured JSON
 * to stdout and use semantic exit codes. Warnings (e.g. overwrite of
 * an existing memory.dir) still go to stderr as breadcrumbs.
 *
 * - config show      — display resolved configuration with sources
 * - config set-local — modify config.local.yml (used by plugin hooks)
 */

import path from "node:path";
import { loadConfig, loadConfigFromDirs, updateLocalConfig } from "../config.js";
import { resolveGraphsDirs } from "../graph-resolution.js";
import { EXIT, fatal, outputJson } from "./output.js";

// --- config show ---

export function configShow(opts: { workflows?: string | string[] }): void {
  const dirs = resolveGraphsDirs(opts.workflows);
  if (dirs.length === 0) {
    outputJson({ workflows: [], memory: {}, sources: [], graphsDirs: [] });
    return;
  }
  const config = loadConfigFromDirs(dirs);
  outputJson({ ...config, graphsDirs: dirs });
}

// --- config set-local ---

const SETTABLE_KEYS = ["workflows", "memory.dir", "memory.enabled"] as const;

export function configSetLocal(
  key: string,
  value: string,
  opts: { workflows?: string | string[] },
): void {
  const dirs = resolveGraphsDirs(opts.workflows);
  if (dirs.length === 0) {
    fatal(
      "No .freelance directory found. Run `freelance init` first.",
      EXIT.INVALID_INPUT,
      "NO_FREELANCE_DIR",
    );
  }

  const freelanceDir = dirs[0];

  if (key === "workflows") {
    const resolved = path.resolve(value);
    updateLocalConfig(freelanceDir, (config) => {
      const existing = config.workflows ?? [];
      if (existing.includes(resolved)) return config; // idempotent
      return { ...config, workflows: [...existing, resolved] };
    });
  } else if (key === "memory.dir") {
    const resolved = path.resolve(value);
    updateLocalConfig(freelanceDir, (config) => {
      const existing = config.memory?.dir;
      if (existing && existing !== resolved) {
        process.stderr.write(
          `Warning: memory.dir already set to ${existing}, overwriting with ${resolved}\n`,
        );
      }
      return { ...config, memory: { ...config.memory, dir: resolved } };
    });
  } else if (key === "memory.enabled") {
    if (value !== "true" && value !== "false") {
      fatal(
        `memory.enabled must be "true" or "false", got "${value}"`,
        EXIT.INVALID_INPUT,
        "INVALID_CONFIG_VALUE",
      );
    }
    const enabled = value === "true";
    updateLocalConfig(freelanceDir, (config) => {
      return { ...config, memory: { ...config.memory, enabled } };
    });
  } else {
    fatal(
      `Unknown config key: ${key}. Supported: ${SETTABLE_KEYS.join(", ")}`,
      EXIT.INVALID_INPUT,
      "UNKNOWN_CONFIG_KEY",
    );
  }

  outputJson(loadConfig(freelanceDir));
}
