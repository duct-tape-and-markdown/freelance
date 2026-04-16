import { describe, expect, it } from "vitest";
import { compileMessages, recallMessages } from "../src/memory/messages.js";
import { buildRecollectionWorkflow } from "../src/memory/recollection.js";
import { buildCompileKnowledgeWorkflow } from "../src/memory/workflow.js";

// Snapshot-style assertions on the agent-facing prose. The rubric is shared
// across both sealed memory workflows; if a substring drifts out of the
// compiling/filling instructions we lose teaching value silently. These
// tests fail loudly on regressions in the prose rather than the topology.

describe("PROPOSITION_RUBRIC prose port (Batch 1)", () => {
  // After Batch 3+5 the compile workflow's rubric prose lives in the
  // `staging` node, not `compiling` (which no longer exists). The recall
  // workflow's `filling` node is unchanged.
  const compilingInstructions = compileMessages.nodes.staging.instructions;
  const fillingInstructions = recallMessages.nodes.filling.instructions;

  describe("compileMessages.nodes.staging.instructions", () => {
    it("contains the independence test backstop", () => {
      expect(compilingInstructions).toContain("independence test");
      expect(compilingInstructions).toContain(
        "Could either half be true while the other is false?",
      );
    });

    it("warns against atomizing relationship claims", () => {
      // The "A depends on B" edge IS the knowledge — splitting it into
      // per-entity facts destroys graph connectivity. This intent must
      // survive in the rubric prose (exact phrasing is flexible).
      expect(compilingInstructions).toMatch(/relationship/i);
      expect(compilingInstructions).toMatch(/connectivity|atomiz/i);
    });

    it("names the four knowledge types including metacognitive", () => {
      expect(compilingInstructions).toContain("metacognitive");
      expect(compilingInstructions).toContain("factual");
      expect(compilingInstructions).toContain("conceptual");
      expect(compilingInstructions).toContain("procedural");
    });

    it("preserves the Biome WRONG/RIGHT example block", () => {
      expect(compilingInstructions).toContain(
        "WRONG (four independent facts mashed into one prop)",
      );
      expect(compilingInstructions).toContain("RIGHT (four atomic props, one fact each)");
    });
  });

  describe("recallMessages.nodes.filling.instructions", () => {
    // Same rubric is interpolated into the filling node, so the prose
    // port lands in both workflows atomically.
    it("contains the independence test backstop", () => {
      expect(fillingInstructions).toContain("independence test");
    });

    it("warns against atomizing relationship claims", () => {
      expect(fillingInstructions).toMatch(/relationship/i);
    });

    it("contains the knowledge-types taxonomy", () => {
      expect(fillingInstructions).toContain("metacognitive");
    });
  });
});

describe("Lens directive removed (Ablation 1 finding)", () => {
  // Ablation 1 showed the lens directive produced no measurable delta
  // between lens-ON (compile:alpha) and lens-OFF (compile:beta) variants
  // on the runner-lib fixture. The directive was dropped from the sealed
  // memory:compile workflow as a prose-strip win. Tests below guard the
  // removal — if anything reintroduces lens prose or the lens context
  // field, these fail loudly.
  const compilingInstructions = compileMessages.nodes.staging.instructions;

  it("no longer mentions a lens directive section", () => {
    expect(compilingInstructions).not.toMatch(/lens directive/i);
  });

  it("no longer references context.lens", () => {
    expect(compilingInstructions).not.toContain("context.lens");
  });

  it("still guides extraction via query framing", () => {
    expect(compilingInstructions).toMatch(/query/i);
  });
});

describe("buildCompileKnowledgeWorkflow context default (lens removed)", () => {
  it("no longer declares a lens field in the start context", () => {
    const graph = buildCompileKnowledgeWorkflow();
    // Ablation 1 removed the lens directive; the field was dropped
    // from the initial context alongside the prose.
    expect(graph.definition.context).not.toHaveProperty("lens");
  });
});

