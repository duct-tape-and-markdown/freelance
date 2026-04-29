import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContextCaps,
  DEFAULT_CONTEXT_CAPS,
  enforceContextCaps,
  resolveContextCaps,
} from "../src/engine/context.js";
import { HookRunner } from "../src/engine/hooks.js";
import { GraphEngine } from "../src/engine/index.js";
import { EngineError } from "../src/errors.js";
import { loadFixtureGraphs } from "./helpers.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]) {
  return loadFixtureGraphs(FIXTURES_DIR, "context-caps-test-", ...files);
}

function makeEngineWith(caps: ContextCaps, ...files: string[]): GraphEngine {
  return new GraphEngine(loadFixtures(...files), {
    hookRunner: new HookRunner({ contextCaps: caps }),
    contextCaps: caps,
  });
}

describe("DEFAULT_CONTEXT_CAPS", () => {
  it("defaults to 4 KB per value and 64 KB total", () => {
    expect(DEFAULT_CONTEXT_CAPS.maxValueBytes).toBe(4 * 1024);
    expect(DEFAULT_CONTEXT_CAPS.maxTotalBytes).toBe(64 * 1024);
  });
});

describe("resolveContextCaps", () => {
  it("falls back to defaults when partial is empty or omitted", () => {
    expect(resolveContextCaps()).toEqual(DEFAULT_CONTEXT_CAPS);
    expect(resolveContextCaps({})).toEqual(DEFAULT_CONTEXT_CAPS);
  });

  it("uses supplied values and keeps defaults for the rest", () => {
    expect(resolveContextCaps({ maxValueBytes: 100 })).toEqual({
      maxValueBytes: 100,
      maxTotalBytes: DEFAULT_CONTEXT_CAPS.maxTotalBytes,
    });
    expect(resolveContextCaps({ maxTotalBytes: 200 })).toEqual({
      maxValueBytes: DEFAULT_CONTEXT_CAPS.maxValueBytes,
      maxTotalBytes: 200,
    });
  });
});

describe("enforceContextCaps", () => {
  const tinyCaps: ContextCaps = { maxValueBytes: 50, maxTotalBytes: 200 };

  it("accepts small writes", () => {
    expect(() => enforceContextCaps({}, { a: "hi" }, tinyCaps)).not.toThrow();
  });

  it("rejects a single over-sized value", () => {
    const big = "x".repeat(100);
    try {
      enforceContextCaps({}, { a: big }, tinyCaps);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).code).toBe("CONTEXT_VALUE_TOO_LARGE");
      expect((e as EngineError).message).toContain('"a"');
      expect((e as EngineError).message).toContain("102 bytes");
      expect((e as EngineError).message).toContain("50 bytes");
    }
  });

  it("rejects when total context would exceed cap", () => {
    // Each value ≤ 50 bytes serialized, but four together blow 200 total.
    // Entry footprint in JSON: "key":"value" = quotes + colon = 5 extra chars
    // per entry; with 45-char strings → ~47 serialized each → 4 * ~52 ≈ 210.
    const current = { a: "x".repeat(45), b: "y".repeat(45), c: "z".repeat(45) };
    try {
      enforceContextCaps(current, { d: "q".repeat(45) }, tinyCaps);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).code).toBe("CONTEXT_TOTAL_TOO_LARGE");
      expect((e as EngineError).message).toContain("200 bytes");
    }
  });

  it("treats undefined values as no-ops", () => {
    expect(() => enforceContextCaps({}, { a: undefined }, tinyCaps)).not.toThrow();
  });

  it("checks per-value before total", () => {
    // single over-sized value should surface CONTEXT_VALUE_TOO_LARGE, not
    // CONTEXT_TOTAL_TOO_LARGE — the inner cap catches it first
    try {
      enforceContextCaps({}, { a: "x".repeat(500) }, tinyCaps);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as EngineError).code).toBe("CONTEXT_VALUE_TOO_LARGE");
    }
  });

  it("does not mutate current context when it throws", () => {
    const current: Record<string, unknown> = { a: "hi" };
    try {
      enforceContextCaps(current, { b: "x".repeat(100) }, tinyCaps);
    } catch {}
    expect(current).toEqual({ a: "hi" });
  });
});

