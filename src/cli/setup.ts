/**
 * Shared CLI setup — graph loading and store creation for CLI commands.
 *
 * Mirrors the setup path in src/server.ts but without starting an MCP server.
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

function ensureStateDir(graphsDir: string): string {
  const dir = path.join(graphsDir, ".state");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function resolveStateDb(graphsDirs: string[]): string {
  for (const dir of graphsDirs) {
    if (fs.existsSync(dir)) {
      return path.join(ensureStateDir(dir), "state.db");
    }
  }
  return path.join(ensureStateDir(".freelance"), "state.db");
}

function resolveMemoryDbPath(graphsDirs: string[]): string {
  return path.join(ensureStateDir(graphsDirs[0] ?? ".freelance"), "memory.db");
}

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
  const dbPath = resolveMemoryDbPath(setup.graphsDirs);

  // Load optional overlay from config.yml
  let ignore: string[] | undefined;
  let collections: Array<{ name: string; description: string; paths: string[] }> | undefined;
  for (const dir of setup.graphsDirs) {
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

  const store = new MemoryStore(dbPath, setup.sourceRoot, ignore, collections);
  return { store, setup };
}
