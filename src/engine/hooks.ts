/**
 * onEnter hook types + runner.
 *
 * Hooks run on node arrival (from start() and from advance()'s post-edge
 * target), before the engine builds its response. Each hook receives
 * resolved args + live context + the memory store, and returns a plain
 * object of context updates which the runner merges via the existing
 * applyContextUpdates / enforceStrictContext path.
 */

import { pathToFileURL } from "node:url";
import { EngineError } from "../errors.js";
import { CONTEXT_PATH_PATTERN, resolveContextPath } from "../evaluator.js";
import type { HookResolutionMap, ResolvedHook } from "../hook-resolution.js";
import type { BrowseResult, StatusResult } from "../memory/types.js";
import type { GraphDefinition, SessionState } from "../types.js";
import { BUILTIN_HOOKS } from "./builtin-hooks.js";
import { applyContextUpdates, enforceStrictContext } from "./context.js";

/**
 * Narrow interface the hook runner exposes to hooks. Built-ins call
 * `status()` and `browse()` and nothing else; user scripts see the
 * same two methods, which prevents them from reaching into `emit()`,
 * `close()`, `updateConfig()`, or anything else on the concrete store.
 *
 * The real `MemoryStore` class satisfies this structurally — no
 * explicit `implements` needed.
 */
export interface HookMemoryAccess {
  status(collection?: string): StatusResult;
  browse(options?: {
    name?: string;
    kind?: string;
    limit?: number;
    offset?: number;
    collection?: string;
  }): BrowseResult;
}

/**
 * Context passed to every hook invocation. `args` has already been
 * resolved — strings matching `context.foo.bar` are replaced with their
 * live context values before the hook is called.
 *
 * `memory` is the narrow read interface over the host's memory store,
 * present only when memory is enabled. Built-in memory hooks assert
 * on its presence; user scripts that don't touch it work regardless.
 */
export interface HookContext {
  readonly args: Record<string, unknown>;
  readonly context: Readonly<Record<string, unknown>>;
  readonly memory?: HookMemoryAccess;
  readonly graphId: string;
  readonly nodeId: string;
  /**
   * Merge tags into the traversal's `meta`. Present only when the host has
   * threaded a collector — the store wrapper does this around every advance
   * and start. Hooks that do not need to write meta ignore it; built-ins
   * that do (e.g. `meta_set`) call it directly. Updates are batched and
   * applied by the host *after* the hook chain returns, so they don't race
   * the engine's own state save.
   */
  readonly setMeta?: (updates: Record<string, string>) => void;
}

/**
 * Hook function contract. Must return a plain object of context updates;
 * keys are merged into session context via applyContextUpdates, so strict
 * context enforcement applies the same way it does for agent-driven updates.
 */
export type HookFn = (ctx: HookContext) => Promise<Record<string, unknown>>;

export const DEFAULT_HOOK_TIMEOUT_MS = 5000;

export interface HookRunnerOptions {
  /**
   * Memory access object threaded into HookContext. Optional — when
   * omitted, user-script hooks that ignore `ctx.memory` still work,
   * and built-in memory hooks throw a clear error on first invocation.
   * Takes the narrow `HookMemoryAccess` interface rather than the
   * concrete `MemoryStore` so hooks can't reach into write methods.
   */
  readonly memory?: HookMemoryAccess;
  readonly hookTimeoutMs?: number;
  /** Test override. Falls back to the package's BUILTIN_HOOKS map. */
  readonly builtinHooks?: ReadonlyMap<string, HookFn>;
}

export class HookRunner {
  private readonly memory?: HookMemoryAccess;
  private readonly hookTimeoutMs: number;
  private readonly builtinHooks: ReadonlyMap<string, HookFn>;
  // Per-call meta collector, set via withMetaCollector around an engine
  // operation. Hook context surfaces it as `setMeta` only when present.
  // Single-threaded by virtue of the store awaiting every engine call.
  private currentMetaCollector?: (updates: Record<string, string>) => void;

  constructor(options: HookRunnerOptions = {}) {
    this.memory = options.memory;
    this.hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    this.builtinHooks = options.builtinHooks ?? BUILTIN_HOOKS;
  }

  /**
   * Wrap an engine operation so that hooks fired during `fn` can write to
   * meta via `ctx.setMeta`. `collector` receives every update; the caller
   * (typically TraversalStore) applies the merged result after `fn`
   * resolves but before persisting the record.
   */
  async withMetaCollector<T>(
    collector: (updates: Record<string, string>) => void,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.currentMetaCollector;
    this.currentMetaCollector = collector;
    try {
      return await fn();
    } finally {
      this.currentMetaCollector = previous;
    }
  }

