import { EC, EngineError } from "../errors.js";
import type {
  AdvanceSuccessMinimalResult,
  AdvanceSuccessResult,
  NodeDefinition,
  NodeInfo,
  SessionState,
  SourceBinding,
  SubgraphPushedInfo,
  TransitionInfo,
  ValidatedGraph,
  WaitCondition,
} from "../types.js";
import { evaluateTransitions } from "./transitions.js";

export function requireGraph(
  graphs: ReadonlyMap<string, ValidatedGraph>,
  graphId: string,
): ValidatedGraph {
  const graph = graphs.get(graphId);
  if (!graph) {
    throw new EngineError(`Graph "${graphId}" not found`, EC.GRAPH_NOT_FOUND);
  }
  return graph;
}

export function cloneContext(ctx: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(ctx);
}

export function toNodeInfo(node: NodeDefinition): NodeInfo {
  return {
    type: node.type,
    description: node.description,
    ...(node.instructions ? { instructions: node.instructions } : {}),
    suggestedTools: node.suggestedTools ?? [],
    ...(node.returns ? { returns: node.returns } : {}),
    ...(node.readOnly ? { readOnly: node.readOnly } : {}),
    ...(node.sources?.length ? { sources: node.sources } : {}),
  };
}

/**
 * Collect unique keys written to a contextHistory tail (entries added
 * since `sinceIndex`). Source of truth for the minimal-response
 * `contextDelta`: both `applyContextUpdates` (caller-driven) and the
 * hook runner append to contextHistory, so reading off it captures
 * every write path without parallel bookkeeping. Dedups within the
 * window — e.g. caller write then hook overwrite on the same key
 * surfaces once.
 */
export function keysSince(
  history: ReadonlyArray<{ readonly key: string }>,
  sinceIndex: number,
): readonly string[] {
  if (history.length === sinceIndex) return [];
  const seen = new Set<string>();
  for (let i = sinceIndex; i < history.length; i++) {
    seen.add(history[i].key);
  }
  return [...seen];
}

/**
 * Merge `extra` keys into `base`, deduping. Returns `base` unchanged
 * when `extra` is empty so callers avoid allocation on the common
 * case. Used by subgraph push/pop to fold child-side hook writes or
 * `returnMap` keys into a minimal response's `contextDelta`.
 */
export function mergeDelta(base: readonly string[], extra: readonly string[]): readonly string[] {
  if (extra.length === 0) return base;
  return [...new Set([...base, ...extra])];
}

/**
 * Base fields every advance-success response shares, regardless of
 * shape. Branch-specific optionals (subgraphPushed, returnedContext,
 * waitingOn, etc.) sit here so each caller passes only the fields its
 * branch uses; the helper spreads them through.
 */
export interface BaseAdvanceFields {
  readonly status: AdvanceSuccessResult["status"];
  readonly previousNode: string;
  readonly edgeTaken: string;
  readonly currentNode: string;
  readonly validTransitions: readonly TransitionInfo[];
  readonly subgraphPushed?: SubgraphPushedInfo;
  readonly completedGraph?: string;
  readonly returnedContext?: Readonly<Record<string, unknown>>;
  readonly stackDepth?: number;
  readonly resumedNode?: string;
  readonly waitingOn?: readonly WaitCondition[];
  readonly timeout?: string;
  readonly timeoutAt?: string;
  readonly traversalHistory?: readonly string[];
}

/**
 * Shape-discriminated: minimal passes `contextDelta`; full passes
 * `node` + `context` (+ optional `graphSources`). The two variants
 * share no keys, so `"contextDelta" in mode` narrows cleanly.
 */
export type AdvanceResponseMode =
  | { readonly contextDelta: readonly string[] }
  | {
      readonly node: NodeDefinition;
      readonly context: Record<string, unknown>;
      readonly graphSources?: readonly SourceBinding[];
    };

export function buildAdvanceSuccessResult(
  base: BaseAdvanceFields,
  mode: AdvanceResponseMode,
): AdvanceSuccessResult | AdvanceSuccessMinimalResult {
  if ("contextDelta" in mode) {
    return { ...base, isError: false, contextDelta: mode.contextDelta };
  }
  return {
    ...base,
    isError: false,
    node: toNodeInfo(mode.node),
    context: cloneContext(mode.context),
    ...(mode.graphSources?.length ? { graphSources: mode.graphSources } : {}),
  };
}

/**
 * Mode discriminator for `buildAdvanceSnapshot`. Mirrors the
 * success-side `AdvanceResponseMode`: minimal passes a pre-computed
 * `contextDelta`, full requests a fresh clone of `session.context`.
 */
export type AdvanceSnapshotMode =
  | { readonly contextDelta: readonly string[] }
  | { readonly full: true };

/**
 * Shared advance-failure snapshot fields — `currentNode`,
 * `validTransitions`, and `context | contextDelta`. The bundle a
 * skill needs to recover from any advance failure (gate-block or
 * post-transition hook throw).
 */
export type AdvanceSnapshot =
  | {
      readonly currentNode: string;
      readonly validTransitions: readonly TransitionInfo[];
      readonly contextDelta: readonly string[];
    }
  | {
      readonly currentNode: string;
      readonly validTransitions: readonly TransitionInfo[];
      readonly context: Readonly<Record<string, unknown>>;
    };

/**
 * Single source for the advance-failure snapshot. Owned here so
 * gate-block builders (`makeAdvanceError`) and hook-throw envelope
 * attachment (`captureHookFailureEnvelope`) emit the same shape — a
 * future field on the recover-or-stop bundle lands on both paths.
 * Computes `validTransitions` once against the post-transition node;
 * skills read it on every advance failure to pick the next move.
 */
export function buildAdvanceSnapshot(
  session: SessionState,
  nodeDef: NodeDefinition,
  mode: AdvanceSnapshotMode,
): AdvanceSnapshot {
  const validTransitions = evaluateTransitions(nodeDef, session.context);
  if ("contextDelta" in mode) {
    return {
      currentNode: session.currentNode,
      validTransitions,
      contextDelta: mode.contextDelta,
    };
  }
  return {
    currentNode: session.currentNode,
    validTransitions,
    context: cloneContext(session.context),
  };
}
