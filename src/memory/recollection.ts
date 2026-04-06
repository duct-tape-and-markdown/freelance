/**
 * Sealed recollection workflow.
 *
 * Query-driven recall: pull what's known, read provenance sources,
 * compare against the query, and fill the delta with new propositions.
 * Built programmatically, injected alongside compile-knowledge when memory is enabled.
 */

import { GraphBuilder } from "../builder.js";
import type { ValidatedGraph } from "../types.js";

export const RECOLLECTION_ID = "memory:recall";

export function buildRecollectionWorkflow(): ValidatedGraph {
  return new GraphBuilder(RECOLLECTION_ID, "Recollection")
    .setDescription(
      "Query-driven knowledge recall. Searches existing memory, reads provenance sources, " +
      "identifies gaps between what's known and what the sources say about the query, " +
      "and emits new propositions to fill the delta."
    )
    .setContext({
      query: "",
      recalledEntities: 0,
      recalledPropositions: 0,
      sourcesRead: 0,
      gapsFilled: 0,
      coverageSatisfied: false,
    })
    .node("recalling", {
      type: "action",
      description: "Search memory for existing knowledge related to the query.",
      instructions:
        "Use memory_browse and memory_inspect to find entities and propositions " +
        "related to the query. Catalog what's already known — these are the propositions " +
        "from prior compilation sessions. Note the source files listed in provenance " +
        "(source_sessions) — you'll read those next. " +
        "Update context.recalledEntities and context.recalledPropositions with counts.",
      suggestedTools: ["memory_browse", "memory_inspect"],
      edges: [
        {
          target: "sourcing",
          label: "recalled",
          description: "Existing knowledge cataloged, proceed to read sources.",
        },
      ],
    })
    .node("sourcing", {
      type: "action",
      description: "Read source files guided by provenance from recalled propositions.",
      instructions:
        "Read the source files identified during recall (from provenance in source_sessions). " +
        "If recall found no prior knowledge, read sources relevant to the query on your own. " +
        "Focus on understanding what the sources say about the query subject matter — " +
        "not on indexing the files themselves. " +
        "Update context.sourcesRead with the number of files read.",
      suggestedTools: ["memory_register_source"],
      edges: [
        {
          target: "comparing",
          label: "sources-read",
          condition: "context.sourcesRead > 0",
          description: "Sources read, ready to compare against existing knowledge.",
        },
      ],
    })
    .node("comparing", {
      type: "decision",
      description: "Compare existing knowledge against what sources say about the query.",
      instructions:
        "This is the core step. Think of a venn diagram: " +
        "left circle is what existing propositions already capture about the query, " +
        "right circle is what the source files say about the query. " +
        "Your job is to identify the right-side crescent — facts the sources reveal " +
        "about the query that aren't covered by existing propositions. " +
        "If existing knowledge fully covers the query, set context.coverageSatisfied = true. " +
        "If there are gaps, leave it false and proceed to fill them.",
      edges: [
        {
          target: "complete",
          label: "fully-covered",
          condition: "context.coverageSatisfied == true",
          description: "Existing knowledge already covers the query.",
        },
        {
          target: "filling",
          label: "gaps-identified",
          condition: "context.coverageSatisfied == false",
          description: "Delta identified between known propositions and source content.",
        },
      ],
    })
    .node("filling", {
      type: "action",
      description: "Emit new propositions to cover the delta.",
      instructions:
        "Emit propositions for the gaps identified in the comparison step. " +
        "Each proposition should be a self-contained claim about 1-2 entities, " +
        "capturing knowledge the sources reveal about the query that wasn't " +
        "previously compiled. Don't re-emit what's already known — focus on the delta. " +
        "Update context.gapsFilled with the number of new propositions emitted.",
      suggestedTools: ["memory_emit"],
      edges: [
        {
          target: "evaluating",
          label: "gaps-filled",
          description: "New propositions emitted, evaluate coverage.",
        },
      ],
    })
    .node("evaluating", {
      type: "decision",
      description: "Evaluate whether the query is now adequately covered.",
      instructions:
        "Review the full picture: recalled propositions plus newly emitted ones. " +
        "Does this body of knowledge adequately answer the query? " +
        "Are there source files you haven't read yet that are relevant? " +
        "If coverage is adequate, set context.coverageSatisfied = true. " +
        "If more sources need to be read, leave it false.",
      edges: [
        {
          target: "complete",
          label: "coverage-satisfied",
          condition: "context.coverageSatisfied == true",
          description: "Query is fully covered by existing and new propositions.",
        },
        {
          target: "sourcing",
          label: "more-sources-needed",
          condition: "context.coverageSatisfied == false",
          description: "Additional sources needed to cover the query.",
        },
      ],
    })
    .node("complete", {
      type: "terminal",
      description: "Recollection complete.",
    })
    .build();
}
