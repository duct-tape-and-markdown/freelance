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
  let sourceFile: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-mcp-test-"));
    const dbPath = path.join(tmpDir, "memory.db");
    sourceFile = path.join(tmpDir, "auth.ts");
    fs.writeFileSync(sourceFile, "export class Auth { validate() {} }");

    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const { server, memoryStore } = createServer(graphs, {
      memory: { enabled: true, db: dbPath },
      sourceRoot: tmpDir,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      if (memoryStore) memoryStore.close();
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it("memory tools are registered", async () => {
    const tools = await client.listTools();
    const memTools = tools.tools.filter((t) => t.name.startsWith("memory_"));
    expect(memTools.length).toBe(10);
    const names = memTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "memory_begin",
      "memory_browse",
      "memory_by_source",
      "memory_emit",
      "memory_end",
      "memory_gaps",
      "memory_inspect",
      "memory_register_source",
      "memory_relationships",
      "memory_status",
    ]);
  });

  it("full compilation flow via MCP tools", async () => {
    // Begin session
    const beginResult = await client.callTool({ name: "memory_begin", arguments: {} });
    expect(beginResult.isError).toBeFalsy();
    const begin = parseContent(beginResult) as { session_id: string };
    expect(begin.session_id).toBeTruthy();

    // Register source
    const regResult = await client.callTool({
      name: "memory_register_source",
      arguments: { file_path: "auth.ts" },
    });
    expect(regResult.isError).toBeFalsy();
    const reg = parseContent(regResult) as { content_hash: string; status: string };
    expect(reg.status).toBe("registered");

    // Emit propositions
    const emitResult = await client.callTool({
      name: "memory_emit",
      arguments: {
        propositions: [
          { content: "Auth validates JWT tokens.", entities: ["Auth"] },
          { content: "Auth returns 401 for expired tokens.", entities: ["Auth"] },
        ],
      },
    });
    expect(emitResult.isError).toBeFalsy();
    const emit = parseContent(emitResult) as { created: number };
    expect(emit.created).toBe(2);

    // End session
    const endResult = await client.callTool({ name: "memory_end", arguments: {} });
    expect(endResult.isError).toBeFalsy();
    const end = parseContent(endResult) as { propositions_emitted: number; files_registered: number };
    expect(end.propositions_emitted).toBe(2);
    expect(end.files_registered).toBe(1);

    // Browse entities
    const browseResult = await client.callTool({ name: "memory_browse", arguments: {} });
    const browse = parseContent(browseResult) as { entities: Array<{ name: string }> };
    expect(browse.entities).toHaveLength(1);
    expect(browse.entities[0].name).toBe("Auth");

    // Inspect entity
    const inspectResult = await client.callTool({
      name: "memory_inspect",
      arguments: { entity: "Auth" },
    });
    const inspect = parseContent(inspectResult) as { propositions: Array<{ valid: boolean }> };
    expect(inspect.propositions).toHaveLength(2);
    expect(inspect.propositions[0].valid).toBe(true);

    // Status
    const statusResult = await client.callTool({ name: "memory_status", arguments: {} });
    const status = parseContent(statusResult) as { total_propositions: number; valid_propositions: number };
    expect(status.total_propositions).toBe(2);
    expect(status.valid_propositions).toBe(2);
  });

  it("memory tools not registered when memory disabled", async () => {
    // Create a server without memory
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const { server: noMemServer } = createServer(graphs);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const noMemClient = new Client({ name: "test-client", version: "1.0.0" });
    await noMemServer.connect(st);
    await noMemClient.connect(ct);

    const tools = await noMemClient.listTools();
    const memTools = tools.tools.filter((t) => t.name.startsWith("memory_"));
    expect(memTools.length).toBe(0);

    await noMemClient.close();
    await noMemServer.close();
  });
});
