/**
 * Built-in onEnter hooks shipped with freelance.
 *
 * Bare identifiers in a node's `onEnter[].call` field (no `./` or `../`
 * prefix) are resolved against BUILTIN_HOOKS at graph-load time; a
 * missing name fails the graph load, same as a missing script file.
 */

import { EC, EngineError } from "../errors.js";
import type { PropositionShape } from "../memory/types.js";
import type { HookContext, HookFn, HookMemoryAccess } from "./hooks.js";

/**
 * Guard: every built-in memory hook needs live memory access. If the
 * host wired a HookRunner without memory (memory off), fail at first
 * invocation with the catalogued `MEMORY_DISABLED` code so the skill's
 * structured recovery fires (point operator at config.yml).
 */
function requireMemory(ctx: HookContext, opName: string): HookMemoryAccess {
  if (!ctx.memory) {
    throw new EngineError(
      `Built-in hook "${opName}" on node "${ctx.nodeId}" requires memory to be enabled. ` +
        `Set memory.enabled: true in config.yml, or replace this hook with a local script.`,
      EC.MEMORY_DISABLED,
    );
  }
  return ctx.memory;
}

type Guard<T> = (v: unknown) => v is T;

const isString: Guard<string> = (v): v is string => typeof v === "string";
const isNonEmptyString: Guard<string> = (v): v is string => typeof v === "string" && v.length > 0;
const isInt: Guard<number> = (v): v is number =>
  typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
const isBool: Guard<boolean> = (v): v is boolean => typeof v === "boolean";
const isShape: Guard<PropositionShape> = (v): v is PropositionShape =>
  v === "minimal" || v === "full";

/**
 * Reads `args[key]`. `null`/`undefined` returns undefined; anything
 * else must satisfy `guard` or throws with a uniform message. `desc`
 * fills the "must be ${desc}" slot — caller chooses the wording.
 *
 * Note: the optional-shape's "or null" wording lives at the call site
 * because nullability is per-helper convention, not part of the guard.
 */
function optional<T>(
  args: Record<string, unknown>,
  key: string,
  guard: Guard<T>,
  desc: string,
): T | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!guard(v)) {
    throw new TypeError(
      `Hook arg "${key}" must be ${desc}; got ${typeof v} (${JSON.stringify(v)})`,
    );
  }
  return v;
}

/**
 * Reads `args[key]` and asserts it satisfies `guard` (covering
 * missing/null/wrong-type in one branch). `desc` fills the "must be
 * ${desc}" slot.
 */
function required<T>(args: Record<string, unknown>, key: string, guard: Guard<T>, desc: string): T {
  const v = args[key];
  if (!guard(v)) {
    throw new TypeError(
      `Hook arg "${key}" is required and must be ${desc}; got ${typeof v} (${JSON.stringify(v)})`,
    );
  }
  return v;
}

/**
 * `paths: string[]` — bespoke because element-level validation isn't
 * captured by a single guard; building an `arrayOf(guard)` factory for
 * one call site would be more scaffold than the inline check.
 */
function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) {
    throw new TypeError(
      `Hook arg "${key}" is required and must be a string array; got ${typeof v} (${JSON.stringify(v)})`,
    );
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new TypeError(
        `Hook arg "${key}" must contain only strings; got element ${JSON.stringify(item)}`,
      );
    }
  }
  return v as string[];
}

const memoryStatus: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_status");
  return { ...memory.status() };
};

const memoryBrowse: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_browse");
  return {
    ...memory.browse({
      name: optional(ctx.args, "name", isString, "a string or null"),
      kind: optional(ctx.args, "kind", isString, "a string or null"),
      limit: optional(ctx.args, "limit", isInt, "an integer"),
      offset: optional(ctx.args, "offset", isInt, "an integer"),
      includeOrphans: optional(ctx.args, "includeOrphans", isBool, "a boolean"),
    }),
  };
};

const memorySearch: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_search");
  const query = required(ctx.args, "query", isNonEmptyString, "a non-empty string");
  return {
    ...memory.search(query, {
      limit: optional(ctx.args, "limit", isInt, "an integer"),
    }),
  };
};

const memoryRelated: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_related");
  const entity = required(ctx.args, "entity", isNonEmptyString, "a non-empty string");
  return {
    ...memory.related(entity, {
      limit: optional(ctx.args, "limit", isInt, "an integer"),
      offset: optional(ctx.args, "offset", isInt, "an integer"),
    }),
  };
};

