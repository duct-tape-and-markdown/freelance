import { describe, expect, it } from "vitest";
import { compileMessages, recallMessages } from "../src/memory/messages.js";

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
