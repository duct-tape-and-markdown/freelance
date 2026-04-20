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

// biome-ignore lint/suspicious/noExplicitAny: vitest spy types
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

// --- Helpers ---

function createTestStore(): TraversalStore {
  const fixture = path.resolve("test/fixtures/valid-branching.workflow.yaml");
  const loaded = loadSingleGraph(fixture);
  const graphs = new Map<string, ValidatedGraph>([[loaded.id, loaded]]);
  const db = openStateStore(":memory:");
  return new TraversalStore(db, graphs, { maxDepth: 5, hookRunner: new HookRunner() });
}

function stdoutJson(): unknown {
  const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
  return JSON.parse(output);
}

// Runtime CLI handlers are JSON-only per docs/decisions.md § CLI-primary.
// All assertions go against stdout (parsed JSON) — stderr is for
// breadcrumbs and does not carry any response data.

describe("traversalStatus", () => {
  it("outputs JSON with graphs and activeTraversals", () => {
    const store = createTestStore();
    try {
      traversalStatus(store);
      const parsed = stdoutJson() as {
        graphs: unknown[];
        activeTraversals: unknown[];
      };
      expect(parsed).toHaveProperty("graphs");
      expect(parsed).toHaveProperty("activeTraversals");
    } finally {
      store.close();
    }
  });
});

describe("traversalStart", () => {
  it("starts a traversal and outputs JSON with traversalId + currentNode", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await traversalStart(store, graphId);
      const parsed = stdoutJson() as { traversalId: string; currentNode: string };
      expect(parsed).toHaveProperty("traversalId");
      expect(parsed).toHaveProperty("currentNode");
    } finally {
      store.close();
    }
  });

  it("errors on unknown graph with GRAPH_NOT_FOUND code", async () => {
    const store = createTestStore();
    try {
      await expect(traversalStart(store, "nonexistent-graph")).rejects.toThrow("process.exit");
      const parsed = stdoutJson() as { isError: true; error: { code: string } };
      expect(parsed.isError).toBe(true);
      expect(parsed.error.code).toBe("GRAPH_NOT_FOUND");
      expect(exitSpy).toHaveBeenCalledWith(4); // EXIT.NOT_FOUND
    } finally {
      store.close();
    }
  });
});

describe("traversalInspect", () => {
  it("outputs JSON with currentNode and node info", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      traversalInspect(store, traversalId, "position");
      const parsed = stdoutJson() as { traversalId: string; currentNode: string; node: unknown };
      expect(parsed.traversalId).toBe(traversalId);
      expect(parsed.currentNode).toBeDefined();
      expect(parsed.node).toBeDefined();
    } finally {
      store.close();
    }
  });
});