// `shape` defaults to `"minimal"` in hooks: the warm-path delta-check
// only needs claim text, and the full PropositionInfo payload (per-file
// hashes, validity flags, source arrays, `created_at`) blew `freelance
// advance` responses past 50 KB on multi-file on-enter hooks (see #87).
// Callers that genuinely need provenance pass `shape: "full"` explicitly.
const memoryInspect: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_inspect");
  const entity = required(ctx.args, "entity", isNonEmptyString, "a non-empty string");
  return {
    ...memory.inspect(entity, {
      limit: optional(ctx.args, "limit", isInt, "an integer"),
      offset: optional(ctx.args, "offset", isInt, "an integer"),
      shape: optional(ctx.args, "shape", isShape, '"minimal" or "full"') ?? "minimal",
    }),
  };
};

// memory_by_source accepts `paths: string[]` and loops internally, so
// a single onEnter declaration can fan out over context.filesReadPaths.
// Caller-provided lists are capped at MAX_BY_SOURCE_PATHS to bound
// runtime against the 5-second default timeout — anything longer
// should be a script hook.
//
// Per-path reads default to `shape: "minimal"` (just { id, content })
// because the warm-path delta check only needs claim text; the richer
// `PropositionInfo` payload (per-file hashes, validity flags, source
// arrays, `created_at`) blew `freelance advance` responses past 50 KB
// on multi-file hooks. Since issue #87 this defaulting is the store's
// responsibility — the hook just threads the arg through.
const MAX_BY_SOURCE_PATHS = 50;

interface PriorKnowledgeEntry {
  id: string;
  content: string;
}

const memoryBySource: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_by_source");
  const paths = requireStringArray(ctx.args, "paths");
  const capped = paths.slice(0, MAX_BY_SOURCE_PATHS);
  const perPathLimit = optional(ctx.args, "limit", isInt, "an integer");
  const priorKnowledgeByPath: Record<string, PriorKnowledgeEntry[]> = {};
  for (const p of capped) {
    // Always ask the store for the minimal shape — the wire contract
    // here is fixed at { id, content } and enriching with provenance
    // would just waste the per-proposition source join + staleness
    // check on data that gets stripped below.
    const result = memory.bySource(p, { limit: perPathLimit, shape: "minimal" });
    priorKnowledgeByPath[p] = result.propositions.map((prop) => ({
      id: prop.id,
      content: prop.content,
    }));
  }
  return {
    priorKnowledgeByPath,
    priorKnowledgePathsConsidered: capped.length,
    priorKnowledgePathsTruncated: paths.length > MAX_BY_SOURCE_PATHS,
  };
};

// meta_set lets a workflow tag the traversal with caller-opaque keys at
// node arrival — e.g. write `meta.prUrl = context.prUrl` once the PR
// exists. Args are taken verbatim as the meta payload, after string-typing.
// Returns {} (no context update); meta lands via the host-provided
// collector which the store applies before persisting the record.
const metaSet: HookFn = async (ctx) => {
  if (!ctx.setMeta) {
    throw new EngineError(
      `Built-in hook "meta_set" on node "${ctx.nodeId}" needs a meta collector — ` +
        `the host did not thread one. Internal bug; please report.`,
      EC.INTERNAL,
    );
  }
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.args)) {
    if (typeof value !== "string") {
      throw new TypeError(
        `meta_set arg "${key}" must resolve to a string; got ${typeof value} (${JSON.stringify(value)}). ` +
          `If sourcing from context, check that the referenced field is a string.`,
      );
    }
    updates[key] = value;
  }
  if (Object.keys(updates).length === 0) {
    throw new Error(`meta_set on node "${ctx.nodeId}" requires at least one key=value pair`);
  }
  ctx.setMeta(updates);
  return {};
};

export const BUILTIN_HOOKS: ReadonlyMap<string, HookFn> = new Map<string, HookFn>([
  ["memory_status", memoryStatus],
  ["memory_browse", memoryBrowse],
  ["memory_search", memorySearch],
  ["memory_related", memoryRelated],
  ["memory_inspect", memoryInspect],
  ["memory_by_source", memoryBySource],
  ["meta_set", metaSet],
]);

export const BUILTIN_HOOK_NAMES: ReadonlySet<string> = new Set(BUILTIN_HOOKS.keys());

export function isBuiltinHook(name: string): boolean {
  return BUILTIN_HOOKS.has(name);
}
