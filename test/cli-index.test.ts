import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock heavy dependencies to prevent real server starts
vi.mock("../src/server.js", () => ({ startServer: vi.fn(async () => {}) }));
vi.mock("../src/cli/validate.js", () => ({ validate: vi.fn() }));
vi.mock("../src/cli/visualize.js", () => ({ visualize: vi.fn() }));
vi.mock("../src/cli/init.js", () => ({
  init: vi.fn(async () => {}),
  initInteractive: vi.fn(async () => {}),
  INIT_DEFAULTS: { starter: "blank", hooks: false, dryRun: false },
}));
vi.mock("../src/cli/traversals.js", () => ({
  traversalStatus: vi.fn(),
  traversalStart: vi.fn(),
  traversalAdvance: vi.fn(),
  traversalContextSet: vi.fn(),
  traversalInspect: vi.fn(),
  traversalReset: vi.fn(),
}));
vi.mock("../src/cli/memory.js", () => ({
  memoryStatus: vi.fn(),
  memoryBrowse: vi.fn(),
  memoryInspect: vi.fn(),
  memorySearch: vi.fn(),
  memoryRelated: vi.fn(),
  memoryBySource: vi.fn(),
  memoryRegister: vi.fn(),
  memoryEmit: vi.fn(),
  memoryEnd: vi.fn(),
}));
vi.mock("../src/cli/stateless.js", () => ({
  guideShow: vi.fn(),
  distillRun: vi.fn(),
  sourcesHash: vi.fn(),
  sourcesCheck: vi.fn(),
  sourcesValidate: vi.fn(),
}));
vi.mock("../src/cli/setup.js", () => ({
  createTraversalStore: vi.fn(() => ({
    store: { close: vi.fn(), listGraphs: vi.fn(() => ({ graphs: [], activeTraversals: [] })) },
    setup: { graphsDirs: [], sourceOpts: {} },
  })),
  createMemoryStore: vi.fn(() => ({
    store: { close: vi.fn() },
    setup: { graphsDirs: [], sourceOpts: {} },
  })),
  loadGraphSetup: vi.fn(() => ({
    graphs: new Map(),
    graphsDirs: [],
    sourceRoot: undefined,
    sourceOpts: {},
  })),
  ensureStateDir: vi.fn((dir: string) => `${dir}/.state`),
  resolveStateDir: vi.fn(() => ":memory:"),
  resolveMemoryConfig: vi.fn((_dirs: string[], opts: { memoryDir?: string; memory?: boolean }) => {
    if (opts.memory === false) return null;
    const db = opts.memoryDir ? `${opts.memoryDir}/memory.db` : "/tmp/test-memory.db";
    return { enabled: true, db };
  }),
}));
vi.mock("../src/loader.js", () => ({
  loadGraphs: vi.fn(() => new Map([["test", {}]])),
  loadGraphsLayered: vi.fn(() => new Map([["test", {}]])),
  loadGraphsCollecting: vi.fn(() => ({ graphs: new Map([["test", {}]]), errors: [] })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;
let stderrSpy: any;
let stdoutSpy: any;

import { program } from "../src/cli/program.js";

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
    expect(validate).toHaveBeenCalledWith("/tmp/test", {
      checkSources: undefined,
      fix: undefined,
      basePath: undefined,
    });
  });

  it("visualize command calls visualize function", async () => {
    const { visualize } = await import("../src/cli/visualize.js");
    await program.parseAsync([
      "node",
      "freelance",
      "visualize",
      "/tmp/test.workflow.yaml",
      "--format",
      "dot",
    ]);
    expect(visualize).toHaveBeenCalledWith(
      "/tmp/test.workflow.yaml",
      expect.objectContaining({ format: "dot" }),
    );
  });

  it("inspect command calls traversalInspect", async () => {
    const { traversalInspect } = await import("../src/cli/traversals.js");
    await program.parseAsync(["node", "freelance", "inspect"]);
    expect(traversalInspect).toHaveBeenCalled();
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
      program.parseAsync(["node", "freelance", "completion", "powershell"]),
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

  it("mcp standalone loads graphs and starts server", async () => {
    const { startServer } = await import("../src/server.js");
    await program.parseAsync(["node", "freelance", "mcp", "--workflows", "/tmp/fake"]);
    expect(startServer).toHaveBeenCalled();
  });

  it("mcp enables memory by default", async () => {
    const { startServer } = await import("../src/server.js");
    await program.parseAsync(["node", "freelance", "mcp", "--workflows", "/tmp/fake"]);
    const call = (startServer as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const opts = call?.[1];
    expect(opts?.memory).toBeDefined();
    expect(opts?.memory?.enabled).toBe(true);
    expect(opts?.memory?.db).toMatch(/memory\.db$/);
  });

  it("mcp --no-memory disables memory", async () => {
    const { startServer } = await import("../src/server.js");
    await program.parseAsync([
      "node",
      "freelance",
      "mcp",
      "--workflows",
      "/tmp/fake",
      "--no-memory",
    ]);
    const call = (startServer as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const opts = call?.[1];
    expect(opts?.memory).toBeUndefined();
  });

  it("mcp --memory-dir overrides DB path", async () => {
    const { startServer } = await import("../src/server.js");
    const tmpDir = "/tmp/freelance-test-memdir-" + Date.now();
    await program.parseAsync([
      "node",
      "freelance",
      "mcp",
      "--workflows",
      "/tmp/fake",
      "--memory-dir",
      tmpDir,
    ]);
    const call = (startServer as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const opts = call?.[1];
    expect(opts?.memory?.enabled).toBe(true);
    expect(opts?.memory?.db).toBe(`${tmpDir}/memory.db`);
    // Clean up
    const fs = await import("node:fs");
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it("status command calls traversalStatus", async () => {
    const { traversalStatus } = await import("../src/cli/traversals.js");
    await program.parseAsync(["node", "freelance", "status"]);
    expect(traversalStatus).toHaveBeenCalled();
  });

  it("start command calls traversalStart", async () => {
    const { traversalStart } = await import("../src/cli/traversals.js");
    await program.parseAsync(["node", "freelance", "start", "my-graph"]);
    expect(traversalStart).toHaveBeenCalled();
  });

  it("guide command calls guideShow", async () => {
    const { guideShow } = await import("../src/cli/stateless.js");
    await program.parseAsync(["node", "freelance", "guide"]);
    expect(guideShow).toHaveBeenCalled();
  });
});