describe("traversalContextSet", () => {
  it("sets key=value pairs and outputs updated context", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      traversalContextSet(store, ["qualityPassed=true", 'path="left"']);
      const parsed = stdoutJson() as { status: string; context: Record<string, unknown> };
      expect(parsed.status).toBe("updated");
      expect(parsed.context.qualityPassed).toBe(true);
      expect(parsed.context.path).toBe("left");
    } finally {
      store.close();
    }
  });

  it("errors on invalid pair with INTERNAL exit code (thrown Error)", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      expect(() => traversalContextSet(store, ["noequalssign"])).toThrow("process.exit");
      const parsed = stdoutJson() as { isError: true; error: { code: string } };
      expect(parsed.isError).toBe(true);
      expect(parsed.error.code).toBe("INTERNAL");
      expect(exitSpy).toHaveBeenCalledWith(1);
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

  it("outputs an empty traversals array when nothing is active", () => {
    const store = createTestStore();
    try {
      traversalInspectActive(store);
      const parsed = stdoutJson() as { traversals: unknown[] };
      expect(parsed.traversals).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("lists active traversals including non-wait nodes", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      traversalInspectActive(store);
      const parsed = stdoutJson() as {
        traversals: Array<{ traversalId: string; nodeType: string }>;
      };
      expect(parsed.traversals).toHaveLength(1);
      expect(parsed.traversals[0]).toHaveProperty("traversalId");
      expect(parsed.traversals[0]).toHaveProperty("nodeType");
    } finally {
      store.close();
    }
  });

  it("filters to wait nodes when waitsOnly is set", async () => {
    const store = createWaitStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      await store.advance(traversalId, "done");
      traversalInspectActive(store, { waitsOnly: true });
      const parsed = stdoutJson() as {
        traversals: Array<{ nodeType: string; waitStatus?: string; waitingOn?: unknown }>;
      };
      expect(parsed.traversals).toHaveLength(1);
      expect(parsed.traversals[0].nodeType).toBe("wait");
      expect(parsed.traversals[0].waitStatus).toBe("waiting");
      expect(parsed.traversals[0].waitingOn).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("excludes non-wait traversals when waitsOnly is set", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      traversalInspectActive(store, { waitsOnly: true });
      const parsed = stdoutJson() as { traversals: unknown[] };
      expect(parsed.traversals).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("traversalStart --meta", () => {
  it("persists meta tags and includes them in the JSON response", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await traversalStart(store, graphId, undefined, {
        meta: ["externalKey=DEV-1234", "branch=feature/x"],
      });
      const parsed = stdoutJson() as { meta: Record<string, string> };
      expect(parsed.meta).toEqual({ externalKey: "DEV-1234", branch: "feature/x" });
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
  it("JSON output reflects the filtered set", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId, undefined, { externalKey: "DEV-1" });
      await store.createTraversal(graphId, undefined, { externalKey: "DEV-2" });
      traversalStatus(store, { filter: ["externalKey=DEV-1"] });
      const parsed = stdoutJson() as {
        activeTraversals: Array<{ meta?: Record<string, string> }>;
      };
      expect(parsed.activeTraversals).toHaveLength(1);
      expect(parsed.activeTraversals[0].meta).toEqual({ externalKey: "DEV-1" });
    } finally {
      store.close();
    }
  });

  it("returns an empty activeTraversals when filter matches nothing", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId, undefined, { externalKey: "DEV-1" });
      traversalStatus(store, { filter: ["externalKey=DEV-NONE"] });
      const parsed = stdoutJson() as { activeTraversals: unknown[] };
      expect(parsed.activeTraversals).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("traversalStatus shows meta on active traversals", () => {
  it("JSON response surfaces meta tags", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId, undefined, { externalKey: "DEV-1234" });
      traversalStatus(store);
      const parsed = stdoutJson() as {
        activeTraversals: Array<{ meta?: Record<string, string> }>;
      };
      expect(parsed.activeTraversals[0].meta).toEqual({ externalKey: "DEV-1234" });
    } finally {
      store.close();
    }
  });
});

describe("traversalInspect shows meta", () => {
  it("includes meta at the top level of the response", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId, undefined, {
        externalKey: "DEV-9",
      });
      traversalInspect(store, traversalId, "position");
      const parsed = stdoutJson() as { meta?: Record<string, string> };
      expect(parsed.meta).toEqual({ externalKey: "DEV-9" });
    } finally {
      store.close();
    }
  });
});

describe("traversalMetaSet", () => {
  it("merges key=value pairs and outputs the updated meta", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId, undefined, {
        externalKey: "DEV-1",
      });
      traversalMetaSet(store, ["prUrl=https://example/pr/7"], { traversal: traversalId });
      const parsed = stdoutJson() as { meta: Record<string, string> };
      expect(parsed.meta).toEqual({
        externalKey: "DEV-1",
        prUrl: "https://example/pr/7",
      });
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
  it("errors without --confirm (CONFIRM_REQUIRED / EXIT 5)", () => {
    const store = createTestStore();
    try {
      expect(() => traversalReset(store, undefined, {})).toThrow("process.exit");
      const parsed = stdoutJson() as { isError: true; error: { code: string } };
      expect(parsed.isError).toBe(true);
      expect(parsed.error.code).toBe("CONFIRM_REQUIRED");
      expect(exitSpy).toHaveBeenCalledWith(5); // EXIT.INVALID_INPUT
    } finally {
      store.close();
    }
  });

  it("resets with --confirm and outputs JSON", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      traversalReset(store, traversalId, { confirm: true });
      const parsed = stdoutJson() as { status: string };
      expect(parsed.status).toBe("reset");
    } finally {
      store.close();
    }
  });
});
