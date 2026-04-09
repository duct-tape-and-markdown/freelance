import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadGraphs } from "../src/loader.js";
import { createServer } from "../src/server.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-tool-test-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

function parseContent(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  return JSON.parse(text);
}

describe("Memory MCP tools", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-mcp-test-"));
    const dbPath = path.join(tmpDir, "memory.db");
    fs.writeFileSync(path.join(tmpDir, "auth.ts"), "export class Auth { validate() {} }");

    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const { server, memoryStore, manager } = createServer(graphs, {
      memory: { enabled: true, db: dbPath },
      sourceRoot: tmpDir,
      stateDb: path.join(tmpDir, "state.db"),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      if (memoryStore) memoryStore.close();
      manager.close();
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it("registers 9 memory tools (no memory_begin)", async () => {
    const tools = await client.listTools();
    const memTools = tools.tools.filter((t) => t.name.startsWith("memory_"));
    const names = memTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "memory_browse",
      "memory_by_source",
      "memory_emit",
      "memory_end",
      "memory_inspect",
      "memory_register_source",
      "memory_related",
      "memory_search",
      "memory_status",
    ]);
  });

  it("full compilation flow via MCP tools", async () => {
    // Register source — session created lazily
    const regResult = await client.callTool({
      name: "memory_register_source",
      arguments: { file_path: "auth.ts" },
    });
    expect(regResult.isError).toBeFalsy();
    const reg = parseContent(regResult) as { status: string };
    expect(reg.status).toBe("registered");

    // Emit
    const emitResult = await client.callTool({
      name: "memory_emit",
      arguments: {
        collection: "default",
        propositions: [
          { content: "Auth validates JWT tokens using RS256.", entities: ["Auth"], sources: ["auth.ts"] },
          { content: "Auth returns 401 for expired tokens.", entities: ["Auth"], sources: ["auth.ts"] },
        ],
      },
    });
    expect(emitResult.isError).toBeFalsy();
    const emit = parseContent(emitResult) as { created: number };
    expect(emit.created).toBe(2);

    // End
    const endResult = await client.callTool({ name: "memory_end", arguments: {} });
    expect(endResult.isError).toBeFalsy();
    const end = parseContent(endResult) as { propositions_emitted: number; files_registered: number };
    expect(end.propositions_emitted).toBe(2);
    expect(end.files_registered).toBe(1);

    // Browse
    const browseResult = await client.callTool({ name: "memory_browse", arguments: {} });
    const browse = parseContent(browseResult) as { entities: Array<{ name: string }> };
    expect(browse.entities).toHaveLength(1);
    expect(browse.entities[0].name).toBe("Auth");

    // Inspect
    const inspectResult = await client.callTool({
      name: "memory_inspect",
      arguments: { entity: "Auth" },
    });
    const inspect = parseContent(inspectResult) as {
      propositions: Array<{ valid: boolean }>;
      source_sessions: Array<{ files: string[] }>;
    };
    expect(inspect.propositions).toHaveLength(2);
    expect(inspect.propositions[0].valid).toBe(true);
    expect(inspect.source_sessions).toHaveLength(1);
    expect(inspect.source_sessions[0].files).toEqual(["auth.ts"]);

    // Status
    const statusResult = await client.callTool({ name: "memory_status", arguments: {} });
    const status = parseContent(statusResult) as { total_propositions: number; valid_propositions: number };
    expect(status.total_propositions).toBe(2);
    expect(status.valid_propositions).toBe(2);
  });

  it("emit rejected without registered source", async () => {
    const emitResult = await client.callTool({
      name: "memory_emit",
      arguments: { collection: "default", propositions: [{ content: "test", entities: ["Foo"], sources: ["a.ts"] }] },
    });
    expect(emitResult.isError).toBeTruthy();
    const err = parseContent(emitResult) as { error: string };
    expect(err.error).toContain("Register a source file first");
  });

  it("sealed compile-knowledge workflow is available", async () => {
    const result = await client.callTool({ name: "freelance_list", arguments: {} });
    const data = parseContent(result) as { graphs: Array<{ id: string }> };
    const ids = data.graphs.map((g) => g.id);
    expect(ids).toContain("memory:compile");
  });

  it("sealed workflow is traversable", async () => {
    const startResult = await client.callTool({
      name: "freelance_start",
      arguments: { graphId: "memory:compile" },
    });
    expect(startResult.isError).toBeFalsy();
    const start = parseContent(startResult) as { status: string; currentNode: string };
    expect(start.status).toBe("started");
    expect(start.currentNode).toBe("exploring");
  });

  it("memory tools not registered when memory disabled", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const { server: noMemServer, manager: noMemManager } = createServer(graphs);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const noMemClient = new Client({ name: "test-client", version: "1.0.0" });
    await noMemServer.connect(st);
    await noMemClient.connect(ct);

    const tools = await noMemClient.listTools();
    const memTools = tools.tools.filter((t) => t.name.startsWith("memory_"));
    expect(memTools.length).toBe(0);

    await noMemClient.close();
    noMemManager.close();
    await noMemServer.close();
  });
});
