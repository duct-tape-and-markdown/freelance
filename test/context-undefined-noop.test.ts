/**
 * #301 — undefined = no-op everywhere.
 *
 * A `{ key: undefined }` write is uniformly a no-op: it never lands in
 * context, never records a contextHistory entry, never appears in
 * contextDelta or the clone/inspect echo, and wait/return still see the
 * key as unset. One strip seam (omitUndefined in context.ts) backs all
 * six surfaces.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_HOOKS, type BuiltinHookOverrides } from "../src/engine/builtin-hooks.js";
import { HookRunner } from "../src/engine/hooks.js";
import { GraphEngine } from "../src/engine/index.js";
import type {
  AdvanceSuccessMinimalResult,
  ContextSetMinimalResult,
  ContextSetResult,
  InspectHistoryResult,
  InspectPositionResult,
} from "../src/types.js";
import { loadFixtureGraphs } from "./helpers.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]) {
  return loadFixtureGraphs(FIXTURES_DIR, "ctx-undef-test-", ...files);
}

function makeRunner(overrides: BuiltinHookOverrides = {}): HookRunner {
  return new HookRunner({ builtinHooks: { ...BUILTIN_HOOKS, ...overrides } });
}

describe("#301 — undefined context writes are a no-op (contextSet)", () => {
  it("does not materialize an undefined key in context or contextHistory", async () => {
    const engine = new GraphEngine(loadFixtures("valid-simple.workflow.yaml"), {
      hookRunner: makeRunner(),
    });
    await engine.start("valid-simple");

    const result = engine.contextSet({ real: "value", ghost: undefined }) as ContextSetResult;

    expect(result.context).toHaveProperty("real", "value");
    expect(result.context).not.toHaveProperty("ghost");
    expect("ghost" in result.context).toBe(false);

    // contextHistory must not carry a ghost write — surfaces via inspect history.
    const history = engine.inspect("history") as InspectHistoryResult;
    expect(history.contextHistory.some((e) => e.key === "ghost")).toBe(false);
    expect(history.contextHistory.some((e) => e.key === "real")).toBe(true);
  });

  it("excludes the undefined key from the minimal contextDelta", async () => {
    const engine = new GraphEngine(loadFixtures("valid-simple.workflow.yaml"), {
      hookRunner: makeRunner(),
    });
    await engine.start("valid-simple");

    const result = engine.contextSet(
      { real: "value", ghost: undefined },
      { responseMode: "minimal" },
    ) as ContextSetMinimalResult;

    expect(result.contextDelta).toContain("real");
    expect(result.contextDelta).not.toContain("ghost");
  });

  it("inspect echo never surfaces the undefined key", async () => {
    const engine = new GraphEngine(loadFixtures("valid-simple.workflow.yaml"), {
      hookRunner: makeRunner(),
    });
    await engine.start("valid-simple");
    engine.contextSet({ ghost: undefined });

    const pos = engine.inspect("position") as InspectPositionResult;
    expect(pos.context).not.toHaveProperty("ghost");
  });
});

describe("#301 — undefined context writes are a no-op (hook return)", () => {
  it("an onEnter hook returning { key: undefined } writes nothing", async () => {
    // memory_status is stubbed to return an undefined-valued key plus a
    // real key. The real key lands; the undefined one is dropped.
    const engine = new GraphEngine(loadFixtures("hook-context-return.workflow.yaml"), {
      hookRunner: makeRunner({
        memory_status: async () => ({ written: 1, ghost: undefined }),
      }),
    });
    const start = await engine.start("hook-context-return");

    expect(start.context).toHaveProperty("written", 1);
    expect(start.context).not.toHaveProperty("ghost");

    // contextDelta on a minimal advance reads off contextHistory; the
    // ghost key never entered it. Advance to terminal to confirm no
    // ghost leaks via the delta path either.
    const adv = (await engine.advance("next", undefined, {
      responseMode: "minimal",
    })) as AdvanceSuccessMinimalResult;
    expect(adv.contextDelta).not.toContain("ghost");
  });
});
