import type { Graph } from "@dagrejs/graphlib";

// Re-export schema types — single source of truth in schema/graph-schema.ts
export type {
  EdgeDefinition,
  GraphDefinition,
  NodeDefinition,
  OnEnterHook,
  ReturnField,
  ReturnSchema,
  SourceBinding,
  SubgraphDefinition,
  ValidationRule,
  WaitOnEntry,
} from "./schema/graph-schema.js";

import type { GateBlockCode } from "./error-codes.js";
import type { HookResolutionMap } from "./hook-resolution.js";
import type {
  GraphDefinition,
  NodeDefinition,
  ReturnSchema,
  SourceBinding,
} from "./schema/graph-schema.js";

export interface ValidatedGraph {
  readonly definition: GraphDefinition;
  readonly graph: Graph;
  // Present on YAML-loaded graphs that declare onEnter hooks. Absent on
  // programmatic (GraphBuilder) graphs, and absent on YAML graphs with
  // no hooks — both cases are treated identically by the engine.
  readonly hookResolutions?: HookResolutionMap;
}

// --- Result types (shape of CLI JSON responses) ---
// All result properties are readonly — results are snapshots, not live references.

export interface TransitionInfo {
  readonly label: string;
  readonly target: string;
  readonly condition?: string;
  readonly description?: string;
  readonly conditionMet: boolean;
  readonly nextStepHint?: string;
}

export interface NodeInfo {
  readonly type: NodeDefinition["type"];
  readonly description: string;
  readonly instructions?: string;
  readonly suggestedTools: readonly string[];
  readonly returns?: ReturnSchema;
  readonly readOnly?: boolean;
  readonly sources?: readonly SourceBinding[];
}

export interface GraphListResult {
  readonly graphs: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly description: string;
  }>;
}

export interface StartResult {
  readonly status: "started";
  readonly isError: false;
  readonly graphId: string;
  readonly currentNode: string;
  readonly node: NodeInfo;
  readonly validTransitions: readonly TransitionInfo[];
  readonly context: Readonly<Record<string, unknown>>;
  readonly graphSources?: readonly SourceBinding[];
}

export interface SubgraphPushedInfo {
  readonly graphId: string;
  readonly startNode: string;
  readonly stackDepth: number;
}

export interface WaitCondition {
  readonly key: string;
  readonly type: string;
  readonly description?: string;
  readonly satisfied: boolean;
}

export interface AdvanceSuccessResult {
  readonly status: "advanced" | "complete" | "subgraph_complete" | "waiting";
  readonly isError: false;
  readonly previousNode: string;
  readonly edgeTaken: string;
  readonly currentNode: string;
  readonly node: NodeInfo;
  readonly validTransitions: readonly TransitionInfo[];
  readonly context: Readonly<Record<string, unknown>>;
  readonly traversalHistory?: readonly string[];
  readonly subgraphPushed?: SubgraphPushedInfo;
  readonly completedGraph?: string;
  readonly returnedContext?: Readonly<Record<string, unknown>>;
  readonly stackDepth?: number;
  readonly resumedNode?: string;
  readonly waitingOn?: readonly WaitCondition[];
  readonly timeout?: string;
  readonly timeoutAt?: string;
  readonly graphSources?: readonly SourceBinding[];
}

/**
 * Lean success shape — returned when the caller passes `responseMode:
 * "minimal"`. Strips the two fat fields that dominate per-response token
 * cost: `node` (full NodeInfo — instructions, suggestedTools, sources)
 * and `context` (full state echo). `contextDelta` names the keys
 * written this turn (caller updates + hook writes) so hook activity
 * stays visible without echoing unchanged state. See issue #81.
 *
 * Callers resync to the full shape on demand via `freelance inspect`
 * (which defaults to `responseMode: "full"`) — typically once after
 * compaction rather than on every advance.
 */
export interface AdvanceSuccessMinimalResult {
  readonly status: "advanced" | "complete" | "subgraph_complete" | "waiting";
  readonly isError: false;
  readonly previousNode: string;
  readonly edgeTaken: string;
  readonly currentNode: string;
  readonly validTransitions: readonly TransitionInfo[];
  readonly contextDelta: readonly string[];
  readonly traversalHistory?: readonly string[];
  readonly subgraphPushed?: SubgraphPushedInfo;
  readonly completedGraph?: string;
  readonly returnedContext?: Readonly<Record<string, unknown>>;
  readonly stackDepth?: number;
  readonly resumedNode?: string;
  readonly waitingOn?: readonly WaitCondition[];
  readonly timeout?: string;
  readonly timeoutAt?: string;
}

