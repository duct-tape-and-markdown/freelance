import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Graph, alg } from "@dagrejs/graphlib";
import { graphDefinitionSchema } from "./schema/graph-schema.js";
import type { GraphDefinition } from "./schema/graph-schema.js";
import type { ValidatedGraph } from "./types.js";
import { validateExpression } from "./evaluator.js";

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
    throw new Error(
      `Schema validation failed for ${resolved}:\n${errors}`
    );
  }

  const def = parseResult.data;
  validateReturnSchemas(def, resolved);
  validateExpressions(def, resolved);
  const graph = buildAndValidateGraph(def, resolved);

  return { id: def.id, definition: def, graph };
}

/**
 * Recursively find all *.workflow.yaml files under a directory.
 */
function findGraphFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findGraphFiles(full));
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
      const { id, definition, graph } = loadSingleGraph(filePath);
      results.set(id, { definition, graph });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (results.size === 0) {
    throw new Error(
      `All ${files.length} graph(s) failed validation:\n${errors.join("\n")}`
    );
  }

  if (errors.length > 0) {
    process.stderr.write(
      `Warning: ${errors.length} graph(s) failed validation and were skipped:\n${errors.join("\n")}\n`
    );
  }

  // Cross-graph validation: subgraph references and circular detection
  validateCrossGraphRefs(results);

  return results;
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
        const { id, definition, graph } = loadSingleGraph(filePath);
        if (results.has(id)) {
          warnings.push(
            `Graph "${id}" from ${resolvedDir} shadows earlier definition from another directory`
          );
        }
        results.set(id, { definition, graph });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    if (errors.length > 0) {
      warnings.push(
        `Warning from ${resolvedDir}: ${errors.length} graph(s) failed validation:\n${errors.join("\n")}`
      );
    }
  }

  if (results.size === 0) {
    const dirs = directories.map((d) => path.resolve(d)).join(", ");
    throw new Error(
      `No valid graphs found in any directory: ${dirs}.\n\nSearched: ${directories.join(" → ")}`
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
 * Validate return schema structure on nodes.
 * - items only valid on array type
 * - required/optional keys must not overlap
 * - terminal nodes must not have returns
 */
function validateReturnSchemas(def: GraphDefinition, filePath: string): void {
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (!node.returns) continue;

    if (node.type === "terminal") {
      throw new Error(
        `[${filePath}] Node "${nodeId}": terminal node must not have a returns schema`
      );
    }

    const requiredKeys = new Set(Object.keys(node.returns.required ?? {}));
    const optionalKeys = new Set(Object.keys(node.returns.optional ?? {}));

    for (const key of optionalKeys) {
      if (requiredKeys.has(key)) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": returns key "${key}" appears in both required and optional`
        );
      }
    }

    const allFields = {
      ...(node.returns.required ?? {}),
      ...(node.returns.optional ?? {}),
    };

    for (const [key, field] of Object.entries(allFields)) {
      if (field.items && field.type !== "array") {
        throw new Error(
          `[${filePath}] Node "${nodeId}": returns key "${key}" has "items" but type is "${field.type}" (items only valid on array type)`
        );
      }
    }
  }
}

/**
 * Parse-check all expressions in edge conditions and validation rules.
 * Catches malformed expressions at load time, not at traversal time.
 */
function validateExpressions(def: GraphDefinition, filePath: string): void {
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (node.validations) {
      for (const v of node.validations) {
        try {
          validateExpression(v.expr);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            `[${filePath}] Node "${nodeId}": invalid validation expression "${v.expr}": ${msg}`
          );
        }
      }
    }
    if (node.edges) {
      for (const edge of node.edges) {
        if (edge.condition) {
          try {
            validateExpression(edge.condition);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(
              `[${filePath}] Node "${nodeId}": edge "${edge.label}" has invalid condition "${edge.condition}": ${msg}`
            );
          }
        }
      }
    }
    // Validate subgraph condition expression
    if (node.subgraph?.condition) {
      try {
        validateExpression(node.subgraph.condition);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `[${filePath}] Node "${nodeId}": invalid subgraph condition "${node.subgraph.condition}": ${msg}`
        );
      }
    }
  }
}

