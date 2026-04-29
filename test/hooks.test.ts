import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_HOOKS, type BuiltinHookOverrides } from "../src/engine/builtin-hooks.js";
import type { HookFn } from "../src/engine/hooks.js";
import { HookRunner, resolveHookArgs } from "../src/engine/hooks.js";
import { GraphEngine } from "../src/engine/index.js";
import { EngineError } from "../src/errors.js";
import type { HookResolutionMap } from "../src/hook-resolution.js";
import { resolveGraphHooks, validateHookImports } from "../src/hook-resolution.js";
import { loadGraphs, loadSingleGraph } from "../src/loader.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

// Copy a fixture graph — plus any scripts it references — into a temp
// directory so relative path resolution has something real to stat.
function stageFixture(
  graphFile: string,
  scripts: string[] = [],
): { graphs: Map<string, ValidatedGraph>; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
  fs.copyFileSync(path.join(FIXTURES_DIR, graphFile), path.join(tmpDir, graphFile));
  if (scripts.length > 0) {
    fs.mkdirSync(path.join(tmpDir, "scripts"));
    for (const s of scripts) {
      fs.copyFileSync(path.join(FIXTURES_DIR, "scripts", s), path.join(tmpDir, "scripts", s));
    }
  }
  return { graphs: loadGraphs(tmpDir), tmpDir };
}

function makeRunner(overrides: BuiltinHookOverrides = {}, hookTimeoutMs?: number): HookRunner {
  // Memory store is optional; fixtures in this file only exercise
  // user-script hooks or hand-stubbed built-ins, so we leave it off.
  return new HookRunner({ builtinHooks: { ...BUILTIN_HOOKS, ...overrides }, hookTimeoutMs });
}

describe("resolveHookArgs", () => {
  it("resolves context paths and passes literals through", () => {
    const ctx = { collection: "notes", count: 12, nested: { a: "x" } };
    const out = resolveHookArgs(
      {
        collection: "context.collection",
        fixed: 100,
        flag: true,
        deep: "context.nested.a",
        literalString: "hello",
      },
      ctx,
    );
    expect(out).toEqual({
      collection: "notes",
      fixed: 100,
      flag: true,
      deep: "x",
      literalString: "hello",
    });
  });

  it("missing context paths resolve to null", () => {
    const out = resolveHookArgs({ missing: "context.nope" }, {});
    expect(out).toEqual({ missing: null });
  });
});

