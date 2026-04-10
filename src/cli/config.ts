/**
 * CLI handlers for `freelance config` subcommands.
 *
 * - config show     — display resolved configuration with sources
 * - config set-local — modify config.local.yml (used by plugin hooks)
 */

import path from "node:path";
import { loadConfig, loadConfigFromDirs, updateLocalConfig } from "../config.js";
import { resolveGraphsDirs } from "../graph-resolution.js";
import { cli, info, outputJson, fatal, EXIT } from "./output.js";

// --- config show ---

export function configShow(opts: { workflows?: string | string[] }): void {
  const dirs = resolveGraphsDirs(opts.workflows);
  if (dirs.length === 0) {
    if (cli.json) {
      outputJson({ workflows: [], memory: {}, sources: [], graphsDirs: [] });
    } else {
      info("No configuration found.");
      info("Run `freelance init` or specify --workflows.");
    }
    return;
  }

  const config = loadConfigFromDirs(dirs);

  if (cli.json) {
    outputJson({ ...config, graphsDirs: dirs });
    return;
  }

  info("Resolved configuration:\n");

  info("  Graph directories:");
  for (const d of dirs) {
    info(`    - ${d}`);
  }

  if (config.workflows.length) {
    info("\n  Additional workflows (from config):");
    for (const w of config.workflows) {
      info(`    - ${w}`);
    }
  }

  info(`\n  Memory:`);
  info(`    enabled: ${config.memory.enabled ?? "true (default)"}`);
  if (config.memory.dir) {
    info(`    dir: ${config.memory.dir}`);
  }
  if (config.memory.ignore?.length) {
    info(`    ignore: ${config.memory.ignore.join(", ")}`);
  }
  if (config.memory.collections?.length) {
    info(`    collections: ${config.memory.collections.map((c) => c.name).join(", ")}`);
  }

  if (config.sources.length) {
    info(`\n  Loaded from:`);
    for (const s of config.sources) {
      info(`    - ${s}`);
    }
  }
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
    fatal("No .freelance directory found. Run `freelance init` first.", EXIT.INVALID_USAGE);
  }

  const freelanceDir = dirs[0];

  if (key === "workflows") {
    const resolved = path.resolve(value);
    updateLocalConfig(freelanceDir, (config) => {
      const existing = config.workflows ?? [];
      if (existing.includes(resolved)) return config; // idempotent
      return { ...config, workflows: [...existing, resolved] };
    });
    info(`Added workflow directory: ${resolved}`);
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
    info(`Set memory.dir: ${resolved}`);
  } else if (key === "memory.enabled") {
    if (value !== "true" && value !== "false") {
      fatal(`memory.enabled must be "true" or "false", got "${value}"`, EXIT.INVALID_USAGE);
    }
    const enabled = value === "true";
    updateLocalConfig(freelanceDir, (config) => {
      return { ...config, memory: { ...config.memory, enabled } };
    });
    info(`Set memory.enabled: ${enabled}`);
  } else {
    fatal(`Unknown config key: ${key}. Supported: ${SETTABLE_KEYS.join(", ")}`, EXIT.INVALID_USAGE);
  }

  if (cli.json) {
    const config = loadConfig(freelanceDir);
    outputJson(config);
  }
}
