import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCli } from "../src/cli/output.js";
import {
  traversalContextSet,
  traversalInspect,
  traversalReset,
  traversalStart,
  traversalStatus,
} from "../src/cli/traversals.js";
import { loadSingleGraph } from "../src/loader.js";
import { openStateStore, TraversalStore } from "../src/state/index.js";
import type { ValidatedGraph } from "../src/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;
let stderrSpy: any;
let stdoutSpy: any;

beforeEach(() => {
  setCli({ json: false, quiet: false, verbose: false, noColor: false });
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Direct store-based CLI tests ---

function createTestStore(): TraversalStore {
  // Load a single valid graph to avoid circular subgraph errors
  const fixture = path.resolve("test/fixtures/valid-branching.workflow.yaml");
  const loaded = loadSingleGraph(fixture);
  const graphs = new Map<string, ValidatedGraph>([[loaded.id, loaded]]);
  const db = openStateStore(":memory:");
  return new TraversalStore(db, graphs, { maxDepth: 5 });
}

describe("traversalStatus", () => {
  it("shows graphs and no traversals (text mode)", () => {
    const store = createTestStore();
    try {
      traversalStatus(store);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Graphs:"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("No active traversals"));
    } finally {
      store.close();
    }
  });

  it("outputs JSON", () => {
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
  it("starts a traversal and prints node info", () => {
    const store = createTestStore();
    try {
      // Use a graph from fixtures — "linear" is a simple one
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return; // skip if no fixtures
      traversalStart(store, graphId);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Started traversal"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Node:"));
    } finally {
      store.close();
    }
  });

  it("outputs JSON on start", () => {
    setCli({ json: true });
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      traversalStart(store, graphId);
      const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("traversalId");
      expect(parsed).toHaveProperty("currentNode");
    } finally {
      store.close();
    }
  });

  it("errors on unknown graph", () => {
    const store = createTestStore();
    try {
      expect(() => traversalStart(store, "nonexistent-graph")).toThrow("process.exit");
    } finally {
      store.close();
    }
  });
});

describe("traversalInspect", () => {
  it("shows current position", () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = store.createTraversal(graphId);
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
  it("sets key=value pairs", () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      store.createTraversal(graphId);
      traversalContextSet(store, ["foo=42", "bar=true"]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Updated context"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("foo = 42"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("bar = true"));
    } finally {
      store.close();
    }
  });

  it("errors on invalid pair", () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      store.createTraversal(graphId);
      expect(() => traversalContextSet(store, ["noequalssign"])).toThrow("process.exit");
    } finally {
      store.close();
    }
  });
});

describe("traversalReset", () => {
  it("errors without --confirm", () => {
    const store = createTestStore();
    try {
      expect(() => traversalReset(store, undefined, {})).toThrow("process.exit");
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--confirm"));
    } finally {
      store.close();
    }
  });

  it("resets with --confirm", () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = store.createTraversal(graphId);
      traversalReset(store, traversalId, { confirm: true });
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Reset traversal"));
    } finally {
      store.close();
    }
  });

  it("outputs JSON on reset", () => {
    setCli({ json: true });
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = store.createTraversal(graphId);
      traversalReset(store, traversalId, { confirm: true });
      const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("status", "reset");
    } finally {
      store.close();
    }
  });
});
