/**
 * End-to-end test: createServer wires the default ops registry when
 * memory is enabled, so programmatic nodes in memory-backed workflows
 * can drain without an explicit registry argument.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAndValidateGraph } from "../src/graph-construction.js";
import { createServer } from "../src/server.js";
import type { GraphDefinition, ValidatedGraph } from "../src/types.js";

function buildGraphs(def: GraphDefinition): Map<string, ValidatedGraph> {
  const graph = buildAndValidateGraph(def, "<test>");
  return new Map([[def.id, { definition: def, graph }]]);
}

const programmaticGraph: GraphDefinition = {
  id: "srv-prog",
  version: "1.0.0",
  name: "Server Prog",
  description: "test",
  startNode: "prep",
  strictContext: false,
  nodes: {
    prep: {
      type: "programmatic",
      description: "fetch collection status",
      operation: { name: "memory_status" },
      contextUpdates: { propositionCount: "total_propositions" },
      edges: [{ label: "ready", target: "work" }],
    },
    work: {
      type: "action",
      description: "agent reviews the count",
      edges: [{ label: "done", target: "end" }],
    },
    end: { type: "terminal", description: "done" },
  },
};

describe("createServer — ops registry wiring with memory enabled", () => {
  let tmpRoot: string;
  let memDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "srv-prog-"));
    memDir = path.join(tmpRoot, "memory");
    fs.mkdirSync(memDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("drains a programmatic node that calls memory_status", () => {
    const graphs = buildGraphs(programmaticGraph);
    const { manager, memoryStore } = createServer(graphs, {
      memory: { enabled: true, db: path.join(memDir, "test.db") },
      sourceRoot: tmpRoot,
    });
    expect(memoryStore).toBeDefined();
    try {
      const result = manager.createTraversal("srv-prog");
      expect(result.status).toBe("started");
      expect(result.currentNode).toBe("work");
      // Fresh memory store returns zero — the drain populated context.
      expect(result.context.propositionCount).toBe(0);
    } finally {
      memoryStore?.close();
      manager.close();
    }
  });

  it("fails gracefully when memory is disabled and a programmatic workflow exists", () => {
    const graphs = buildGraphs(programmaticGraph);
    const { manager, memoryStore } = createServer(graphs, {
      memory: { enabled: false, db: "" },
    });
    expect(memoryStore).toBeUndefined();
    try {
      expect(() => manager.createTraversal("srv-prog")).toThrow(/no ops registry/);
    } finally {
      manager.close();
    }
  });
});