describe("Issue #53 finish — manual prose dropped, onEnter populated (Batch 6)", () => {
  describe("compile workflow exploring node", () => {
    const graph = buildCompileKnowledgeWorkflow();
    const exploring = graph.definition.nodes.exploring;
    const exploringInstructions = compileMessages.nodes.exploring.instructions;

    it("attaches all three onEnter hooks (status, browse, by_source)", () => {
      const calls = (exploring.onEnter ?? []).map((h) => h.call);
      expect(calls).toEqual(["memory_status", "memory_browse", "memory_by_source"]);
    });

    it("resolves all three exploring onEnter hooks into hookResolutions", () => {
      const resolutions = graph.hookResolutions?.get("exploring") ?? [];
      const names = resolutions
        .filter((r): r is { kind: "builtin"; call: string; name: string } => r.kind === "builtin")
        .map((r) => r.name);
      expect(names).toContain("memory_status");
      expect(names).toContain("memory_browse");
      expect(names).toContain("memory_by_source");
    });

    it("instruction tells the agent it arrives with status/browse/by_source already populated", () => {
      expect(exploringInstructions).toContain("What you arrive with");
      expect(exploringInstructions).toContain("memory_status");
      expect(exploringInstructions).toContain("memory_browse");
      expect(exploringInstructions).toContain("memory_by_source");
    });

    it("does NOT instruct the agent to manually call memory_status or memory_browse", () => {
      expect(exploringInstructions).not.toMatch(/first call memory_status/i);
      expect(exploringInstructions).not.toMatch(/use memory_browse to see what/i);
    });
  });

  describe("recall workflow recalling node", () => {
    const graph = buildRecollectionWorkflow();
    const recalling = graph.definition.nodes.recalling;
    const recallingInstructions = recallMessages.nodes.recalling.instructions;

    it("attaches memory_status + memory_browse onEnter to recalling", () => {
      const calls = (recalling.onEnter ?? []).map((h) => h.call);
      expect(calls).toEqual(["memory_status", "memory_browse"]);
    });

    it("resolves recalling onEnter hooks into hookResolutions", () => {
      const resolutions = graph.hookResolutions?.get("recalling") ?? [];
      const names = resolutions
        .filter((r): r is { kind: "builtin"; call: string; name: string } => r.kind === "builtin")
        .map((r) => r.name);
      expect(names).toEqual(["memory_status", "memory_browse"]);
    });

    it("recalling node still lists memory_inspect and memory_related as suggestedTools", () => {
      // These remain agent-driven because they need a specific entity arg.
      expect(recalling.suggestedTools).toContain("memory_inspect");
      expect(recalling.suggestedTools).toContain("memory_related");
    });

    it("recalling does NOT list memory_browse as suggestedTools anymore", () => {
      // Browse moved to onEnter — listing it as suggested would tell the
      // agent to call something it already has.
      expect(recalling.suggestedTools ?? []).not.toContain("memory_browse");
    });

    it("instruction reads from hook-populated context, not manual calls", () => {
      expect(recallingInstructions).toContain("What you arrive with");
      expect(recallingInstructions).toContain("context.entities");
      expect(recallingInstructions).not.toMatch(/^Use memory_browse and memory_inspect/m);
    });

    it("still tells the agent to drive memory_inspect for depth", () => {
      // memory_inspect needs an entity arg the agent must pick from
      // context.entities — it can't be auto-fetched.
      expect(recallingInstructions).toContain("memory_inspect");
    });
  });
});

describe("Exploring onEnter — graph-aware reads (Batch 4)", () => {
  const graph = buildCompileKnowledgeWorkflow();
  const exploring = graph.definition.nodes.exploring;
  const exploringInstructions = compileMessages.nodes.exploring.instructions;

  it("attaches a memory_by_source onEnter hook to exploring", () => {
    const onEnter = exploring.onEnter ?? [];
    expect(onEnter.some((h) => h.call === "memory_by_source")).toBe(true);
  });

  it("passes context.filesReadPaths through hook args", () => {
    const onEnter = exploring.onEnter ?? [];
    const hook = onEnter.find((h) => h.call === "memory_by_source");
    expect(hook?.args).toMatchObject({
      paths: "context.filesReadPaths",
    });
  });

  it("resolves the exploring onEnter hook into hookResolutions", () => {
    const resolutions = graph.hookResolutions?.get("exploring");
    expect(resolutions).toBeDefined();
    expect(resolutions?.some((r) => r.kind === "builtin" && r.name === "memory_by_source")).toBe(
      true,
    );
  });

  it("declares priorKnowledgeByPath defaults in start context", () => {
    expect(graph.definition.context).toHaveProperty("priorKnowledgeByPath");
    expect(graph.definition.context).toHaveProperty("priorKnowledgePathsConsidered", 0);
    expect(graph.definition.context).toHaveProperty("priorKnowledgePathsTruncated", false);
  });

  it("instructs the agent to stage only deltas", () => {
    expect(exploringInstructions).toContain("priorKnowledgeByPath");
    expect(exploringInstructions).toContain("Stage only DELTAS");
  });

  it("documents the warm-exit signal", () => {
    expect(exploringInstructions).toContain("warm-exit");
    expect(exploringInstructions).toContain("coverageSatisfied: true");
  });

  it("warns when the 50-path cap was hit", () => {
    expect(exploringInstructions).toContain("priorKnowledgePathsTruncated");
  });
});

