/**
 * CLI handlers for traversal commands. Operates directly on TraversalStore.
 */

import { EngineError } from "../errors.js";
import type { TraversalStore } from "../state/index.js";
import type {
  InspectFullResult,
  InspectHistoryResult,
  InspectPositionResult,
  WaitCondition,
} from "../types.js";
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

export function traversalStatus(store: TraversalStore): void {
  try {
    const result = store.listGraphs();
    if (cli.json) {
      outputJson(result);
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
    if (result.activeTraversals.length > 0) {
      info("\nActive traversals:");
      for (const t of result.activeTraversals) {
        info(
          `  ${t.traversalId}  ${t.graphId} @ ${t.currentNode}  (depth: ${t.stackDepth}, updated: ${t.lastUpdated})`,
        );
      }
    } else {
      info("\nNo active traversals.");
    }
  } catch (e) {
    handleError(e);
  }
}

export async function traversalStart(
  store: TraversalStore,
  graphId: string,
  context?: string,
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
    const result = await store.createTraversal(graphId, initialContext);
    if (cli.json) {
      outputJson(result);
    } else {
      info(`Started traversal ${result.traversalId} on ${graphId}`);
      info(`  Node: ${result.currentNode}`);
      if (result.node.description) {
        info(`  Description: ${result.node.description}`);
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

    // Parse key=value pairs
    const parsed: Record<string, unknown> = {};
    for (const pair of updates) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        info(`Error: invalid key=value pair: "${pair}"`);
        process.exit(1);
      }
      const key = pair.slice(0, eqIdx);
      const rawValue = pair.slice(eqIdx + 1);
      // Try parsing as JSON, fall back to string
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

interface ActiveTraversalEntry {
  readonly traversalId: string;
  readonly graphId: string;
  readonly currentNode: string;
  readonly nodeType: string;
  readonly description: string;
  readonly lastUpdated: string;
  readonly stackDepth: number;
  readonly waitStatus?: "waiting" | "ready" | "timed_out";
  readonly waitingOn?: readonly WaitCondition[];
  readonly timeout?: string;
  readonly timeoutAt?: string;
}

/**
 * List every active traversal with its current-node details. When `waitsOnly`
 * is set, include only traversals sitting on a wait node — the shape plugin
 * hooks rely on to nudge the agent when a blocking condition might have
 * flipped.
 */
export function traversalInspectActive(
  store: TraversalStore,
  opts?: { waitsOnly?: boolean },
): void {
  try {
    const infos = store.listTraversals();
    const entries: ActiveTraversalEntry[] = [];
    for (const t of infos) {
      const raw = store.inspect(t.traversalId, "position");
      const pos = raw as { traversalId: string } & InspectPositionResult;
      if (opts?.waitsOnly && pos.node.type !== "wait") continue;
      entries.push({
        traversalId: t.traversalId,
        graphId: t.graphId,
        currentNode: t.currentNode,
        nodeType: pos.node.type,
        description: pos.node.description ?? "",
        lastUpdated: t.lastUpdated,
        stackDepth: t.stackDepth,
        ...(pos.waitStatus ? { waitStatus: pos.waitStatus } : {}),
        ...(pos.waitingOn ? { waitingOn: pos.waitingOn } : {}),
        ...(pos.timeout ? { timeout: pos.timeout } : {}),
        ...(pos.timeoutAt ? { timeoutAt: pos.timeoutAt } : {}),
      });
    }
    if (cli.json) {
      outputJson({ traversals: entries });
      return;
    }
    if (entries.length === 0) {
      info(opts?.waitsOnly ? "No active traversals in wait state." : "No active traversals.");
      return;
    }
    info(opts?.waitsOnly ? "Active traversals in wait state:" : "Active traversals:");
    for (const e of entries) {
      const waitBit = e.waitStatus ? ` [${e.waitStatus}]` : "";
      info(`  ${e.traversalId}  ${e.graphId} @ ${e.currentNode}${waitBit}`);
      if (e.description) info(`    ${e.description}`);
      if (e.waitingOn?.length) {
        for (const w of e.waitingOn) {
          const mark = w.satisfied ? "✓" : "·";
          info(`    ${mark} ${w.key} (${w.type})${w.description ? ` — ${w.description}` : ""}`);
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
