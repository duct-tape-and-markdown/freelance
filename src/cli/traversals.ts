/**
 * CLI handlers for traversal commands. Operates directly on TraversalStore.
 */

import { EngineError } from "../errors.js";
import type { TraversalStore } from "../state/index.js";
import type { InspectFullResult, InspectHistoryResult, InspectPositionResult } from "../types.js";
import { cli, info, outputJson } from "./output.js";

function handleError(e: unknown): never {
  const message = e instanceof EngineError ? e.message : e instanceof Error ? e.message : String(e);
  if (cli.json) {
    outputJson({ error: message });
  } else {
    info(`Error: ${message}`);
  }
  process.exit(1);
}

/**
 * Shared primitive for CLI flags that accept `key=value` pairs. Splits on
 * the first `=`, validates a non-empty key, and throws with a consistent
 * error message across `--meta`, `--filter`, and `context set`. Callers
 * layer their own value handling on top (string-only for meta, JSON-
 * coerced for context).
 */
function splitKeyValue(pair: string, flag: string): [string, string] {
  const eqIdx = pair.indexOf("=");
  if (eqIdx === -1) {
    throw new Error(`${flag} requires key=value pairs; got "${pair}"`);
  }
  const key = pair.slice(0, eqIdx);
  if (!key) throw new Error(`${flag} key is empty in "${pair}"`);
  return [key, pair.slice(eqIdx + 1)];
}

export function traversalStatus(store: TraversalStore, opts?: { filter?: string[] }): void {
  try {
    const result = store.listGraphs();
    // Operator-side filter — kept off the MCP surface deliberately. LLMs
    // already see meta on every list entry and can pick; humans grepping
    // among 50 traversals want a flag.
    const filter = parseMetaPairs(opts?.filter, "--filter");
    const filterEntries = Object.entries(filter);
    const traversals =
      filterEntries.length === 0
        ? result.activeTraversals
        : result.activeTraversals.filter(
            (t) => t.meta !== undefined && filterEntries.every(([k, v]) => t.meta?.[k] === v),
          );

    if (cli.json) {
      outputJson({ ...result, activeTraversals: traversals });
      return;
    }
    if (result.graphs.length > 0) {
      info("Graphs:");
      for (const g of result.graphs) {
        info(`  ${g.id}  ${g.name} (v${g.version})${g.description ? ` — ${g.description}` : ""}`);
      }
    } else {
      info("No graphs loaded.");
    }
    if (traversals.length > 0) {
      const heading =
        filterEntries.length > 0
          ? `\nActive traversals matching ${JSON.stringify(filter)}:`
          : "\nActive traversals:";
      info(heading);
      for (const t of traversals) {
        info(
          `  ${t.traversalId}  ${t.graphId} @ ${t.currentNode}  (depth: ${t.stackDepth}, updated: ${t.lastUpdated})`,
        );
        if (t.meta) info(`    meta: ${JSON.stringify(t.meta)}`);
      }
    } else if (filterEntries.length > 0) {
      info(`\nNo active traversals match ${JSON.stringify(filter)}.`);
    } else {
      info("\nNo active traversals.");
    }
  } catch (e) {
    handleError(e);
  }
}

// Values stay strings — meta is deliberately opaque, so (unlike
// `freelance context set`) no JSON coercion here.
function parseMetaPairs(pairs: string[] | undefined, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!pairs) return out;
  for (const pair of pairs) {
    const [key, value] = splitKeyValue(pair, flag);
    out[key] = value;
  }
  return out;
}

export async function traversalStart(
  store: TraversalStore,
  graphId: string,
  context?: string,
  opts?: { meta?: string[] },
): Promise<void> {
  try {
    let initialContext: Record<string, unknown> | undefined;
    if (context) {
      try {
        initialContext = JSON.parse(context) as Record<string, unknown>;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`--context must be valid JSON: ${msg}`);
      }
    }
    const meta = parseMetaPairs(opts?.meta, "--meta");
    const result = await store.createTraversal(
      graphId,
      initialContext,
      Object.keys(meta).length > 0 ? meta : undefined,
    );
    if (cli.json) {
      outputJson(result);
    } else {
      info(`Started traversal ${result.traversalId} on ${graphId}`);
      info(`  Node: ${result.currentNode}`);
      if (result.node.description) {
        info(`  Description: ${result.node.description}`);
      }
      if (result.meta) {
        info(`  Meta: ${JSON.stringify(result.meta)}`);
      }
    }
  } catch (e) {
    handleError(e);
  }
}

