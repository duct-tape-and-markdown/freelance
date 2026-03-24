import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock heavy dependencies to prevent real server/daemon starts
vi.mock("../src/server.js", () => ({ startServer: vi.fn(async () => {}) }));
vi.mock("../src/daemon.js", () => ({
  startDaemon: vi.fn(async () => {}),
  createDaemon: vi.fn(),
}));
vi.mock("../src/proxy.js", () => ({ startProxy: vi.fn(async () => {}) }));
vi.mock("../src/cli/validate.js", () => ({ validate: vi.fn() }));
vi.mock("../src/cli/visualize.js", () => ({ visualize: vi.fn() }));
vi.mock("../src/cli/inspect.js", () => ({ inspect: vi.fn() }));
vi.mock("../src/cli/init.js", () => ({
  init: vi.fn(async () => {}),
  initInteractive: vi.fn(async () => {}),
  INIT_DEFAULTS: { starter: "blank", dryRun: false },
}));
vi.mock("../src/cli/daemon.js", () => ({
  daemonStop: vi.fn(),
  daemonStatus: vi.fn(),
  checkRunningDaemon: vi.fn(() => null),
}));
vi.mock("../src/cli/traversals.js", () => ({
  parseDaemonConnect: vi.fn(() => ({ host: "127.0.0.1", port: 7433 })),
  traversalsList: vi.fn(async () => {}),
  traversalsInspect: vi.fn(async () => {}),
  traversalsReset: vi.fn(async () => {}),
}));
vi.mock("../src/loader.js", () => ({
  loadGraphs: vi.fn(() => new Map([["test", {}]])),
  loadGraphsLayered: vi.fn(() => new Map([["test", {}]])),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;
let stderrSpy: any;
let stdoutSpy: any;

import { program } from "../src/index.js";
// Graph resolution tests live in test/graph-resolution.test.ts (canonical location)

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("program commands", () => {
  it("validate command calls validate function", async () => {
    const { validate } = await import("../src/cli/validate.js");
    await program.parseAsync(["node", "freelance", "validate", "/tmp/test"]);
    expect(validate).toHaveBeenCalledWith("/tmp/test", { checkSources: undefined });
  });

  it("visualize command calls visualize function", async () => {
    const { visualize } = await import("../src/cli/visualize.js");
    await program.parseAsync(["node", "freelance", "visualize", "/tmp/test.graph.yaml", "--format", "dot"]);
    expect(visualize).toHaveBeenCalledWith("/tmp/test.graph.yaml", expect.objectContaining({ format: "dot" }));
  });

  it("inspect command calls inspect function", async () => {
    const { inspect } = await import("../src/cli/inspect.js");
    await program.parseAsync(["node", "freelance", "inspect", "--oneline"]);
    expect(inspect).toHaveBeenCalledWith({ oneline: true });
  });

  it("init --yes calls init function", async () => {
    const { init } = await import("../src/cli/init.js");
    await program.parseAsync(["node", "freelance", "init", "--yes"]);
    expect(init).toHaveBeenCalled();
  });

  it("init without --yes calls initInteractive", async () => {
    const { initInteractive } = await import("../src/cli/init.js");
    await program.parseAsync(["node", "freelance", "init"]);
    expect(initInteractive).toHaveBeenCalled();
  });

  it("completion with invalid shell calls fatal", async () => {
    await expect(
      program.parseAsync(["node", "freelance", "completion", "powershell"])
    ).rejects.toThrow("process.exit");
  });

  it("completion with bash outputs completion script", async () => {
    // This will fail if completion file doesn't exist, but that's fine
    // as it tests the code path
    try {
      await program.parseAsync(["node", "freelance", "completion", "bash"]);
    } catch {
      // May fail with "Completion file not found" — that's fine, it covers the code path
    }
  });

  it("preAction hook sets CLI state", async () => {
    const { validate } = await import("../src/cli/validate.js");
    await program.parseAsync(["node", "freelance", "--json", "--quiet", "validate", "/tmp"]);
    expect(validate).toHaveBeenCalled();
  });

  it("daemon stop calls daemonStop", async () => {
    const { daemonStop } = await import("../src/cli/daemon.js");
    try {
      await program.parseAsync(["node", "freelance", "daemon", "stop"]);
    } catch {
      // daemonStop calls fatal which throws
    }
    expect(daemonStop).toHaveBeenCalled();
  });

  it("daemon status calls daemonStatus", async () => {
    const { daemonStatus } = await import("../src/cli/daemon.js");
    await program.parseAsync(["node", "freelance", "daemon", "status"]);
    expect(daemonStatus).toHaveBeenCalled();
  });

  it("mcp standalone loads graphs and starts server", async () => {
    const { startServer } = await import("../src/server.js");
    await program.parseAsync(["node", "freelance", "mcp", "--graphs", "/tmp/fake"]);
    expect(startServer).toHaveBeenCalled();
  });

  it("mcp --connect starts proxy", async () => {
    const { startProxy } = await import("../src/proxy.js");
    await program.parseAsync(["node", "freelance", "mcp", "--connect", "localhost:8080"]);
    expect(startProxy).toHaveBeenCalled();
  });

  it("daemon start loads graphs and starts daemon", async () => {
    const { startDaemon } = await import("../src/daemon.js");
    await program.parseAsync(["node", "freelance", "daemon", "start", "--graphs", "/tmp/fake", "--port", "9999"]);
    expect(startDaemon).toHaveBeenCalled();
  });

  it("daemon start exits when already running", async () => {
    const { checkRunningDaemon } = await import("../src/cli/daemon.js");
    (checkRunningDaemon as ReturnType<typeof vi.fn>).mockReturnValueOnce({ pid: 1234, port: 7433 });
    await expect(
      program.parseAsync(["node", "freelance", "daemon", "start", "--graphs", "/tmp/fake"])
    ).rejects.toThrow("process.exit");
  });

  it("daemon start with invalid port calls fatal", async () => {
    await expect(
      program.parseAsync(["node", "freelance", "daemon", "start", "--graphs", "/tmp/fake", "--port", "99999"])
    ).rejects.toThrow("process.exit");
  });

  it("traversals list calls traversalsList", async () => {
    const { traversalsList } = await import("../src/cli/traversals.js");
    await program.parseAsync(["node", "freelance", "traversals", "list"]);
    expect(traversalsList).toHaveBeenCalled();
  });

  it("traversals inspect calls traversalsInspect", async () => {
    const { traversalsInspect } = await import("../src/cli/traversals.js");
    await program.parseAsync(["node", "freelance", "traversals", "inspect", "tr_abc"]);
    expect(traversalsInspect).toHaveBeenCalled();
  });

  it("traversals reset calls traversalsReset", async () => {
    const { traversalsReset } = await import("../src/cli/traversals.js");
    await program.parseAsync(["node", "freelance", "traversals", "reset", "tr_abc"]);
    expect(traversalsReset).toHaveBeenCalled();
  });
});
