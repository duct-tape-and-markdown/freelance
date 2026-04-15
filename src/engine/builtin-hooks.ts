/**
 * Built-in onEnter hooks shipped with freelance.
 *
 * Bare identifiers in a node's `onEnter[].call` field (no `./` or `../`
 * prefix) are resolved against BUILTIN_HOOKS at graph-load time; a
 * missing name fails the graph load, same as a missing script file.
 */

import type { HookContext, HookFn, HookMemoryAccess } from "./hooks.js";

/**
 * Guard: every built-in memory hook needs live memory access. If the
 * host wired a HookRunner without memory (memory off), fail at first
 * invocation with a message that points the user at the config switch.
 */
function requireMemory(ctx: HookContext, opName: string): HookMemoryAccess {
  if (!ctx.memory) {
    throw new Error(
      `Built-in hook "${opName}" on node "${ctx.nodeId}" requires memory to be enabled. ` +
        `Set memory.enabled: true in config.yml, or replace this hook with a local script.`,
    );
  }
  return ctx.memory;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new TypeError(
      `Hook arg "${key}" must be a string or null; got ${typeof v} (${JSON.stringify(v)})`,
    );
  }
  return v;
}

function optionalInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new TypeError(
      `Hook arg "${key}" must be an integer; got ${typeof v} (${JSON.stringify(v)})`,
    );
  }
  return v;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new TypeError(
      `Hook arg "${key}" is required and must be a non-empty string; got ${typeof v} (${JSON.stringify(v)})`,
    );
  }
  return v;
}

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

// Normalize "" to undefined so graphs with strict-context can declare a
// default-empty collection key and still trigger the "no collection"
// branch in the store.
function optionalCollection(args: Record<string, unknown>): string | undefined {
  const v = optionalString(args, "collection");
  return v === "" ? undefined : v;
}

const memoryStatus: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_status");
  return { ...memory.status(optionalCollection(ctx.args)) };
};

const memoryBrowse: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_browse");
  return {
    ...memory.browse({
      collection: optionalCollection(ctx.args),
      name: optionalString(ctx.args, "name"),
      kind: optionalString(ctx.args, "kind"),
      limit: optionalInt(ctx.args, "limit"),
      offset: optionalInt(ctx.args, "offset"),
    }),
  };
};

const memorySearch: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_search");
  const query = requireString(ctx.args, "query");
  return {
    ...memory.search(query, {
      collection: optionalCollection(ctx.args),
      limit: optionalInt(ctx.args, "limit"),
    }),
  };
};

const memoryRelated: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_related");
  const entity = requireString(ctx.args, "entity");
  return { ...memory.related(entity, optionalCollection(ctx.args)) };
};

const memoryInspect: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_inspect");
  const entity = requireString(ctx.args, "entity");
  return { ...memory.inspect(entity, optionalCollection(ctx.args)) };
};

// memory_by_source diverges from the single-path MCP tool: it accepts
// `paths: string[]` and loops internally so a single onEnter declaration
// can fan out over context.filesReadPaths. Caller-provided lists are
// capped at MAX_BY_SOURCE_PATHS to bound the hook's runtime against the
// 5-second default timeout — anything longer should be a script hook.
const MAX_BY_SOURCE_PATHS = 50;

const memoryBySource: HookFn = async (ctx) => {
  const memory = requireMemory(ctx, "memory_by_source");
  const paths = requireStringArray(ctx.args, "paths");
  const collection = optionalCollection(ctx.args);
  const capped = paths.slice(0, MAX_BY_SOURCE_PATHS);
  const priorKnowledgeByPath: Record<string, ReturnType<typeof memory.bySource>["propositions"]> =
    {};
  for (const p of capped) {
    priorKnowledgeByPath[p] = memory.bySource(p, collection).propositions;
  }
  return {
    priorKnowledgeByPath,
    priorKnowledgePathsConsidered: capped.length,
    priorKnowledgePathsTruncated: paths.length > MAX_BY_SOURCE_PATHS,
  };
};

export const BUILTIN_HOOKS: ReadonlyMap<string, HookFn> = new Map<string, HookFn>([
  ["memory_status", memoryStatus],
  ["memory_browse", memoryBrowse],
  ["memory_search", memorySearch],
  ["memory_related", memoryRelated],
  ["memory_inspect", memoryInspect],
  ["memory_by_source", memoryBySource],
]);

export const BUILTIN_HOOK_NAMES: ReadonlySet<string> = new Set(BUILTIN_HOOKS.keys());

export function isBuiltinHook(name: string): boolean {
  return BUILTIN_HOOKS.has(name);
}
