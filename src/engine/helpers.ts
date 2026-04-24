import type {
  AdvanceSuccessMinimalResult,
  AdvanceSuccessResult,
  NodeDefinition,
  NodeInfo,
  SourceBinding,
  SubgraphPushedInfo,
  TransitionInfo,
  WaitCondition,
} from "../types.js";

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
