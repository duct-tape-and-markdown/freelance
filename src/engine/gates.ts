import { evaluate } from "../evaluator.js";
import { validateReturnSchema } from "./returns.js";
import { evaluateWaitConditions, checkWaitTimeout } from "./wait.js";
import { cloneContext } from "./helpers.js";
import { evaluateTransitions } from "./transitions.js";
import type {
  NodeDefinition,
  SourceBinding,
  SessionState,
  AdvanceErrorResult,
} from "../types.js";

export function makeAdvanceError(
  currentNode: string,
  reason: string,
  nodeDef: NodeDefinition,
  context: Record<string, unknown>,
  graphSources?: readonly SourceBinding[]
): AdvanceErrorResult {
  return {
    status: "error",
    isError: true,
    currentNode,
    reason,
    validTransitions: evaluateTransitions(nodeDef, context),
    context: cloneContext(context),
    ...(graphSources?.length ? { graphSources } : {}),
  };
}

/** Returns an AdvanceErrorResult if wait conditions block advancement, null otherwise. */
export function checkWaitBlocking(
  session: SessionState,
  nodeDef: NodeDefinition,
  graphSources?: readonly SourceBinding[]
): AdvanceErrorResult | null {
  if (nodeDef.type !== "wait" || !nodeDef.waitOn) return null;

  const timedOut = checkWaitTimeout(session, nodeDef);
  if (timedOut) return null;

  const waitConditions = evaluateWaitConditions(nodeDef.waitOn, session.context);
  const allSatisfied = waitConditions.every((w) => w.satisfied);
  if (allSatisfied) return null;

  const unsatisfied = waitConditions.filter((w) => !w.satisfied);
  return makeAdvanceError(
    session.currentNode,
    `Waiting for external signals: ${unsatisfied.map((w) => `${w.key} (${w.type})`).join(", ")}`,
    nodeDef,
    session.context,
    graphSources
  );
}

/** Returns an AdvanceErrorResult if return schema validation fails, null otherwise. */
export function checkReturnSchema(
  session: SessionState,
  nodeDef: NodeDefinition,
  graphSources?: readonly SourceBinding[]
): AdvanceErrorResult | null {
  if (!nodeDef.returns) return null;

  const violation = validateReturnSchema(nodeDef.returns, session.context);
  if (!violation) return null;

  return makeAdvanceError(
    session.currentNode,
    `Return schema violation: ${violation}`,
    nodeDef,
    session.context,
    graphSources
  );
}

/** Returns an AdvanceErrorResult if any validation rule fails, null otherwise. */
export function checkValidations(
  session: SessionState,
  nodeDef: NodeDefinition,
  graphSources?: readonly SourceBinding[]
): AdvanceErrorResult | null {
  if (!nodeDef.validations || nodeDef.validations.length === 0) return null;

  for (const v of nodeDef.validations) {
    let result: boolean;
    try {
      result = evaluate(v.expr, session.context);
    } catch {
      result = false;
    }
    if (!result) {
      return makeAdvanceError(
        session.currentNode,
        `Validation failed: ${v.message}`,
        nodeDef,
        session.context,
        graphSources
      );
    }
  }
  return null;
}

/** Returns an AdvanceErrorResult if the edge condition is not met, null otherwise. */
export function checkEdgeCondition(
  session: SessionState,
  nodeDef: NodeDefinition,
  edgeCondition: string,
  edgeLabel: string,
  graphSources?: readonly SourceBinding[]
): AdvanceErrorResult | null {
  let condMet: boolean;
  try {
    condMet = evaluate(edgeCondition, session.context);
  } catch {
    condMet = false;
  }
  if (condMet) return null;

  return makeAdvanceError(
    session.currentNode,
    `Edge "${edgeLabel}" condition not met: ${edgeCondition}`,
    nodeDef,
    session.context,
    graphSources
  );
}
