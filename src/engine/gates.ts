import type { GateBlockCode } from "../error-codes.js";
import { evaluate } from "../evaluator.js";
import type { AdvanceErrorResult, NodeDefinition, SessionState, SourceBinding } from "../types.js";
import { cloneContext } from "./helpers.js";
import { validateReturnSchema } from "./returns.js";
import { evaluateTransitions } from "./transitions.js";
import { checkWaitTimeout, evaluateWaitConditions } from "./wait.js";

/**
 * Build the unified in-band gate-block envelope. Shape matches the
 * thrown-error envelope (`isError: true` + `error: { code, message,
 * kind }`) so the CLI writes one wire format for every advance
 * failure — see issue #95. `reason` duplicates `error.message` for
 * pre-#95 readers; new code should read `error.message`.
 */
function makeAdvanceError(
  currentNode: string,
  code: GateBlockCode,
  message: string,
  nodeDef: NodeDefinition,
  context: Record<string, unknown>,
  graphSources?: readonly SourceBinding[],
): AdvanceErrorResult {
  return {
    status: "error",
    isError: true,
    error: { code, message, kind: "blocked" },
    currentNode,
    reason: message,
    validTransitions: evaluateTransitions(nodeDef, context),
    context: cloneContext(context),
    ...(graphSources?.length ? { graphSources } : {}),
  };
}

/** Returns an AdvanceErrorResult if wait conditions block advancement, null otherwise. */
export function checkWaitBlocking(
  session: SessionState,
  nodeDef: NodeDefinition,
  graphSources?: readonly SourceBinding[],
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
    "WAIT_BLOCKING",
    `Waiting for external signals: ${unsatisfied.map((w) => `${w.key} (${w.type})`).join(", ")}`,
    nodeDef,
    session.context,
    graphSources,
  );
}

/** Returns an AdvanceErrorResult if return schema validation fails, null otherwise. */
export function checkReturnSchema(
  session: SessionState,
  nodeDef: NodeDefinition,
  graphSources?: readonly SourceBinding[],
): AdvanceErrorResult | null {
  if (!nodeDef.returns) return null;

  const violation = validateReturnSchema(nodeDef.returns, session.context);
  if (!violation) return null;

  return makeAdvanceError(
    session.currentNode,
    "RETURN_SCHEMA_VIOLATION",
    `Return schema violation: ${violation}`,
    nodeDef,
    session.context,
    graphSources,
  );
}

/** Returns an AdvanceErrorResult if any validation rule fails, null otherwise. */
export function checkValidations(
  session: SessionState,
  nodeDef: NodeDefinition,
  graphSources?: readonly SourceBinding[],
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
        "VALIDATION_FAILED",
        `Validation failed: ${v.message}`,
        nodeDef,
        session.context,
        graphSources,
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
  graphSources?: readonly SourceBinding[],
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
    "EDGE_CONDITION_NOT_MET",
    `Edge "${edgeLabel}" condition not met: ${edgeCondition}`,
    nodeDef,
    session.context,
    graphSources,
  );
}