describe("GraphEngine cap enforcement", () => {
  const tinyCaps: ContextCaps = { maxValueBytes: 50, maxTotalBytes: 200 };

  it("contextSet rejects over-sized value", async () => {
    const engine = makeEngineWith(tinyCaps, "valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    try {
      engine.contextSet({ taskStarted: "x".repeat(100) });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as EngineError).code).toBe("CONTEXT_VALUE_TOO_LARGE");
    }
  });

  it("contextSet leaves session untouched when rejected", async () => {
    const engine = makeEngineWith(tinyCaps, "valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    try {
      engine.contextSet({ taskStarted: "x".repeat(100) });
    } catch {}
    const snapshot = engine.inspect("position");
    expect(snapshot.context).toEqual({ taskStarted: false });
  });

  it("advance rejects over-sized contextUpdates", async () => {
    const engine = makeEngineWith(tinyCaps, "valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await expect(
      engine.advance("work-done", { taskStarted: "x".repeat(100) }),
    ).rejects.toMatchObject({ code: "CONTEXT_VALUE_TOO_LARGE" });
  });

  it("start rejects over-sized initialContext", async () => {
    const engine = makeEngineWith(tinyCaps, "valid-simple.workflow.yaml");
    await expect(
      engine.start("valid-simple", { taskStarted: "x".repeat(100) }),
    ).rejects.toMatchObject({ code: "CONTEXT_VALUE_TOO_LARGE" });
  });

  it("small writes pass through normally under tight caps", async () => {
    const engine = makeEngineWith(tinyCaps, "valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    const result = engine.contextSet({ taskStarted: true });
    expect(result.status).toBe("updated");
    expect(result.context).toEqual({ taskStarted: true });
  });

  it("defaults (no explicit caps) accept normal-sized writes", async () => {
    // Exercise the default-caps path via makeEngine — doesn't pass contextCaps
    const engine = new GraphEngine(loadFixtures("valid-simple.workflow.yaml"), {
      hookRunner: new HookRunner(),
    });
    await engine.start("valid-simple");
    // 1 KB string — well under default 4 KB per-value cap
    const result = engine.contextSet({ taskStarted: "x".repeat(1024) });
    expect(result.status).toBe("updated");
  });

  it("total cap rejects cumulative blowup even when each value is small", async () => {
    // per-value cap 50 bytes, total cap 200 bytes. Start a-aware: defaults
    // already contain taskStarted:false. Push four 40-byte values — the
    // projected total will exceed 200 bytes.
    const engine = makeEngineWith(tinyCaps, "valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    engine.contextSet({ a: "x".repeat(40) });
    engine.contextSet({ b: "y".repeat(40) });
    engine.contextSet({ c: "z".repeat(40) });
    try {
      engine.contextSet({ d: "q".repeat(40) });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as EngineError).code).toBe("CONTEXT_TOTAL_TOO_LARGE");
    }
  });
});

describe("HookRunner cap enforcement", () => {
  const tinyCaps: ContextCaps = { maxValueBytes: 50, maxTotalBytes: 200 };

  it("rejects a hook return value that exceeds per-value cap", async () => {
    const graphs = loadFixtures("hook-context-return.workflow.yaml");
    const bigString = "x".repeat(100);
    const runner = new HookRunner({
      contextCaps: tinyCaps,
      builtinHooks: { memory_status: async () => ({ blowup: bigString }) },
    });
    const engine = new GraphEngine(graphs, {
      hookRunner: runner,
      contextCaps: tinyCaps,
    });
    await expect(engine.start("hook-context-return")).rejects.toMatchObject({
      code: "CONTEXT_VALUE_TOO_LARGE",
    });
  });

  it("rejects when a hook's return pushes total context over cap", async () => {
    const graphs = loadFixtures("hook-context-return.workflow.yaml");
    // Each value fits per-value cap individually but cumulatively blows total.
    const runner = new HookRunner({
      contextCaps: tinyCaps,
      builtinHooks: {
        memory_status: async () => ({
          a: "x".repeat(40),
          b: "y".repeat(40),
          c: "z".repeat(40),
          d: "q".repeat(40),
        }),
      },
    });
    const engine = new GraphEngine(graphs, {
      hookRunner: runner,
      contextCaps: tinyCaps,
    });
    await expect(engine.start("hook-context-return")).rejects.toMatchObject({
      code: "CONTEXT_TOTAL_TOO_LARGE",
    });
  });

  it("accepts a hook return that fits the caps", async () => {
    const graphs = loadFixtures("hook-context-return.workflow.yaml");
    const runner = new HookRunner({
      contextCaps: tinyCaps,
      builtinHooks: { memory_status: async () => ({ ok: "small" }) },
    });
    const engine = new GraphEngine(graphs, {
      hookRunner: runner,
      contextCaps: tinyCaps,
    });
    const result = await engine.start("hook-context-return");
    expect(result.context).toMatchObject({ ok: "small", seeded: false });
  });
});