describe("hook resolution — loader", () => {
  it("resolves built-in names and local scripts", () => {
    const { graphs } = stageFixture("hook-simple.workflow.yaml", ["set-count.js"]);
    const vg = graphs.get("hook-simple")!;
    expect(vg.hookResolutions).toBeDefined();
    const startHooks = vg.hookResolutions?.get("start");
    expect(startHooks).toHaveLength(1);
    expect(startHooks?.[0].kind).toBe("script");
    if (startHooks?.[0].kind === "script") {
      expect(startHooks[0].absolutePath).toMatch(/scripts[\\/]set-count\.js$/);
    }
  });

  it("rejects unknown built-in names", () => {
    const def = {
      id: "bad",
      version: "1.0.0",
      name: "bad",
      description: "",
      startNode: "start",
      nodes: {
        start: {
          type: "action" as const,
          description: "",
          onEnter: [{ call: "not_a_real_builtin" }],
          edges: [{ target: "done", label: "next" }],
        },
        done: { type: "terminal" as const, description: "" },
      },
    };
    expect(() => resolveGraphHooks(def, "/tmp/bad.workflow.yaml")).toThrow(
      /unknown built-in hook "not_a_real_builtin"/,
    );
  });

  it("rejects missing local scripts", () => {
    const def = {
      id: "bad",
      version: "1.0.0",
      name: "bad",
      description: "",
      startNode: "start",
      nodes: {
        start: {
          type: "action" as const,
          description: "",
          onEnter: [{ call: "./scripts/nope.js" }],
          edges: [{ target: "done", label: "next" }],
        },
        done: { type: "terminal" as const, description: "" },
      },
    };
    expect(() => resolveGraphHooks(def, "/tmp/bad.workflow.yaml")).toThrow(/not found/);
  });

  it("rejects absolute paths", () => {
    const def = {
      id: "bad",
      version: "1.0.0",
      name: "bad",
      description: "",
      startNode: "start",
      nodes: {
        start: {
          type: "action" as const,
          description: "",
          onEnter: [{ call: "/etc/passwd" }],
          edges: [{ target: "done", label: "next" }],
        },
        done: { type: "terminal" as const, description: "" },
      },
    };
    expect(() => resolveGraphHooks(def, "/tmp/bad.workflow.yaml")).toThrow(/must be relative/);
  });

  describe("FREELANCE_HOOKS_ALLOW_SCRIPTS opt-in hardening", () => {
    // Env var is read on every resolution call — not cached — so we can
    // flip it per-test without restart. Restore after each case so later
    // suites that rely on the default (allowed) don't see stale state.
    const originalEnv = process.env.FREELANCE_HOOKS_ALLOW_SCRIPTS;
    afterEach(() => {
      if (originalEnv === undefined) delete process.env.FREELANCE_HOOKS_ALLOW_SCRIPTS;
      else process.env.FREELANCE_HOOKS_ALLOW_SCRIPTS = originalEnv;
    });

    it("rejects script hooks when set to 0", () => {
      process.env.FREELANCE_HOOKS_ALLOW_SCRIPTS = "0";
      expect(() => stageFixture("hook-simple.workflow.yaml", ["set-count.js"])).toThrow(
        /FREELANCE_HOOKS_ALLOW_SCRIPTS is disabled/,
      );
    });

    it.each(["false", "no", "FALSE", "No"])("rejects script hooks when set to %s", (value) => {
      process.env.FREELANCE_HOOKS_ALLOW_SCRIPTS = value;
      expect(() => stageFixture("hook-simple.workflow.yaml", ["set-count.js"])).toThrow(
        /FREELANCE_HOOKS_ALLOW_SCRIPTS is disabled/,
      );
    });

    it("still resolves built-in hooks when scripts are disabled", () => {
      process.env.FREELANCE_HOOKS_ALLOW_SCRIPTS = "0";
      const def = {
        id: "ok",
        version: "1.0.0",
        name: "ok",
        description: "",
        startNode: "start",
        nodes: {
          start: {
            type: "action" as const,
            description: "",
            onEnter: [{ call: "memory_status" }],
            edges: [{ target: "done", label: "next" }],
          },
          done: { type: "terminal" as const, description: "" },
        },
      };
      expect(() => resolveGraphHooks(def, "/tmp/ok.workflow.yaml")).not.toThrow();
    });

    it.each(["1", "true", "yes", "", undefined])("allows scripts when env is %s", (value) => {
      if (value === undefined) delete process.env.FREELANCE_HOOKS_ALLOW_SCRIPTS;
      else process.env.FREELANCE_HOOKS_ALLOW_SCRIPTS = value;
      expect(() => stageFixture("hook-simple.workflow.yaml", ["set-count.js"])).not.toThrow();
    });
  });
});

