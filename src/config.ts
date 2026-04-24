/**
 * Freelance configuration loading and merging.
 *
 * Two config files, same schema, layered:
 *   .freelance/config.yml        — committed, team-shared
 *   .freelance/config.local.yml  — gitignored, machine-specific (plugin hooks)
 *
 * Merge rules:
 *   - Arrays (workflows) concatenate across files
 *   - Scalars (memory.enabled, memory.dir, maxDepth, hooks.timeoutMs)
 *     use local over base
 *
 * Per-field CLI / env / config surface (see README.md for the full table):
 *   workflows        — CLI: --workflows (repeatable); env: FREELANCE_WORKFLOWS
 *   memory.enabled   — CLI: --memory / --no-memory
 *   memory.dir       — CLI: --memory-dir
 *   maxDepth         — CLI: --max-depth
 *   hooks.timeoutMs  — config-only; no CLI flag or env var
 *   sourceRoot       — CLI: --source-root; computed from graphsDir otherwise
 *
 * Callers in src/cli/program.ts and src/cli/setup.ts apply the CLI
 * overrides on top of the parsed file config. This module is purely
 * the file-layer loader and merger.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

// --- Schema ---

const pruneSchema = z
  .object({
    /**
     * Default preserve set for `memory prune --keep`. CLI `--keep`
     * flags concatenate on top of this list. No hardcoded `main` —
     * users opt in to a preserve set explicitly.
     */
    keep: z.array(z.string()).optional(),
  })
  .optional();

const memorySchema = z
  .object({
    enabled: z.boolean().optional(),
    dir: z.string().optional(),
    prune: pruneSchema,
  })
  .optional();

const hooksSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
  })
  .optional();

const contextSchema = z
  .object({
    maxValueBytes: z.number().int().positive().optional(),
    maxTotalBytes: z.number().int().positive().optional(),
  })
  .optional();

const configSchema = z.object({
  workflows: z.array(z.string()).optional(),
  memory: memorySchema,
  hooks: hooksSchema,
  context: contextSchema,
  maxDepth: z.number().int().positive().optional(),
});

type FreelanceConfigFile = z.infer<typeof configSchema>;

/** Resolved config with provenance tracking. */
export interface FreelanceConfig {
  workflows: string[];
  memory: {
    enabled?: boolean;
    dir?: string;
    prune?: {
      keep?: string[];
    };
  };
  hooks: {
    timeoutMs?: number;
  };
  context: {
    maxValueBytes?: number;
    maxTotalBytes?: number;
  };
  /** Max subgraph stack depth. CLI `--max-depth` overrides this. */
  maxDepth?: number;
  /** Which files contributed to this config, in load order. */
  sources: string[];
}

// --- Loading ---

const CONFIG_FILE = "config.yml";
const CONFIG_LOCAL_FILE = "config.local.yml";

/** Parse and validate a single config file. Returns null if file doesn't exist or is invalid. */
function loadConfigFile(filePath: string): FreelanceConfigFile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return configSchema.parse(parsed);
  } catch {
    return null;
  }
}

/** Resolve relative paths in a config file relative to a base directory. */
function resolvePaths(config: FreelanceConfigFile, baseDir: string): FreelanceConfigFile {
  const resolved = { ...config };
  if (resolved.workflows) {
    resolved.workflows = resolved.workflows.map((w) => path.resolve(baseDir, w));
  }
  if (resolved.memory?.dir) {
    resolved.memory = { ...resolved.memory, dir: path.resolve(baseDir, resolved.memory.dir) };
  }
  return resolved;
}

/**
 * Merge two config objects. Arrays (e.g. workflows) concatenate so
 * plugin hooks can extend project-level values without clobbering them.
 * Scalars use the overlay value.
 */
