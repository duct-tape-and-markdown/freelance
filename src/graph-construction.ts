/**
 * graphlib Graph construction + topology validation.
 *
 * Runs after graph-validation.ts's pure checks pass. Builds the
 * graphlib Graph by adding every node and edge, then enforces the
 * structural rules: startNode must exist, all edge targets must
 * resolve, terminals have no outgoing edges, non-terminals have at
 * least one, gates have validations, wait nodes have waitOn, all
 * nodes are reachable from startNode, and every cycle includes at
 * least one decision/gate/wait node.
 */

// @dagrejs/graphlib — see loader.ts for the createRequire explanation
// (tsx can't resolve named ESM exports from the CJS bundle).
import { createRequire } from "node:module";
import type { OpsRegistry } from "./engine/operations.js";
import type { GraphDefinition, NodeDefinition } from "./schema/graph-schema.js";

const { Graph, alg } = createRequire(import.meta.url)(
  "@dagrejs/graphlib",
) as typeof import("@dagrejs/graphlib");
type Graph = import("@dagrejs/graphlib").Graph;

/**
 * Fields that a programmatic node must not carry. Each of these is either
 * agent-facing (instructions, suggestedTools, maxTurns, readOnly) or
 * belongs to a different node-type contract (validations, returns, waitOn,
 * timeout, subgraph). Programmatic nodes are engine-internal execution
 * points; they compose with the rest of the graph only through their
 * operation, contextUpdates, and outgoing edges.
 */
const PROGRAMMATIC_FORBIDDEN_FIELDS: ReadonlyArray<keyof NodeDefinition> = [
  "instructions",
  "suggestedTools",
  "maxTurns",
  "readOnly",
  "validations",
  "returns",
  "subgraph",
  "waitOn",
  "timeout",
];

export function buildAndValidateGraph(
  def: GraphDefinition,
  filePath: string,
  opsRegistry?: OpsRegistry,
): Graph {
  const g = new Graph({ directed: true });
  const nodeIds = Object.keys(def.nodes);

  // Add all nodes
  for (const nodeId of nodeIds) {
    g.setNode(nodeId, def.nodes[nodeId]);
  }

  // Validate startNode exists
  if (!def.nodes[def.startNode]) {
    throw new Error(`[${filePath}] startNode "${def.startNode}" is not defined in nodes`);
  }

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    // Terminal nodes cannot have subgraph
    if (node.type === "terminal" && node.subgraph) {
      throw new Error(`[${filePath}] Node "${nodeId}": terminal node must not have a subgraph`);
    }

    if (node.type === "terminal") {
      // (d) Terminal nodes must have zero outgoing edges
      if (node.edges && node.edges.length > 0) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": terminal node must not have outgoing edges`,
        );
      }
    } else {
      // (c) Non-terminal nodes must have at least one outgoing edge
      if (!node.edges || node.edges.length === 0) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": non-terminal node of type "${node.type}" must have at least one outgoing edge`,
        );
      }

      // Add edges to graph and validate targets
      for (const edge of node.edges) {
        // (a) All edge targets must point to defined nodes
        if (!def.nodes[edge.target]) {
          throw new Error(
            `[${filePath}] Node "${nodeId}": edge "${edge.label}" targets undefined node "${edge.target}"`,
          );
        }
        g.setEdge(nodeId, edge.target, edge.label);
      }
    }

    // (f) Gate nodes must have at least one validation
    if (node.type === "gate") {
      if (!node.validations || node.validations.length === 0) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": gate node must have at least one validation`,
        );
      }
    }

    // Wait nodes must have at least one waitOn entry
    if (node.type === "wait") {
      if (!node.waitOn || node.waitOn.length === 0) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": wait node must have at least one waitOn entry`,
        );
      }
    }

    // Programmatic node constraints. Enforced post-Zod so the schema stays
    // a simple flat shape (see src/schema/graph-schema.ts).
    if (node.type === "programmatic") {
      if (!node.operation) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": programmatic node must declare an operation`,
        );
      }
      for (const field of PROGRAMMATIC_FORBIDDEN_FIELDS) {
        if (node[field] !== undefined) {
          throw new Error(
            `[${filePath}] Node "${nodeId}": programmatic node must not have "${field}". ` +
              `Programmatic nodes are engine-internal; they compose through operation, ` +
              `contextUpdates, and edges only.`,
          );
        }
      }
      if (opsRegistry && !opsRegistry.has(node.operation.name)) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": unknown operation "${node.operation.name}". ` +
            `Registered ops: [${opsRegistry.list().join(", ")}]`,
        );
      }
    } else {
      if (node.operation !== undefined) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": only programmatic nodes may have "operation" ` +
            `(got type "${node.type}")`,
        );
      }
      if (node.contextUpdates !== undefined) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": only programmatic nodes may have "contextUpdates" ` +
            `(got type "${node.type}")`,
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
        `[${filePath}] Node "${nodeId}": unreachable from startNode "${def.startNode}"`,
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
function validateCycles(g: Graph, def: GraphDefinition, filePath: string): void {
  const sccs = alg.tarjan(g);

  for (const scc of sccs) {
    // Only check SCCs that form actual cycles
    const isCycle = scc.length > 1 || (scc.length === 1 && g.hasEdge(scc[0], scc[0]));

    if (!isCycle) continue;

    const hasBreakingNode = scc.some((nodeId) => {
      const nodeType = def.nodes[nodeId]?.type;
      return nodeType === "decision" || nodeType === "gate" || nodeType === "wait";
    });

    if (!hasBreakingNode) {
      throw new Error(
        `[${filePath}] Cycle detected among nodes [${scc.join(", ")}] with no decision, gate, or wait node. ` +
          `Cycles must include at least one decision, gate, or wait node to prevent infinite action loops.`,
      );
    }
  }
}
