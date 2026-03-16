import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadGraphs } from "../src/loader.js";
import { createDaemon } from "../src/daemon.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-test-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };

    const req = http.request(options, (res) => {
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
    });

    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe("Daemon HTTP API", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const graphs = loadFixtures("valid-simple.graph.yaml", "valid-branching.graph.yaml");
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-persist-"));
    const daemon = createDaemon(graphs, {
      port: 0,
      host: "127.0.0.1",
      persistDir,
    });
    server = daemon.server;

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /health returns ok", async () => {
    const { status, data } = await request(port, "GET", "/health");
    expect(status).toBe(200);
    expect(data.status).toBe("ok");
  });

  it("GET /graphs lists graphs and traversals", async () => {
    const { status, data } = await request(port, "GET", "/graphs");
    expect(status).toBe(200);
    expect(data.graphs).toBeDefined();
    expect(Array.isArray(data.graphs)).toBe(true);
    expect(data.activeTraversals).toBeDefined();
  });

  it("POST /traversals creates a traversal", async () => {
    const { status, data } = await request(port, "POST", "/traversals", {
      graphId: "valid-simple",
    });
    expect(status).toBe(201);
    expect(data.traversalId).toBeDefined();
    expect(data.status).toBe("started");
    expect(data.graphId).toBe("valid-simple");
    expect(data.currentNode).toBe("start");
  });

  it("GET /traversals lists active traversals", async () => {
    const { data } = await request(port, "GET", "/traversals");
    const traversals = data.traversals as Array<Record<string, unknown>>;
    expect(traversals.length).toBeGreaterThan(0);
    expect(traversals[0].traversalId).toBeDefined();
  });

  it("full lifecycle: create → context → advance → inspect → reset", async () => {
    // Create
    const { data: created } = await request(port, "POST", "/traversals", {
      graphId: "valid-simple",
    });
    const id = created.traversalId as string;

    // Context set
    const { data: ctx } = await request(port, "POST", `/traversals/${id}/context`, {
      updates: { taskStarted: true },
    });
    expect(ctx.status).toBe("updated");

    // Advance
    const { data: adv1 } = await request(port, "POST", `/traversals/${id}/advance`, {
      edge: "work-done",
    });
    expect(adv1.currentNode).toBe("review");

    // Inspect
    const { data: inspected } = await request(port, "GET", `/traversals/${id}`);
    expect(inspected.currentNode).toBe("review");

    // Advance to terminal
    const { data: adv2 } = await request(port, "POST", `/traversals/${id}/advance`, {
      edge: "approved",
    });
    expect(adv2.status).toBe("complete");

    // Reset
    const { data: reset } = await request(port, "POST", `/traversals/${id}/reset`);
    expect(reset.status).toBe("reset");
  });

  it("returns error for unknown traversal", async () => {
    const { status, data } = await request(port, "GET", "/traversals/tr_nonexistent");
    expect(status).toBe(400);
    expect(data.error).toContain("not found");
  });

  it("returns 404 for unknown routes", async () => {
    const { status } = await request(port, "GET", "/nonexistent");
    expect(status).toBe(404);
  });

  it("returns error for invalid JSON body", async () => {
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/traversals",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            expect(res.statusCode).toBe(400);
            resolve();
          });
        }
      );
      req.on("error", reject);
      req.write("not json{{{");
      req.end();
    });
  });

  it("GET /guide returns topics list", async () => {
    const { status, data } = await request(port, "GET", "/guide");
    expect(status).toBe(200);
    expect(data.topics).toBeDefined();
    expect(Array.isArray(data.topics)).toBe(true);
    expect(data.topics).toContain("basics");
  });

  it("GET /guide?topic=basics returns content", async () => {
    const { status, data } = await request(port, "GET", "/guide?topic=basics");
    expect(status).toBe(200);
    expect(data.content).toBeDefined();
    expect(data.content).toContain("Graph Basics");
  });

  it("GET /guide?topic=unknown returns error", async () => {
    const { status, data } = await request(port, "GET", "/guide?topic=nonexistent");
    expect(status).toBe(400);
    expect(data.error).toContain("nonexistent");
  });

  it("advance with context updates that fail validation", async () => {
    const { data: created } = await request(port, "POST", "/traversals", {
      graphId: "valid-simple",
    });
    const id = created.traversalId as string;

    // Advance to review without setting taskStarted
    await request(port, "POST", `/traversals/${id}/advance`, { edge: "work-done" });

    // Try to advance past gate — should fail but context updates persist
    const { data } = await request(port, "POST", `/traversals/${id}/advance`, {
      edge: "approved",
      contextUpdates: { extra: "persisted" },
    });
    expect(data.isError).toBe(true);
    const ctx = data.context as Record<string, unknown>;
    expect(ctx.extra).toBe("persisted");
  });
});
