import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadGraphs } from "../src/loader.js";
import { createDaemon } from "../src/daemon.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-edge-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

async function request(
  port: number,
  method: string,
  reqPath: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve({ status: res.statusCode ?? 500, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 500, data: { raw } as Record<string, unknown> });
          }
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function startDaemonOnRandomPort(
  graphs: Map<string, ValidatedGraph>,
  persistDir: string
): Promise<{ server: http.Server; port: number }> {
  const daemon = createDaemon(graphs, {
    port: 0,
    host: "127.0.0.1",
    persistDir,
  });
  await new Promise<void>((resolve) => {
    daemon.server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = daemon.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server: daemon.server, port };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("Daemon edge cases", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await closeServer(s).catch(() => {});
    }
    servers.length = 0;
  });

  it("persists traversals across restart", async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml");
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-persist-restart-"));

    // Start daemon 1, create a traversal, advance once
    const d1 = await startDaemonOnRandomPort(graphs, persistDir);
    servers.push(d1.server);

    const { data: created } = await request(d1.port, "POST", "/traversals", {
      graphId: "valid-simple",
    });
    const traversalId = created.traversalId as string;
    expect(created.currentNode).toBe("start");

    await request(d1.port, "POST", `/traversals/${traversalId}/advance`, {
      edge: "work-done",
    });

    // Stop daemon 1
    await closeServer(d1.server);
    servers.pop();

    // Verify persistence files exist
    const files = fs.readdirSync(persistDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    // Start daemon 2 with same persistDir
    const d2 = await startDaemonOnRandomPort(graphs, persistDir);
    servers.push(d2.server);

    // The traversal should be restored
    const { data: listed } = await request(d2.port, "GET", "/traversals");
    const traversals = listed.traversals as Array<Record<string, unknown>>;
    expect(traversals.length).toBe(1);
    expect(traversals[0].traversalId).toBe(traversalId);
    expect(traversals[0].currentNode).toBe("review");

    // Can still interact with restored traversal
    const { data: inspected } = await request(d2.port, "GET", `/traversals/${traversalId}`);
    expect(inspected.currentNode).toBe("review");
  });

  it("handles concurrent traversals on different graphs", async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml", "valid-branching.graph.yaml");
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-concurrent-"));
    const d = await startDaemonOnRandomPort(graphs, persistDir);
    servers.push(d.server);

    // Create two traversals concurrently
    const [r1, r2] = await Promise.all([
      request(d.port, "POST", "/traversals", { graphId: "valid-simple" }),
      request(d.port, "POST", "/traversals", { graphId: "valid-branching" }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.data.traversalId).not.toBe(r2.data.traversalId);

    // List should show both
    const { data: listed } = await request(d.port, "GET", "/traversals");
    const traversals = listed.traversals as Array<Record<string, unknown>>;
    expect(traversals.length).toBe(2);

    // Each can be operated independently
    const id1 = r1.data.traversalId as string;
    const id2 = r2.data.traversalId as string;

    const [adv1, adv2] = await Promise.all([
      request(d.port, "POST", `/traversals/${id1}/advance`, { edge: "work-done" }),
      request(d.port, "POST", `/traversals/${id2}/context`, {
        updates: { path: "left" },
      }),
    ]);
    expect(adv1.data.currentNode).toBe("review");
    expect(adv2.data.status).toBe("updated");
  });

  it("corrupted persistence file is skipped on restore", async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml");
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-corrupt-"));

    // Write a corrupted JSON file
    fs.writeFileSync(path.join(persistDir, "tr_corrupt.json"), "not json{{{");

    // Write a valid but empty-stack JSON file
    fs.writeFileSync(
      path.join(persistDir, "tr_empty.json"),
      JSON.stringify({ traversalId: "tr_empty", stack: [], createdAt: "", lastUpdated: "" })
    );

    // Daemon should start fine, skipping corrupt files
    const d = await startDaemonOnRandomPort(graphs, persistDir);
    servers.push(d.server);

    const { status, data } = await request(d.port, "GET", "/health");
    expect(status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.traversals).toBe(0);
  });

  it("reset deletes persistence file", async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml");
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-reset-persist-"));
    const d = await startDaemonOnRandomPort(graphs, persistDir);
    servers.push(d.server);

    // Create and then reset
    const { data: created } = await request(d.port, "POST", "/traversals", {
      graphId: "valid-simple",
    });
    const id = created.traversalId as string;

    // Persistence file should exist
    const fileBefore = fs.readdirSync(persistDir).filter((f) => f.includes(id));
    expect(fileBefore.length).toBe(1);

    // Reset
    await request(d.port, "POST", `/traversals/${id}/reset`);

    // Persistence file should be gone
    const fileAfter = fs.readdirSync(persistDir).filter((f) => f.includes(id));
    expect(fileAfter.length).toBe(0);
  });

  it("returns EngineError as 400 for invalid graph ID", async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml");
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-badgraph-"));
    const d = await startDaemonOnRandomPort(graphs, persistDir);
    servers.push(d.server);

    const { status, data } = await request(d.port, "POST", "/traversals", {
      graphId: "nonexistent-graph",
    });
    expect(status).toBe(400);
    expect(data.error).toContain("not found");
  });

  it("advance on unknown traversal returns 400", async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml");
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-unknown-"));
    const d = await startDaemonOnRandomPort(graphs, persistDir);
    servers.push(d.server);

    const { status, data } = await request(d.port, "POST", "/traversals/tr_nonexistent/advance", {
      edge: "whatever",
    });
    expect(status).toBe(400);
    expect(data.error).toContain("not found");
  });

  it("context set on unknown traversal returns 400", async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml");
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-unknown-ctx-"));
    const d = await startDaemonOnRandomPort(graphs, persistDir);
    servers.push(d.server);

    const { status, data } = await request(d.port, "POST", "/traversals/tr_nope/context", {
      updates: { x: 1 },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("not found");
  });

  it("inspect with full detail returns graph definition", async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml");
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-full-"));
    const d = await startDaemonOnRandomPort(graphs, persistDir);
    servers.push(d.server);

    const { data: created } = await request(d.port, "POST", "/traversals", {
      graphId: "valid-simple",
    });
    const id = created.traversalId as string;

    const { data } = await request(d.port, "GET", `/traversals/${id}?detail=full`);
    expect(data.definition).toBeDefined();
    const def = data.definition as Record<string, unknown>;
    expect(def.id).toBe("valid-simple");
    expect(def.nodes).toBeDefined();
  });
});