function mergeConfigs(
  base: FreelanceConfigFile,
  overlay: FreelanceConfigFile,
): FreelanceConfigFile {
  const merged: FreelanceConfigFile = { ...base };

  if (overlay.workflows?.length) {
    merged.workflows = [...(base.workflows ?? []), ...overlay.workflows];
  }

  if (overlay.memory) {
    const baseMem = base.memory ?? {};
    // `keep` concatenates like top-level `workflows` so plugin/local
    // config can extend the preserve set without clobbering project
    // defaults. Dedup on merge — refs match by exact string, so
    // `[main]` + `[main]` yielded `[main, main]` previously and
    // showed twice in `freelance config show`. Harmless at resolve
    // time (same SHA), cosmetically ugly.
    const mergedPrune = overlay.memory.prune?.keep?.length
      ? {
          keep: [...new Set([...(baseMem.prune?.keep ?? []), ...overlay.memory.prune.keep])],
        }
      : baseMem.prune;
    merged.memory = {
      ...baseMem,
      ...(overlay.memory.enabled !== undefined ? { enabled: overlay.memory.enabled } : {}),
      ...(overlay.memory.dir !== undefined ? { dir: overlay.memory.dir } : {}),
      ...(mergedPrune ? { prune: mergedPrune } : {}),
    };
  }

  if (overlay.hooks) {
    merged.hooks = { ...(base.hooks ?? {}), ...overlay.hooks };
  }

  if (overlay.context) {
    merged.context = { ...(base.context ?? {}), ...overlay.context };
  }

  if (overlay.maxDepth !== undefined) {
    merged.maxDepth = overlay.maxDepth;
  }

  return merged;
}

/** Normalize a raw config file into the resolved FreelanceConfig shape. */
function toFreelanceConfig(merged: FreelanceConfigFile, sources: string[]): FreelanceConfig {
  const keep = merged.memory?.prune?.keep;
  return {
    workflows: merged.workflows ?? [],
    memory: {
      enabled: merged.memory?.enabled,
      dir: merged.memory?.dir,
      ...(keep?.length ? { prune: { keep } } : {}),
    },
    hooks: {
      timeoutMs: merged.hooks?.timeoutMs,
    },
    context: {
      maxValueBytes: merged.context?.maxValueBytes,
      maxTotalBytes: merged.context?.maxTotalBytes,
    },
    maxDepth: merged.maxDepth,
    sources,
  };
}

/**
 * Load and merge config from a .freelance/ directory.
 * Reads config.yml (base) and config.local.yml (local overrides).
 * Paths in both files resolve relative to the directory containing them.
 */
export function loadConfig(freelanceDir: string): FreelanceConfig {
  const sources: string[] = [];
  let merged: FreelanceConfigFile = {};

  const basePath = path.join(freelanceDir, CONFIG_FILE);
  const base = loadConfigFile(basePath);
  if (base) {
    merged = resolvePaths(base, freelanceDir);
    sources.push(basePath);
  }

  const localPath = path.join(freelanceDir, CONFIG_LOCAL_FILE);
  const local = loadConfigFile(localPath);
  if (local) {
    merged = mergeConfigs(merged, resolvePaths(local, freelanceDir));
    sources.push(localPath);
  }

  return toFreelanceConfig(merged, sources);
}

/**
 * Load config from multiple .freelance/ directories (project + user level).
 * Merges at the raw schema level so there's a single merge codepath,
 * then normalizes once at the end.
 */
export function loadConfigFromDirs(dirs: string[]): FreelanceConfig {
  if (dirs.length === 0) {
    return { workflows: [], memory: {}, hooks: {}, context: {}, sources: [] };
  }

  let mergedFile: FreelanceConfigFile = {};
  const allSources: string[] = [];

  for (const dir of dirs) {
    const basePath = path.join(dir, CONFIG_FILE);
    const base = loadConfigFile(basePath);
    if (base) {
      mergedFile = mergeConfigs(mergedFile, resolvePaths(base, dir));
      allSources.push(basePath);
    }

    const localPath = path.join(dir, CONFIG_LOCAL_FILE);
    const local = loadConfigFile(localPath);
    if (local) {
      mergedFile = mergeConfigs(mergedFile, resolvePaths(local, dir));
      allSources.push(localPath);
    }
  }

  return toFreelanceConfig(mergedFile, allSources);
}

// --- Writing (for `config set-local`) ---

/**
 * Read, modify, and write config.local.yml atomically.
 * Creates the file if it doesn't exist.
 */
export function updateLocalConfig(
  freelanceDir: string,
  updater: (config: FreelanceConfigFile) => FreelanceConfigFile,
): void {
  const localPath = path.join(freelanceDir, CONFIG_LOCAL_FILE);
  const existing = loadConfigFile(localPath) ?? {};
  const updated = updater(existing);
  const content = yaml.dump(updated, { lineWidth: -1, noRefs: true });
  fs.writeFileSync(localPath, content, "utf-8");
}
