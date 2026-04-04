import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadGraphs } from "../src/loader.js";
import { createServer } from "../src/server.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function copyFixtures(tmpDir: string, ...files: string[]): void {
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
}

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
  copyFixtures(tmpDir, ...files);
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
    const graphs = loadFixtures("valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    const { server } = createServer(graphs);
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
    it("freelance_list returns correct graphs", async () => {
      const result = await client.callTool({ name: "freelance_list", arguments: {} });
      expect(result.isError).toBeFalsy();
      const data = parseContent(result) as { graphs: Array<{ id: string }> };
      expect(data.graphs).toHaveLength(2);
      const ids = data.graphs.map((g) => g.id).sort();
      expect(ids).toEqual(["valid-branching", "valid-simple"]);
    });

    it("full traversal: start → advance → terminal", async () => {
      // Start
      const startResult = await client.callTool({
        name: "freelance_start",
        arguments: { graphId: "valid-simple" },
      });
      expect(startResult.isError).toBeFalsy();
      const startData = parseContent(startResult) as { status: string; currentNode: string };
      expect(startData.status).toBe("started");
      expect(startData.currentNode).toBe("start");

      // Advance to review (with context update)
      const adv1 = await client.callTool({
        name: "freelance_advance",
        arguments: { edge: "work-done", contextUpdates: { taskStarted: true } },
      });
      expect(adv1.isError).toBeFalsy();
      const adv1Data = parseContent(adv1) as { status: string; currentNode: string };
      expect(adv1Data.status).toBe("advanced");
      expect(adv1Data.currentNode).toBe("review");

      // Advance to done (terminal)
      const adv2 = await client.callTool({
        name: "freelance_advance",
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
        name: "freelance_start",
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
      const listResult = await client.callTool({ name: "freelance_list", arguments: {} });
      expect(listResult.isError).toBeFalsy();
      const listData = parseContent(listResult) as { graphs: Array<{ id: string }> };
      expect(listData.graphs.length).toBeGreaterThan(0);

      // Start a graph
      const startResult = await client.callTool({
        name: "freelance_start",
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
        name: "freelance_context_set",
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
        name: "freelance_advance",
        arguments: { edge: "work-done" },
      });
      expect(adv1.isError).toBeFalsy();
      const adv1Data = parseContent(adv1) as { status: string; currentNode: string };
      expect(adv1Data.status).toBe("advanced");
      expect(adv1Data.currentNode).toBe("review");

      // Advance: review → done (terminal)
      const adv2 = await client.callTool({
        name: "freelance_advance",
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
        name: "freelance_reset",
        arguments: { confirm: true },
      });
      expect(resetResult.isError).toBeFalsy();
      const resetData = parseContent(resetResult) as { status: string; previousGraph: string };
      expect(resetData.status).toBe("reset");
      expect(resetData.previousGraph).toBe("valid-simple");

      // Restart works
      const restartResult = await client.callTool({
        name: "freelance_start",
        arguments: { graphId: "valid-simple" },
      });
      expect(restartResult.isError).toBeFalsy();
      const restartData = parseContent(restartResult) as { status: string; currentNode: string };
      expect(restartData.status).toBe("started");
      expect(restartData.currentNode).toBe("start");
    });
  });

  describe("error handling", () => {
    it("freelance_start with invalid graphId → isError", async () => {
      const result = await client.callTool({
        name: "freelance_start",
        arguments: { graphId: "nonexistent" },
      });
      expect(result.isError).toBe(true);
    });

    it("freelance_advance before starting → isError", async () => {
      const result = await client.callTool({
        name: "freelance_advance",
        arguments: { edge: "some-edge" },
      });
      expect(result.isError).toBe(true);
    });

    it("freelance_advance with gate validation failure → isError with full state", async () => {
      await client.callTool({
        name: "freelance_start",
        arguments: { graphId: "valid-simple" },
      });
      // Advance to gate without setting taskStarted
      await client.callTool({
        name: "freelance_advance",
        arguments: { edge: "work-done" },
      });
      // Try to pass gate
      const result = await client.callTool({
        name: "freelance_advance",
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

    it("freelance_context_set before starting → isError", async () => {
      const result = await client.callTool({
        name: "freelance_context_set",
        arguments: { updates: { foo: "bar" } },
      });
      expect(result.isError).toBe(true);
    });

    it("freelance_reset without confirm: true → isError", async () => {
      const result = await client.callTool({
        name: "freelance_reset",
        arguments: { confirm: false },
      });
      expect(result.isError).toBe(true);
    });

    it("freelance_reset with confirm: true → success, then start works", async () => {
      await client.callTool({
        name: "freelance_start",
        arguments: { graphId: "valid-simple" },
      });

      const resetResult = await client.callTool({
        name: "freelance_reset",
        arguments: { confirm: true },
      });
      expect(resetResult.isError).toBeFalsy();
      const resetData = parseContent(resetResult) as { status: string };
      expect(resetData.status).toBe("reset");

      // Can start again
      const startResult = await client.callTool({
        name: "freelance_start",
        arguments: { graphId: "valid-simple" },
      });
      expect(startResult.isError).toBeFalsy();
    });
  });
});

describe("MCP server source tools", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let graphsDir: string;

  beforeEach(async () => {
    graphsDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-sources-"));
    // Create a doc file for hashing
    fs.writeFileSync(path.join(graphsDir, "doc.md"), "# Test Document\n\nSome content.\n");
    copyFixtures(graphsDir, "valid-simple.workflow.yaml");
    const graphs = loadGraphs(graphsDir);
    const { server } = createServer(graphs, { graphsDirs: [graphsDir] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await server.close();
      fs.rmSync(graphsDir, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it("freelance_sources_hash returns hashes for files", async () => {
    const result = await client.callTool({
      name: "freelance_sources_hash",
      arguments: { sources: [{ path: path.join(graphsDir, "doc.md") }] },
    });
    expect(result.isError).toBeFalsy();
    const data = parseContent(result) as { hash: string; sources: Array<{ hash: string }> };
    expect(data.hash).toBeTruthy();
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0].hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("freelance_sources_hash errors on missing file", async () => {
    const result = await client.callTool({
      name: "freelance_sources_hash",
      arguments: { sources: [{ path: "/nonexistent/file.md" }] },
    });
    expect(result.isError).toBe(true);
  });

  it("freelance_sources_check detects matching hashes", async () => {
    // First hash it
    const hashResult = await client.callTool({
      name: "freelance_sources_hash",
      arguments: { sources: [{ path: path.join(graphsDir, "doc.md") }] },
    });
    const hashData = parseContent(hashResult) as { sources: Array<{ path: string; hash: string }> };

    // Then check it
    const checkResult = await client.callTool({
      name: "freelance_sources_check",
      arguments: { sources: hashData.sources },
    });
    expect(checkResult.isError).toBeFalsy();
    const checkData = parseContent(checkResult) as { valid: boolean; drifted: unknown[] };
    expect(checkData.valid).toBe(true);
    expect(checkData.drifted).toHaveLength(0);
  });

  it("freelance_sources_check detects drift", async () => {
    const result = await client.callTool({
      name: "freelance_sources_check",
      arguments: {
        sources: [{ path: path.join(graphsDir, "doc.md"), hash: "0000000000000000" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = parseContent(result) as { valid: boolean; drifted: Array<{ actual: string }> };
    expect(data.valid).toBe(false);
    expect(data.drifted).toHaveLength(1);
  });

  it("freelance_sources_validate with no graphsDirs returns error", async () => {
    // Create server without graphsDirs
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const { server: s2 } = createServer(graphs);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: "test", version: "1.0.0" });
    await s2.connect(st);
    await c2.connect(ct);

    const result = await c2.callTool({
      name: "freelance_sources_validate",
      arguments: {},
    });
    expect(result.isError).toBe(true);

    await c2.close();
    await s2.close();
  });

  it("freelance_sources_validate checks loaded graphs", async () => {
    const result = await client.callTool({
      name: "freelance_sources_validate",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const data = parseContent(result) as { valid: boolean; graphsChecked: number };
    expect(data.graphsChecked).toBe(1);
    // valid-simple has no sources, so no drift
    expect(data.valid).toBe(true);
  });

  it("freelance_sources_validate resolves paths from sourceRoot (parent of graphsDir)", async () => {
    // Reproduce issue #16 with correct sourceRoot resolution:
    // project-root/docs/guide.md exists, graph lives in project-root/.freelance/,
    // source path in YAML is "docs/guide.md" — resolves from parent of .freelance/.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "server-sources-root-"));
    const docsDir = path.join(projectRoot, "docs");
    const graphSubDir = path.join(projectRoot, ".freelance");
    fs.mkdirSync(docsDir);
    fs.mkdirSync(graphSubDir);

    // Create docs/guide.md at the project root level
    fs.writeFileSync(path.join(docsDir, "guide.md"), "# Guide\n\nContent here.\n");

    // Hash using absolute path to get the correct hash
    const hashResult = await client.callTool({
      name: "freelance_sources_hash",
      arguments: { sources: [{ path: path.join(docsDir, "guide.md") }] },
    });
    const hashData = parseContent(hashResult) as { sources: Array<{ hash: string }> };
    const docHash = hashData.sources[0].hash;

    // Write a graph in .freelance/ that references "docs/guide.md" —
    // this path is relative to projectRoot (parent of .freelance/), NOT to CWD.
    const graphYaml = `
id: source-root-test
version: "1.0"
name: "Source Root Test"
description: "Tests sourceRoot resolution from parent of graphsDir"
startNode: start
sources:
  - path: "docs/guide.md"
    hash: "${docHash}"
nodes:
  start:
    type: action
    description: "Start"
    edges:
      - target: end
        label: done
  end:
    type: terminal
    description: "End"
`;
    fs.writeFileSync(path.join(graphSubDir, "root-test.workflow.yaml"), graphYaml);

    // Create server with sourceRoot = projectRoot (parent of graphsDir)
    const graphs = loadGraphs(graphSubDir);
    const { server: s2 } = createServer(graphs, {
      graphsDirs: [graphSubDir],
      sourceRoot: projectRoot,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: "test", version: "1.0.0" });
    await s2.connect(st);
    await c2.connect(ct);

    try {
      const result = await c2.callTool({
        name: "freelance_sources_validate",
        arguments: { graphId: "source-root-test" },
      });
      expect(result.isError).toBeFalsy();
      const data = parseContent(result) as { valid: boolean; drift: unknown[] };
      expect(data.valid).toBe(true);
      expect(data.drift).toHaveLength(0);
    } finally {
      await c2.close();
      await s2.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("freelance_sources_hash resolves paths from sourceRoot", async () => {
    // Sibling layout: CWD is /workspace/codebase, graphs in /workspace/dev-docs/.freelance,
    // source "docs/guide.md" should resolve from /workspace/dev-docs/ (sourceRoot).
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "server-sources-sibling-"));
    const devDocs = path.join(workspace, "dev-docs");
    const graphSubDir = path.join(devDocs, ".freelance");
    const docsDir = path.join(devDocs, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(graphSubDir);

    fs.writeFileSync(path.join(docsDir, "guide.md"), "# Sibling Guide\n\nContent.\n");
    copyFixtures(graphSubDir, "valid-simple.workflow.yaml");

    const graphs = loadGraphs(graphSubDir);
    // sourceRoot points to dev-docs/ (parent of .freelance/)
    const { server: s2 } = createServer(graphs, {
      graphsDirs: [graphSubDir],
      sourceRoot: devDocs,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: "test", version: "1.0.0" });
    await s2.connect(st);
    await c2.connect(ct);

    try {
      // Hash "docs/guide.md" — should resolve from devDocs, not from CWD
      const result = await c2.callTool({
        name: "freelance_sources_hash",
        arguments: { sources: [{ path: "docs/guide.md" }] },
      });
      expect(result.isError).toBeFalsy();
      const data = parseContent(result) as { sources: Array<{ path: string; hash: string }> };
      expect(data.sources[0].hash).toMatch(/^[a-f0-9]{16}$/);

      // Verify the hash matches the actual file content
      const checkResult = await c2.callTool({
        name: "freelance_sources_check",
        arguments: { sources: data.sources },
      });
      expect(checkResult.isError).toBeFalsy();
      const checkData = parseContent(checkResult) as { valid: boolean };
      expect(checkData.valid).toBe(true);
    } finally {
      await c2.close();
      await s2.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("freelance_sources_validate with unknown graphId returns error", async () => {
    const result = await client.callTool({
      name: "freelance_sources_validate",
      arguments: { graphId: "nonexistent-graph" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("MCP server hot-reload", () => {
  it("picks up new graph files via watcher", async () => {
    const graphsDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-reload-"));
    copyFixtures(graphsDir, "valid-simple.workflow.yaml");
    const graphs = loadGraphs(graphsDir);

    const { server, stopWatcher } = createServer(graphs, { graphsDirs: [graphsDir] });
    expect(stopWatcher).toBeDefined();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      // Initially only one graph
      const before = parseContent(await client.callTool({ name: "freelance_list", arguments: {} })) as {
        graphs: Array<{ id: string }>;
      };
      expect(before.graphs).toHaveLength(1);
      expect(before.graphs[0].id).toBe("valid-simple");

      // Copy a second graph file into the watched dir
      copyFixtures(graphsDir, "valid-branching.workflow.yaml");

      // Wait for debounce (200ms default) + buffer
      await new Promise((r) => setTimeout(r, 500));

      // Now freelance_list should return both
      const after = parseContent(await client.callTool({ name: "freelance_list", arguments: {} })) as {
        graphs: Array<{ id: string }>;
      };
      expect(after.graphs).toHaveLength(2);
      const ids = after.graphs.map((g) => g.id).sort();
      expect(ids).toEqual(["valid-branching", "valid-simple"]);
    } finally {
      if (stopWatcher) stopWatcher();
      await client.close();
      await server.close();
      fs.rmSync(graphsDir, { recursive: true, force: true });
    }
  });

  it("surfaces load errors via freelance_list after reload failure", async () => {
    const graphsDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-reload-err-"));
    copyFixtures(graphsDir, "valid-simple.workflow.yaml");
    const graphs = loadGraphs(graphsDir);

    const { server, stopWatcher } = createServer(graphs, { graphsDirs: [graphsDir] });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      // Break the graph file
      fs.writeFileSync(path.join(graphsDir, "valid-simple.workflow.yaml"), "not: valid: yaml: [[[");

      await new Promise((r) => setTimeout(r, 500));

      // freelance_list should now include loadErrors
      const listResult = parseContent(await client.callTool({ name: "freelance_list", arguments: {} })) as {
        graphs: unknown[];
        loadErrors?: Array<{ file: string; message: string }>;
      };
      expect(listResult.loadErrors).toBeDefined();
      expect(listResult.loadErrors!.length).toBeGreaterThan(0);
    } finally {
      if (stopWatcher) stopWatcher();
      await client.close();
      await server.close();
      fs.rmSync(graphsDir, { recursive: true, force: true });
    }
  });

  it("does not start watcher when graphsDirs is not provided", () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const { stopWatcher } = createServer(graphs);
    expect(stopWatcher).toBeUndefined();
  });
});

describe("freelance_list with loadErrors", () => {
  it("includes loadErrors when graphs failed to load", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const loadErrors = [
      { file: "broken.workflow.yaml", message: "Schema validation failed" },
    ];
    const { server } = createServer(graphs, { loadErrors });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: "freelance_list", arguments: {} });
      const data = parseContent(result) as {
        graphs: unknown[];
        loadErrors: Array<{ file: string; message: string }>;
      };
      expect(data.loadErrors).toHaveLength(1);
      expect(data.loadErrors[0].file).toBe("broken.workflow.yaml");
      expect(data.graphs.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("omits loadErrors when there are none", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const { server } = createServer(graphs, { loadErrors: [] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: "freelance_list", arguments: {} });
      const data = parseContent(result) as Record<string, unknown>;
      expect(data.loadErrors).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("freelance_validate", () => {
  it("returns valid for correct graphs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-test-"));
    copyFixtures(tmpDir, "valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    const graphs = loadGraphs(tmpDir);
    const { server } = createServer(graphs, { graphsDirs: [tmpDir] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: "freelance_validate", arguments: {} });
      expect(result.isError).toBeFalsy();
      const data = parseContent(result) as { valid: boolean; graphs: unknown[]; errors: unknown[] };
      expect(data.valid).toBe(true);
      expect(data.graphs).toHaveLength(2);
      expect(data.errors).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns errors for invalid graphs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-test-"));
    copyFixtures(tmpDir, "valid-simple.workflow.yaml", "invalid-no-edges.workflow.yaml");
    // Load only the valid ones for the server
    const graphs = new Map<string, ValidatedGraph>();
    try {
      const loaded = loadGraphs(tmpDir);
      for (const [k, v] of loaded) graphs.set(k, v);
    } catch {
      // Expected — some are invalid
    }
    const { server } = createServer(graphs, { graphsDirs: [tmpDir] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: "freelance_validate", arguments: {} });
      expect(result.isError).toBeFalsy();
      const data = parseContent(result) as { valid: boolean; graphs: unknown[]; errors: Array<{ file: string; message: string }> };
      expect(data.valid).toBe(false);
      expect(data.errors.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns error when no graphsDirs configured", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const { server } = createServer(graphs); // no graphsDirs
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: "freelance_validate", arguments: {} });
      expect(result.isError).toBeTruthy();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("filters by graphId when provided", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-test-"));
    copyFixtures(tmpDir, "valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    const graphs = loadGraphs(tmpDir);
    const { server } = createServer(graphs, { graphsDirs: [tmpDir] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "freelance_validate",
        arguments: { graphId: "valid-simple" },
      });
      expect(result.isError).toBeFalsy();
      const data = parseContent(result) as { valid: boolean; graphs: Array<{ id: string }> };
      expect(data.valid).toBe(true);
      expect(data.graphs).toHaveLength(1);
      expect(data.graphs[0].id).toBe("valid-simple");
    } finally {
      await client.close();
      await server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