describe("hook runner — end-to-end via engine", () => {
  it("start() fires onEnter on the start node", async () => {
    const { graphs } = stageFixture("hook-simple.workflow.yaml", ["set-count.js"]);
    const engine = new GraphEngine(graphs, { hookRunner: makeRunner() });
    const result = await engine.start("hook-simple");
    expect(result.currentNode).toBe("start");
    expect(result.context.count).toBe(42);
    expect(result.context.echoed).toBe(7); // resolved from context.seed (default 7)
  });

  it("advance() fires onEnter on the target node, not the source", async () => {
    const { graphs } = stageFixture("hook-on-advance.workflow.yaml", ["set-count.js"]);
    const engine = new GraphEngine(graphs, { hookRunner: makeRunner() });
    const start = await engine.start("hook-on-advance");
    // Hook was defined on `middle`, not `start` — start's context should be unchanged
    expect(start.context.count).toBe(0);

    const advanced = await engine.advance("next");
    if (advanced.isError) throw new Error("advance failed");
    expect(advanced.currentNode).toBe("middle");
    expect(advanced.context.count).toBe(99);
    expect(advanced.context.echoed).toBe(11);
  });

  it("engine with an empty runner (no memory) still fires local-script hooks", async () => {
    // A bare `new HookRunner()` has no memory store. User-script hooks
    // that don't touch ctx.memory still fire normally — built-in
    // memory hooks would throw loudly if reached.
    const { graphs } = stageFixture("hook-simple.workflow.yaml", ["set-count.js"]);
    const engine = new GraphEngine(graphs, { hookRunner: new HookRunner() });
    const result = await engine.start("hook-simple");
    expect(result.context.count).toBe(42);
  });

  it("timeout fires when hook never resolves", async () => {
    const { graphs } = stageFixture("hook-slow.workflow.yaml", ["slow.js"]);
    const engine = new GraphEngine(graphs, { hookRunner: makeRunner({}, 50) });
    await expect(engine.start("hook-slow")).rejects.toThrow(/exceeded 50ms timeout/);
  });

  it("repeat hook invocations don't re-import the script", async () => {
    // Node's import() cache makes repeat imports of the same absolute
    // path free — this test is a canary that running the same hook
    // twice works, without us layering our own cache on top.
    const { graphs } = stageFixture("hook-simple.workflow.yaml", ["set-count.js"]);
    const engine = new GraphEngine(graphs, { hookRunner: makeRunner() });
    const r1 = await engine.start("hook-simple");
    expect(r1.context.count).toBe(42);
    engine.reset();

    const r2 = await engine.start("hook-simple");
    expect(r2.context.count).toBe(42);
  });

  it("built-in name is callable when overridden in the runner", async () => {
    // Use a fixture that references a built-in name directly, with the
    // built-in replaced by a test stub so we don't need a real memory
    // store. This exercises the "bare identifier" branch of the
    // resolver end-to-end.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
    const graphPath = path.join(tmpDir, "g.workflow.yaml");
    fs.writeFileSync(
      graphPath,
      [
        "id: builtin-ref",
        'version: "1.0.0"',
        "name: G",
        'description: ""',
        "startNode: start",
        "nodes:",
        "  start:",
        "    type: action",
        '    description: ""',
        "    onEnter:",
        "      - call: memory_status",
        "        args: { collection: 'notes' }",
        "    edges:",
        "      - target: done",
        "        label: next",
        "  done:",
        "    type: terminal",
        '    description: ""',
      ].join("\n"),
    );
    const { id, definition, graph, hookResolutions } = loadSingleGraph(graphPath);
    const graphs = new Map<string, ValidatedGraph>([[id, { definition, graph, hookResolutions }]]);
    const stubHook: HookFn = async (ctx) => ({ stubbedCollection: ctx.args.collection });
    const runner = makeRunner({ memory_status: stubHook });
    const engine = new GraphEngine(graphs, { hookRunner: runner });
    const result = await engine.start("builtin-ref");
    expect(result.context.stubbedCollection).toBe("notes");
  });

  it("built-in memory hook throws clearly when runner has no memoryStore", async () => {
    // Same YAML fixture as the earlier "bare identifier" test, but the
    // runner is constructed WITHOUT a memoryStore — simulating a host
    // (CLI --no-memory or MCP with memory disabled) that wires a hook
    // runner but no store. The built-in should fail at first use with
    // a pointer to the config switch.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
    const graphPath = path.join(tmpDir, "g.workflow.yaml");
    fs.writeFileSync(
      graphPath,
      [
        "id: builtin-no-store",
        'version: "1.0.0"',
        "name: G",
        'description: ""',
        "startNode: start",
        "nodes:",
        "  start:",
        "    type: action",
        '    description: ""',
        "    onEnter:",
        "      - call: memory_status",
        "    edges:",
        "      - target: done",
        "        label: next",
        "  done:",
        "    type: terminal",
        '    description: ""',
      ].join("\n"),
    );
    const { id, definition, graph, hookResolutions } = loadSingleGraph(graphPath);
    const graphs = new Map<string, ValidatedGraph>([[id, { definition, graph, hookResolutions }]]);
    // Default runner (no overrides) → uses real BUILTIN_HOOKS, no memoryStore.
    const runner = new HookRunner({});
    const engine = new GraphEngine(graphs, { hookRunner: runner });
    try {
      await engine.start("builtin-no-store");
      expect.fail("expected EngineError");
    } catch (e) {
      // HookRunner preserves EngineError codes thrown by built-ins
      // instead of wrapping as HOOK_FAILED — lets the skill branch
      // on the catalogued MEMORY_DISABLED recovery (point operator
      // at config.yml) rather than the generic script-hook-blew-up
      // fallback.
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).code).toBe("MEMORY_DISABLED");
      expect((e as EngineError).message).toMatch(/requires memory to be enabled/);
      // Hook attribution still attaches on the pass-through path.
      expect((e as EngineError).context?.hook).toEqual({
        name: "memory_status",
        nodeId: "start",
        index: 0,
      });
    }
  });

  it("throws a clear error when script returns non-object", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
    fs.mkdirSync(path.join(tmpDir, "scripts"));
    fs.writeFileSync(
      path.join(tmpDir, "scripts", "bad.js"),
      "export default async function () { return 42; }\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, "g.workflow.yaml"),
      [
        "id: bad-return",
        'version: "1.0.0"',
        "name: G",
        'description: ""',
        "startNode: start",
        "nodes:",
        "  start:",
        "    type: action",
        '    description: ""',
        "    onEnter:",
        "      - call: ./scripts/bad.js",
        "    edges:",
        "      - target: done",
        "        label: next",
        "  done:",
        "    type: terminal",
        '    description: ""',
      ].join("\n"),
    );
    const graphs = loadGraphs(tmpDir);
    const engine = new GraphEngine(graphs, { hookRunner: makeRunner() });
    await expect(engine.start("bad-return")).rejects.toThrow(/must return a plain object/);
  });
});

