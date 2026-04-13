import { EngineError } from "../errors.js";
import type {
  ContextSetResult,
  GraphDefinition,
  InspectFullResult,
  InspectHistoryResult,
  InspectPositionResult,
  InspectResult,
  NodeDefinition,
  SessionState,
  StackEntry,
  WaitCondition,
} from "../types.js";
import { cloneContext, toNodeInfo } from "./helpers.js";
import { evaluateTransitions } from "./transitions.js";
import { checkWaitTimeout, computeTimeoutAt, evaluateWaitConditions } from "./wait.js";

export function applyContextUpdates(session: SessionState, updates: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  for (const [key, value] of Object.entries(updates)) {
    session.context[key] = value;
    session.contextHistory.push({
      key,
      value,
      setAt: session.currentNode,
      timestamp,
    });
  }
}

export function enforceStrictContext(def: GraphDefinition, updates: Record<string, unknown>): void {
  if (!def.strictContext) return;
  const declaredKeys = new Set(Object.keys(def.context ?? {}));
  for (const key of Object.keys(updates)) {
    if (!declaredKeys.has(key)) {
      throw new EngineError(
        `Key "${key}" is not declared in the graph's context schema (strictContext is enabled)`,
        "STRICT_CONTEXT_VIOLATION",
      );
    }
  }
}

export function buildStackView(stack: SessionState[]): StackEntry[] {
  return stack.map((s, i) => {
    if (i === stack.length - 1) {
      return { graphId: s.graphId, currentNode: s.currentNode };
    }
    return { graphId: s.graphId, suspendedAt: s.currentNode };
  });
}

function computeTurnWarning(nodeDef: NodeDefinition, turnCount: number): string | null {
  if (!nodeDef.maxTurns || turnCount < nodeDef.maxTurns) return null;
  return `Turn budget reached (${turnCount}/${nodeDef.maxTurns}). Consider wrapping up and advancing to the next node.`;
}

export function buildContextSetResult(
  session: SessionState,
  nodeDef: NodeDefinition,
): ContextSetResult {
  return {
    status: "updated",
    isError: false,
    currentNode: session.currentNode,
    context: cloneContext(session.context),
    validTransitions: evaluateTransitions(nodeDef, session.context),
    turnCount: session.turnCount,
    turnWarning: computeTurnWarning(nodeDef, session.turnCount),
  };
}

export function buildInspectResult(
  detail: "position" | "full" | "history",
  session: SessionState,
  def: GraphDefinition,
  stack: SessionState[],
): InspectResult {
  switch (detail) {
    case "history":
      return {
        graphId: session.graphId,
        currentNode: session.currentNode,
        traversalHistory: session.history,
        contextHistory: session.contextHistory,
      } satisfies InspectHistoryResult;

    case "full":
      return {
        graphId: session.graphId,
        currentNode: session.currentNode,
        definition: def,
        context: cloneContext(session.context),
      } satisfies InspectFullResult;

    case "position": {
      const currentNodeDef = def.nodes[session.currentNode];
      const waitInfo = computeWaitInfo(session, currentNodeDef);

      return {
        graphId: session.graphId,
        graphName: def.name,
        currentNode: session.currentNode,
        node: toNodeInfo(currentNodeDef),
        validTransitions: evaluateTransitions(currentNodeDef, session.context),
        context: cloneContext(session.context),
        turnCount: session.turnCount,
        turnWarning: computeTurnWarning(currentNodeDef, session.turnCount),
        stackDepth: stack.length,
        stack: buildStackView(stack),
        ...(def.sources && def.sources.length > 0 ? { graphSources: def.sources } : {}),
        ...waitInfo,
      } satisfies InspectPositionResult;
    }
  }
}

function computeWaitInfo(
  session: SessionState,
  nodeDef: NodeDefinition,
): {
  waitStatus?: "waiting" | "ready" | "timed_out";
  waitingOn?: WaitCondition[];
  timeout?: string;
  timeoutAt?: string;
} {
  if (nodeDef.type !== "wait" || !nodeDef.waitOn) return {};

  const timedOut = checkWaitTimeout(session, nodeDef);
  const waitConditions = evaluateWaitConditions(nodeDef.waitOn, session.context);
  const allSatisfied = waitConditions.every((w) => w.satisfied);

  let waitStatus: "waiting" | "ready" | "timed_out";
  if (timedOut) {
    waitStatus = "timed_out";
  } else if (allSatisfied) {
    waitStatus = "ready";
  } else {
    waitStatus = "waiting";
  }

  const timeoutAt = session.waitArrivedAt
    ? computeTimeoutAt(session.waitArrivedAt, nodeDef.timeout)
    : undefined;

  return {
    waitStatus,
    waitingOn: waitConditions,
    ...(nodeDef.timeout ? { timeout: nodeDef.timeout } : {}),
    ...(timeoutAt ? { timeoutAt } : {}),
  };
}
