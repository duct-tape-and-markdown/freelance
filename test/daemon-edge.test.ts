import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadGraphs } from "../src/loader.js";
import { createDaemon, startDaemon } from "../src/daemon.js";
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

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "daemon-edge-"));
}

async function startDaemonOnRandomPort(
  graphs: Map<string, ValidatedGraph>,
  stateDir: string
): Promise<{ server: http.Server; port: number }> {
  const daemon = createDaemon(graphs, {
    port: 0,
    host: "127.0.0.1",
    stateDir,
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

  it("persists traversals across restart via JSON files", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const tmpDir = makeTmpDir();
    const stateDir = path.join(tmpDir, "traversals");

    // Start daemon 1, create a traversal, advance once
    const d1 = await startDaemonOnRandomPort(graphs, stateDir);
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

    // Start daemon 2 with same stateDir
    const d2 = await startDaemonOnRandomPort(graphs, stateDir);
    servers.push(d2.server);

    // The traversal should be restored from disk
    const { data: listed } = await request(d2.port, "GET", "/traversals");
    const traversals = listed.traversals as Array<Record<string, unknown>>;
    expect(traversals.length).toBe(1);
    expect(traversals[0].traversalId).toBe(traversalId);
    expect(traversals[0].currentNode).toBe("review");

    // Can still interact with restored traversal
    const { data: inspected } = await request(d2.port, "GET", `/traversals/${traversalId}`);
    expect(inspected.currentNode).toBe("review");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles concurrent traversals on different graphs", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    const tmpDir = makeTmpDir();
    const d = await startDaemonOnRandomPort(graphs, path.join(tmpDir, "traversals"));
    servers.push(d.server);

    const [r1, r2] = await Promise.all([
      request(d.port, "POST", "/traversals", { graphId: "valid-simple" }),
      request(d.port, "POST", "/traversals", { graphId: "valid-branching" }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.data.traversalId).not.toBe(r2.data.traversalId);

    const { data: listed } = await request(d.port, "GET", "/traversals");
    const traversals = listed.traversals as Array<Record<string, unknown>>;
    expect(traversals.length).toBe(2);

    const id1 = r1.data.traversalId as string;
    const id2 = r2.data.traversalId as string;

    const [adv1, adv2] = await Promise.all([
      request(d.port, "POST", `/traversals/${id1}/advance`, { edge: "work-done" }),
      request(d.port, "POST", `/traversals/${id2}/context`, { updates: { path: "left" } }),
    ]);
    expect(adv1.data.currentNode).toBe("review");
    expect(adv2.data.status).toBe("updated");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reset removes traversal from SQLite", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const tmpDir = makeTmpDir();
    const d = await startDaemonOnRandomPort(graphs, path.join(tmpDir, "traversals"));
    servers.push(d.server);

    const { data: created } = await request(d.port, "POST", "/traversals", {
      graphId: "valid-simple",
    });
    const id = created.traversalId as string;

    // List should show 1
    const { data: before } = await request(d.port, "GET", "/traversals");
    expect((before.traversals as unknown[]).length).toBe(1);

    // Reset
    await request(d.port, "POST", `/traversals/${id}/reset`);

    // List should show 0
    const { data: after } = await request(d.port, "GET", "/traversals");
    expect((after.traversals as unknown[]).length).toBe(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns EngineError as 400 for invalid graph ID", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const tmpDir = makeTmpDir();
    const d = await startDaemonOnRandomPort(graphs, path.join(tmpDir, "traversals"));
    servers.push(d.server);

    const { status, data } = await request(d.port, "POST", "/traversals", {
      graphId: "nonexistent-graph",
    });
    expect(status).toBe(400);
    expect(data.error).toContain("not found");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("advance on unknown traversal returns 400", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const tmpDir = makeTmpDir();
    const d = await startDaemonOnRandomPort(graphs, path.join(tmpDir, "traversals"));
    servers.push(d.server);

    const { status, data } = await request(d.port, "POST", "/traversals/tr_nonexistent/advance", {
      edge: "whatever",
    });
    expect(status).toBe(400);
    expect(data.error).toContain("not found");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("context set on unknown traversal returns 400", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const tmpDir = makeTmpDir();
    const d = await startDaemonOnRandomPort(graphs, path.join(tmpDir, "traversals"));
    servers.push(d.server);

    const { status, data } = await request(d.port, "POST", "/traversals/tr_nope/context", {
      updates: { x: 1 },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("not found");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inspect with full detail returns graph definition", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const tmpDir = makeTmpDir();
    const d = await startDaemonOnRandomPort(graphs, path.join(tmpDir, "traversals"));
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 404 for unknown routes", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const tmpDir = makeTmpDir();
    const d = await startDaemonOnRandomPort(graphs, path.join(tmpDir, "traversals"));
    servers.push(d.server);

    const { status, data } = await request(d.port, "GET", "/nonexistent");
    expect(status).toBe(404);
    expect(data.error).toContain("Not found");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 400 for invalid JSON body", async () => {
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const tmpDir = makeTmpDir();
    const d = await startDaemonOnRandomPort(graphs, path.join(tmpDir, "traversals"));
    servers.push(d.server);

    const { status, data } = await new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: d.port, path: "/traversals", method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            resolve({ status: res.statusCode ?? 500, data: JSON.parse(raw) });
          });
        }
      );
      req.on("error", reject);
      req.write("not valid json{{{");
      req.end();
    });
    expect(status).toBe(400);
    expect(data.error).toContain("Invalid JSON");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles watcher integration with graphsDir and triggers onUpdate", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const graphsDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-watcher-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(graphsDir, "valid-simple.workflow.yaml")
    );
    const graphs = loadGraphs(graphsDir);

    const daemon = createDaemon(graphs, {
      port: 0,
      host: "127.0.0.1",
      stateDir: path.join(graphsDir, "traversals"),
      graphsDirs: [graphsDir],
    });
    expect(daemon.stopWatcher).toBeDefined();

    await new Promise<void>((resolve) => {
      daemon.server.listen(0, "127.0.0.1", () => resolve());
    });
    servers.push(daemon.server);

    const graphFile = path.join(graphsDir, "valid-simple.workflow.yaml");
    const content = fs.readFileSync(graphFile, "utf-8");
    fs.writeFileSync(graphFile, content);

    await new Promise((resolve) => setTimeout(resolve, 500));

    const reloadLogged = stderrSpy.mock.calls.some(
      (c: [string]) => typeof c[0] === "string" && c[0].includes("Graph reload")
    );
    expect(reloadLogged).toBe(true);

    if (daemon.stopWatcher) daemon.stopWatcher();
    stderrSpy.mockRestore();
    fs.rmSync(graphsDir, { recursive: true, force: true });
  });

  it("watcher reports validation errors on invalid graph reload", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const graphsDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-watcher-err-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(graphsDir, "valid-simple.workflow.yaml")
    );
    const graphs = loadGraphs(graphsDir);

    const daemon = createDaemon(graphs, {
      port: 0,
      host: "127.0.0.1",
      stateDir: path.join(graphsDir, "traversals"),
      graphsDirs: [graphsDir],
    });

    await new Promise<void>((resolve) => {
      daemon.server.listen(0, "127.0.0.1", () => resolve());
    });
    servers.push(daemon.server);

    fs.writeFileSync(path.join(graphsDir, "valid-simple.workflow.yaml"), "not: valid: yaml: [[[");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const errorLogged = stderrSpy.mock.calls.some(
      (c: [string]) => typeof c[0] === "string" && c[0].includes("failed validation")
    );
    expect(errorLogged).toBe(true);

    if (daemon.stopWatcher) daemon.stopWatcher();
    stderrSpy.mockRestore();
    fs.rmSync(graphsDir, { recursive: true, force: true });
  });

  it("POST /shutdown responds and closes server", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const tmpDir = makeTmpDir();
    const d = await startDaemonOnRandomPort(graphs, path.join(tmpDir, "traversals"));

    const { status, data } = await request(d.port, "POST", "/shutdown");
    expect(status).toBe(200);
    expect(data.status).toBe("shutting_down");

    await new Promise((resolve) => setTimeout(resolve, 100));
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("startDaemon writes PID file and listens", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const graphs = loadFixtures("valid-simple.workflow.yaml");
    const tmpDir = makeTmpDir();

    const pidFile = path.resolve(".freelance", "daemon.pid");
    const pidExisted = fs.existsSync(pidFile);
    let pidContent: string | null = null;
    if (pidExisted) pidContent = fs.readFileSync(pidFile, "utf-8");

    try {
      startDaemon(graphs, {
        port: 0,
        host: "127.0.0.1",
        stateDir: path.join(tmpDir, "traversals"),
        graphsDirs: [tmpDir],
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(fs.existsSync(pidFile)).toBe(true);
      const pidData = JSON.parse(fs.readFileSync(pidFile, "utf-8"));
      expect(pidData.pid).toBe(process.pid);
      expect(pidData.graphsDirs).toEqual([tmpDir]);

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Freelance daemon listening"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Watching:"));
    } finally {
      if (pidExisted && pidContent) {
        fs.writeFileSync(pidFile, pidContent);
      } else if (!pidExisted && fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