describe("Stage-and-address split (Batch 3+5)", () => {
  const graph = buildCompileKnowledgeWorkflow();
  const nodes = graph.definition.nodes;
  const stagingInstructions = compileMessages.nodes.staging.instructions;
  const addressingInstructions = compileMessages.nodes.addressing.instructions;

  describe("topology", () => {
    it("removes the old `compiling` node", () => {
      expect(nodes).not.toHaveProperty("compiling");
    });

    it("introduces `staging` and `addressing` nodes", () => {
      expect(nodes).toHaveProperty("staging");
      expect(nodes).toHaveProperty("addressing");
    });

    it("wires exploring → staging → addressing → evaluating", () => {
      const exploring = nodes.exploring;
      expect(exploring.edges?.some((e) => e.target === "staging")).toBe(true);

      const staging = nodes.staging;
      expect(staging.edges?.some((e) => e.target === "addressing")).toBe(true);

      const addressing = nodes.addressing;
      expect(addressing.edges?.some((e) => e.target === "evaluating")).toBe(true);
    });

    it("declares stagedClaims and entities as start-context defaults", () => {
      expect(graph.definition.context).toHaveProperty("stagedClaims");
      expect(graph.definition.context).toHaveProperty("entities");
    });
  });

  describe("addressing onEnter (memory_browse)", () => {
    it("attaches a memory_browse onEnter hook to addressing", () => {
      const addressing = nodes.addressing;
      const onEnter = addressing.onEnter ?? [];
      expect(onEnter.length).toBeGreaterThan(0);
      expect(onEnter.some((h) => h.call === "memory_browse")).toBe(true);
    });

    it("resolves the addressing onEnter hook into hookResolutions", () => {
      const resolutions = graph.hookResolutions?.get("addressing");
      expect(resolutions).toBeDefined();
      expect(resolutions?.length).toBeGreaterThan(0);
      expect(resolutions?.[0]).toMatchObject({ kind: "builtin", name: "memory_browse" });
    });
  });

  describe("staging instruction prose", () => {
    it("references context.stagedClaims and the per-claim schema", () => {
      expect(stagingInstructions).toContain("context.stagedClaims");
      expect(stagingInstructions).toContain("draftEntities");
    });

    it("inherits the rubric", () => {
      expect(stagingInstructions).toContain("independence test");
    });
  });

  describe("addressing instruction prose", () => {
    // The old prose encoded mechanical rules ("3+ floor", "count/3 ceiling",
    // "GOOD vs BAD"). We've removed those — those are enforcement concerns,
    // not agent-reading ones. Tests now assert the intent that should survive.

    it("references the onEnter-populated context.entities vocabulary", () => {
      expect(addressingInstructions).toContain("context.entities");
    });

    it("tells the agent to reuse existing entity names", () => {
      expect(addressingInstructions).toMatch(/reuse existing/i);
    });

    it("frames entities as search hubs rather than field/setting names", () => {
      expect(addressingInstructions).toMatch(/hub/i);
      expect(addressingInstructions).toMatch(/setting|field|config/i);
    });

    it("instructs calling memory_emit and clearing stagedClaims", () => {
      expect(addressingInstructions).toContain("memory_emit");
      expect(addressingInstructions).toMatch(/clear.*stagedClaims/i);
    });
  });
});
