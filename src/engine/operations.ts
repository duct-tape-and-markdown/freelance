import type { MemoryStore } from "../memory/store.js";

export interface OpContext {
  readonly memoryStore: MemoryStore;
}

export type OpHandler = (args: Record<string, unknown>, ctx: OpContext) => Record<string, unknown>;

export interface OpsRegistry {
  get(name: string): OpHandler | undefined;
  has(name: string): boolean;
  list(): readonly string[];
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new TypeError(
      `Op arg "${key}" must be a string or null; got ${typeof v} (${JSON.stringify(v)})`,
    );
  }
  return v;
}

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

// The memory_* ops treat "" as "no collection specified" because that's the
// default value sealed workflows declare in their context schema — not a
// collection literally named "". The normalization is op-local rather than
// global so other future ops can make their own choice for other string args.
function optionalCollection(args: Record<string, unknown>): string | undefined {
  const v = optionalString(args, "collection");
  return v === "" ? undefined : v;
}

// Shallow-spread so the return type widens to Record<string, unknown> —
// required by the OpHandler contract since the store's typed interfaces
// (StatusResult, BrowseResult) lack an index signature.
const memoryStatus: OpHandler = (args, ctx) => ({
  ...ctx.memoryStore.status(optionalCollection(args)),
});

const memoryBrowse: OpHandler = (args, ctx) => ({
  ...ctx.memoryStore.browse({
    collection: optionalCollection(args),
    name: optionalString(args, "name"),
    kind: optionalString(args, "kind"),
    limit: optionalInt(args, "limit"),
    offset: optionalInt(args, "offset"),
  }),
});

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
