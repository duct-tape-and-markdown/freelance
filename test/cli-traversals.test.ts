import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCli } from "../src/cli/output.js";
import {
  traversalAdvance,
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

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  setCli({ quiet: false, verbose: false });
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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
      const parsed = stdoutJson() as {
        isError: true;
        error: { code: string; kind: string };
      };
      expect(parsed.isError).toBe(true);
      expect(parsed.error.code).toBe("GRAPH_NOT_FOUND");
      expect(parsed.error.kind).toBe("structural");
      expect(exitSpy).toHaveBeenCalledWith(4); // EXIT.NOT_FOUND
    } finally {
      store.close();
    }
  });
});

describe("traversalAdvance — unified error envelope on gate-block", () => {
  it("emits error.code + kind and exits BLOCKED on edge-condition failure", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      await traversalAdvance(store, "initialized", { traversal: traversalId });

      // Reset stdout so we only capture the blocked response
      stdoutSpy.mockClear();

      await expect(traversalAdvance(store, "go-left", { traversal: traversalId })).rejects.toThrow(
        "process.exit",
      );

      const parsed = stdoutJson() as {
        isError: true;
        status: string;
        error: { code: string; kind: string; message: string };
        reason: string;
        validTransitions: unknown[];
      };
      expect(parsed.isError).toBe(true);
      expect(parsed.status).toBe("error");
      expect(parsed.error.code).toBe("EDGE_CONDITION_NOT_MET");
      expect(parsed.error.kind).toBe("blocked");
      expect(parsed.error.message).toBe(parsed.reason);
      expect(parsed.validTransitions).toBeDefined();
      expect(exitSpy).toHaveBeenCalledWith(2); // EXIT.BLOCKED
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

  it("errors on invalid pair with INVALID_KEY_VALUE_PAIR / EXIT 5", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      expect(() => traversalContextSet(store, ["noequalssign"])).toThrow("process.exit");
      const parsed = stdoutJson() as { isError: true; error: { code: string } };
      expect(parsed.isError).toBe(true);
      expect(parsed.error.code).toBe("INVALID_KEY_VALUE_PAIR");
      expect(exitSpy).toHaveBeenCalledWith(5); // EXIT.INVALID_INPUT
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

describe("--minimal response projection (issue #81)", () => {
  it("traversalAdvance --minimal drops context + node, keeps contextDelta", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      await traversalAdvance(store, "initialized", {
        traversal: traversalId,
        minimal: true,
      });
      const parsed = stdoutJson() as Record<string, unknown>;
      expect(parsed).toHaveProperty("contextDelta");
      expect(parsed).not.toHaveProperty("context");
      expect(parsed).not.toHaveProperty("node");
      expect(parsed).toHaveProperty("validTransitions");
      expect(parsed).toHaveProperty("currentNode");
    } finally {
      store.close();
    }
  });

  it("traversalAdvance without --minimal keeps full shape", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      await traversalAdvance(store, "initialized", { traversal: traversalId });
      const parsed = stdoutJson() as Record<string, unknown>;
      expect(parsed).toHaveProperty("context");
      expect(parsed).toHaveProperty("node");
      expect(parsed).not.toHaveProperty("contextDelta");
    } finally {
      store.close();
    }
  });

  it("traversalContextSet --minimal drops context, keeps contextDelta", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      traversalContextSet(store, ["path=left"], {
        traversal: traversalId,
        minimal: true,
      });
      const parsed = stdoutJson() as Record<string, unknown>;
      expect(parsed).toHaveProperty("contextDelta");
      expect(parsed.contextDelta).toEqual(["path"]);
      expect(parsed).not.toHaveProperty("context");
      expect(parsed).toHaveProperty("validTransitions");
    } finally {
      store.close();
    }
  });

  it("traversalInspect --minimal (position) drops node + context + stack", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      traversalInspect(store, traversalId, "position", { minimal: true });
      const parsed = stdoutJson() as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("node");
      expect(parsed).not.toHaveProperty("context");
      expect(parsed).not.toHaveProperty("stack");
      expect(parsed).not.toHaveProperty("graphName");
      expect(parsed).toHaveProperty("currentNode");
      expect(parsed).toHaveProperty("validTransitions");
    } finally {
      store.close();
    }
  });

  it("traversalInspect without --minimal keeps full shape", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      traversalInspect(store, traversalId, "position");
      const parsed = stdoutJson() as Record<string, unknown>;
      expect(parsed).toHaveProperty("node");
      expect(parsed).toHaveProperty("context");
      expect(parsed).toHaveProperty("stack");
    } finally {
      store.close();
    }
  });

  it("--minimal on a blocked advance keeps reason + validTransitions, drops context", async () => {
    // valid-branching's choose-path decision has conditional-only edges;
    // without context.path set, every edge's condition evaluates false
    // and `advance go-left` fires checkEdgeCondition as a gate block.
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      // Walk to choose-path up-front so the stdout mock only captures
      // the blocked-advance response we want to assert against.
      await store.advance(traversalId, "initialized");
      stdoutSpy.mockClear();
      await expect(
        traversalAdvance(store, "go-left", { traversal: traversalId, minimal: true }),
      ).rejects.toThrow("process.exit");
      const parsed = stdoutJson() as Record<string, unknown>;
      expect(parsed.isError).toBe(true);
      expect(parsed).toHaveProperty("reason");
      expect(parsed).toHaveProperty("validTransitions");
      expect(parsed).toHaveProperty("contextDelta");
      expect(parsed).not.toHaveProperty("context");
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
      const parsed = stdoutJson() as {
        isError: true;
        error: { code: string; kind: string };
      };
      expect(parsed.isError).toBe(true);
      expect(parsed.error.code).toBe("CONFIRM_REQUIRED");
      expect(parsed.error.kind).toBe("structural");
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

describe("traversalInspect options (#122)", () => {
  it("forwards --fields to the store and surfaces projections in the response", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      traversalInspect(store, undefined, "position", { fields: ["currentNode", "neighbors"] });
      const parsed = stdoutJson() as {
        currentNodeDefinition?: unknown;
        neighbors?: unknown;
      };
      expect(parsed.currentNodeDefinition).toBeDefined();
      expect(parsed.neighbors).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("forwards --limit/--offset to history detail", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      traversalInspect(store, undefined, "history", { limit: "3", offset: "0" });
      const parsed = stdoutJson() as {
        traversalHistory: unknown[];
        totalSteps: number;
      };
      // Pagination applies — the slice is bounded even on an empty
      // history. The total-field contract (pre-pagination count) is
      // covered by the engine tests; here we only assert the CLI
      // threads the options through without error.
      expect(Array.isArray(parsed.traversalHistory)).toBe(true);
      expect(parsed.traversalHistory.length).toBeLessThanOrEqual(3);
    } finally {
      store.close();
    }
  });

  it("forwards --include-snapshots so history entries retain contextSnapshot", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      const { traversalId } = await store.createTraversal(graphId);
      // Advance once so there's something in history to project. The
      // fixture is valid-branching; the first edge label from `start`
      // varies — just grab it from the validTransitions.
      const inspectRaw = store.inspect(traversalId, "position") as {
        validTransitions: Array<{ label: string }>;
      };
      const firstEdge = inspectRaw.validTransitions[0]?.label;
      if (!firstEdge) return;
      await store.advance(traversalId, firstEdge, undefined);
      stdoutSpy.mockClear();
      traversalInspect(store, traversalId, "history", { includeSnapshots: true });
      const parsed = stdoutJson() as {
        traversalHistory: Array<{ contextSnapshot?: unknown }>;
      };
      expect(parsed.traversalHistory.length).toBeGreaterThan(0);
      expect(parsed.traversalHistory[0]).toHaveProperty("contextSnapshot");
    } finally {
      store.close();
    }
  });

  it("emits INVALID_FLAG_VALUE on non-integer --limit", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      expect(() => traversalInspect(store, undefined, "history", { limit: "abc" })).toThrow(
        "process.exit",
      );
      const parsed = stdoutJson() as {
        isError: true;
        error: { code: string; kind: string };
      };
      expect(parsed.isError).toBe(true);
      expect(parsed.error.code).toBe("INVALID_FLAG_VALUE");
      expect(parsed.error.kind).toBe("structural");
      expect(exitSpy).toHaveBeenCalledWith(5); // EXIT.INVALID_INPUT
    } finally {
      store.close();
    }
  });

  it("emits INVALID_FLAG_VALUE on non-integer --offset", async () => {
    const store = createTestStore();
    try {
      const graphId = store.listGraphs().graphs[0]?.id;
      if (!graphId) return;
      await store.createTraversal(graphId);
      expect(() => traversalInspect(store, undefined, "history", { offset: "1.5" })).toThrow(
        "process.exit",
      );
      const parsed = stdoutJson() as {
        isError: true;
        error: { code: string };
      };
      expect(parsed.error.code).toBe("INVALID_FLAG_VALUE");
      expect(exitSpy).toHaveBeenCalledWith(5);
    } finally {
      store.close();
    }
  });
});

