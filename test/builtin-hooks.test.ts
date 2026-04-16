import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_HOOK_NAMES, BUILTIN_HOOKS, isBuiltinHook } from "../src/engine/builtin-hooks.js";
import type { HookContext } from "../src/engine/hooks.js";
import { openDatabase } from "../src/memory/db.js";
import { MemoryStore } from "../src/memory/store.js";

function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    args: {},
    context: {},
    graphId: "test-graph",
    nodeId: "test-node",
    ...overrides,
  };
}

describe("BUILTIN_HOOK_NAMES + isBuiltinHook", () => {
  it("names set matches BUILTIN_HOOKS keys", () => {
    expect([...BUILTIN_HOOK_NAMES].sort()).toEqual([...BUILTIN_HOOKS.keys()].sort());
  });

  it("isBuiltinHook true for registered names, false otherwise", () => {
    expect(isBuiltinHook("memory_status")).toBe(true);
    expect(isBuiltinHook("memory_browse")).toBe(true);
    expect(isBuiltinHook("meta_set")).toBe(true);
    expect(isBuiltinHook("memory_emit")).toBe(false);
    expect(isBuiltinHook("not-a-hook")).toBe(false);
  });
});

describe("meta_set built-in hook", () => {
  it("forwards every arg as a meta update via the host-provided collector", async () => {
    const collected: Record<string, string>[] = [];
    const metaSet = BUILTIN_HOOKS.get("meta_set");
    expect(metaSet).toBeDefined();
    const result = await metaSet!(
      makeCtx({
        args: { externalKey: "DEV-1234", branch: "feature/x" },
        setMeta: (u) => collected.push(u),
      }),
    );
    expect(result).toEqual({});
    expect(collected).toEqual([{ externalKey: "DEV-1234", branch: "feature/x" }]);
  });

  it("rejects non-string arg values (e.g. unresolved context paths)", async () => {
    const metaSet = BUILTIN_HOOKS.get("meta_set")!;
    await expect(
      metaSet(makeCtx({ args: { externalKey: 1234 }, setMeta: () => {} })),
    ).rejects.toThrow(/must resolve to a string/);
  });

  it("requires at least one arg", async () => {
    const metaSet = BUILTIN_HOOKS.get("meta_set")!;
    await expect(metaSet(makeCtx({ args: {}, setMeta: () => {} }))).rejects.toThrow(
      /at least one key=value/,
    );
  });

  it("throws if no collector is threaded (host bug)", async () => {
    const metaSet = BUILTIN_HOOKS.get("meta_set")!;
    await expect(metaSet(makeCtx({ args: { x: "y" } }))).rejects.toThrow(/meta collector/);
  });
});

describe("memory_status built-in hook", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-hook-"));
    store = new MemoryStore(openDatabase(path.join(tmpDir, "memory.db")), tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns status shape from a live MemoryStore", async () => {
    const memoryStatus = BUILTIN_HOOKS.get("memory_status");
    expect(memoryStatus).toBeDefined();
    const result = await memoryStatus!(makeCtx({ memory: store }));

    expect(result).toHaveProperty("total_propositions", 0);
    expect(result).toHaveProperty("valid_propositions", 0);
    expect(result).toHaveProperty("stale_propositions", 0);
    expect(result).toHaveProperty("total_entities", 0);
  });

  it("passes an explicit collection arg through", async () => {
    const memoryStatus = BUILTIN_HOOKS.get("memory_status")!;
    const result = await memoryStatus(makeCtx({ args: { collection: "default" }, memory: store }));

    expect(result.total_propositions).toBe(0);
  });

  it("coerces empty-string collection to undefined", async () => {
    // The optionalCollection helper normalizes "" → undefined so that
    // sealed workflows with a default-empty context field don't hit the
    // store with a literal empty collection name.
    const memoryStatus = BUILTIN_HOOKS.get("memory_status")!;
    const result = await memoryStatus(makeCtx({ args: { collection: "" }, memory: store }));

    expect(result.total_propositions).toBe(0);
  });

  it("throws a clear error when ctx.memory is undefined", async () => {
    const memoryStatus = BUILTIN_HOOKS.get("memory_status")!;
    await expect(memoryStatus(makeCtx())).rejects.toThrow(
      /memory_status.*requires memory to be enabled/,
    );
  });

  it("rejects non-string collection arg", async () => {
    const memoryStatus = BUILTIN_HOOKS.get("memory_status")!;
    await expect(
      memoryStatus(makeCtx({ args: { collection: 42 }, memory: store })),
    ).rejects.toThrow(/collection.*must be a string/);
  });
});

describe("memory_browse built-in hook", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-hook-"));
    store = new MemoryStore(openDatabase(path.join(tmpDir, "memory.db")), tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns browse shape from a live MemoryStore", async () => {
    const memoryBrowse = BUILTIN_HOOKS.get("memory_browse");
    expect(memoryBrowse).toBeDefined();
    const result = await memoryBrowse!(makeCtx({ memory: store }));

    expect(result).toHaveProperty("entities");
    expect(Array.isArray(result.entities)).toBe(true);
    expect(result.entities).toHaveLength(0);
    expect(result).toHaveProperty("total", 0);
  });

  it("threads name/kind/limit/offset args through", async () => {
    const memoryBrowse = BUILTIN_HOOKS.get("memory_browse")!;
    const result = await memoryBrowse(
      makeCtx({
        args: { name: "Foo", kind: "class", limit: 10, offset: 0 },
        memory: store,
      }),
    );

    expect(result.entities).toHaveLength(0);
  });

  it("throws a clear error when ctx.memory is undefined", async () => {
    const memoryBrowse = BUILTIN_HOOKS.get("memory_browse")!;
    await expect(memoryBrowse(makeCtx())).rejects.toThrow(
      /memory_browse.*requires memory to be enabled/,
    );
  });

  it("rejects non-integer limit arg", async () => {
    const memoryBrowse = BUILTIN_HOOKS.get("memory_browse")!;
    await expect(memoryBrowse(makeCtx({ args: { limit: 1.5 }, memory: store }))).rejects.toThrow(
      /limit.*must be an integer/,
    );
  });

  it("accepts null args as undefined", async () => {
    const memoryBrowse = BUILTIN_HOOKS.get("memory_browse")!;
    const result = await memoryBrowse(
      makeCtx({
        args: { name: null, kind: null, limit: null, offset: null },
        memory: store,
      }),
    );

    expect(result.entities).toHaveLength(0);
  });
});