/**
 * Gate-blocked advance result — carried in-band on the engine's advance
 * return, not thrown. The wire envelope matches the thrown-error shape
 * so a skill sees one unified error format: `{ isError: true, error: {
 * code, message, kind } }`. Blocked responses add `status: "error"`,
 * `currentNode`, `validTransitions`, and `context` so the caller can
 * pick a different edge or fix context and retry. `reason` duplicates
 * `error.message` for back-compat with pre-#95 readers; new code should
 * read `error.message`. See `error-codes.ts` for the `kind`
 * discriminator and issue #95 for the unification rationale.
 */
export interface AdvanceErrorResult {
  readonly status: "error";
  readonly isError: true;
  readonly error: {
    readonly code: GateBlockCode;
    readonly message: string;
    readonly kind: "blocked";
  };
  readonly currentNode: string;
  readonly reason: string;
  readonly validTransitions: readonly TransitionInfo[];
  readonly context: Readonly<Record<string, unknown>>;
  readonly graphSources?: readonly SourceBinding[];
}

/**
 * Lean gate-blocked shape — `responseMode: "minimal"` counterpart to
 * `AdvanceErrorResult`. Keeps `reason` and `validTransitions` (the
 * caller needs both to fix and retry) but drops the full `context`
 * echo. `contextDelta` is included for symmetry with the success shape
 * — empty on pure gate blocks (wait/validation/return-schema/edge
 * condition don't write), populated only when the caller's
 * contextUpdates applied before a gate failed.
 */
export interface AdvanceErrorMinimalResult {
  readonly status: "error";
  readonly isError: true;
  readonly error: {
    readonly code: GateBlockCode;
    readonly message: string;
    readonly kind: "blocked";
  };
  readonly currentNode: string;
  readonly reason: string;
  readonly validTransitions: readonly TransitionInfo[];
  readonly contextDelta: readonly string[];
}

export type AdvanceResult = AdvanceSuccessResult | AdvanceErrorResult;
export type AdvanceMinimalResult = AdvanceSuccessMinimalResult | AdvanceErrorMinimalResult;

export interface ContextSetResult {
  readonly status: "updated";
  readonly isError: false;
  readonly currentNode: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly validTransitions: readonly TransitionInfo[];
  readonly turnCount: number;
  readonly turnWarning: string | null;
}

export interface ContextSetMinimalResult {
  readonly status: "updated";
  readonly isError: false;
  readonly currentNode: string;
  readonly contextDelta: readonly string[];
  readonly validTransitions: readonly TransitionInfo[];
  readonly turnCount: number;
  readonly turnWarning: string | null;
}

export interface StackEntry {
  readonly graphId: string;
  readonly suspendedAt?: string;
  readonly currentNode?: string;
}

/**
 * Optional projections an inspect caller can layer on top of the base
 * position/history response. Each field is additive — the base shape
 * stays lean and the caller explicitly asks for the expansion.
 */
export const INSPECT_FIELDS = ["currentNode", "neighbors", "contextSchema", "definition"] as const;
export type InspectField = (typeof INSPECT_FIELDS)[number];

export interface InspectFieldProjections {
  /** Full `NodeDefinition` for the current node (edges, onEnter, validations, subgraph, timeout, etc.). Requested via fields: ["currentNode"]. */
  readonly currentNodeDefinition?: NodeDefinition;
  /** Full `NodeDefinition` for each node reachable in one edge. Requested via fields: ["neighbors"]. */
  readonly neighbors?: Readonly<Record<string, NodeDefinition>>;
  /** Declared context schema from the graph. Requested via fields: ["contextSchema"]. */
  readonly contextSchema?: GraphDefinition["context"];
  /** Full GraphDefinition — the escape hatch for debugging / authoring. Requested via fields: ["definition"]. */
  readonly definition?: GraphDefinition;
}

export interface InspectPositionResult extends InspectFieldProjections {
  readonly graphId: string;
  readonly graphName: string;
  readonly currentNode: string;
  readonly node: NodeInfo;
  readonly validTransitions: readonly TransitionInfo[];
  readonly context: Readonly<Record<string, unknown>>;
  readonly turnCount: number;
  readonly turnWarning: string | null;
  readonly stackDepth: number;
  readonly stack: readonly StackEntry[];
  readonly graphSources?: readonly SourceBinding[];
  readonly waitStatus?: "waiting" | "ready" | "timed_out";
  readonly waitingOn?: readonly WaitCondition[];
  readonly timeout?: string;
  readonly timeoutAt?: string;
}

/**
 * Lean position shape — `responseMode: "minimal"` on inspect. Drops
 * `node` (NodeInfo), `context`, `stack` array, and `graphSources`.
 * Keeps the fields a mid-loop caller actually reads: current node id,
 * valid transitions, turn state, stack depth, and wait info if any.
 * `fields` projections are intentionally ignored on minimal — the
 * projection surface is an introspection affordance, not a loop-hot
 * one.
 */
