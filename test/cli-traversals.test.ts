import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCli } from "../src/cli/output.js";
import {
  traversalContextSet,
  traversalInspect,
  traversalInspectActive,
  traversalMetaSet,
  traversalReset,
  traversalStart,
  traversalStatus,
} from "../src/cli/traversals.js";
import { HookRunner } from "../src/engine/hooks.js";
import { loadSingleGraph } from "../src/loader.js";
import { openStateStore, TraversalStore } from "../src/state/index.js";
import type { ValidatedGraph } from "../src/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;
let stderrSpy: any;
let stdoutSpy: any;

beforeEach(async () => {
  setCli({ json: false, quiet: false, verbose: false, noColor: false });
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
});

// --- Direct store-based CLI tests ---

function createTestStore(): TraversalStore {
  // Load a single valid graph to avoid circular subgraph errors
  const fixture = path.resolve("test/fixtures/valid-branching.workflow.yaml");
  const loaded = loadSingleGraph(fixture);
  const graphs = new Map<string, ValidatedGraph>([[loaded.id, loaded]]);
  const db = openStateStore(":memory:");
  return new TraversalStore(db, graphs, { maxDepth: 5, hookRunner: new HookRunner() });
}

describe("traversalStatus", () => {
  it("shows graphs and no traversals (text mode)", async () => {
    const store = createTestStore();
    try {
      traversalStatus(store);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Graphs:"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("No active traversals"));
    } finally {
      store.close();
    }
  });

  it("outputs JSON", async () => {
    setCli({ json: true });
    const store = createTestStore();
    try {
      traversalStatus(store);
      const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("graphs");
      expect(parsed).toHaveProperty("activeTraversals");
    } finally {
      store.close();
    }
  });
});

describe("traversalStart", () => {
  it("starts a traversal and prints node info", async () => {
    const store = createTestStore();
    try {
      // Use a graph from fixtures — "linear" is a simple one
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return; // skip if no fixtures
      await traversalStart(store, graphId);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Started traversal"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Node:"));
    } finally {
      store.close();
    }
  });

  it("outputs JSON on start", async () => {
    setCli({ json: true });
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await traversalStart(store, graphId);
      const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("traversalId");
      expect(parsed).toHaveProperty("currentNode");
    } finally {
      store.close();
    }
  });

  it("errors on unknown graph", async () => {
    const store = createTestStore();
    try {
      await expect(traversalStart(store, "nonexistent-graph")).rejects.toThrow("process.exit");
    } finally {
      store.close();
    }
  });
});

describe("traversalInspect", () => {
  it("shows current position", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      traversalInspect(store, traversalId, "position");
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Traversal:"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Graph:"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Node:"));
    } finally {
      store.close();
    }
  });
});

describe("traversalContextSet", () => {
  it("sets key=value pairs", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      traversalContextSet(store, ["foo=42", "bar=true"]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Updated context"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("foo = 42"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("bar = true"));
    } finally {
      store.close();
    }
  });

  it("errors on invalid pair", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      expect(() => traversalContextSet(store, ["noequalssign"])).toThrow("process.exit");
    } finally {
      store.close();
    }
  });
});

describe("traversalInspectActive", () => {
  function createWaitStore(): TraversalStore {
    const fixture = path.resolve("test/fixtures/valid-wait-simple.workflow.yaml");
    const loaded = loadSingleGraph(fixture);
    const graphs = new Map<string, ValidatedGraph>([[loaded.id, loaded]]);
    const db = openStateStore(":memory:");
    return new TraversalStore(db, graphs, { maxDepth: 5, hookRunner: new HookRunner() });
  }

  it("reports an empty list when nothing is active (text)", () => {
    const store = createTestStore();
    try {
      traversalInspectActive(store);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("No active traversals"));
    } finally {
      store.close();
    }
  });

  it("lists active traversals including non-wait nodes", async () => {
    setCli({ json: true });
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      traversalInspectActive(store);
      const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(parsed.traversals).toHaveLength(1);
      expect(parsed.traversals[0]).toHaveProperty("traversalId");
      expect(parsed.traversals[0]).toHaveProperty("nodeType");
    } finally {
      store.close();
    }
  });

  it("filters to wait nodes when waitsOnly is set", async () => {
    setCli({ json: true });
    const store = createWaitStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      // Advance off the action node into the wait node.
      await store.advance(traversalId, "done");
      traversalInspectActive(store, { waitsOnly: true });
      const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(parsed.traversals).toHaveLength(1);
      expect(parsed.traversals[0].nodeType).toBe("wait");
      expect(parsed.traversals[0].waitStatus).toBe("waiting");
      expect(parsed.traversals[0].waitingOn).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("excludes non-wait traversals when waitsOnly is set", async () => {
    setCli({ json: true });
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      traversalInspectActive(store, { waitsOnly: true });
      const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(parsed.traversals).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("traversalStart --meta", () => {
  it("persists meta key=value pairs and prints them", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await traversalStart(store, graphId, undefined, {
        meta: ["externalKey=DEV-1234", "branch=feature/x"],
      });
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Meta:"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("DEV-1234"));
      const list = store.listTraversals();
      expect(list[0].meta).toEqual({ externalKey: "DEV-1234", branch: "feature/x" });
    } finally {
      store.close();
    }
  });

  it("rejects malformed --meta pairs", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await expect(
        traversalStart(store, graphId, undefined, { meta: ["noequalssign"] }),
      ).rejects.toThrow("process.exit");
    } finally {
      store.close();
    }
  });
});

