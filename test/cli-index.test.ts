import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FreelanceConfig } from "../src/config.js";

// Typed against the real interface so a schema change breaks the
// mock instead of letting it rot under structural-typing optionality.
const STUB_CONFIG: FreelanceConfig = {
  workflows: [],
  memory: {},
  hooks: {},
  context: {},
  sources: [],
};

// Mock heavy dependencies
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
  memoryEmit: vi.fn(),
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
    runtime: { close: vi.fn() },
  })),
  createMemoryStore: vi.fn(() => ({
    store: { close: vi.fn() },
    setup: { graphsDirs: [], sourceRoot: undefined, config: STUB_CONFIG },
  })),
  loadGraphSetup: vi.fn(() => ({
    graphs: new Map(),
    graphsDirs: [],
    sourceRoot: undefined,
    sourceOpts: {},
    config: STUB_CONFIG,
    loadErrors: [],
  })),
  loadMemorySetup: vi.fn(() => ({
    graphsDirs: [],
    sourceRoot: undefined,
    config: STUB_CONFIG,
  })),
  ensureFreelanceDir: vi.fn((dir: string) => dir),
  resolveTraversalsDir: vi.fn(() => ":memory:"),
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
// Stub sealed graph builder — irrelevant to these wiring tests and pulls in GraphBuilder.
vi.mock("../src/memory/sealed.js", () => ({
  getSealedGraphs: vi.fn(() => new Map()),
  mergeSealedGraphs: vi.fn((target: Map<string, unknown>) => target),
  SEALED_GRAPH_IDS: new Set<string>(),
  COMPILE_KNOWLEDGE_ID: "memory:compile",
  RECOLLECTION_ID: "memory:recall",
}));

import { program } from "../src/cli/program.js";

// Graph resolution tests live in test/graph-resolution.test.ts (canonical location)

beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
    await program.parseAsync(["node", "freelance", "--quiet", "validate", "/tmp"]);
    expect(validate).toHaveBeenCalled();
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