function buildAndValidateGraph(def: GraphDefinition, filePath: string): Graph {
  const g = new Graph({ directed: true });
  const nodeIds = Object.keys(def.nodes);

  // Add all nodes
  for (const nodeId of nodeIds) {
    g.setNode(nodeId, def.nodes[nodeId]);
  }

  // Validate startNode exists
  if (!def.nodes[def.startNode]) {
    throw new Error(
      `[${filePath}] startNode "${def.startNode}" is not defined in nodes`
    );
  }

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    // Terminal nodes cannot have subgraph
    if (node.type === "terminal" && node.subgraph) {
      throw new Error(
        `[${filePath}] Node "${nodeId}": terminal node must not have a subgraph`
      );
    }

    if (node.type === "terminal") {
      // (d) Terminal nodes must have zero outgoing edges
      if (node.edges && node.edges.length > 0) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": terminal node must not have outgoing edges`
        );
      }
    } else {
      // (c) Non-terminal nodes must have at least one outgoing edge
      if (!node.edges || node.edges.length === 0) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": non-terminal node of type "${node.type}" must have at least one outgoing edge`
        );
      }

      // Add edges to graph and validate targets
      for (const edge of node.edges) {
        // (a) All edge targets must point to defined nodes
        if (!def.nodes[edge.target]) {
          throw new Error(
            `[${filePath}] Node "${nodeId}": edge "${edge.label}" targets undefined node "${edge.target}"`
          );
        }
        g.setEdge(nodeId, edge.target, edge.label);
      }
    }

    // (f) Gate nodes must have at least one validation
    if (node.type === "gate") {
      if (!node.validations || node.validations.length === 0) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": gate node must have at least one validation`
        );
      }
    }

    // Wait nodes must have at least one waitOn entry
    if (node.type === "wait") {
      if (!node.waitOn || node.waitOn.length === 0) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": wait node must have at least one waitOn entry`
        );
      }
    }
  }

  // (e) No orphan nodes — all nodes reachable from startNode
  const reachable = new Set<string>();
  const preorder = alg.preorder(g, [def.startNode]);
  for (const nodeId of preorder) {
    reachable.add(nodeId);
  }
  for (const nodeId of nodeIds) {
    if (!reachable.has(nodeId)) {
      throw new Error(
        `[${filePath}] Node "${nodeId}": unreachable from startNode "${def.startNode}"`
      );
    }
  }

  // (g) Cycles must include at least one decision or gate node
  validateCycles(g, def, filePath);

  return g;
}

/**
 * Detect cycles and ensure each cycle contains at least one decision or gate node.
 * Uses Tarjan's SCC algorithm — any SCC with size > 1 is a cycle.
 * Also check self-loops (single-node SCCs with an edge to themselves).
 */
function validateCycles(
  g: Graph,
  def: GraphDefinition,
  filePath: string
): void {
  const sccs = alg.tarjan(g);

  for (const scc of sccs) {
    // Only check SCCs that form actual cycles
    const isCycle =
      scc.length > 1 ||
      (scc.length === 1 && g.hasEdge(scc[0], scc[0]));

    if (!isCycle) continue;

    const hasBreakingNode = scc.some((nodeId) => {
      const nodeType = def.nodes[nodeId]?.type;
      return nodeType === "decision" || nodeType === "gate" || nodeType === "wait";
    });

    if (!hasBreakingNode) {
      throw new Error(
        `[${filePath}] Cycle detected among nodes [${scc.join(", ")}] with no decision, gate, or wait node. ` +
          `Cycles must include at least one decision, gate, or wait node to prevent infinite action loops.`
      );
    }
  }
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
            `Graph "${graphId}", node "${nodeId}": subgraph references unknown graph "${targetId}"`
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
      throw new Error(
        `Circular subgraph reference detected: ${cycle.join(" → ")}`
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