describe("traversalStatus --filter (operator-side)", () => {
  it("narrows the listing to traversals matching every key=value pair", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const a = await store.createTraversal(graphId, undefined, { externalKey: "DEV-1" });
      await store.createTraversal(graphId, undefined, { externalKey: "DEV-2" });

      traversalStatus(store, { filter: ["externalKey=DEV-1"] });
      const printed = stderrSpy.mock.calls.map((c: [string]) => c[0] as string).join("");
      expect(printed).toContain("matching");
      expect(printed).toContain(a.traversalId);
      expect(printed).toContain("DEV-1");
      expect(printed).not.toContain("DEV-2");
    } finally {
      store.close();
    }
  });

  it("reports no matches when filter excludes everything", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId, undefined, { externalKey: "DEV-1" });
      traversalStatus(store, { filter: ["externalKey=DEV-NONE"] });
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("No active traversals match"));
    } finally {
      store.close();
    }
  });

  it("--json output reflects the filtered set", async () => {
    setCli({ json: true });
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId, undefined, { externalKey: "DEV-1" });
      await store.createTraversal(graphId, undefined, { externalKey: "DEV-2" });
      traversalStatus(store, { filter: ["externalKey=DEV-1"] });
      const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
      const parsed = JSON.parse(output) as {
        activeTraversals: Array<{ meta?: Record<string, string> }>;
      };
      expect(parsed.activeTraversals).toHaveLength(1);
      expect(parsed.activeTraversals[0].meta).toEqual({ externalKey: "DEV-1" });
    } finally {
      store.close();
    }
  });
});

describe("traversalStatus shows meta on active traversals", () => {
  it("prints meta tags so callers can pick a traversal by tag", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId, undefined, { externalKey: "DEV-1234" });
      traversalStatus(store);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Active traversals"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("DEV-1234"));
    } finally {
      store.close();
    }
  });
});

describe("traversalInspect shows meta", () => {
  it("prints meta tags when present on the traversal", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId, undefined, {
        externalKey: "DEV-9",
      });
      traversalInspect(store, traversalId, "position");
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Meta:"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("DEV-9"));
    } finally {
      store.close();
    }
  });
});

describe("traversalMetaSet", () => {
  it("merges key=value pairs and prints the updated meta", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId, undefined, {
        externalKey: "DEV-1",
      });
      traversalMetaSet(store, ["prUrl=https://example/pr/7"], { traversal: traversalId });
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Updated meta"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("prUrl"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("DEV-1"));
    } finally {
      store.close();
    }
  });

  it("errors on invalid pair", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      expect(() => traversalMetaSet(store, ["noequalssign"])).toThrow("process.exit");
    } finally {
      store.close();
    }
  });

  it("errors on empty updates", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      expect(() => traversalMetaSet(store, [])).toThrow("process.exit");
    } finally {
      store.close();
    }
  });
});

describe("traversalReset", () => {
  it("errors without --confirm", async () => {
    const store = createTestStore();
    try {
      expect(() => traversalReset(store, undefined, {})).toThrow("process.exit");
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--confirm"));
    } finally {
      store.close();
    }
  });

  it("resets with --confirm", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      traversalReset(store, traversalId, { confirm: true });
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Reset traversal"));
    } finally {
      store.close();
    }
  });

  it("outputs JSON on reset", async () => {
    setCli({ json: true });
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      traversalReset(store, traversalId, { confirm: true });
      const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("status", "reset");
    } finally {
      store.close();
    }
  });
});