export async function traversalAdvance(
  store: TraversalStore,
  edge?: string,
  opts?: { traversal?: string; context?: string },
): Promise<void> {
  try {
    const id = store.resolveTraversalId(opts?.traversal);
    let contextUpdates: Record<string, unknown> | undefined;
    if (opts?.context) {
      try {
        contextUpdates = JSON.parse(opts.context) as Record<string, unknown>;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`--context must be valid JSON: ${msg}`);
      }
    }
    if (!edge) {
      // Show available edges when no edge specified
      const raw = store.inspect(id, "position");
      const inspectResult = raw as { traversalId: string } & InspectPositionResult;
      if (cli.json) {
        outputJson({ traversalId: id, validTransitions: inspectResult.validTransitions });
      } else {
        info(`Traversal ${id} @ ${inspectResult.currentNode}`);
        if (inspectResult.validTransitions?.length) {
          info("Available edges:");
          for (const t of inspectResult.validTransitions) {
            info(
              `  ${t.label}${t.target ? ` → ${t.target}` : ""}${t.conditionMet === false ? " (condition not met)" : ""}`,
            );
          }
        } else {
          info("No available edges.");
        }
      }
      return;
    }
    const result = await store.advance(id, edge, contextUpdates);
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.isError) {
        info(`Advance failed: ${result.reason}`);
        process.exit(1);
      }
      info(`Advanced ${result.traversalId} → ${result.currentNode}`);
      if (result.node.description) {
        info(`  Description: ${result.node.description}`);
      }
    }
  } catch (e) {
    handleError(e);
  }
}

export function traversalContextSet(
  store: TraversalStore,
  updates: string[],
  opts?: { traversal?: string },
): void {
  try {
    const id = store.resolveTraversalId(opts?.traversal);

    // Parse key=value pairs. Context accepts typed values, so JSON-coerce
    // and fall back to the raw string — `foo=true` → boolean, `bar=1`
    // → number, `baz=hello` → string.
    const parsed: Record<string, unknown> = {};
    for (const pair of updates) {
      const [key, rawValue] = splitKeyValue(pair, "context set");
      try {
        parsed[key] = JSON.parse(rawValue);
      } catch {
        parsed[key] = rawValue;
      }
    }

    const result = store.contextSet(id, parsed);
    if (cli.json) {
      outputJson(result);
    } else {
      info(`Updated context for ${result.traversalId}`);
      for (const [k, v] of Object.entries(parsed)) {
        info(`  ${k} = ${JSON.stringify(v)}`);
      }
    }
  } catch (e) {
    handleError(e);
  }
}

export function traversalMetaSet(
  store: TraversalStore,
  updates: string[],
  opts?: { traversal?: string },
): void {
  try {
    const id = store.resolveTraversalId(opts?.traversal);
    const parsed = parseMetaPairs(updates, "meta set");
    if (Object.keys(parsed).length === 0) {
      throw new Error("meta set requires at least one key=value pair");
    }
    const result = store.setMeta(id, parsed);
    if (cli.json) {
      outputJson(result);
    } else {
      info(`Updated meta for ${result.traversalId}`);
      info(`  Meta: ${JSON.stringify(result.meta)}`);
    }
  } catch (e) {
    handleError(e);
  }
}

export function traversalInspect(
  store: TraversalStore,
  traversalId?: string,
  detail?: string,
): void {
  try {
    const id = store.resolveTraversalId(traversalId);
    const validDetail = detail === "full" || detail === "history" ? detail : "position";
    const raw = store.inspect(id, validDetail);
    if (cli.json) {
      outputJson(raw);
    } else {
      info(`Traversal: ${raw.traversalId}`);
      info(`  Graph: ${raw.graphId}`);
      info(`  Node:  ${raw.currentNode}`);
      if (raw.meta) info(`  Meta:  ${JSON.stringify(raw.meta)}`);
      if (validDetail === "position") {
        const pos = raw as { traversalId: string } & InspectPositionResult;
        if (pos.node.description) {
          info(`  Description: ${pos.node.description}`);
        }
        if (pos.validTransitions?.length) {
          info("  Edges:");
          for (const t of pos.validTransitions) {
            info(
              `    ${t.label}${t.target ? ` → ${t.target}` : ""}${t.conditionMet === false ? " (condition not met)" : ""}`,
            );
          }
        }
      }
      if (validDetail === "full") {
        const full = raw as { traversalId: string } & InspectFullResult;
        info(`  Context: ${JSON.stringify(full.context)}`);
      }
      if (validDetail === "history") {
        const hist = raw as { traversalId: string } & InspectHistoryResult;
        info("  History:");
        for (const h of hist.traversalHistory) {
          info(`    ${h.node} (${h.edge ?? "start"})`);
        }
      }
    }
  } catch (e) {
    handleError(e);
  }
}

export function traversalReset(
  store: TraversalStore,
  traversalId?: string,
  opts?: { confirm?: boolean },
): void {
  if (!opts?.confirm) {
    info("Error: must pass --confirm to reset a traversal.");
    process.exit(1);
  }
  try {
    const id = store.resolveTraversalId(traversalId);
    const result = store.resetTraversal(id);
    if (cli.json) {
      outputJson(result);
    } else {
      info(`Reset traversal ${result.traversalId}: ${result.status}`);
    }
  } catch (e) {
    handleError(e);
  }
}
