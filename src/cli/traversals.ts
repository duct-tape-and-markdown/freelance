/**
 * CLI handlers for traversal commands — JSON-only machine surface.
 *
 * Runtime verbs (status, start, advance, context set, meta set, inspect,
 * reset) are the primary execution path for the Claude Agent Skill
 * per `docs/decisions.md` § "CLI is the primary execution surface".
 * There is no human audience — every handler writes structured JSON
 * to stdout and exits with a semantic code (see `EXIT` in output.ts).
 * Breadcrumbs and startup logs still go to stderr via `info()` where
 * relevant, never on the success path.
 */

import type { InspectHistoryOptions } from "../engine/context.js";
import { EC, EngineError } from "../errors.js";
import type { TraversalStore } from "../state/index.js";
import type { InspectField, InspectPositionResult } from "../types.js";
import { CliExit, EXIT, outputJson, parseIntArg, splitKeyValue } from "./output.js";

// Shared by `start` and `advance` for their `--context` JSON payload.
function parseContextJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new EngineError(`--context must be valid JSON: ${msg}`, EC.INVALID_CONTEXT_JSON);
  }
}

// Byte caps for meta key/value pairs at the CLI boundary. Key names
// are short by design; values are tag-sized (URLs, ticket ids, branch
// names), not blob-sized. `--filter` uses the same caps since a value
// larger than the cap couldn't have been stored to match against.
export const META_KEY_MAX_BYTES = 256;
export const META_VALUE_MAX_BYTES = 4096;

// Values stay strings — meta is deliberately opaque, so (unlike
// `freelance context set`) no JSON coercion here.
function parseMetaPairs(pairs: string[] | undefined, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!pairs) return out;
  for (const pair of pairs) {
    const [key, value] = splitKeyValue(pair, flag);
    const keyBytes = Buffer.byteLength(key, "utf-8");
    if (keyBytes > META_KEY_MAX_BYTES) {
      throw new EngineError(
        `${flag} key exceeds ${META_KEY_MAX_BYTES}-byte cap (got ${keyBytes} bytes)`,
        EC.INVALID_META,
      );
    }
    const valueBytes = Buffer.byteLength(value, "utf-8");
    if (valueBytes > META_VALUE_MAX_BYTES) {
      throw new EngineError(
        `${flag} value for "${key}" exceeds ${META_VALUE_MAX_BYTES}-byte cap (got ${valueBytes} bytes)`,
        EC.INVALID_META,
      );
    }
    out[key] = value;
  }
  return out;
}

export function traversalStatus(store: TraversalStore, opts?: { filter?: string[] }): void {
  const result = store.listGraphs();
  // Operator-side pre-filter. The skill sees `meta` on every list
  // entry and can pick directly; this shortcut is for shell scripts
  // and humans who want to scope the response before parsing.
  const filter = parseMetaPairs(opts?.filter, "--filter");
  const filterEntries = Object.entries(filter);
  const traversals =
    filterEntries.length === 0
      ? result.activeTraversals
      : result.activeTraversals.filter(
          (t) => t.meta !== undefined && filterEntries.every(([k, v]) => t.meta?.[k] === v),
        );
  outputJson({ ...result, activeTraversals: traversals });
}

export async function traversalStart(
  store: TraversalStore,
  graphId: string,
  context?: string,
  opts?: { meta?: string[] },
): Promise<void> {
  const initialContext = context ? parseContextJson(context) : undefined;
  const meta = parseMetaPairs(opts?.meta, "--meta");
  const result = await store.createTraversal(
    graphId,
    initialContext,
    Object.keys(meta).length > 0 ? meta : undefined,
  );
  outputJson(result);
}

export async function traversalAdvance(
  store: TraversalStore,
  edge?: string,
  opts?: { traversal?: string; context?: string; minimal?: boolean },
): Promise<void> {
  const id = store.resolveTraversalId(opts?.traversal);
  const contextUpdates = opts?.context ? parseContextJson(opts.context) : undefined;
  if (!edge) {
    // No edge argument: report the available edges instead. Useful for
    // the skill to probe validTransitions without side effects.
    const raw = store.inspect(id, "position");
    const inspectResult = raw as { traversalId: string } & InspectPositionResult;
    outputJson({ traversalId: id, validTransitions: inspectResult.validTransitions });
    return;
  }
  const result = await store.advance(id, edge, contextUpdates, {
    ...(opts?.minimal ? { responseMode: "minimal" as const } : {}),
  });
  if (result.isError) {
    // In-band advance error — the traversal is fine, the caller's
    // requested edge didn't pass. Exit BLOCKED so the skill can
    // distinguish "retry with different context" from "structural
    // error, stop". Response still carries `validTransitions` etc.
    // `CliExit` lets `runCliHandlerAsync` close the runtime before
    // the BLOCKED exit — direct `process.exit` would leak sidecars.
    throw new CliExit(result, EXIT.BLOCKED);
  }
  outputJson(result);
}

export function traversalContextSet(
  store: TraversalStore,
  updates: string[],
  opts?: { traversal?: string; minimal?: boolean },
): void {
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

  const result = store.contextSet(id, parsed, {
    ...(opts?.minimal ? { responseMode: "minimal" as const } : {}),
  });
  outputJson(result);
}

export function traversalMetaSet(
  store: TraversalStore,
  updates: string[],
  opts?: { traversal?: string },
): void {
  const id = store.resolveTraversalId(opts?.traversal);
  const parsed = parseMetaPairs(updates, "meta set");
  if (Object.keys(parsed).length === 0) {
    throw new EngineError("meta set requires at least one key=value pair", EC.INVALID_META);
  }
  const result = store.setMeta(id, parsed);
  outputJson(result);
}

export function traversalInspect(
  store: TraversalStore,
  traversalId?: string,
  detail?: "position" | "history",
  opts?: {
    minimal?: boolean;
    fields?: readonly InspectField[];
    limit?: string;
    offset?: string;
    includeSnapshots?: boolean;
  },
): void {
  const limit = parseIntArg(opts?.limit, "--limit");
  const offset = parseIntArg(opts?.offset, "--offset");
  const id = store.resolveTraversalId(traversalId);
  const historyOpts: InspectHistoryOptions = {
    ...(limit !== undefined && { limit }),
    ...(offset !== undefined && { offset }),
    ...(opts?.includeSnapshots && { includeSnapshots: true }),
  };
  const raw = store.inspect(id, detail ?? "position", opts?.fields, historyOpts, {
    ...(opts?.minimal ? { responseMode: "minimal" as const } : {}),
  });
  outputJson(raw);
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
  outputJson({ traversals: store.inspectActive(opts) });
}

export function traversalReset(
  store: TraversalStore,
  traversalId?: string,
  opts?: { confirm?: boolean },
): void {
  if (!opts?.confirm) {
    throw new EngineError("must pass --confirm to reset a traversal.", EC.CONFIRM_REQUIRED, {
      envelopeSlots: { commandName: "reset" },
    });
  }
  const id = store.resolveTraversalId(traversalId);
  const result = store.resetTraversal(id);
  outputJson(result);
}
