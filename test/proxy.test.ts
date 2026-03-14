import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadGraphs } from "../src/loader.js";
import { createDaemon } from "../src/daemon.js";
import { createProxy } from "../src/proxy.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-test-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

function parseContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  return JSON.parse(text);
}

describe("MCP proxy → daemon integration", () => {
  let daemonServer: http.Server;
  let daemonPort: number;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml", "valid-branching.graph.yaml");
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-persist-"));

    // Start daemon on random port
    const daemon = createDaemon(graphs, {
      port: 0,
      host: "127.0.0.1",
      persistDir,
    });
    daemonServer = daemon.server;

    await new Promise<void>((resolve) => {
      daemonServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = daemonServer.address();
    daemonPort = typeof addr === "object" && addr ? addr.port : 0;

    // Create proxy pointing at daemon
    const proxy = createProxy("127.0.0.1", daemonPort);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await proxy.close();
      await new Promise<void>((resolve) => daemonServer.close(() => resolve()));
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  it("graph_list returns available graphs via proxy", async () => {
    const result = await client.callTool({ name: "graph_list", arguments: {} });
    const data = parseContent(result);
    expect(data.graphs).toBeDefined();
    expect(Array.isArray(data.graphs)).toBe(true);
    const graphs = data.graphs as Array<Record<string, unknown>>;
    const ids = graphs.map((g) => g.id);
    expect(ids).toContain("valid-simple");
    expect(ids).toContain("valid-branching");
  });

  it("graph_start creates traversal via proxy", async () => {
    const result = await client.callTool({
      name: "graph_start",
      arguments: { graphId: "valid-simple" },
    });
    const data = parseContent(result);
    expect(data.status).toBe("started");
    expect(data.traversalId).toBeDefined();
    expect(data.currentNode).toBe("start");
  });

  it("full lifecycle through proxy: start → context → advance → inspect → reset", async () => {
    // Start
    const startResult = await client.callTool({
      name: "graph_start",
      arguments: { graphId: "valid-simple" },
    });
    const started = parseContent(startResult);
    const traversalId = started.traversalId as string;
    expect(started.currentNode).toBe("start");

    // Context set
    const ctxResult = await client.callTool({
      name: "graph_context_set",
      arguments: { traversalId, updates: { taskStarted: true } },
    });
    const ctx = parseContent(ctxResult);
    expect(ctx.status).toBe("updated");

    // Advance
    const advResult = await client.callTool({
      name: "graph_advance",
      arguments: { traversalId, edge: "work-done" },
    });
    const adv = parseContent(advResult);
    expect(adv.currentNode).toBe("review");

    // Inspect
    const inspectResult = await client.callTool({
      name: "graph_inspect",
      arguments: { traversalId, detail: "position" },
    });
    const inspected = parseContent(inspectResult);
    expect(inspected.currentNode).toBe("review");

    // Advance to terminal
    const adv2Result = await client.callTool({
      name: "graph_advance",
      arguments: { traversalId, edge: "approved" },
    });
    const adv2 = parseContent(adv2Result);
    expect(adv2.status).toBe("complete");

    // Reset
    const resetResult = await client.callTool({
      name: "graph_reset",
      arguments: { traversalId, confirm: true },
    });
    const reset = parseContent(resetResult);
    expect(reset.status).toBe("reset");
  });

  it("proxy returns error for failed advance (gate validation)", async () => {
    const startResult = await client.callTool({
      name: "graph_start",
      arguments: { graphId: "valid-simple" },
    });
    const started = parseContent(startResult);
    const traversalId = started.traversalId as string;

    // Advance to review node
    await client.callTool({
      name: "graph_advance",
      arguments: { traversalId, edge: "work-done" },
    });

    // Try to advance past gate without meeting validation — should get isError
    const advResult = await client.callTool({
      name: "graph_advance",
      arguments: { traversalId, edge: "approved" },
    });
    expect(advResult.isError).toBe(true);

    // Clean up
    await client.callTool({
      name: "graph_reset",
      arguments: { traversalId, confirm: true },
    });
  });

  it("graph_reset without confirm returns error", async () => {
    const result = await client.callTool({
      name: "graph_reset",
      arguments: { confirm: false },
    });
    expect(result.isError).toBe(true);
  });

  it("proxy handles inspect with history detail", async () => {
    const startResult = await client.callTool({
      name: "graph_start",
      arguments: { graphId: "valid-simple" },
    });
    const started = parseContent(startResult);
    const traversalId = started.traversalId as string;

    // Advance once to create history
    await client.callTool({
      name: "graph_advance",
      arguments: { traversalId, edge: "work-done" },
    });

    const inspectResult = await client.callTool({
      name: "graph_inspect",
      arguments: { traversalId, detail: "history" },
    });
    const data = parseContent(inspectResult);
    expect(data.traversalHistory).toBeDefined();
    const history = data.traversalHistory as Array<Record<string, unknown>>;
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].node).toBe("start");

    await client.callTool({
      name: "graph_reset",
      arguments: { traversalId, confirm: true },
    });
  });
});
