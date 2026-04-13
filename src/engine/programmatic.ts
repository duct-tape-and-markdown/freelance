/**
 * Programmatic-node drain loop.
 *
 * When a traversal lands on a `programmatic` node, the engine runs its
 * declared operation server-side, projects the result into context via
 * the node's contextUpdates mapping, picks the first outgoing edge whose
 * condition is met, and advances — all without consuming an agent turn.
 * If the new target is also programmatic, the loop continues until it
 * lands on a non-programmatic node (or a terminal, subgraph, or wait
 * node, which are all handled by the main advance dispatch immediately
 * after this function returns).
 *
 * The drain loop composes with the existing engine helpers rather than
 * duplicating them:
 *
 *   - applyContextUpdates: the same append-only mutation path agent
 *     updates use. Each op's contextUpdates flow through it, which means
 *     every programmatic write lands in contextHistory with the correct
 *     setAt pointer and timestamp.
 *   - enforceStrictContext: the same invariant agents are held to. If a
 *     graph declares strictContext and a programmatic op would write an
 *     undeclared key, the drain loop throws rather than silently bloat
 *     the context shape.
 *   - evaluateTransitions: the same edge-selection semantics every other
 *     part of the engine sees. Default edges, conditional edges, and
 *     unconditional edges all compose through one path.
 *
 * Errors thrown from this loop are EngineError, not AdvanceErrorResult.
 * Op failures signal that the workflow or the engine host is in an
 * inconsistent state — not something the agent can recover from by
 * adjusting context — so they bubble as exceptions. Business-logic
 * branching (empty results, missing entities, zero counts) should be
 * encoded as edge conditions, not as thrown errors; see operations.ts.
 */

import { EngineError } from "../errors.js";
import { CONTEXT_PATH_PATTERN, resolveContextPath } from "../evaluator.js";
import type { GraphDefinition, HistoryEntry, NodeDefinition, SessionState } from "../types.js";
import { applyContextUpdates, enforceStrictContext } from "./context.js";
import { cloneContext } from "./helpers.js";
import type { OpContext, OpsRegistry } from "./operations.js";
import { evaluateTransitions } from "./transitions.js";

/**
 * Belt-and-suspenders runtime guard against runaway programmatic chains.
 * Authoring-time validation in graph-construction.ts rejects any cycle
 * composed entirely of programmatic nodes, so this cap should never fire
 * in a valid graph. If it does, something slipped past the validator.
 */
export const MAX_PROGRAMMATIC_STEPS = 32;

/**
 * Run zero or more programmatic hops from the current session position
 * until the next non-programmatic node is reached. Mutates the session's
 * context, history, currentNode, and turnCount in place. Returns the
 * number of programmatic hops executed (zero if the current node was
 * already non-programmatic).
 */
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
          `Path: ${visited.join(" → ")}. Authoring-time cycle detection should have ` +
          `caught this — report as a validator bug.`,
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
        `Programmatic node "${session.currentNode}" has no operation defined. ` +
          `Graph construction validation should have rejected this.`,
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
        appliedUpdates: cloneContext(projected),
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
 * Resolve a programmatic-node op-arg map against live context. Strings
 * that match the CONTEXT_PATH_PATTERN are resolved as dotted context
 * paths via the expression evaluator's shared path resolver; everything
 * else (numbers, booleans, null, arrays, objects, plain strings) is
 * passed through as a literal. This single rule is the entire arg
 * language in Phase 1 — no interpolation, no expressions, no computed
 * values. If authors need computed args, they write an op that produces
 * them into context and reference the resulting key.
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
 * Project fields from an op result into an updates object usable by
 * applyContextUpdates. Each contextUpdates entry maps a context key to
 * a top-level field name on the op result. Missing fields are a hard
 * error — that means the op's return shape and the node's contextUpdates
 * mapping are out of sync, which is a workflow bug worth surfacing.
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
 * Pick the first outgoing edge from a programmatic node whose condition
 * is met in the current context. Uses evaluateTransitions so the
 * selection semantics — conditional edges, default edges, unconditional
 * edges — are identical to what the agent sees when inspecting valid
 * transitions on a non-programmatic node.
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
