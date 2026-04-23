import { EC, EngineError } from "../errors.js";
import type {
  ContextSetMinimalResult,
  ContextSetResult,
  GraphDefinition,
  HistoryEntryProjection,
  InspectField,
  InspectFieldProjections,
  InspectHistoryResult,
  InspectMinimalResult,
  InspectPositionMinimalResult,
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

/**
 * Caller-controlled response shape. `"full"` (default) is the
 * backwards-compatible echo-everything response. `"minimal"` strips
 * the full-context echo and the NodeInfo blob from success / gate-
 * blocked / context-set / inspect-position responses, keeping only
 * the fields a mid-loop caller needs to pick the next edge (see
 * issue #81). Structural `EngineError` throws are unaffected — they
 * carry no context payload either way.
 */
export type ResponseMode = "full" | "minimal";

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

/**
 * Size caps on context writes. See `enforceContextCaps` for the check
 * path. A bad write (from a misbehaving hook or a runaway
 * `freelance_context_set`) persists server-side and echoes in every
 * subsequent response — caps prevent the blowup from ever landing.
 */
export interface ContextCaps {
  /** Serialized-JSON byte cap per value. */
  readonly maxValueBytes: number;
  /** Serialized-JSON byte cap for the whole context after the write applies. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_CONTEXT_CAPS: ContextCaps = {
  maxValueBytes: 4 * 1024,
  maxTotalBytes: 64 * 1024,
};

/**
 * Fill in a partial cap config with defaults. Lets the CLI bootstrap
 * forward user config that may specify one cap, both, or neither, and
 * still produce a concrete `ContextCaps` for the runtime.
 */
export function resolveContextCaps(partial?: {
  maxValueBytes?: number;
  maxTotalBytes?: number;
}): ContextCaps {
  return {
    maxValueBytes: partial?.maxValueBytes ?? DEFAULT_CONTEXT_CAPS.maxValueBytes,
    maxTotalBytes: partial?.maxTotalBytes ?? DEFAULT_CONTEXT_CAPS.maxTotalBytes,
  };
}

/**
 * Reject an incoming context write if any individual value or the
 * projected total exceeds its cap. Throws `EngineError` with codes
 * `CONTEXT_VALUE_TOO_LARGE` / `CONTEXT_TOTAL_TOO_LARGE` so callers can
 * surface structured errors. Must be called *before*
 * `applyContextUpdates` so a failing write leaves the session state
 * untouched.
 *
 * `undefined` values serialize to nothing (JSON.stringify returns
 * undefined) — we treat them as no-ops rather than errors so the shape
 * matches how JSON serialization already handles missing keys.
 */
export function enforceContextCaps(
  currentContext: Readonly<Record<string, unknown>>,
  updates: Record<string, unknown>,
  caps: ContextCaps,
): void {
  for (const [key, value] of Object.entries(updates)) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) continue;
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > caps.maxValueBytes) {
      throw new EngineError(
        `Context value "${key}" is ${bytes} bytes, exceeds per-value cap of ${caps.maxValueBytes} bytes (context.maxValueBytes).`,
        EC.CONTEXT_VALUE_TOO_LARGE,
      );
    }
  }

  const projected = { ...currentContext, ...updates };
  const totalBytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
  if (totalBytes > caps.maxTotalBytes) {
    throw new EngineError(
      `Context total would be ${totalBytes} bytes after write, exceeds cap of ${caps.maxTotalBytes} bytes (context.maxTotalBytes).`,
      EC.CONTEXT_TOTAL_TOO_LARGE,
    );
  }
}

export function enforceStrictContext(def: GraphDefinition, updates: Record<string, unknown>): void {
  if (!def.strictContext) return;
  const declaredKeys = new Set(Object.keys(def.context ?? {}));
  for (const key of Object.keys(updates)) {
    if (!declaredKeys.has(key)) {
      throw new EngineError(
        `Key "${key}" is not declared in the graph's context schema (strictContext is enabled)`,
        EC.STRICT_CONTEXT_VIOLATION,
      );
    }
  }
}

function buildStackView(stack: SessionState[]): StackEntry[] {
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

/**
 * Build the contextSet response. When `contextDelta` is supplied the
 * caller is on the minimal hot path — the response carries the list of
 * keys that changed instead of echoing the full context. When omitted
 * it's the full path and `context` ships in full. Branching here
 * (rather than in two paired builders) keeps the shared setup —
 * validTransitions, turnCount, turnWarning — in one place; the diff
 * between the two surfaces is one field.
 */
export function buildContextSetResult(
  session: SessionState,
  nodeDef: NodeDefinition,
  contextDelta?: readonly string[],
): ContextSetResult | ContextSetMinimalResult {
  const base = {
    status: "updated" as const,
    isError: false as const,
    currentNode: session.currentNode,
    validTransitions: evaluateTransitions(nodeDef, session.context),
    turnCount: session.turnCount,
    turnWarning: computeTurnWarning(nodeDef, session.turnCount),
  };
  return contextDelta !== undefined
    ? ({ ...base, contextDelta } satisfies ContextSetMinimalResult)
    : ({ ...base, context: cloneContext(session.context) } satisfies ContextSetResult);
}

/**
 * Build the set of optional projections a caller asked for via `fields`.
 * Each entry in `fields` maps to exactly one property on the result; any
 * field the caller didn't request is omitted rather than `undefined`.
 */
function buildFieldProjections(
  fields: readonly InspectField[],
  def: GraphDefinition,
  currentNode: string,
): InspectFieldProjections {
  if (fields.length === 0) return {};
  const requested = new Set(fields);
  const currentNodeDef = def.nodes[currentNode];
  const out: Record<string, unknown> = {};

  if (requested.has("currentNode")) {
    out.currentNodeDefinition = currentNodeDef;
  }
  if (requested.has("neighbors")) {
    const neighbors: Record<string, NodeDefinition> = {};
    for (const edge of currentNodeDef.edges ?? []) {
      const target = def.nodes[edge.target];
      if (target) neighbors[edge.target] = target;
    }
    out.neighbors = neighbors;
  }
  if (requested.has("contextSchema") && def.context) {
    out.contextSchema = def.context;
  }
  if (requested.has("definition")) {
    out.definition = def;
  }
  return out as InspectFieldProjections;
}

/**
 * Options for `detail: "history"` responses. `limit`/`offset` slice
 * `traversalHistory` — that's the array that blows up quadratically
 * because each entry carries a `contextSnapshot`. `contextHistory`
 * entries are small (key + value + two timestamps) so they ship in
 * full; the response still reports `totalContextWrites` so callers
 * can sense the size. `includeSnapshots` toggles inclusion of the
 * per-step `contextSnapshot` blob on `traversalHistory` entries.
 */
export interface InspectHistoryOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly includeSnapshots?: boolean;
}

