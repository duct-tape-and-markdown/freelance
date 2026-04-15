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

export const BUILTIN_HOOKS: ReadonlyMap<string, HookFn> = new Map<string, HookFn>([
  ["memory_status", memoryStatus],
  ["memory_browse", memoryBrowse],
]);

export const BUILTIN_HOOK_NAMES: ReadonlySet<string> = new Set(BUILTIN_HOOKS.keys());

export function isBuiltinHook(name: string): boolean {
  return BUILTIN_HOOKS.has(name);
}
