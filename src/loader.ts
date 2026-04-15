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
import { validateExpressions, validateReturnSchemas } from "./graph-validation.js";
import { resolveGraphHooks } from "./hook-resolution.js";

// @dagrejs/graphlib is a CJS bundle with `cjs-module-lexer` named-export
// hints. Node's native ESM loader reads those hints and lets us import
// named exports, but `tsx` does not — `import { Graph }` works under
// `node dist/...` and fails under `tsx src/...`. We don't need the runtime
// Graph export here (graph-construction.ts owns construction); importing
// only the type keeps this file free of the CJS/ESM dance.
type Graph = import("@dagrejs/graphlib").Graph;

import type { GraphDefinition } from "./schema/graph-schema.js";
import { graphDefinitionSchema, isContextFieldDescriptor } from "./schema/graph-schema.js";
import type { ValidatedGraph } from "./types.js";

/**
 * Load and validate a single *.workflow.yaml file.
 * Returns the graph id, definition, and graphlib graph.
 * Throws on any validation failure with descriptive errors.
 */
export function loadSingleGraph(filePath: string): { id: string } & ValidatedGraph {
  const resolved = path.resolve(filePath);
  const content = fs.readFileSync(resolved, "utf-8");
  const parsed = yaml.load(content);

  const parseResult = graphDefinitionSchema.safeParse(parsed);
  if (!parseResult.success) {
    const errors = parseResult.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Schema validation failed for ${resolved}:\n${errors}`);
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
  validateReturnSchemas(def, source);
  validateExpressions(def, source);
  return buildAndValidateGraph(def, source);
}

/**
 * Resolve context field descriptors to their default values.
 * Plain scalars pass through unchanged; descriptors are replaced by their default.
 */
export function resolveContextDefaults(context: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    resolved[key] = isContextFieldDescriptor(value) ? (value.default ?? null) : value;
  }
  return resolved;
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

/**
 * Load and validate all *.workflow.yaml files from a directory (recursively).
 * Returns a Map of graphId → ValidatedGraph.
 * Throws on any validation failure with descriptive errors.
 */
export function loadGraphs(directory: string): Map<string, ValidatedGraph> {
  const resolvedDir = path.resolve(directory);

  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Graph directory does not exist: ${resolvedDir}`);
  }

  const files = findGraphFiles(resolvedDir);

  if (files.length === 0) {
    throw new Error(`No *.workflow.yaml files found in or under: ${resolvedDir}`);
  }

  const results = new Map<string, ValidatedGraph>();
  const errors: string[] = [];

  for (const filePath of files) {
    try {
      const { id, definition, graph, hookResolutions } = loadSingleGraph(filePath);
      results.set(id, { definition, graph, hookResolutions });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (results.size === 0) {
    throw new Error(`All ${files.length} graph(s) failed validation:\n${errors.join("\n")}`);
  }

  if (errors.length > 0) {
    process.stderr.write(
      `Warning: ${errors.length} graph(s) failed validation and were skipped:\n${errors.join("\n")}\n`,
    );
  }

  // Cross-graph validation: subgraph references and circular detection
  validateCrossGraphRefs(results);

  return results;
}

export interface CollectingLoadResult {
  graphs: Map<string, ValidatedGraph>;
  errors: Array<{ file: string; message: string }>;
}

/**
 * Load and validate all *.workflow.yaml files, collecting errors instead of
 * throwing or writing to stderr. Always returns both graphs and errors.
 * Suitable for contexts where partial success should be surfaced.
 */
export function loadGraphsCollecting(directories: string[]): CollectingLoadResult {
  const graphs = new Map<string, ValidatedGraph>();
  const errors: Array<{ file: string; message: string }> = [];

  const resolvedDirs = directories.map((d) => path.resolve(d));
  const existingDirs = resolvedDirs.filter((d) => fs.existsSync(d));

  if (existingDirs.length === 0) {
    return { graphs, errors };
  }

  for (const resolvedDir of existingDirs) {
    const files = findGraphFiles(resolvedDir);

    for (const filePath of files) {
      const relFile = path.relative(resolvedDir, filePath);
      try {
        const { id, definition, graph, hookResolutions } = loadSingleGraph(filePath);
        graphs.set(id, { definition, graph, hookResolutions });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ file: relFile, message: msg });
      }
    }
  }

  // Cross-graph validation (only if we have graphs)
  if (graphs.size > 0) {
    try {
      validateCrossGraphRefs(graphs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ file: "(cross-graph)", message: msg });
    }
  }

  return { graphs, errors };
}

/**
 * Load and validate graphs from multiple directories with cascading resolution.
 * Later directories shadow earlier ones (same graph ID in later dir wins).
 * Non-existent or empty directories are skipped with warnings.
 * Returns a Map of graphId → ValidatedGraph.
 */
export function loadGraphsLayered(directories: string[]): Map<string, ValidatedGraph> {
  const results = new Map<string, ValidatedGraph>();
  const warnings: string[] = [];

  if (directories.length === 0) {
    throw new Error("No graph directories provided");
  }

  // Load in order so later directories override earlier ones
  for (const dir of directories) {
    const resolvedDir = path.resolve(dir);

    if (!fs.existsSync(resolvedDir)) {
      warnings.push(`Skipped ${resolvedDir}: directory does not exist`);
      continue;
    }

    const files = findGraphFiles(resolvedDir);

    if (files.length === 0) {
      warnings.push(`Skipped ${resolvedDir}: no *.workflow.yaml files found in or under directory`);
      continue;
    }

    const errors: string[] = [];

    for (const filePath of files) {
      try {
        const { id, definition, graph, hookResolutions } = loadSingleGraph(filePath);
        if (results.has(id)) {
          warnings.push(
            `Graph "${id}" from ${resolvedDir} shadows earlier definition from another directory`,
          );
        }
        results.set(id, { definition, graph, hookResolutions });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    if (errors.length > 0) {
      warnings.push(
        `Warning from ${resolvedDir}: ${errors.length} graph(s) failed validation:\n${errors.join("\n")}`,
      );
    }
  }

  if (results.size === 0) {
    const dirs = directories.map((d) => path.resolve(d)).join(", ");
    throw new Error(
      `No valid graphs found in any directory: ${dirs}.\n\nSearched: ${directories.join(" → ")}`,
    );
  }

  // Emit warnings after successful load
  if (warnings.length > 0) {
    process.stderr.write(`Warnings:\n${warnings.join("\n")}\n`);
  }

  // Cross-graph validation: subgraph references and circular detection
  validateCrossGraphRefs(results);

  return results;
}

/**
 * Cross-graph validation for subgraph references.
 * 1. Verify all subgraph.graphId references exist in the loaded graph set.
 * 2. Detect circular subgraph references via DFS.
 */
export function validateCrossGraphRefs(graphs: Map<string, ValidatedGraph>): void {
  // Build adjacency list for subgraph references
  const subgraphEdges = new Map<string, Set<string>>();

  for (const [graphId, { definition }] of graphs) {
    const targets = new Set<string>();

    for (const [nodeId, node] of Object.entries(definition.nodes)) {
      if (node.subgraph) {
        const targetId = node.subgraph.graphId;

        // Verify referenced graph exists
        if (!graphs.has(targetId)) {
          throw new Error(
            `Graph "${graphId}", node "${nodeId}": subgraph references unknown graph "${targetId}"`,
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
      throw new Error(`Circular subgraph reference detected: ${cycle.join(" → ")}`);
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
