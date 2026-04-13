import { EngineError } from "../errors.js";
import { CONTEXT_PATH_PATTERN, resolveContextPath } from "../evaluator.js";
import type { GraphDefinition, HistoryEntry, NodeDefinition, SessionState } from "../types.js";
import { applyContextUpdates, enforceStrictContext } from "./context.js";
import { cloneContext } from "./helpers.js";
import type { OpContext, OpsRegistry } from "./operations.js";
import { evaluateTransitions } from "./transitions.js";

/**
 * Runtime cap for programmatic chain length. The existing cycle validator
 * (graph-construction.ts:validateCycles) rejects cycles without a
 * decision/gate/wait node, which by construction rejects pure-programmatic
 * cycles — so this cap should never fire in a loaded graph. It exists as a
 * backstop for construction-time gaps.
 * @internal
 */
export const MAX_PROGRAMMATIC_STEPS = 32;

export function drainProgrammaticChain(
  session: SessionState,
  graphDef: GraphDefinition,
  opsRegistry: OpsRegistry | undefined,
  opCtx: OpContext | undefined,
): number {
  let steps = 0;
  const visited: string[] = [];

  while (true) {
    const node = graphDef.nodes[session.currentNode];
    if (!node) {
      throw new EngineError(
        `Node "${session.currentNode}" not found in graph "${graphDef.id}"`,
        "NODE_NOT_FOUND",
      );
    }
    if (node.type !== "programmatic") return steps;

    if (steps >= MAX_PROGRAMMATIC_STEPS) {
      throw new EngineError(
        `Programmatic chain exceeded ${MAX_PROGRAMMATIC_STEPS} steps. ` +
          `Path: ${visited.join(" → ")}. The cycle validator should have caught this — ` +
          `check for a pure-programmatic cycle in the graph.`,
        "PROGRAMMATIC_CHAIN_CAP_EXCEEDED",
      );
    }

    if (!opsRegistry || !opCtx) {
      throw new EngineError(
        `Programmatic node "${session.currentNode}" encountered but no ops registry is ` +
          `configured on this engine. Wire an OpsRegistry through the engine constructor.`,
        "NO_OPS_REGISTRY",
      );
    }

    if (!node.operation) {
      throw new EngineError(
        `Programmatic node "${session.currentNode}" has no operation defined`,
        "PROGRAMMATIC_MISSING_OPERATION",
      );
    }

    const handler = opsRegistry.get(node.operation.name);
    if (!handler) {
      throw new EngineError(
        `Unknown operation "${node.operation.name}" on node "${session.currentNode}". ` +
          `Registered ops: [${opsRegistry.list().join(", ")}]`,
        "UNKNOWN_OP",
      );
    }

    const resolvedArgs = resolveOpArgs(node.operation.args ?? {}, session.context);

    let result: Record<string, unknown>;
    try {
      result = handler(resolvedArgs, opCtx);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new EngineError(
        `Operation "${node.operation.name}" failed on node "${session.currentNode}": ${message}`,
        "OP_EXECUTION_FAILED",
      );
    }

    const projected = projectOpResult(
      result,
      node.contextUpdates ?? {},
      node.operation.name,
      session.currentNode,
    );

    enforceStrictContext(graphDef, projected);
    applyContextUpdates(session, projected);

    const chosen = pickOutgoingEdge(node, session.context, session.currentNode);

    const historyEntry: HistoryEntry = {
      node: session.currentNode,
      edge: chosen.label,
      timestamp: new Date().toISOString(),
      contextSnapshot: cloneContext(session.context),
      operation: {
        name: node.operation.name,
        // `projected` is freshly built every iteration and doesn't escape;
        // no clone needed.
        appliedUpdates: projected,
      },
    };
    session.history.push(historyEntry);

    visited.push(session.currentNode);
    session.currentNode = chosen.target;
    session.turnCount = 0;
    steps++;
  }
}

/**
 * Resolve op args against live context. Strings matching CONTEXT_PATH_PATTERN
 * are resolved as dotted paths; everything else (numbers, booleans, null,
 * arrays, objects, plain strings) passes through as a literal.
 */
export function resolveOpArgs(
  args: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && CONTEXT_PATH_PATTERN.test(value)) {
      resolved[key] = resolveContextPath(context, value);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Project op result fields into an updates object for applyContextUpdates.
 * Missing fields are a hard error: an op's return shape and a node's
 * contextUpdates mapping drifting apart is a workflow bug worth surfacing.
 */
export function projectOpResult(
  result: Record<string, unknown>,
  mapping: Record<string, string>,
  opName: string,
  nodeId: string,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [contextKey, resultField] of Object.entries(mapping)) {
    if (!Object.hasOwn(result, resultField)) {
      throw new EngineError(
        `Operation "${opName}" on node "${nodeId}" returned no field "${resultField}" ` +
          `(referenced by contextUpdates["${contextKey}"]). Available fields: ` +
          `[${Object.keys(result).join(", ")}]`,
        "OP_RESULT_FIELD_MISSING",
      );
    }
    projected[contextKey] = result[resultField];
  }
  return projected;
}

/**
 * Pick the first outgoing edge whose condition is met, via evaluateTransitions
 * so programmatic branching shares semantics with the agent-visible path.
 */
export function pickOutgoingEdge(
  node: NodeDefinition,
  context: Record<string, unknown>,
  nodeId: string,
): { label: string; target: string } {
  if (!node.edges || node.edges.length === 0) {
    throw new EngineError(
      `Programmatic node "${nodeId}" has no outgoing edges`,
      "PROGRAMMATIC_NO_EDGES",
    );
  }

  const transitions = evaluateTransitions(node, context);
  const chosen = transitions.find((t) => t.conditionMet);
  if (!chosen) {
    throw new EngineError(
      `No valid outgoing edge from programmatic node "${nodeId}" — no edge condition ` +
        `matched the current context. Add a default edge or broaden conditions.`,
      "PROGRAMMATIC_NO_VALID_EDGE",
    );
  }
  return { label: chosen.label, target: chosen.target };
}