describe("validateHookImports — load-time eager check", () => {
  // resolveGraphHooks already stats the script path; the cases here
  // only materialize when the file exists but fails to import or
  // exports the wrong thing. Runtime's lazy check still covers the
  // same surface, but authors want the failure at validate time.

  function stageScript(contents: string): { resolutions: HookResolutionMap } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-validate-test-"));
    fs.mkdirSync(path.join(tmpDir, "scripts"));
    const abs = path.join(tmpDir, "scripts", "hook.js");
    fs.writeFileSync(abs, contents);
    const resolutions: HookResolutionMap = new Map([
      ["start", [{ kind: "script", call: "./scripts/hook.js", absolutePath: abs }]],
    ]);
    return { resolutions };
  }

  it("returns no errors for a valid default-exporting script", async () => {
    const { resolutions } = stageScript("export default async function () { return {}; }\n");
    const errors = await validateHookImports(resolutions);
    expect(errors).toEqual([]);
  });

  it("flags syntax errors as import failures", async () => {
    // Unterminated string — parse fails during import()
    const { resolutions } = stageScript('export default "\n');
    const errors = await validateHookImports(resolutions);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Failed to import hook script/);
    expect(errors[0].nodeId).toBe("start");
    expect(errors[0].index).toBe(0);
  });

  it("flags missing default export", async () => {
    const { resolutions } = stageScript("export const other = 1;\n");
    const errors = await validateHookImports(resolutions);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/must export a default function/);
  });

  it("flags non-function default exports", async () => {
    const { resolutions } = stageScript("export default 42;\n");
    const errors = await validateHookImports(resolutions);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/must export a default function \(got number\)/);
  });

  it("ignores built-in resolutions", async () => {
    const resolutions: HookResolutionMap = new Map([
      ["start", [{ kind: "builtin", call: "memory_status", name: "memory_status" }]],
    ]);
    const errors = await validateHookImports(resolutions);
    expect(errors).toEqual([]);
  });

  it("does NOT invoke the hook body (module-level side effects stay quiet)", async () => {
    // If we called fn(), this would throw. The check is import-only.
    const { resolutions } = stageScript(
      "export default async function () { throw new Error('SHOULD-NOT-RUN'); }\n",
    );
    const errors = await validateHookImports(resolutions);
    expect(errors).toEqual([]);
  });
});
