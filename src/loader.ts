/**
 * Public loader API. Orchestrates the three-phase graph loading
 * pipeline — YAML parse + Zod schema → pre-build validation
 * (graph-validation.ts) → graphlib construction + topology checks
 * (graph-construction.ts) — and exposes the multi-file loaders
 * that every caller uses.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { buildAndValidateGraph } from "./graph-construction.js";
import {
  validateContextDescriptors,
  validateExpressions,
  validateReturnSchemas,
} from "./graph-validation.js";
import { resolveGraphHooks } from "./hook-resolution.js";
import { mergeSealedGraphs } from "./memory/sealed.js";

// @dagrejs/graphlib is a CJS bundle with `cjs-module-lexer` named-export
// hints. Node's native ESM loader reads those hints and lets us import
// named exports, but `tsx` does not — `import { Graph }` works under
// `node dist/...` and fails under `tsx src/...`. We don't need the runtime
// Graph export here (graph-construction.ts owns construction); importing
// only the type keeps this file free of the CJS/ESM dance.
type Graph = import("@dagrejs/graphlib").Graph;

import { EC } from "./error-codes.js";
import { EngineError } from "./errors.js";
import type { GraphDefinition } from "./schema/graph-schema.js";
import { graphDefinitionSchema } from "./schema/graph-schema.js";
import type { ValidatedGraph } from "./types.js";

/**
 * Load and validate a single *.workflow.yaml file.
 * Returns the graph id, definition, and graphlib graph.
 * Throws on any validation failure with descriptive errors.
 */
export function loadSingleGraph(filePath: string): { id: string } & ValidatedGraph {
  const resolved = path.resolve(filePath);

  let content: string;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch (err) {
    // ENOENT → the file the operator named doesn't exist (exit 4);
    // any other read failure (permissions, I/O) is structural (exit 1).
    // Without this, a raw fs error would collapse to INTERNAL.
    const code =
      (err as NodeJS.ErrnoException).code === "ENOENT" ? EC.FILE_NOT_FOUND : EC.GRAPH_LOAD_FAILED;
    throw new EngineError(`Cannot read graph file ${resolved}: ${(err as Error).message}`, code);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    // A YAML syntax error means the *.workflow.yaml file is malformed —
    // an authoring-time failure (exit 3), same category as schema
    // validation below. Without this, js-yaml's YAMLException collapses
    // to INTERNAL (#273).
    throw new EngineError(
      `YAML parse failed for ${resolved}:\n  ${(err as Error).message}`,
      EC.GRAPH_STRUCTURE_INVALID,
    );
  }

  const parseResult = graphDefinitionSchema.safeParse(parsed);
  if (!parseResult.success) {
    const errors = parseResult.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new EngineError(
      `Schema validation failed for ${resolved}:\n${errors}`,
      EC.GRAPH_STRUCTURE_INVALID,
    );
  }

  const def = parseResult.data;
  const graph = validateAndBuild(def, resolved);
  const hookResolutions = resolveGraphHooks(def, resolved);

  return { id: def.id, definition: def, graph, hookResolutions };
}

/**
 * Validate a GraphDefinition and build its graphlib graph.
 * This is the shared validation pipeline used by both YAML loading and
 * programmatic graph construction (GraphBuilder).
 *
 * @param def - A valid GraphDefinition (already schema-parsed)
 * @param source - Label for error messages (file path or builder id)
 * @returns The validated graphlib Graph
 */
export function validateAndBuild(def: GraphDefinition, source: string): Graph {
  validateContextDescriptors(def, source);
  validateReturnSchemas(def, source);
  validateExpressions(def, source);
  return buildAndValidateGraph(def, source);
}

/**
 * Recursively find all *.workflow.yaml files under a directory.
 * Skips unreadable subdirectories (permission errors, broken symlinks).
 */
export function findGraphFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      try {
        results.push(...findGraphFiles(full));
      } catch {
        // Skip unreadable directories (permission denied, broken symlinks, etc.)
      }
    } else if (entry.name.endsWith(".workflow.yaml")) {
      results.push(full);
    }
  }
  return results;
}

