/**
 * Shared CLI setup — graph loading and store creation.
 *
 * Single source of truth for state directory resolution, DB paths,
 * and memory config parsing. Used by both CLI commands and the MCP
 * entry point in index.ts.
 */

import path from "node:path";
import fs from "node:fs";
import yaml from "js-yaml";
import { TraversalStore } from "../state/index.js";
import { openStateDatabase } from "../state/index.js";
import { MemoryStore, parseMemoryOverlay } from "../memory/index.js";
import { resolveGraphsDirs, resolveSourceRoot, loadGraphsGraceful } from "../graph-resolution.js";
import { extractSection } from "../section-resolver.js";
import type { ValidatedGraph } from "../types.js";
import type { SourceOptions } from "../sources.js";
import type { MemoryConfig } from "../memory/index.js";

// --- State directory resolution ---

function stateDir(graphsDir: string): string {
  return path.join(graphsDir, ".state");
}

export function ensureStateDir(graphsDir: string): string {
  const dir = stateDir(graphsDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function resolveStateDb(graphsDirs: string[]): string {
  for (const dir of graphsDirs) {
    if (fs.existsSync(dir)) {
      return path.join(ensureStateDir(dir), "state.db");
    }
  }
  return path.join(ensureStateDir(".freelance"), "state.db");
}

// --- Memory config resolution ---

export function resolveMemoryConfig(
  graphsDirs: string[],
  opts: { memoryDir?: string; memory?: boolean },
): MemoryConfig | null {
  // Opt-out via --no-memory
  if (opts.memory === false) return null;

  // Default DB path: .state/memory.db inside the first graphs directory
  let dbPath = path.join(ensureStateDir(graphsDirs[0] ?? ".freelance"), "memory.db");

  // CLI flag override
  if (opts.memoryDir) {
    const memDir = path.resolve(opts.memoryDir);
    if (!fs.existsSync(memDir)) {
      fs.mkdirSync(memDir, { recursive: true });
    }
    dbPath = path.join(memDir, "memory.db");
  }

  // Load optional overlay from config.yml (collections, ignore only)
  let ignore: string[] | undefined;
  let collections: Array<{ name: string; description: string; paths: string[] }> | undefined;
  for (const dir of graphsDirs) {
    const configPath = path.join(dir, "config.yml");
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = yaml.load(raw) as Record<string, unknown>;
        if (config?.memory && typeof config.memory === "object") {
          const overlay = parseMemoryOverlay(config.memory as Record<string, unknown>);
          ignore = overlay.ignore;
          collections = overlay.collections;
        }
      } catch {
        // Config parse failure — use defaults
      }
      break;
    }
  }

  return { enabled: true, db: dbPath, ignore, collections };
}

// --- CLI setup helpers ---

export interface CliSetupOptions {
  workflows?: string | string[];
  maxDepth?: number;
  sourceRoot?: string;
}

export interface CliSetup {
  graphs: Map<string, ValidatedGraph>;
  graphsDirs: string[];
  sourceRoot: string | undefined;
  sourceOpts: SourceOptions;
}

/** Load graphs and resolve directories for CLI commands. */
export function loadGraphSetup(opts: CliSetupOptions): CliSetup {
  const graphsDirs = resolveGraphsDirs(opts.workflows);
  const { graphs } = loadGraphsGraceful(opts.workflows);
  const sourceRoot = resolveSourceRoot(graphsDirs, opts.sourceRoot);
  const sectionResolver = (filePath: string, section: string) => extractSection(filePath, section);
  return {
    graphs,
    graphsDirs,
    sourceRoot,
    sourceOpts: { resolver: sectionResolver, basePath: sourceRoot },
  };
}

/** Create a TraversalStore for CLI traversal commands. */
export function createTraversalStore(opts: CliSetupOptions): { store: TraversalStore; setup: CliSetup } {
  const setup = loadGraphSetup(opts);
  const stateDb = resolveStateDb(setup.graphsDirs);
  const db = openStateDatabase(stateDb);
  const maxDepth = opts.maxDepth ?? 5;
  const store = new TraversalStore(db, setup.graphs, { maxDepth });
  return { store, setup };
}

/** Create a MemoryStore for CLI memory commands. */
export function createMemoryStore(opts: CliSetupOptions): { store: MemoryStore; setup: CliSetup } {
  const setup = loadGraphSetup(opts);
  const memConfig = resolveMemoryConfig(setup.graphsDirs, {});
  const store = new MemoryStore(memConfig!.db, setup.sourceRoot, memConfig!.ignore, memConfig!.collections);
  return { store, setup };
}
