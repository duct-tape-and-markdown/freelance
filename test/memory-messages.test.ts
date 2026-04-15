import { describe, expect, it } from "vitest";
import { compileMessages, recallMessages } from "../src/memory/messages.js";
import { buildCompileKnowledgeWorkflow } from "../src/memory/workflow.js";

// Snapshot-style assertions on the agent-facing prose. The rubric is shared
// across both sealed memory workflows; if a substring drifts out of the
// compiling/filling instructions we lose teaching value silently. These
// tests fail loudly on regressions in the prose rather than the topology.

describe("PROPOSITION_RUBRIC prose port (Batch 1)", () => {
  const compilingInstructions = compileMessages.nodes.compiling.instructions;
  const fillingInstructions = recallMessages.nodes.filling.instructions;

  describe("compileMessages.nodes.compiling.instructions", () => {
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
  const compilingInstructions = compileMessages.nodes.compiling.instructions;

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
