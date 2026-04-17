import { describe, expect, it } from "vitest";
import { compileMessages, recallMessages } from "../src/memory/messages.js";
import { buildRecollectionWorkflow } from "../src/memory/recollection.js";
import { buildCompileKnowledgeWorkflow } from "../src/memory/workflow.js";

// Snapshot-style assertions on the agent-facing prose. The rubric is shared
// across both sealed memory workflows; if a substring drifts out of the
// compiling/filling instructions we lose teaching value silently. These
// tests fail loudly on regressions in the prose rather than the topology.

describe("PROPOSITION_RUBRIC — minimal load-bearing prose", () => {
  // The rubric was stripped to only the prose that ablations proved
  // effective OR that is structurally necessary. Kept:
  //   - Atomicity directive (opener)
  //   - Independence test (semantic check)
  //   - Relationship exception (prevents edge destruction)
  // Cut:
  //   - Knowledge types taxonomy (ablation 7a: no effect)
  //   - Content vs graph structure (retracted — based on flawed premise)
  //   - WRONG/RIGHT conjunctions (marginal, entity reuse taught by entity guidance)
  //   - WRONG/RIGHT enumerations (retracted alongside content-vs-graph)
  const compilingInstructions = compileMessages.nodes.compiling.instructions;
  const fillingInstructions = recallMessages.nodes.filling.instructions;

  describe("compileMessages.nodes.compiling.instructions", () => {
    it("contains the independence test backstop", () => {
      expect(compilingInstructions).toContain("independence test");
      expect(compilingInstructions).toContain(
        "could either half be true while the other is false?",
      );
    });

    it("warns against atomizing relationship claims", () => {
      // The "A depends on B" edge IS the knowledge. Without this
      // exception an agent following the independence test would
      // destroy relationship edges — this is structural, not stylistic.
      expect(compilingInstructions).toMatch(/relationship/i);
      expect(compilingInstructions).toMatch(/connectivity|destroys/i);
    });
  });

  describe("recallMessages.nodes.filling.instructions", () => {
    // Same rubric is interpolated into the filling node.
    it("contains the independence test backstop", () => {
      expect(fillingInstructions).toContain("independence test");
    });

    it("warns against atomizing relationship claims", () => {
      expect(fillingInstructions).toMatch(/relationship/i);
    });
  });
});

describe("Rubric strips (retracted prose)", () => {
  // These sections were added then retracted based on evidence or
  // flawed premises. Tests below guard the removal — if anything
  // reintroduces them, these fail loudly.
  const compilingInstructions = compileMessages.nodes.compiling.instructions;
  const fillingInstructions = recallMessages.nodes.filling.instructions;

  it("no longer teaches the knowledge types taxonomy (ablation 7a: no effect)", () => {
    expect(compilingInstructions).not.toContain("metacognitive");
    expect(fillingInstructions).not.toContain("metacognitive");
  });

  it("no longer includes the Content vs graph structure section (retracted)", () => {
    // The principle was wrong — enumerations can name authoritative
    // sets, which is content, not redundancy with graph edges.
    expect(compilingInstructions).not.toContain("Content vs graph structure");
    expect(fillingInstructions).not.toContain("Content vs graph structure");
  });

  it("no longer includes WRONG/RIGHT example blocks", () => {
    // Marginal effect per ablation 5; any entity-reuse teaching is
    // carried by the dedicated entity guidance in the compiling node.
    expect(compilingInstructions).not.toContain("WRONG vs RIGHT");
    expect(compilingInstructions).not.toContain("WRONG (four independent facts");
    expect(compilingInstructions).not.toContain("WRONG vs RIGHT — enumerations");
  });
});