export interface InspectPositionMinimalResult {
  readonly graphId: string;
  readonly currentNode: string;
  readonly validTransitions: readonly TransitionInfo[];
  readonly turnCount: number;
  readonly turnWarning: string | null;
  readonly stackDepth: number;
  readonly waitStatus?: "waiting" | "ready" | "timed_out";
  readonly waitingOn?: readonly WaitCondition[];
  readonly timeout?: string;
  readonly timeoutAt?: string;
}

export interface HistoryEntry {
  readonly node: string;
  readonly edge: string;
  readonly timestamp: string;
  readonly contextSnapshot: Readonly<Record<string, unknown>>;
}

/**
 * History entry as it appears in a `detail: "history"` response.
 * `contextSnapshot` is populated only when the caller opts in via
 * `includeSnapshots: true` — by default it's stripped so responses
 * don't grow quadratically on long traversals.
 */
export interface HistoryEntryProjection {
  readonly node: string;
  readonly edge: string;
  readonly timestamp: string;
  readonly contextSnapshot?: Readonly<Record<string, unknown>>;
}

export interface ContextHistoryEntry {
  readonly key: string;
  readonly value: unknown;
  readonly setAt: string;
  readonly timestamp: string;
}

export interface InspectHistoryResult extends InspectFieldProjections {
  readonly graphId: string;
  readonly currentNode: string;
  /** Paginated entries — starts at `offset`, capped at `limit`. `contextSnapshot` present only when `includeSnapshots: true`. */
  readonly traversalHistory: readonly HistoryEntryProjection[];
  /** Full contextHistory — not paginated (entries are small; pagination muddles indexing). */
  readonly contextHistory: readonly ContextHistoryEntry[];
  /** Total edges taken across the whole traversal (before pagination). */
  readonly totalSteps: number;
  /** Total context writes across the whole traversal. Reported for size awareness; `contextHistory` is not paginated. */
  readonly totalContextWrites: number;
}

export type InspectResult = InspectPositionResult | InspectHistoryResult;

/**
 * Shape returned by `engine.inspect` / `store.inspect` when
 * `responseMode: "minimal"` is requested. History mode is unchanged —
 * `detail: "history"` is the recovery/audit path where the whole point
 * is the full entry list, so projecting it to a lean form would
 * defeat the purpose. Only `detail: "position"` has a minimal form.
 */
export type InspectMinimalResult = InspectPositionMinimalResult | InspectHistoryResult;

export interface ClearedStackEntry {
  readonly graphId: string;
  readonly node: string;
}

export interface ResetResult {
  readonly status: "reset";
  readonly previousGraph: string | null;
  readonly previousNode: string | null;
  readonly message: string;
  readonly clearedStack?: readonly ClearedStackEntry[];
}

// SessionState is mutable internal state — no readonly
export interface SessionState {
  graphId: string;
  currentNode: string;
  context: Record<string, unknown>;
  history: HistoryEntry[];
  contextHistory: ContextHistoryEntry[];
  turnCount: number;
  startedAt: string;
  waitArrivedAt?: string;
  /**
   * ISO timestamp of when `checkWaitTimeout` first observed that
   * `waitArrivedAt + timeout` was in the past. Engine-internal —
   * lives on SessionState rather than `context` so it doesn't ride
   * the context wire (full-mode echoes) or slip past `strictContext`,
   * byte caps, or the `contextHistory` audit trail. `waitStatus:
   * "timed_out"` is the public signal.
   */
  waitTimedOutAt?: string;
}

// --- Traversal management types ---

export interface TraversalInfo {
  readonly traversalId: string;
  readonly graphId: string;
  readonly currentNode: string;
  readonly lastUpdated: string;
  readonly stackDepth: number;
  // Always present on responses (empty when untagged), matching the
  // convention used for `context` — callers can read meta[key] without
  // null-checking the map itself. On-disk TraversalRecord.meta stays
  // optional; the store normalizes at read time.
  readonly meta: Readonly<Record<string, string>>;
}

/**
 * One entry per graph file that failed to load (parse error, schema
 * violation, or hook-resolution failure). Surfaced in `TraversalListResult`
 * so CLI/skill callers can see which files were silently dropped from
 * `graphs` — otherwise a broken yaml just disappears from `freelance status`.
 */
export interface LoadError {
  readonly file: string;
  readonly message: string;
}

export interface TraversalListResult {
  readonly graphs: GraphListResult["graphs"];
  readonly activeTraversals: readonly TraversalInfo[];
  /** Only included when non-empty — keeps the success shape unchanged. */
  readonly loadErrors?: readonly LoadError[];
  /**
   * Traversals whose top-of-stack `graphId` doesn't resolve against the
   * graphs currently loaded (yaml deleted / renamed / failed to parse).
   * Split out so callers can see them distinctly from `activeTraversals`
   * without having to cross-reference `graphs`. Only included when
   * non-empty; mirrors the `loadErrors` elision pattern.
   */
  readonly orphanedTraversals?: readonly TraversalInfo[];
}
