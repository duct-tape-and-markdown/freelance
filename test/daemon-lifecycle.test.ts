import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

let pidDir: string;
let pidFilePath: string;

vi.mock("../src/paths.js", () => ({
  getPidFilePath: () => pidFilePath,
  FREELANCE_DIR: ".freelance",
  TRAVERSALS_DIR: ".freelance/traversals",
  DEFAULT_PORT: 7433,
}));

import { writePidFile, registerShutdownHandlers } from "../src/daemon.js";

beforeEach(() => {
  pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-lifecycle-"));
  pidFilePath = path.join(pidDir, "daemon.pid");
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(pidDir, { recursive: true, force: true });
});

describe("writePidFile", () => {
  it("writes PID file with pid and port", () => {
    const result = writePidFile(8080);
    expect(fs.existsSync(result)).toBe(true);
    const data = JSON.parse(fs.readFileSync(result, "utf-8"));
    expect(data.pid).toBe(process.pid);
    expect(data.port).toBe(8080);
    expect(data.graphsDirs).toBeUndefined();
  });

  it("includes graphsDirs when provided", () => {
    const result = writePidFile(8080, ["/tmp/graphs"]);
    const data = JSON.parse(fs.readFileSync(result, "utf-8"));
    expect(data.graphsDirs).toEqual(["/tmp/graphs"]);
  });

  it("creates parent directories", () => {
    pidFilePath = path.join(pidDir, "nested", "deep", "daemon.pid");
    const result = writePidFile(8080);
    expect(fs.existsSync(result)).toBe(true);
  });
});

describe("registerShutdownHandlers", () => {
  it("registers SIGINT and SIGTERM handlers", () => {
    const onSpy = vi.spyOn(process, "on");
    const server = http.createServer();

    registerShutdownHandlers(server, pidFilePath);

    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));

    onSpy.mockRestore();
  });
});
