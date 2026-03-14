import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadGraphs } from "../src/loader.js";
import { createServer } from "../src/server.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

function parseContent(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  return JSON.parse(text);
}

describe("MCP server integration", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml", "valid-branching.graph.yaml");
    const server = createServer(graphs);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("happy path", () => {
    it("graph_list returns correct graphs", async () => {
      const result = await client.callTool({ name: "graph_list", arguments: {} });
      expect(result.isError).toBeFalsy();
      const data = parseContent(result) as { graphs: Array<{ id: string }> };
      expect(data.graphs).toHaveLength(2);
      const ids = data.graphs.map((g) => g.id).sort();
      expect(ids).toEqual(["valid-branching", "valid-simple"]);
    });

    it("full traversal: start → advance → terminal", async () => {
      // Start
      const startResult = await client.callTool({
        name: "graph_start",
        arguments: { graphId: "valid-simple" },
      });
      expect(startResult.isError).toBeFalsy();
      const startData = parseContent(startResult) as { status: string; currentNode: string };
      expect(startData.status).toBe("started");
      expect(startData.currentNode).toBe("start");

      // Advance to review (with context update)
      const adv1 = await client.callTool({
        name: "graph_advance",
        arguments: { edge: "work-done", contextUpdates: { taskStarted: true } },
      });
      expect(adv1.isError).toBeFalsy();
      const adv1Data = parseContent(adv1) as { status: string; currentNode: string };
      expect(adv1Data.status).toBe("advanced");
      expect(adv1Data.currentNode).toBe("review");

      // Advance to done (terminal)
      const adv2 = await client.callTool({
        name: "graph_advance",
        arguments: { edge: "approved" },
      });
      expect(adv2.isError).toBeFalsy();
      const adv2Data = parseContent(adv2) as {
        status: string;
        currentNode: string;
        traversalHistory: string[];
      };
      expect(adv2Data.status).toBe("complete");
      expect(adv2Data.currentNode).toBe("done");
      expect(adv2Data.traversalHistory).toEqual(["start", "review", "done"]);
    });

    it("response has correct structure", async () => {
      const result = await client.callTool({
        name: "graph_start",
        arguments: { graphId: "valid-simple" },
      });
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].type).toBe("text");
      // JSON is parseable
      expect(() => JSON.parse(content[0].text)).not.toThrow();
    });
  });

  describe("full lifecycle", () => {
    it("list → start → context_set → advance → terminal → reset → restart", async () => {
      // List available graphs
      const listResult = await client.callTool({ name: "graph_list", arguments: {} });
      expect(listResult.isError).toBeFalsy();
      const listData = parseContent(listResult) as { graphs: Array<{ id: string }> };
      expect(listData.graphs.length).toBeGreaterThan(0);

      // Start a graph
      const startResult = await client.callTool({
        name: "graph_start",
        arguments: { graphId: "valid-simple" },
      });
      expect(startResult.isError).toBeFalsy();
      const startData = parseContent(startResult) as {
        status: string; currentNode: string; context: Record<string, unknown>;
      };
      expect(startData.status).toBe("started");
      expect(startData.currentNode).toBe("start");
      expect(startData.context.taskStarted).toBe(false);

      // Set context
      const ctxResult = await client.callTool({
        name: "graph_context_set",
        arguments: { updates: { taskStarted: true } },
      });
      expect(ctxResult.isError).toBeFalsy();
      const ctxData = parseContent(ctxResult) as {
        status: string; context: Record<string, unknown>; turnCount: number;
      };
      expect(ctxData.status).toBe("updated");
      expect(ctxData.context.taskStarted).toBe(true);
      expect(ctxData.turnCount).toBe(1);

      // Advance: start → review
      const adv1 = await client.callTool({
        name: "graph_advance",
        arguments: { edge: "work-done" },
      });
      expect(adv1.isError).toBeFalsy();
      const adv1Data = parseContent(adv1) as { status: string; currentNode: string };
      expect(adv1Data.status).toBe("advanced");
      expect(adv1Data.currentNode).toBe("review");

      // Advance: review → done (terminal)
      const adv2 = await client.callTool({
        name: "graph_advance",
        arguments: { edge: "approved" },
      });
      expect(adv2.isError).toBeFalsy();
      const adv2Data = parseContent(adv2) as {
        status: string; currentNode: string; traversalHistory: string[];
      };
      expect(adv2Data.status).toBe("complete");
      expect(adv2Data.currentNode).toBe("done");
      expect(adv2Data.traversalHistory).toEqual(["start", "review", "done"]);

      // Reset
      const resetResult = await client.callTool({
        name: "graph_reset",
        arguments: { confirm: true },
      });
      expect(resetResult.isError).toBeFalsy();
      const resetData = parseContent(resetResult) as { status: string; previousGraph: string };
      expect(resetData.status).toBe("reset");
      expect(resetData.previousGraph).toBe("valid-simple");

      // Restart works
      const restartResult = await client.callTool({
        name: "graph_start",
        arguments: { graphId: "valid-simple" },
      });
      expect(restartResult.isError).toBeFalsy();
      const restartData = parseContent(restartResult) as { status: string; currentNode: string };
      expect(restartData.status).toBe("started");
      expect(restartData.currentNode).toBe("start");
    });
  });

  describe("error handling", () => {
    it("graph_start with invalid graphId → isError", async () => {
      const result = await client.callTool({
        name: "graph_start",
        arguments: { graphId: "nonexistent" },
      });
      expect(result.isError).toBe(true);
    });

    it("graph_advance before starting → isError", async () => {
      const result = await client.callTool({
        name: "graph_advance",
        arguments: { edge: "some-edge" },
      });
      expect(result.isError).toBe(true);
    });

    it("graph_advance with gate validation failure → isError with full state", async () => {
      await client.callTool({
        name: "graph_start",
        arguments: { graphId: "valid-simple" },
      });
      // Advance to gate without setting taskStarted
      await client.callTool({
        name: "graph_advance",
        arguments: { edge: "work-done" },
      });
      // Try to pass gate
      const result = await client.callTool({
        name: "graph_advance",
        arguments: { edge: "approved" },
      });
      expect(result.isError).toBe(true);
      const data = parseContent(result) as {
        currentNode: string;
        reason: string;
        validTransitions: unknown[];
        context: Record<string, unknown>;
      };
      expect(data.currentNode).toBe("review");
      expect(data.reason).toContain("Validation failed");
      expect(data.validTransitions).toBeDefined();
      expect(data.context).toBeDefined();
    });

    it("graph_context_set before starting → isError", async () => {
      const result = await client.callTool({
        name: "graph_context_set",
        arguments: { updates: { foo: "bar" } },
      });
      expect(result.isError).toBe(true);
    });

    it("graph_reset without confirm: true → isError", async () => {
      const result = await client.callTool({
        name: "graph_reset",
        arguments: { confirm: false },
      });
      expect(result.isError).toBe(true);
    });

    it("graph_reset with confirm: true → success, then start works", async () => {
      await client.callTool({
        name: "graph_start",
        arguments: { graphId: "valid-simple" },
      });

      const resetResult = await client.callTool({
        name: "graph_reset",
        arguments: { confirm: true },
      });
      expect(resetResult.isError).toBeFalsy();
      const resetData = parseContent(resetResult) as { status: string };
      expect(resetData.status).toBe("reset");

      // Can start again
      const startResult = await client.callTool({
        name: "graph_start",
        arguments: { graphId: "valid-simple" },
      });
      expect(startResult.isError).toBeFalsy();
    });
  });
});
