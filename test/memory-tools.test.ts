import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const { server, runtime } = createServer(graphs, {
      memory: { enabled: true, db: dbPath },
      sourceRoot: tmpDir,
      stateDir: path.join(tmpDir, "traversals"),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      runtime.close();
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it("registers 8 memory tools", async () => {
    const tools = await client.listTools();
    const memTools = tools.tools.filter((t) => t.name.startsWith("memory_"));
    const names = memTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "memory_browse",
      "memory_by_source",
      "memory_emit",
      "memory_inspect",
      "memory_related",
      "memory_reset",
      "memory_search",
      "memory_status",
    ]);
  });

  it("write tools blocked without active memory traversal", async () => {
    // memory_emit should be blocked
    const emitResult = await client.callTool({
      name: "memory_emit",
      arguments: {
        collection: "default",
        propositions: [{ content: "test", entities: ["Foo"], sources: ["a.ts"] }],
      },
    });
    expect(emitResult.isError).toBeTruthy();
    const emitErr = parseContent(emitResult) as { error: string };
    expect(emitErr.error).toContain("active workflow traversal");
  });

  it("read tools available without active memory traversal", async () => {
    // Browse should work without a traversal
    const browseResult = await client.callTool({ name: "memory_browse", arguments: {} });
    expect(browseResult.isError).toBeFalsy();

    // Status should work without a traversal
    const statusResult = await client.callTool({ name: "memory_status", arguments: {} });
    expect(statusResult.isError).toBeFalsy();

    // Search should work without a traversal
    const searchResult = await client.callTool({
      name: "memory_search",
      arguments: { query: "test" },
    });
    expect(searchResult.isError).toBeFalsy();
  });

  it("full compilation flow via MCP tools (with active traversal)", async () => {
    // Start a memory:compile traversal first
    const startResult = await client.callTool({
      name: "freelance_start",
      arguments: { graphId: "memory:compile" },
    });
    expect(startResult.isError).toBeFalsy();

    // Emit — memory_emit hashes sources at emit time, no pre-registration needed
    const emitResult = await client.callTool({
      name: "memory_emit",
      arguments: {
        collection: "default",
        propositions: [
          {
            content: "Auth validates JWT tokens using RS256.",
            entities: ["Auth"],
            sources: ["auth.ts"],
          },
          {
            content: "Auth returns 401 for expired tokens.",
            entities: ["Auth"],
            sources: ["auth.ts"],
          },
        ],
      },
    });
    expect(emitResult.isError).toBeFalsy();
    const emit = parseContent(emitResult) as { created: number };
    expect(emit.created).toBe(2);

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
      source_files: string[];
    };
    expect(inspect.propositions).toHaveLength(2);
    expect(inspect.propositions[0].valid).toBe(true);
    expect(inspect.source_files).toEqual(["auth.ts"]);

    // Status
    const statusResult = await client.callTool({ name: "memory_status", arguments: {} });
    const status = parseContent(statusResult) as {
      total_propositions: number;
      valid_propositions: number;
    };
    expect(status.total_propositions).toBe(2);
    expect(status.valid_propositions).toBe(2);
  });

  it("emit rejects missing source file (within active traversal)", async () => {
    // Start memory traversal
    await client.callTool({
      name: "freelance_start",
      arguments: { graphId: "memory:compile" },
    });

    const emitResult = await client.callTool({
      name: "memory_emit",
      arguments: {
        collection: "default",
        propositions: [{ content: "test", entities: ["Foo"], sources: ["nonexistent.ts"] }],
      },
    });
    expect(emitResult.isError).toBeTruthy();
    const err = parseContent(emitResult) as { error: string };
    expect(err.error).toContain("Cannot read source file");
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
    const { server: noMemServer, runtime: noMemRuntime } = createServer(graphs);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const noMemClient = new Client({ name: "test-client", version: "1.0.0" });
    await noMemServer.connect(st);
    await noMemClient.connect(ct);

    const tools = await noMemClient.listTools();
    const memTools = tools.tools.filter((t) => t.name.startsWith("memory_"));
    expect(memTools.length).toBe(0);

    await noMemClient.close();
    noMemRuntime.close();
    await noMemServer.close();
  });
});
