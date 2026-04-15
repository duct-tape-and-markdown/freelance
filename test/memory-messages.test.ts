import { describe, expect, it } from "vitest";
import { compileMessages, recallMessages } from "../src/memory/messages.js";
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
        "Could either claim be true while the other is false?",
      );
    });

    it("contains the split-aggressively catalog", () => {
      expect(compilingInstructions).toContain("Split aggressively");
      expect(compilingInstructions).toContain('"X handles A, B, and C"');
    });

    it("contains the keep-together catalog with the relationship warning", () => {
      expect(compilingInstructions).toContain("Keep together when splitting destroys meaning");
      expect(compilingInstructions).toContain("validates X by checking Y");
      expect(compilingInstructions).toContain("KNOWLEDGE IN THEMSELVES");
    });

    it("contains the knowledge-types taxonomy with metacognitive explicitly named", () => {
      expect(compilingInstructions).toContain("Knowledge types");
      expect(compilingInstructions).toContain("metacognitive");
      expect(compilingInstructions).toContain("factual");
      expect(compilingInstructions).toContain("conceptual");
      expect(compilingInstructions).toContain("procedural");
    });

    it("preserves the original Biome WRONG/RIGHT example block", () => {
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

    it("contains the keep-together relationship warning", () => {
      expect(fillingInstructions).toContain("KNOWLEDGE IN THEMSELVES");
    });

    it("contains the knowledge-types taxonomy", () => {
      expect(fillingInstructions).toContain("metacognitive");
    });
  });
});

describe("Lens directive prose port (Batch 2)", () => {
  // Lens directive lives alongside the rubric in the staging node after
  // Batch 3+5's split — entity planning happens in addressing, but the
  // lens decides what gets staged in the first place.
  const compilingInstructions = compileMessages.nodes.staging.instructions;

  it("contains the lens directive section header", () => {
    expect(compilingInstructions).toContain("Lens directive");
  });

  it("references context.lens and the empty-default rule", () => {
    expect(compilingInstructions).toContain("context.lens");
    expect(compilingInstructions).toContain("default to dev");
  });

  it("lists all three lenses with their distinguishing rules", () => {
    expect(compilingInstructions).toContain(
      "dev: extract implementation detail, code names, internal structure",
    );
    expect(compilingInstructions).toContain(
      "support: extract ONLY user-facing behavior and business rules",
    );
    expect(compilingInstructions).toContain(
      "qa: extract testable behaviors, validation rules, edge cases",
    );
  });

  it("forbids code names and file paths under the support lens", () => {
    expect(compilingInstructions).toContain("NO code names, file paths, or internal details");
  });
});

describe("buildCompileKnowledgeWorkflow context default (Batch 2)", () => {
  it("declares lens as an empty-string default in the start context", () => {
    const graph = buildCompileKnowledgeWorkflow();
    // GraphDefinition.context is the start-node default context map
    // produced by GraphBuilder.setContext.
    expect(graph.definition.context).toHaveProperty("lens", "");
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

  it("passes context.filesReadPaths and context.collection through hook args", () => {
    const onEnter = exploring.onEnter ?? [];
    const hook = onEnter.find((h) => h.call === "memory_by_source");
    expect(hook?.args).toMatchObject({
      paths: "context.filesReadPaths",
      collection: "context.collection",
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
    expect(exploringInstructions).toContain("coverageSatisfied = true");
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

    it("explicitly forbids calling memory_emit in this node", () => {
      expect(stagingInstructions).toContain("NOT yet calling memory_emit");
    });

    it("inherits the rubric and the lens directive", () => {
      expect(stagingInstructions).toContain("independence test");
      expect(stagingInstructions).toContain("Lens directive");
    });
  });

  describe("addressing instruction prose", () => {
    it("teaches the 3+ propositions per entity floor", () => {
      expect(addressingInstructions).toContain("3+ propositions");
    });

    it("teaches the staged-claims-divided-by-3 ceiling", () => {
      expect(addressingInstructions).toContain("divided by 3");
    });

    it("includes GOOD vs BAD entity examples", () => {
      expect(addressingInstructions).toContain("GOOD entities");
      expect(addressingInstructions).toContain("BAD entities");
    });

    it("references the onEnter-populated context.entities vocabulary", () => {
      expect(addressingInstructions).toContain("context.entities");
    });

    it("instructs a single batched memory_emit call", () => {
      expect(addressingInstructions).toContain("memory_emit ONCE");
    });
  });
});
