import type { GateBlockCode } from "../error-codes.js";
import { evaluatePredicate } from "../evaluator.js";
import type {
  AdvanceErrorMinimalResult,
  AdvanceErrorResult,
  NodeDefinition,
  SessionState,
  SourceBinding,
} from "../types.js";
import { buildAdvanceErrorResult } from "./helpers.js";
import { validateReturnSchema } from "./returns.js";
import { evaluateTransitions } from "./transitions.js";
import { checkWaitTimeout, evaluateWaitConditions } from "./wait.js";

export type GateBlockResult = AdvanceErrorResult | AdvanceErrorMinimalResult;

export interface GateOptions {
  readonly minimal: boolean;
  /** Keys written this advance (caller updates ∪ hook writes). Surfaced on minimal blocks; ignored on full blocks. */
  readonly contextDelta: readonly string[];
  readonly graphSources?: readonly SourceBinding[];
}

/**
 * Build the unified in-band gate-block envelope. Computes
 * `validTransitions` once (every gate checker would otherwise duplicate
 * it) and delegates shape assembly to `buildAdvanceErrorResult`.
 */
function makeAdvanceError(
  session: SessionState,
  code: GateBlockCode,
  message: string,
  nodeDef: NodeDefinition,
  opts: GateOptions,
): GateBlockResult {
  return buildAdvanceErrorResult(
    {
      code,
      message,
      currentNode: session.currentNode,
      validTransitions: evaluateTransitions(nodeDef, session.context),
    },
    opts.minimal
      ? { contextDelta: opts.contextDelta }
      : { context: session.context, graphSources: opts.graphSources },
  );
}

/** Returns a gate-block result if wait conditions block advancement, null otherwise. */
export function checkWaitBlocking(
  session: SessionState,
  nodeDef: NodeDefinition,
  opts: GateOptions,
): GateBlockResult | null {
  if (nodeDef.type !== "wait" || !nodeDef.waitOn) return null;

  const timedOut = checkWaitTimeout(session, nodeDef);
  if (timedOut) return null;

  const waitConditions = evaluateWaitConditions(nodeDef.waitOn, session.context);
  const allSatisfied = waitConditions.every((w) => w.satisfied);
  if (allSatisfied) return null;

  const unsatisfied = waitConditions.filter((w) => !w.satisfied);
  return makeAdvanceError(
    session,
    "WAIT_BLOCKING",
    `Waiting for external signals: ${unsatisfied.map((w) => `${w.key} (${w.type})`).join(", ")}`,
    nodeDef,
    opts,
  );
}

/** Returns a gate-block result if return schema validation fails, null otherwise. */
export function checkReturnSchema(
  session: SessionState,
  nodeDef: NodeDefinition,
  opts: GateOptions,
): GateBlockResult | null {
  if (!nodeDef.returns) return null;

  const violation = validateReturnSchema(nodeDef.returns, session.context);
  if (!violation) return null;

  return makeAdvanceError(
    session,
    "RETURN_SCHEMA_VIOLATION",
    `Return schema violation: ${violation}`,
    nodeDef,
    opts,
  );
}

/** Returns a gate-block result if any validation rule fails, null otherwise. */
export function checkValidations(
  session: SessionState,
  nodeDef: NodeDefinition,
  opts: GateOptions,
): GateBlockResult | null {
  if (!nodeDef.validations || nodeDef.validations.length === 0) return null;

  for (const v of nodeDef.validations) {
    if (!evaluatePredicate(v.expr, session.context)) {
      return makeAdvanceError(
        session,
        "VALIDATION_FAILED",
        `Validation failed: ${v.message}`,
        nodeDef,
        opts,
      );
    }
  }
  return null;
}

/** Returns a gate-block result if the edge condition is not met, null otherwise. */
export function checkEdgeCondition(
  session: SessionState,
  nodeDef: NodeDefinition,
  edgeCondition: string,
  edgeLabel: string,
  opts: GateOptions,
): GateBlockResult | null {
  if (evaluatePredicate(edgeCondition, session.context)) return null;

  return makeAdvanceError(
    session,
    "EDGE_CONDITION_NOT_MET",
    `Edge "${edgeLabel}" condition not met: ${edgeCondition}`,
    nodeDef,
    opts,
  );
}