describe("Lens directive removed (Ablation 1 finding)", () => {
  // Ablation 1 showed the lens directive produced no measurable delta
  // between lens-ON (compile:alpha) and lens-OFF (compile:beta) variants
  // on the runner-lib fixture. The directive was dropped from the sealed
  // memory:compile workflow as a prose-strip win. Tests below guard the
  // removal — if anything reintroduces lens prose or the lens context
  // field, these fail loudly.
  const compilingInstructions = compileMessages.nodes.compiling.instructions;

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

describe("onEnter hooks populated, manual prose dropped (Batch 6 + Ablation 3)", () => {
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

    it("recalling node offers a warm-exit edge to evaluating (Ablation 6 finding)", () => {
      // Without this, a query fully covered by memory still forces the
      // agent through sourcing/comparing/filling — wasted work.
      const warmExit = recalling.edges?.find((e) => e.target === "evaluating");
      expect(warmExit).toBeDefined();
      expect(warmExit?.label).toBe("warm-exit");
      expect(warmExit?.condition).toBe("context.coverageSatisfied == true");
    });

    it("recalling instruction documents the warm-exit path", () => {
      expect(recallingInstructions).toContain("warm-exit");
      expect(recallingInstructions).toContain("coverageSatisfied");
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

  it("instructs the agent to emit only deltas", () => {
    expect(exploringInstructions).toContain("priorKnowledgeByPath");
    expect(exploringInstructions).toContain("Emit only DELTAS");
  });

  it("documents the warm-exit signal", () => {
    expect(exploringInstructions).toContain("warm-exit");
    expect(exploringInstructions).toContain("coverageSatisfied: true");
  });

  it("warns when the 50-path cap was hit", () => {
    expect(exploringInstructions).toContain("priorKnowledgePathsTruncated");
  });
});

describe("Merged compiling node (Ablation 3 finding)", () => {
  // Ablation 3 proved two-phase staging+addressing costs +25% tokens and
  // +40% wall time without producing better knowledge. Merged into a single
  // `compiling` node: exploring → compiling → evaluating.
  const graph = buildCompileKnowledgeWorkflow();
  const nodes = graph.definition.nodes;
  const compilingInstructions = compileMessages.nodes.compiling.instructions;

  describe("topology", () => {
    it("has no staging or addressing nodes", () => {
      expect(nodes).not.toHaveProperty("staging");
      expect(nodes).not.toHaveProperty("addressing");
    });

    it("has a compiling node", () => {
      expect(nodes).toHaveProperty("compiling");
    });

    it("wires exploring → compiling → evaluating", () => {
      expect(nodes.exploring.edges?.some((e) => e.target === "compiling")).toBe(true);
      expect(nodes.compiling.edges?.some((e) => e.target === "evaluating")).toBe(true);
    });

    it("does not declare stagedClaims in start context", () => {
      expect(graph.definition.context).not.toHaveProperty("stagedClaims");
    });

    it("declares entities as start-context default", () => {
      expect(graph.definition.context).toHaveProperty("entities");
    });
  });

  describe("compiling onEnter (memory_browse)", () => {
    it("attaches a memory_browse onEnter hook to compiling", () => {
      const compiling = nodes.compiling;
      const onEnter = compiling.onEnter ?? [];
      expect(onEnter.length).toBeGreaterThan(0);
      expect(onEnter.some((h) => h.call === "memory_browse")).toBe(true);
    });

    it("resolves the compiling onEnter hook into hookResolutions", () => {
      const resolutions = graph.hookResolutions?.get("compiling");
      expect(resolutions).toBeDefined();
      expect(resolutions?.length).toBeGreaterThan(0);
      expect(resolutions?.[0]).toMatchObject({ kind: "builtin", name: "memory_browse" });
    });
  });

  describe("compiling instruction prose", () => {
    it("inherits the rubric", () => {
      expect(compilingInstructions).toContain("independence test");
    });

    it("references context.entities vocabulary", () => {
      expect(compilingInstructions).toContain("context.entities");
    });

    it("tells the agent to reuse existing entity names", () => {
      expect(compilingInstructions).toMatch(/reuse existing/i);
    });

    it("frames entities as search hubs rather than field/setting names", () => {
      expect(compilingInstructions).toMatch(/hub/i);
      expect(compilingInstructions).toMatch(/setting|field|config/i);
    });

    it("instructs calling memory_emit", () => {
      expect(compilingInstructions).toContain("memory_emit");
    });
  });
});