export interface LoadGraphsOptions {
  /** Built-ins merged before cross-graph validation. User entries win. */
  sealedGraphs?: Map<string, ValidatedGraph>;
}

export interface CollectingLoadResult {
  graphs: Map<string, ValidatedGraph>;
  errors: Array<{ file: string; message: string }>;
}

/**
 * Sentinel `file` value for the single whole-set cross-graph validation
 * failure (unknown subgraph ref, circular ref) — distinct from per-file load
 * failures. Surfaced as data in `loadGraphsCollecting`'s public output; the
 * fail-loud `loadGraphs` wrapper keys off `crossGraphError` instead so it
 * never depends on this string.
 */
const CROSS_GRAPH_FILE = "(cross-graph)";

/** Internal core result: adds the cross-graph signal and the "any files seen"
 * flag that the throwing `loadGraphs` wrapper needs without re-walking. */
interface CoreLoadResult extends CollectingLoadResult {
  /** True if at least one *.workflow.yaml was found under any input dir. */
  sawFiles: boolean;
  /** The whole-set cross-graph failure, if any (also mirrored into `errors`). */
  crossGraphError?: string;
}

/**
 * Shared multi-file load core: list every *.workflow.yaml under each dir,
 * load each into the Map, and accumulate failures as DATA (never stderr).
 * Across dirs, later dirs shadow earlier ones — that is the intended
 * cascade override and drops nothing (the winner loads), so it is NOT
 * reported. Two files in the SAME dir claiming one id IS reported as a
 * warning entry, because there's no defined precedence within a dir so one
 * is genuinely dropped from the listing (SKILL.md: `loadErrors` means a
 * file was dropped). Sealed graphs are merged before cross-graph
 * validation, which only runs when at least one graph loaded (matching the
 * collecting loader's safety guard).
 */
function collectGraphs(dirs: string[], options?: LoadGraphsOptions): CoreLoadResult {
  const graphs = new Map<string, ValidatedGraph>();
  const errors: Array<{ file: string; message: string }> = [];
  // Which dir last claimed each id — lets us tell a same-dir duplicate
  // (ambiguous, one file dropped) from a cross-dir override (intended).
  const idSource = new Map<string, string>();
  let sawFiles = false;

  const existingDirs = dirs.map((d) => path.resolve(d)).filter((d) => fs.existsSync(d));

  for (const resolvedDir of existingDirs) {
    for (const filePath of findGraphFiles(resolvedDir)) {
      sawFiles = true;
      const relFile = path.relative(resolvedDir, filePath);
      try {
        const { id, definition, graph, hookResolutions } = loadSingleGraph(filePath);
        if (idSource.get(id) === resolvedDir) {
          errors.push({
            file: relFile,
            message: `Graph "${id}" is defined by more than one file in ${resolvedDir}`,
          });
        }
        graphs.set(id, { definition, graph, hookResolutions });
        idSource.set(id, resolvedDir);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ file: relFile, message: msg });
      }
    }
  }

  if (options?.sealedGraphs) mergeSealedGraphs(graphs, options.sealedGraphs);

  // Cross-graph validation (only if we have graphs)
  let crossGraphError: string | undefined;
  if (graphs.size > 0) {
    try {
      validateCrossGraphRefs(graphs);
    } catch (e) {
      crossGraphError = e instanceof Error ? e.message : String(e);
      errors.push({ file: CROSS_GRAPH_FILE, message: crossGraphError });
    }
  }

  return { graphs, errors, sawFiles, crossGraphError };
}

/**
 * Load and validate all *.workflow.yaml files from a directory (recursively).
 * Returns a Map of graphId → ValidatedGraph.
 * Throws when nothing loads; otherwise returns the partial Map.
 *
 * This is public lib API (re-exported from core/index.ts) and must NOT emit
 * stderr — partial-failure detail is available via loadGraphsCollecting.
 */