  /**
   * Run every hook declared on the given node, in order. Each hook's
   * result is merged into session context before the next hook runs,
   * so later hooks can read earlier hooks' writes.
   *
   * Invariant: `hookResolutions.get(nodeId).length === node.onEnter.length`,
   * enforced by resolveGraphHooks — we zip the two lists at invocation.
   */
  async runHooksFor(
    session: SessionState,
    graphDef: GraphDefinition,
    nodeId: string,
    hookResolutions: HookResolutionMap | undefined,
  ): Promise<void> {
    const resolutions = hookResolutions?.get(nodeId);
    if (!resolutions || resolutions.length === 0) return;

    const node = graphDef.nodes[nodeId];
    const specs = node.onEnter ?? [];
    // Sanity check: resolveGraphHooks builds `resolutions` by walking
    // `node.onEnter` in order and throws on any failure, so the arrays
    // must be the same length here. If they aren't, something rebuilt
    // `hookResolutions` without going through the resolver.
    if (specs.length !== resolutions.length) {
      throw new EngineError(
        `Hook resolution count mismatch on node "${nodeId}" (specs=${specs.length}, ` +
          `resolutions=${resolutions.length}). This is an internal bug — please report.`,
        "HOOK_RESOLUTION_MISMATCH",
      );
    }

    for (let i = 0; i < resolutions.length; i++) {
      const resolved = resolutions[i];
      const rawArgs = specs[i].args ?? {};
      const resolvedArgs = resolveHookArgs(rawArgs, session.context);

      const fn = await this.loadHookFn(resolved, nodeId);

      const hookCtx: HookContext = {
        args: resolvedArgs,
        context: session.context,
        memory: this.memory,
        graphId: graphDef.id,
        nodeId,
        ...(this.currentMetaCollector && { setMeta: this.currentMetaCollector }),
      };

      let result: Record<string, unknown>;
      try {
        result = await withTimeout(fn(hookCtx), this.hookTimeoutMs, resolved.call, nodeId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new EngineError(
          `onEnter hook "${resolved.call}" on node "${nodeId}" failed: ${message}`,
          "HOOK_FAILED",
        );
      }

      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw new EngineError(
          `onEnter hook "${resolved.call}" on node "${nodeId}" must return a plain object; ` +
            `got ${Array.isArray(result) ? "array" : typeof result}`,
          "HOOK_BAD_RETURN",
        );
      }

      enforceStrictContext(graphDef, result);
      applyContextUpdates(session, result);
    }
  }

  /**
   * Resolve a hook reference to an invokable function. Built-ins come
   * from the static map; script paths go through Node's dynamic import
   * loader, which is itself cached by resolved URL — a repeat import()
   * on the same absolute path is a Module-map lookup, no re-parse and
   * no re-execute. We don't layer our own cache on top.
   *
   * Import failure and bad-shape are both hard errors surfaced at the
   * first invocation attempt, not at engine construction, so graphs
   * with script hooks only fail when those nodes are actually reached.
   */
  private async loadHookFn(resolved: ResolvedHook, nodeId: string): Promise<HookFn> {
    if (resolved.kind === "builtin") {
      const fn = this.builtinHooks.get(resolved.name);
      if (!fn) {
        throw new EngineError(
          `Built-in hook "${resolved.name}" referenced by node "${nodeId}" is not registered. ` +
            `Available built-ins: [${[...this.builtinHooks.keys()].join(", ")}]`,
          "HOOK_BUILTIN_MISSING",
        );
      }
      return fn;
    }

    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(resolved.absolutePath).href)) as Record<string, unknown>;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new EngineError(
        `Failed to import hook script "${resolved.absolutePath}" for node "${nodeId}": ${message}`,
        "HOOK_IMPORT_FAILED",
      );
    }

    const fn = mod.default;
    if (typeof fn !== "function") {
      throw new EngineError(
        `Hook script "${resolved.absolutePath}" must export a default function (got ${typeof fn})`,
        "HOOK_BAD_SHAPE",
      );
    }

    return fn as HookFn;
  }
}

/**
 * Walk raw arg values; strings matching CONTEXT_PATH_PATTERN get
 * resolved against live context, everything else passes through. Does
 * not recurse into nested objects/arrays — if authors ever need that,
 * add it with a test case, not speculatively.
 */
export function resolveHookArgs(
  args: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && CONTEXT_PATH_PATTERN.test(value)) {
      resolved[key] = resolveContextPath(context, value);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Wrap a hook invocation in a timeout race. The dangling hook promise
 * keeps running in the background after timeout — tolerable because
 * hooks are expected to be short IO (status/browse/HTTP) and the host
 * process lifetime bounds the leak.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  call: string,
  nodeId: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`hook "${call}" on node "${nodeId}" exceeded ${timeoutMs}ms timeout`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
