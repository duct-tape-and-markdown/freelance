import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock getPidFilePath to use a temp directory
let tmpDir: string;
let pidFilePath: string;

vi.mock("../src/paths.js", () => ({
  getPidFilePath: () => pidFilePath,
}));

// Import after mocks are set up
import { readPidFile, checkRunningDaemon, daemonStop, daemonStatus } from "../src/cli/daemon.js";
import { setCli } from "../src/cli/output.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;
let stderrSpy: any;
let stdoutSpy: any;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-daemon-test-"));
  pidFilePath = path.join(tmpDir, "daemon.pid");
  setCli({ json: false, quiet: false, verbose: false, noColor: false });

  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readPidFile", () => {
  it("returns null when no PID file exists", () => {
    expect(readPidFile()).toBeNull();
  });

  it("parses valid PID file with pid and port", () => {
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: 1234, port: 7433 }));
    const result = readPidFile();
    expect(result).toEqual({ pid: 1234, port: 7433, graphsDirs: undefined });
  });

  it("parses valid PID file with graphsDirs", () => {
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: 1234, port: 7433, graphsDirs: ["/tmp/graphs"] }));
    const result = readPidFile();
    expect(result).toEqual({ pid: 1234, port: 7433, graphsDirs: ["/tmp/graphs"] });
  });

  it("returns null for invalid JSON", () => {
    fs.writeFileSync(pidFilePath, "not json at all");
    expect(readPidFile()).toBeNull();
  });
});

describe("checkRunningDaemon", () => {
  it("returns null when no PID file exists", () => {
    expect(checkRunningDaemon()).toBeNull();
  });

  it("returns PID info when process is alive", () => {
    // Use our own PID — we know it's alive
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: process.pid, port: 7433 }));
    const result = checkRunningDaemon();
    expect(result).toEqual({ pid: process.pid, port: 7433, graphsDirs: undefined });
  });

  it("cleans up stale PID file when process is dead", () => {
    // PID 999999 is almost certainly not running
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: 999999, port: 7433 }));
    const result = checkRunningDaemon();
    expect(result).toBeNull();
    expect(fs.existsSync(pidFilePath)).toBe(false);
  });
});

describe("daemonStop", () => {
  it("calls fatal when no PID file exists", () => {
    expect(() => daemonStop()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(4);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("No daemon PID file found"));
  });

  it("sends SIGTERM to a running process (text mode)", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: 12345, port: 7433 }));

    daemonStop();

    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Sent SIGTERM to daemon (PID 12345)"));
  });

  it("sends SIGTERM and outputs JSON in json mode", () => {
    setCli({ json: true });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: 12345, port: 7433 }));

    daemonStop();

    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(output)).toEqual({ stopped: true, pid: 12345 });
  });

  it("handles ESRCH (process not found) by cleaning up and calling fatal", () => {
    const esrchError = Object.assign(new Error("No such process"), { code: "ESRCH" });
    vi.spyOn(process, "kill").mockImplementation(() => { throw esrchError; });
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: 12345, port: 7433 }));

    expect(() => daemonStop()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(4);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("handles other kill errors by calling fatal", () => {
    const epermError = Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
    vi.spyOn(process, "kill").mockImplementation(() => { throw epermError; });
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: 12345, port: 7433 }));

    expect(() => daemonStop()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(4);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to stop daemon"));
  });
});

describe("daemonStatus", () => {
  it("reports not running when no PID file (text mode)", () => {
    daemonStatus();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("not running"));
  });

  it("reports not running when no PID file (json mode)", () => {
    setCli({ json: true });
    daemonStatus();
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(output)).toEqual({ running: false });
  });

  it("reports running when process is alive (text mode)", () => {
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: process.pid, port: 7433, graphsDirs: ["/tmp/g"] }));
    daemonStatus();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(`PID ${process.pid}`));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Graphs: /tmp/g"));
  });

  it("reports running without graphsDirs line when not set", () => {
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: process.pid, port: 7433 }));
    daemonStatus();
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain(`PID ${process.pid}`);
    expect(output).not.toContain("Graphs:");
  });

  it("reports running in json mode", () => {
    setCli({ json: true });
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: process.pid, port: 7433, graphsDirs: ["/tmp/g"] }));
    daemonStatus();
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(output)).toEqual({ running: true, pid: process.pid, port: 7433, graphsDirs: ["/tmp/g"] });
  });

  it("reports stale PID in text mode", () => {
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: 999999, port: 7433 }));
    daemonStatus();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("stale PID file"));
  });

  it("reports stale PID in json mode", () => {
    setCli({ json: true });
    fs.writeFileSync(pidFilePath, JSON.stringify({ pid: 999999, port: 7433 }));
    daemonStatus();
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(output)).toEqual({ running: false, stalePid: 999999 });
  });
});
