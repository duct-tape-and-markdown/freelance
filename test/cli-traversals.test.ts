import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { parseDaemonConnect, daemonFetch, traversalsList, traversalsInspect, traversalsReset } from "../src/cli/traversals.js";
import { setCli } from "../src/cli/output.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;
let stderrSpy: any;
let stdoutSpy: any;

beforeEach(() => {
  setCli({ json: false, quiet: false, verbose: false, noColor: false });
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseDaemonConnect", () => {
  it("returns defaults when no connect option", () => {
    expect(parseDaemonConnect({})).toEqual({ host: "127.0.0.1", port: 7433 });
  });

  it("parses host only (no colon)", () => {
    expect(parseDaemonConnect({ connect: "myhost" })).toEqual({ host: "myhost", port: 7433 });
  });

  it("parses host:port", () => {
    expect(parseDaemonConnect({ connect: "myhost:8080" })).toEqual({ host: "myhost", port: 8080 });
  });

  it("defaults host to 127.0.0.1 when only :port given", () => {
    expect(parseDaemonConnect({ connect: ":9000" })).toEqual({ host: "127.0.0.1", port: 9000 });
  });

  it("calls fatal for invalid port (NaN)", () => {
    expect(() => parseDaemonConnect({ connect: "host:abc" })).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("calls fatal for port 0", () => {
    expect(() => parseDaemonConnect({ connect: "host:0" })).toThrow("process.exit");
  });

  it("calls fatal for port > 65535", () => {
    expect(() => parseDaemonConnect({ connect: "host:99999" })).toThrow("process.exit");
  });
});

// Test server for daemonFetch and traversals commands
let server: http.Server;
let port: number;

// Route handler — tests override this per-test
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("daemonFetch", () => {
  it("returns parsed JSON on success", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    };
    const result = await daemonFetch("127.0.0.1", port, "/test");
    expect(result).toEqual({ ok: true });
  });

  it("calls fatal on HTTP error", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    };
    await expect(daemonFetch("127.0.0.1", port, "/fail")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(4);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));
  });

  it("calls fatal on connection error", async () => {
    // Port 1 is almost certainly not listening
    await expect(daemonFetch("127.0.0.1", 1, "/fail")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(4);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to connect"));
  });
});

describe("traversalsList", () => {
  it("prints 'No active traversals' when empty (text mode)", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ traversals: [] }));
    };
    await traversalsList("127.0.0.1", port);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("No active traversals"));
  });

  it("prints formatted traversals (text mode)", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        traversals: [{
          traversalId: "tr_abc123",
          graphId: "test-graph",
          currentNode: "start",
          stackDepth: 0,
          lastUpdated: "2026-01-01T00:00:00Z",
        }],
      }));
    };
    await traversalsList("127.0.0.1", port);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("tr_abc123"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("test-graph"));
  });

  it("outputs JSON in json mode", async () => {
    setCli({ json: true });
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ traversals: [] }));
    };
    await traversalsList("127.0.0.1", port);
    const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
    expect(JSON.parse(output)).toEqual({ traversals: [] });
  });
});

describe("traversalsInspect", () => {
  it("prints formatted traversal detail (text mode)", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        traversalId: "tr_abc123",
        graphId: "test-graph",
        currentNode: "start",
        stackDepth: 0,
      }));
    };
    await traversalsInspect("127.0.0.1", port, "tr_abc123");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("tr_abc123"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("test-graph"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("start"));
  });

  it("outputs JSON in json mode", async () => {
    setCli({ json: true });
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ traversalId: "tr_abc123", graphId: "g", currentNode: "n", stackDepth: 0 }));
    };
    await traversalsInspect("127.0.0.1", port, "tr_abc123");
    const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
    expect(JSON.parse(output).traversalId).toBe("tr_abc123");
  });
});

describe("traversalsReset", () => {
  it("prints reset confirmation (text mode)", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "reset" }));
    };
    await traversalsReset("127.0.0.1", port, "tr_abc123");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Reset traversal tr_abc123"));
  });

  it("outputs JSON in json mode", async () => {
    setCli({ json: true });
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "reset" }));
    };
    await traversalsReset("127.0.0.1", port, "tr_abc123");
    const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
    expect(JSON.parse(output)).toEqual({ status: "reset" });
  });
});