export function loadGraphs(
  directory: string,
  options?: LoadGraphsOptions,
): Map<string, ValidatedGraph> {
  const resolvedDir = path.resolve(directory);

  if (!fs.existsSync(resolvedDir)) {
    throw new EngineError(`Graph directory does not exist: ${resolvedDir}`, EC.NO_GRAPHS_DIR);
  }

  // Single directory walk: collectGraphs reports `sawFiles`, so we derive the
  // "no files" and "all failed" cases from its result instead of pre-scanning.
  const { graphs, errors, sawFiles, crossGraphError } = collectGraphs([resolvedDir], options);

  if (!sawFiles) {
    throw new EngineError(
      `No *.workflow.yaml files found in or under: ${resolvedDir}`,
      EC.NO_GRAPHS_LOADED,
    );
  }

  // Fail loud when nothing loaded; otherwise return the partial Map.
  if (graphs.size === 0 && errors.length > 0) {
    throw new EngineError(
      `All graph(s) failed validation:\n${errors.map((e) => e.message).join("\n")}`,
      EC.NO_GRAPHS_LOADED,
    );
  }

  // Cross-graph validation failures (unknown subgraph ref, circular ref) are a
  // structural defect of the loaded set, not a skippable per-file failure — fail
  // loud even when individual graphs loaded. loadGraphsCollecting surfaces the
  // same failure as data instead.
  if (crossGraphError) {
    throw new EngineError(crossGraphError, EC.GRAPH_STRUCTURE_INVALID);
  }

  return graphs;
}

/**
 * Load and validate all *.workflow.yaml files, collecting errors instead of
 * throwing or writing to stderr. Always returns both graphs and errors.
 * Suitable for contexts where partial success should be surfaced.
 */
export function loadGraphsCollecting(
  directories: string[],
  options?: LoadGraphsOptions,
): CollectingLoadResult {
  const { graphs, errors } = collectGraphs(directories, options);
  return { graphs, errors };
}

export interface ValidateCrossGraphRefsOptions {
  /** IDs accepted as valid subgraph targets without a materialized graph. Treated as leaves by cycle detection. */
  extraAvailableIds?: ReadonlySet<string>;
}

/**
 * Cross-graph validation for subgraph references.
 * 1. Verify all subgraph.graphId references exist in the loaded graph set.
 * 2. Detect circular subgraph references via DFS.
 */
export function validateCrossGraphRefs(
  graphs: Map<string, ValidatedGraph>,
  options?: ValidateCrossGraphRefsOptions,
): void {
  const extra = options?.extraAvailableIds;

  // Build adjacency list for subgraph references
  const subgraphEdges = new Map<string, Set<string>>();

  for (const [graphId, { definition }] of graphs) {
    const targets = new Set<string>();

    for (const [nodeId, node] of Object.entries(definition.nodes)) {
      if (node.subgraph) {
        const targetId = node.subgraph.graphId;

        // Verify referenced graph exists
        if (!graphs.has(targetId) && !extra?.has(targetId)) {
          throw new EngineError(
            `Graph "${graphId}", node "${nodeId}": subgraph references unknown graph "${targetId}"`,
            EC.GRAPH_STRUCTURE_INVALID,
          );
        }

        targets.add(targetId);
      }
    }

    if (targets.size > 0) {
      subgraphEdges.set(graphId, targets);
    }
  }

  // Detect circular references via DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(graphId: string, path: string[]): void {
    if (inStack.has(graphId)) {
      const cycleStart = path.indexOf(graphId);
      const cycle = path.slice(cycleStart).concat(graphId);
      throw new EngineError(
        `Circular subgraph reference detected: ${cycle.join(" → ")}`,
        EC.GRAPH_STRUCTURE_INVALID,
      );
    }
    if (visited.has(graphId)) return;

    visited.add(graphId);
    inStack.add(graphId);
    path.push(graphId);

    const targets = subgraphEdges.get(graphId);
    if (targets) {
      for (const target of targets) {
        dfs(target, [...path]);
      }
    }

    inStack.delete(graphId);
  }

  for (const graphId of graphs.keys()) {
    if (!visited.has(graphId)) {
      dfs(graphId, []);
    }
  }
}