/** Default page size for history arrays. Matches `memory_browse`'s default. */
export const DEFAULT_HISTORY_LIMIT = 50;
/** Hard upper bound on `limit` for history pagination. */
export const MAX_HISTORY_LIMIT = 200;

function resolveHistoryPagination(opts: InspectHistoryOptions): { limit: number; offset: number } {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_HISTORY_LIMIT), MAX_HISTORY_LIMIT);
  const offset = Math.max(0, opts.offset ?? 0);
  return { limit, offset };
}

function projectHistoryEntries(
  entries: SessionState["history"],
  offset: number,
  limit: number,
  includeSnapshots: boolean,
): HistoryEntryProjection[] {
  const slice = entries.slice(offset, offset + limit);
  if (includeSnapshots) return slice.map((e) => ({ ...e }));
  return slice.map(({ contextSnapshot: _drop, ...rest }) => rest);
}

/**
 * Build the history inspect response. Shape is identical across `full`
 * and `minimal` modes — history is the recovery / audit path where
 * stripping fields defeats the purpose — except that `fields`
 * projections are only honored on the full-mode call site (passed via
 * `extraProjections`).
 *
 * contextHistory ships in full — entries are small and per-array
 * pagination on both surfaces muddles the caller's mental model
 * (edge indices and write indices aren't correlated).
 */
function buildHistoryResult(
  session: SessionState,
  historyOpts: InspectHistoryOptions,
  extraProjections?: InspectFieldProjections,
): InspectHistoryResult {
  const { limit, offset } = resolveHistoryPagination(historyOpts);
  return {
    graphId: session.graphId,
    currentNode: session.currentNode,
    traversalHistory: projectHistoryEntries(
      session.history,
      offset,
      limit,
      historyOpts.includeSnapshots === true,
    ),
    contextHistory: session.contextHistory,
    totalSteps: session.history.length,
    totalContextWrites: session.contextHistory.length,
    ...(extraProjections ?? {}),
  };
}

/**
 * Build the inspect response. `options.minimal` switches between the
 * full and minimal position shapes; `detail: "history"` shares one
 * builder across both modes — history is the recovery / audit path
 * where stripping fields defeats the purpose. `fields` projections
 * are honored on the full path only; they're ignored on minimal by
 * design (the projection surface is for introspection, not the hot
 * path that opts into minimal — see `ResponseMode` and issue #81).
 *
 * `historyOpts` are intentionally ignored for non-history detail —
 * pagination and snapshot toggles have no meaning there.
 */
export function buildInspectResult(
  detail: "position" | "history",
  session: SessionState,
  def: GraphDefinition,
  stack: SessionState[],
  options: {
    minimal?: boolean;
    fields?: readonly InspectField[];
    historyOpts?: InspectHistoryOptions;
  } = {},
): InspectResult | InspectMinimalResult {
  const fields = options.fields ?? [];
  const historyOpts = options.historyOpts ?? {};
  const projections =
    options.minimal === true ? undefined : buildFieldProjections(fields, def, session.currentNode);

  if (detail === "history") {
    return buildHistoryResult(session, historyOpts, projections);
  }

  const currentNodeDef = def.nodes[session.currentNode];
  const waitInfo = computeWaitInfo(session, currentNodeDef);
  const transitions = evaluateTransitions(currentNodeDef, session.context);
  const turnWarning = computeTurnWarning(currentNodeDef, session.turnCount);

  const base = {
    graphId: session.graphId,
    currentNode: session.currentNode,
    validTransitions: transitions,
    turnCount: session.turnCount,
    turnWarning,
    stackDepth: stack.length,
    ...waitInfo,
  };

  if (options.minimal === true) {
    return base satisfies InspectPositionMinimalResult;
  }

  return {
    ...base,
    graphName: def.name,
    node: toNodeInfo(currentNodeDef),
    context: cloneContext(session.context),
    stack: buildStackView(stack),
    ...(def.sources && def.sources.length > 0 ? { graphSources: def.sources } : {}),
    ...projections,
  } satisfies InspectPositionResult;
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
