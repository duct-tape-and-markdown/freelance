/**
 * Sealed compile-knowledge workflow.
 *
 * Built programmatically, injected into the graphs map when memory is enabled.
 * Not user-editable. Agent-facing prose lives in messages.ts.
 */

import { GraphBuilder } from "../builder.js";
import type { ValidatedGraph } from "../types.js";
import { compileMessages as M } from "./messages.js";

export const COMPILE_KNOWLEDGE_ID = "memory:compile";

export function buildCompileKnowledgeWorkflow(): ValidatedGraph {
  return new GraphBuilder(COMPILE_KNOWLEDGE_ID, "Compile Knowledge")
    .setDescription(M.description)
    .setContext({
      collection: "",
      query: "",
      filesReadPaths: [],
      propositionsEmitted: 0,
      coverageSatisfied: false,
      manifest: [],
      manifestTotal: 0,
      priorPropositionCount: 0,
      priorEntityCount: 0,
    })
    .node("check-memory", {
      type: "programmatic",
      description: M.nodes.checkMemory.description,
      operation: {
        name: "memory_status",
        args: {
          collection: "context.collection",
        },
      },
      contextUpdates: {
        priorPropositionCount: "total_propositions",
        priorEntityCount: "total_entities",
      },
      edges: [
        {
          target: "build-manifest",
          label: M.edges.memoryChecked.label,
          description: M.edges.memoryChecked.description,
        },
      ],
    })
    .node("build-manifest", {
      type: "programmatic",
      description: M.nodes.buildManifest.description,
      operation: {
        name: "memory_browse",
        args: {
          collection: "context.collection",
          limit: 50,
        },
      },
      contextUpdates: {
        manifest: "entities",
        manifestTotal: "total",
      },
      edges: [
        {
          target: "exploring",
          label: M.edges.manifestReady.label,
          description: M.edges.manifestReady.description,
        },
      ],
    })
    .node("exploring", {
      type: "action",
      description: M.nodes.exploring.description,
      instructions: M.nodes.exploring.instructions,
      edges: [
        {
          target: "compiling",
          label: M.edges.filesRead.label,
          condition: "len(context.filesReadPaths) > 0",
          description: M.edges.filesRead.description,
        },
      ],
    })
    .node("compiling", {
      type: "action",
      description: M.nodes.compiling.description,
      instructions: M.nodes.compiling.instructions,
      suggestedTools: ["memory_emit"],
      edges: [
        {
          target: "evaluating",
          label: M.edges.propositionsEmitted.label,
          description: M.edges.propositionsEmitted.description,
        },
      ],
    })
    .node("evaluating", {
      type: "decision",
      description: M.nodes.evaluating.description,
      instructions: M.nodes.evaluating.instructions,
      edges: [
        {
          target: "complete",
          label: M.edges.coverageSatisfied.label,
          condition: "context.coverageSatisfied == true",
          description: M.edges.coverageSatisfied.description,
        },
        {
          target: "exploring",
          label: M.edges.gapsRemain.label,
          condition: "context.coverageSatisfied == false",
          description: M.edges.gapsRemain.description,
        },
      ],
    })
    .node("complete", {
      type: "terminal",
      description: M.nodes.complete.description,
    })
    .build();
}
