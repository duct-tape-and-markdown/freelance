/**
 * Sealed compile-knowledge workflow.
 *
 * Built programmatically, injected into the graphs map when memory is enabled.
 * Not user-editable.
 */

import { GraphBuilder } from "../builder.js";
import type { ValidatedGraph } from "../types.js";

export const COMPILE_KNOWLEDGE_ID = "compile-knowledge";

export function buildCompileKnowledgeWorkflow(): ValidatedGraph {
  return new GraphBuilder(COMPILE_KNOWLEDGE_ID, "Compile Knowledge")
    .setDescription(
      "Read source files, reason about them, and emit propositions to Memory. " +
      "Use this workflow to build persistent knowledge about the codebase."
    )
    .setContext({
      query: "",
      filesRead: 0,
      propositionsEmitted: 0,
      coverageSatisfied: false,
    })
    .node("exploring", {
      type: "action",
      description: "Read source files relevant to the query.",
      instructions:
        "Read files related to the compilation query using your native Read tool. " +
        "The PreToolUse hook will call memory_register_source automatically (Claude Code), " +
        "or call memory_register_source explicitly for each file you read. " +
        "Update context.filesRead with the number of files read so far.",
      suggestedTools: ["memory_register_source"],
      edges: [
        {
          target: "compiling",
          label: "files-read",
          condition: "context.filesRead > 0",
          description: "At least one source file has been read and registered.",
        },
      ],
    })
    .node("compiling", {
      type: "action",
      description: "Emit propositions about what you learned from the source files.",
      instructions:
        "Reason about what you read. Write self-contained propositions in natural prose, " +
        "each about 1-2 entities. Use memory_emit to write them to Memory. " +
        "Update context.propositionsEmitted with the total emitted this session.",
      suggestedTools: ["memory_emit"],
      edges: [
        {
          target: "evaluating",
          label: "propositions-emitted",
          description: "Propositions have been written to memory.",
        },
      ],
    })
    .node("evaluating", {
      type: "decision",
      description: "Check coverage — are there areas not yet compiled?",
      instructions:
        "Review what you've compiled so far against the original query. " +
        "Are there source files you haven't read yet that are relevant? " +
        "Are there entities or behaviors you noticed but haven't emitted propositions about? " +
        "Set context.coverageSatisfied to true if coverage is adequate.",
      edges: [
        {
          target: "complete",
          label: "coverage-satisfied",
          condition: "context.coverageSatisfied == true",
          description: "All relevant source material has been compiled.",
        },
        {
          target: "exploring",
          label: "gaps-remain",
          condition: "context.coverageSatisfied == false",
          description: "More source files need to be read.",
        },
      ],
    })
    .node("complete", {
      type: "terminal",
      description: "Compilation session complete.",
    })
    .build();
}