describe("traversalStatus loadErrors surface (#122)", () => {
  it("includes loadErrors when the store was constructed with non-empty errors", () => {
    const fixture = path.resolve("test/fixtures/valid-branching.workflow.yaml");
    const loaded = loadSingleGraph(fixture);
    const graphs = new Map<string, ValidatedGraph>([[loaded.id, loaded]]);
    const db = openStateStore(":memory:");
    const store = new TraversalStore(db, graphs, {
      maxDepth: 5,
      hookRunner: new HookRunner(),
      loadErrors: [{ file: "broken.workflow.yaml", message: "unexpected end of stream" }],
    });
    try {
      traversalStatus(store);
      const parsed = stdoutJson() as {
        loadErrors?: Array<{ file: string; message: string }>;
      };
      expect(parsed.loadErrors).toBeDefined();
      expect(parsed.loadErrors).toHaveLength(1);
      expect(parsed.loadErrors?.[0].file).toBe("broken.workflow.yaml");
    } finally {
      store.close();
    }
  });

  it("elides loadErrors when empty — preserves the pre-#122 status shape", () => {
    const store = createTestStore();
    try {
      traversalStatus(store);
      const parsed = stdoutJson() as Record<string, unknown>;
      expect("loadErrors" in parsed).toBe(false);
    } finally {
      store.close();
    }
  });
});
