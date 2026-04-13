/**
 * Programmatic-node operation registry.
 *
 * A `programmatic` node declares an operation the engine runs server-side
 * between agent turns. Ops are pure (no mutation of engine state outside
 * their declared contextUpdates), sync (to match the sync engine loop), and
 * return plain objects that the drain loop projects into traversal context
 * via the node's contextUpdates mapping.
 *
 * The registry is built once at server startup with a live OpContext
 * (currently: a MemoryStore reference), then threaded through the loader
 * for op-name validation and through the engine for execution.
 *
 * Design notes:
 *
 * - Sync only. MemoryStore is sync (node:sqlite). Engine.advance is sync.
 *   Making ops async would cascade `await` through the whole engine surface;
 *   that's its own refactor when a real async op arrives (HTTP, embeddings).
 *
 * - Throw-for-programmer-error, not throw-for-control-flow. An op that
 *   returns an empty array is a valid result, not an error — downstream
 *   edges branch on the result. Throwing is reserved for shape violations
 *   (bad args, unexpected store state) and will surface as EngineError from
 *   the drain loop, halting the traversal.
 *
 * - Each handler validates its resolved args at runtime. Phase 1 does this
 *   inline; per-op Zod arg schemas are a future refinement once we see
 *   what authoring patterns emerge.
 */

import type { MemoryStore } from "../memory/store.js";

/**
 * Host capabilities exposed to op handlers. Keep this narrow — handlers
 * destructure only what they need, and new fields land additively when
 * future ops require new dependencies (filesystem, network, embeddings).
 */
export interface OpContext {
  readonly memoryStore: MemoryStore;
}

/**
 * An op handler runs a deterministic server-side operation and returns a
 * plain object. The drain loop projects the result into traversal context
 * via the node's contextUpdates mapping.
 *
 * `args` arrives pre-resolved — the drain loop has already substituted
 * context-path references (`context.foo.bar`) with their live values and
 * left literal values (numbers, booleans, non-path strings, null, arrays,
 * objects) in place. Handlers just validate shape and return.
 */
export type OpHandler = (args: Record<string, unknown>, ctx: OpContext) => Record<string, unknown>;

/**
 * A read-only lookup for op handlers. The loader uses `has` to validate
 * that workflows reference only known ops; the engine uses `get` at
 * execution time. `list` is exposed for future introspection (freelance_guide
 * ops topic, debug output).
 */
export interface OpsRegistry {
  get(name: string): OpHandler | undefined;
  has(name: string): boolean;
  list(): readonly string[];
}

// --- Argument helpers ---

/**
 * Extract an optional string arg from a resolved args object. Throws on
 * wrong type. Missing, null, and the empty string are all returned as
 * undefined so handlers can treat optional args uniformly — an empty
 * string from a context default ("collection": "") is semantically
 * "no collection specified", not a collection literally named "".
 */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new TypeError(
      `Op arg "${key}" must be a string or null; got ${typeof v} (${JSON.stringify(v)})`,
    );
  }
  return v === "" ? undefined : v;
}

/**
 * Extract an optional integer arg. Throws on wrong type or non-integer
 * numeric value.
 */
function optionalInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new TypeError(
      `Op arg "${key}" must be an integer; got ${typeof v} (${JSON.stringify(v)})`,
    );
  }
  return v;
}

// --- Memory ops ---

/**
 * memory_status — read aggregate counts for a collection (or the whole
 * store when `collection` is omitted). Fully deterministic and idempotent;
 * safe to run between any two agent turns without side effects.
 *
 * args:   { collection?: string }
 * result: { total_propositions, valid_propositions, stale_propositions, total_entities }
 */
const memoryStatus: OpHandler = (args, ctx) => {
  const collection = optionalString(args, "collection");
  return { ...ctx.memoryStore.status(collection) };
};

/**
 * memory_browse — list entities in a collection with optional name/kind
 * filters and pagination. Used by programmatic nodes to populate a manifest
 * of existing graph state the agent should consult before generating new
 * entities, so the agent doesn't proliferate duplicate hubs.
 *
 * args:   { collection?: string, name?: string, kind?: string, limit?: int, offset?: int }
 * result: { entities, total }
 */
const memoryBrowse: OpHandler = (args, ctx) => {
  const collection = optionalString(args, "collection");
  const name = optionalString(args, "name");
  const kind = optionalString(args, "kind");
  const limit = optionalInt(args, "limit");
  const offset = optionalInt(args, "offset");
  return { ...ctx.memoryStore.browse({ collection, name, kind, limit, offset }) };
};

// --- Registry factory ---

/**
 * Build the default ops registry wired to a live OpContext. Returns a
 * plain object implementing OpsRegistry; the underlying handler map is
 * frozen so callers can't mutate the registry at runtime.
 */
export function createDefaultOpsRegistry(ctx: OpContext): OpsRegistry {
  const handlers: Record<string, OpHandler> = {
    memory_status: (args) => memoryStatus(args, ctx),
    memory_browse: (args) => memoryBrowse(args, ctx),
  };
  Object.freeze(handlers);
  const names = Object.freeze(Object.keys(handlers).slice().sort());
  return {
    get: (name) => handlers[name],
    has: (name) => Object.hasOwn(handlers, name),
    list: () => names,
  };
}

/**
 * Build a test ops registry from a caller-supplied handler map. Used by
 * unit tests and fixture graphs so the engine can exercise programmatic
 * chaining without needing a live MemoryStore. The shape matches
 * createDefaultOpsRegistry, so engine code doesn't branch on test vs prod.
 */
export function createTestOpsRegistry(handlers: Record<string, OpHandler>): OpsRegistry {
  const frozen = { ...handlers };
  Object.freeze(frozen);
  const names = Object.freeze(Object.keys(frozen).slice().sort());
  return {
    get: (name) => frozen[name],
    has: (name) => Object.hasOwn(frozen, name),
    list: () => names,
  };
}
