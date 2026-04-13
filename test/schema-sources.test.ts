import { describe, expect, it } from "vitest";
import { graphDefinitionSchema } from "../src/schema/graph-schema.js";

describe("source bindings schema", () => {
  it("accepts nodes with sources", () => {
    const graph = {
      id: "test-sources",
      version: "1.0",
      name: "Test Sources",
      description: "Graph with source bindings",
      startNode: "start",
      nodes: {
        start: {
          type: "action",
          description: "Start",
          sources: [
            { path: "protocols/frontend-security.md", section: "FE-1.1", hash: "a3f2c1b7deadbeef" },
            { path: "implementations/modern.md", hash: "b7d4e9f300112233" },
          ],
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "Done" },
      },
    };

    const result = graphDefinitionSchema.safeParse(graph);
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data.nodes.start;
      expect(node.sources).toHaveLength(2);
      expect(node.sources![0].path).toBe("protocols/frontend-security.md");
      expect(node.sources![0].section).toBe("FE-1.1");
      expect(node.sources![0].hash).toBe("a3f2c1b7deadbeef");
      expect(node.sources![1].section).toBeUndefined();
    }
  });

  it("accepts nodes without sources (backward compatible)", () => {
    const graph = {
      id: "test-no-sources",
      version: "1.0",
      name: "Test No Sources",
      description: "Graph without source bindings",
      startNode: "start",
      nodes: {
        start: {
          type: "action",
          description: "Start",
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "Done" },
      },
    };

    const result = graphDefinitionSchema.safeParse(graph);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nodes.start.sources).toBeUndefined();
    }
  });

  it("rejects sources with missing hash", () => {
    const graph = {
      id: "test-bad",
      version: "1.0",
      name: "Bad",
      description: "Bad",
      startNode: "start",
      nodes: {
        start: {
          type: "action",
          description: "Start",
          sources: [{ path: "foo.md" }], // missing hash
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "Done" },
      },
    };

    const result = graphDefinitionSchema.safeParse(graph);
    expect(result.success).toBe(false);
  });

  it("rejects sources with missing path", () => {
    const graph = {
      id: "test-bad",
      version: "1.0",
      name: "Bad",
      description: "Bad",
      startNode: "start",
      nodes: {
        start: {
          type: "action",
          description: "Start",
          sources: [{ hash: "abc123" }], // missing path
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "Done" },
      },
    };

    const result = graphDefinitionSchema.safeParse(graph);
    expect(result.success).toBe(false);
  });
});
