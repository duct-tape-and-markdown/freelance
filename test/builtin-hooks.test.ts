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
    expect(isBuiltinHook("memory_search")).toBe(true);
    expect(isBuiltinHook("memory_related")).toBe(true);
    expect(isBuiltinHook("memory_inspect")).toBe(true);
    expect(isBuiltinHook("memory_by_source")).toBe(true);
    expect(isBuiltinHook("memory_emit")).toBe(false);
    expect(isBuiltinHook("not-a-hook")).toBe(false);
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

// The four read-narrowing hooks (search, related, inspect, by_source)
// share a fixture that emits one proposition so the store has something
// to return. Each suite asserts the happy-path shape and the
// memory-disabled error path mirroring the status/browse pattern.
describe("memory_search, memory_related, memory_inspect, memory_by_source built-in hooks", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let sourcePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-hook-"));
    store = new MemoryStore(openDatabase(path.join(tmpDir, "memory.db")), tmpDir);
    sourcePath = "fixture.md";
    fs.writeFileSync(path.join(tmpDir, sourcePath), "# fixture\nBiome formats the repo.\n");
    store.emit(
      [
        {
          content: "Biome formats and lints the freelance repo.",
          entities: ["Biome", "freelance"],
          sources: [sourcePath],
        },
      ],
      "default",
    );
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("memory_search", () => {
    it("returns search shape from a live MemoryStore", async () => {
      const memorySearch = BUILTIN_HOOKS.get("memory_search")!;
      const result = await memorySearch(makeCtx({ args: { query: "Biome" }, memory: store }));

      expect(result).toHaveProperty("query", "Biome");
      expect(Array.isArray(result.propositions)).toBe(true);
      expect((result.propositions as unknown[]).length).toBeGreaterThan(0);
    });

    it("threads limit + collection args through", async () => {
      const memorySearch = BUILTIN_HOOKS.get("memory_search")!;
      const result = await memorySearch(
        makeCtx({
          args: { query: "Biome", limit: 5, collection: "default" },
          memory: store,
        }),
      );
      expect(result.query).toBe("Biome");
    });

    it("throws when ctx.memory is undefined", async () => {
      const memorySearch = BUILTIN_HOOKS.get("memory_search")!;
      await expect(memorySearch(makeCtx({ args: { query: "x" } }))).rejects.toThrow(
        /memory_search.*requires memory to be enabled/,
      );
    });

    it("rejects missing query arg", async () => {
      const memorySearch = BUILTIN_HOOKS.get("memory_search")!;
      await expect(memorySearch(makeCtx({ memory: store }))).rejects.toThrow(
        /query.*non-empty string/,
      );
    });
  });

  describe("memory_related", () => {
    it("returns related shape from a live MemoryStore", async () => {
      const memoryRelated = BUILTIN_HOOKS.get("memory_related")!;
      const result = await memoryRelated(makeCtx({ args: { entity: "Biome" }, memory: store }));

      expect(result).toHaveProperty("entity");
      expect(result).toHaveProperty("neighbors");
      expect(Array.isArray(result.neighbors)).toBe(true);
    });

    it("throws when ctx.memory is undefined", async () => {
      const memoryRelated = BUILTIN_HOOKS.get("memory_related")!;
      await expect(memoryRelated(makeCtx({ args: { entity: "Biome" } }))).rejects.toThrow(
        /memory_related.*requires memory to be enabled/,
      );
    });

    it("rejects missing entity arg", async () => {
      const memoryRelated = BUILTIN_HOOKS.get("memory_related")!;
      await expect(memoryRelated(makeCtx({ memory: store }))).rejects.toThrow(
        /entity.*non-empty string/,
      );
    });
  });

  describe("memory_inspect", () => {
    it("returns inspect shape from a live MemoryStore", async () => {
      const memoryInspect = BUILTIN_HOOKS.get("memory_inspect")!;
      const result = await memoryInspect(makeCtx({ args: { entity: "Biome" }, memory: store }));

      expect(result).toHaveProperty("entity");
      expect(result).toHaveProperty("propositions");
      expect(result).toHaveProperty("neighbors");
      expect(result).toHaveProperty("source_files");
      expect((result.propositions as unknown[]).length).toBeGreaterThan(0);
    });

    it("throws when ctx.memory is undefined", async () => {
      const memoryInspect = BUILTIN_HOOKS.get("memory_inspect")!;
      await expect(memoryInspect(makeCtx({ args: { entity: "Biome" } }))).rejects.toThrow(
        /memory_inspect.*requires memory to be enabled/,
      );
    });
  });

  describe("memory_by_source", () => {
    it("returns priorKnowledgeByPath keyed by each path", async () => {
      const memoryBySource = BUILTIN_HOOKS.get("memory_by_source")!;
      const result = await memoryBySource(
        makeCtx({ args: { paths: [sourcePath] }, memory: store }),
      );

      expect(result).toHaveProperty("priorKnowledgeByPath");
      expect(result).toHaveProperty("priorKnowledgePathsConsidered", 1);
      expect(result).toHaveProperty("priorKnowledgePathsTruncated", false);
      const byPath = result.priorKnowledgeByPath as Record<string, unknown[]>;
      expect(byPath[sourcePath]).toBeDefined();
      expect(byPath[sourcePath].length).toBeGreaterThan(0);
    });

    it("returns empty array entries for unknown paths", async () => {
      const memoryBySource = BUILTIN_HOOKS.get("memory_by_source")!;
      const result = await memoryBySource(
        makeCtx({ args: { paths: ["does-not-exist.md"] }, memory: store }),
      );
      const byPath = result.priorKnowledgeByPath as Record<string, unknown[]>;
      expect(byPath["does-not-exist.md"]).toEqual([]);
    });

    it("caps paths at 50 and reports truncation", async () => {
      const memoryBySource = BUILTIN_HOOKS.get("memory_by_source")!;
      const manyPaths = Array.from({ length: 75 }, (_, i) => `f${i}.md`);
      const result = await memoryBySource(makeCtx({ args: { paths: manyPaths }, memory: store }));

      expect(result.priorKnowledgePathsConsidered).toBe(50);
      expect(result.priorKnowledgePathsTruncated).toBe(true);
    });

    it("throws when ctx.memory is undefined", async () => {
      const memoryBySource = BUILTIN_HOOKS.get("memory_by_source")!;
      await expect(memoryBySource(makeCtx({ args: { paths: [sourcePath] } }))).rejects.toThrow(
        /memory_by_source.*requires memory to be enabled/,
      );
    });

    it("rejects non-array paths arg", async () => {
      const memoryBySource = BUILTIN_HOOKS.get("memory_by_source")!;
      await expect(
        memoryBySource(makeCtx({ args: { paths: "single.md" }, memory: store })),
      ).rejects.toThrow(/paths.*string array/);
    });
  });
});
