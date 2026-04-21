import type { NodeDefinition, NodeInfo } from "../types.js";

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
