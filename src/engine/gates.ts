import type { GateBlockCode } from "../error-codes.js";
import { evaluatePredicate } from "../evaluator.js";
import type {
  AdvanceErrorMinimalResult,
  AdvanceErrorResult,
  NodeDefinition,
  SessionState,
  SourceBinding,
} from "../types.js";
import { buildAdvanceSnapshot } from "./helpers.js";
import { validateReturnSchema } from "./returns.js";
import { checkWaitTimeout, evaluateWaitConditions } from "./wait.js";

export type GateBlockResult = AdvanceErrorResult | AdvanceErrorMinimalResult;

export interface GateOptions {
  readonly minimal: boolean;
  /** Keys written this advance (caller updates ∪ hook writes). Surfaced on minimal blocks; ignored on full blocks. */
  readonly contextDelta: readonly string[];
  readonly graphSources?: readonly SourceBinding[];
}

/**
 * Build the unified in-band gate-block envelope. The shared
 * `{currentNode, validTransitions, context | contextDelta}` snapshot
 * comes from `buildAdvanceSnapshot` so the same shape ships on
 * post-transition hook throws (see `captureHookFailureEnvelope`); only
 * the error envelope and optional `graphSources` are layered here.
 */
function makeAdvanceError(
  session: SessionState,
  code: GateBlockCode,
  message: string,
  nodeDef: NodeDefinition,
  opts: GateOptions,
): GateBlockResult {
  const snapshot = buildAdvanceSnapshot(
    session,
    nodeDef,
    opts.minimal ? { contextDelta: opts.contextDelta } : { full: true },
  );
  const envelope = {
    status: "error" as const,
    isError: true as const,
    error: { code, message, kind: "blocked" as const },
    ...snapshot,
  };
  if ("context" in snapshot && opts.graphSources?.length) {
    return { ...envelope, graphSources: opts.graphSources };
  }
  return envelope;
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
