import { describe, expect, it, vi } from "vitest";
import {
  createDefaultOpsRegistry,
  createTestOpsRegistry,
  type OpContext,
  type OpHandler,
} from "../src/engine/operations.js";
import type { MemoryStore } from "../src/memory/store.js";
import type { BrowseResult, StatusResult } from "../src/memory/types.js";

// A minimal fake MemoryStore — we only need the three methods the default
// ops wrap. Cast through `unknown` because we don't want to hand-roll the
// full 20+ method surface just to test argument plumbing.
function makeFakeStore(overrides: Partial<MemoryStore>): MemoryStore {
  return overrides as unknown as MemoryStore;
}

function makeCtx(store: MemoryStore): OpContext {
  return { memoryStore: store };
}

describe("createDefaultOpsRegistry — registration", () => {
  it("registers memory_status and memory_browse", () => {
    const registry = createDefaultOpsRegistry(makeCtx(makeFakeStore({})));
    expect(registry.has("memory_status")).toBe(true);
    expect(registry.has("memory_browse")).toBe(true);
  });

  it("list() returns sorted op names", () => {
    const registry = createDefaultOpsRegistry(makeCtx(makeFakeStore({})));
    expect(registry.list()).toEqual(["memory_browse", "memory_status"]);
  });

  it("has() returns false for unknown op names", () => {
    const registry = createDefaultOpsRegistry(makeCtx(makeFakeStore({})));
    expect(registry.has("nonexistent")).toBe(false);
    expect(registry.has("")).toBe(false);
  });

  it("get() returns undefined for unknown op names", () => {
    const registry = createDefaultOpsRegistry(makeCtx(makeFakeStore({})));
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("list() is frozen — callers cannot mutate", () => {
    const registry = createDefaultOpsRegistry(makeCtx(makeFakeStore({})));
    const list = registry.list() as string[];
    expect(() => {
      list.push("injected");
    }).toThrow();
  });
});

describe("memory_status op", () => {
  const stubStatus: StatusResult = {
    total_propositions: 42,
    valid_propositions: 40,
    stale_propositions: 2,
    total_entities: 15,
  };

  it("calls MemoryStore.status() with no collection when arg is absent", () => {
    const status = vi.fn().mockReturnValue(stubStatus);
    const ctx = makeCtx(makeFakeStore({ status }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_status") as OpHandler;
    const result = handler({}, ctx);
    expect(status).toHaveBeenCalledWith(undefined);
    expect(result).toEqual(stubStatus);
  });

  it("passes a string collection through", () => {
    const status = vi.fn().mockReturnValue(stubStatus);
    const ctx = makeCtx(makeFakeStore({ status }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_status") as OpHandler;
    handler({ collection: "project-alpha" }, ctx);
    expect(status).toHaveBeenCalledWith("project-alpha");
  });

  it("treats null collection as absent (resolved context path that was missing)", () => {
    const status = vi.fn().mockReturnValue(stubStatus);
    const ctx = makeCtx(makeFakeStore({ status }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_status") as OpHandler;
    handler({ collection: null }, ctx);
    expect(status).toHaveBeenCalledWith(undefined);
  });

  it("treats empty-string collection as absent", () => {
    // An initial context defaulting collection to "" is semantically
    // "no collection specified" — not a collection literally named "".
    const status = vi.fn().mockReturnValue(stubStatus);
    const ctx = makeCtx(makeFakeStore({ status }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_status") as OpHandler;
    handler({ collection: "" }, ctx);
    expect(status).toHaveBeenCalledWith(undefined);
  });

  it("throws on non-string collection arg", () => {
    const status = vi.fn().mockReturnValue(stubStatus);
    const ctx = makeCtx(makeFakeStore({ status }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_status") as OpHandler;
    expect(() => handler({ collection: 42 }, ctx)).toThrow(TypeError);
  });

  it("returns a shallow copy of the store result (not a live reference)", () => {
    const status = vi.fn().mockReturnValue(stubStatus);
    const ctx = makeCtx(makeFakeStore({ status }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_status") as OpHandler;
    const result = handler({}, ctx);
    expect(result).not.toBe(stubStatus);
    expect(result).toEqual(stubStatus);
  });
});

describe("memory_browse op", () => {
  const stubBrowse: BrowseResult = {
    entities: [
      {
        id: "ent-1",
        name: "Engine",
        kind: "class",
        proposition_count: 12,
        valid_proposition_count: 10,
      },
    ],
    total: 1,
  };

  it("passes all optional args through to MemoryStore.browse()", () => {
    const browse = vi.fn().mockReturnValue(stubBrowse);
    const ctx = makeCtx(makeFakeStore({ browse }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_browse") as OpHandler;
    handler({ collection: "default", name: "eng", kind: "class", limit: 10, offset: 5 }, ctx);
    expect(browse).toHaveBeenCalledWith({
      collection: "default",
      name: "eng",
      kind: "class",
      limit: 10,
      offset: 5,
    });
  });

  it("normalizes null args to undefined", () => {
    const browse = vi.fn().mockReturnValue(stubBrowse);
    const ctx = makeCtx(makeFakeStore({ browse }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_browse") as OpHandler;
    handler({ collection: null, name: null, kind: null, limit: null, offset: null }, ctx);
    expect(browse).toHaveBeenCalledWith({
      collection: undefined,
      name: undefined,
      kind: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it("throws on non-integer limit", () => {
    const browse = vi.fn().mockReturnValue(stubBrowse);
    const ctx = makeCtx(makeFakeStore({ browse }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_browse") as OpHandler;
    expect(() => handler({ limit: 1.5 }, ctx)).toThrow(TypeError);
  });

  it("throws on non-number limit", () => {
    const browse = vi.fn().mockReturnValue(stubBrowse);
    const ctx = makeCtx(makeFakeStore({ browse }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_browse") as OpHandler;
    expect(() => handler({ limit: "10" }, ctx)).toThrow(TypeError);
  });

  it("throws on non-string name", () => {
    const browse = vi.fn().mockReturnValue(stubBrowse);
    const ctx = makeCtx(makeFakeStore({ browse }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_browse") as OpHandler;
    expect(() => handler({ name: 42 }, ctx)).toThrow(TypeError);
  });

  it("empty result is not an error", () => {
    const emptyResult: BrowseResult = { entities: [], total: 0 };
    const browse = vi.fn().mockReturnValue(emptyResult);
    const ctx = makeCtx(makeFakeStore({ browse }));
    const handler = createDefaultOpsRegistry(ctx).get("memory_browse") as OpHandler;
    const result = handler({}, ctx);
    expect(result).toEqual({ entities: [], total: 0 });
  });
});

describe("createTestOpsRegistry", () => {
  it("exposes the provided handler map", () => {
    const test_echo: OpHandler = (args) => ({ echoed: args });
    const registry = createTestOpsRegistry({ test_echo });
    expect(registry.has("test_echo")).toBe(true);
    expect(registry.list()).toEqual(["test_echo"]);
    const handler = registry.get("test_echo");
    expect(handler).toBeDefined();
    expect(handler?.({ x: 1 }, {} as OpContext)).toEqual({ echoed: { x: 1 } });
  });

  it("sorts op names in list()", () => {
    const registry = createTestOpsRegistry({
      zebra: () => ({}),
      apple: () => ({}),
      mango: () => ({}),
    });
    expect(registry.list()).toEqual(["apple", "mango", "zebra"]);
  });

  it("isolates the registry from post-creation mutation of the source map", () => {
    const handlers: Record<string, OpHandler> = { foo: () => ({ v: 1 }) };
    const registry = createTestOpsRegistry(handlers);
    handlers.bar = () => ({ v: 2 });
    expect(registry.has("bar")).toBe(false);
    expect(registry.list()).toEqual(["foo"]);
  });

  it("get() returns undefined for unknown names", () => {
    const registry = createTestOpsRegistry({ foo: () => ({}) });
    expect(registry.get("bar")).toBeUndefined();
  });
});
