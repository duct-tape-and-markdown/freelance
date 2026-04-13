/**
 * Sealed recollection workflow.
 *
 * Query-driven recall: pull what's known, read provenance sources,
 * compare against the query, and fill the delta with new propositions.
 * Built programmatically, injected alongside compile-knowledge when memory is enabled.
 * Agent-facing prose lives in messages.ts.
 */

import { GraphBuilder } from "../builder.js";
import type { ValidatedGraph } from "../types.js";
import { recallMessages as M } from "./messages.js";

export const RECOLLECTION_ID = "memory:recall";

export function buildRecollectionWorkflow(): ValidatedGraph {
  return new GraphBuilder(RECOLLECTION_ID, "Recollection")
    .setDescription(M.description)
    .setContext({
      collection: "",
      query: "",
      recalledEntities: 0,
      recalledPropositions: 0,
      sourcesRead: 0,
      sourcesReadPaths: [],
      gapsFilled: 0,
      coverageSatisfied: false,
    })
    .node("recalling", {
      type: "action",
      description: M.nodes.recalling.description,
      instructions: M.nodes.recalling.instructions,
      suggestedTools: ["memory_browse", "memory_inspect", "memory_related"],
      edges: [
        {
          target: "sourcing",
          label: M.edges.recalled.label,
          description: M.edges.recalled.description,
        },
      ],
    })
    .node("sourcing", {
      type: "action",
      description: M.nodes.sourcing.description,
      instructions: M.nodes.sourcing.instructions,
      edges: [
        {
          target: "comparing",
          label: M.edges.sourcesRead.label,
          condition: "context.sourcesRead > 0",
          description: M.edges.sourcesRead.description,
        },
      ],
    })
    .node("comparing", {
      type: "decision",
      description: M.nodes.comparing.description,
      instructions: M.nodes.comparing.instructions,
      edges: [
        {
          target: "complete",
          label: M.edges.fullyCovered.label,
          condition: "context.coverageSatisfied == true",
          description: M.edges.fullyCovered.description,
        },
        {
          target: "filling",
          label: M.edges.gapsIdentified.label,
          condition: "context.coverageSatisfied == false",
          description: M.edges.gapsIdentified.description,
        },
      ],
    })
    .node("filling", {
      type: "action",
      description: M.nodes.filling.description,
      instructions: M.nodes.filling.instructions,
      suggestedTools: ["memory_emit"],
      edges: [
        {
          target: "evaluating",
          label: M.edges.gapsFilled.label,
          description: M.edges.gapsFilled.description,
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
          target: "sourcing",
          label: M.edges.moreSourcesNeeded.label,
          condition: "context.coverageSatisfied == false",
          description: M.edges.moreSourcesNeeded.description,
        },
      ],
    })
    .node("complete", {
      type: "terminal",
      description: M.nodes.complete.description,
    })
    .build();
}
