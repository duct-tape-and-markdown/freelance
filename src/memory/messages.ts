/**
 * Agent-facing prose for the sealed memory workflows.
 *
 * Separated from workflow.ts / recollection.ts so that tweaking an
 * instruction is a single-file edit that never touches the structural
 * code (node topology, edge wiring, setContext defaults).
 */

export const compileMessages = {
  description:
    "Read source files, reason about them, and emit propositions to Memory. " +
    "Use this workflow to build persistent knowledge about the codebase.",

  nodes: {
    exploring: {
      description: "Read source files relevant to the query.",
      instructions:
        "Read files related to the compilation query using your native Read tool. " +
        "After each read, call freelance_context_set to append the file path to " +
        "context.filesReadPaths. The path list is your working set — when you emit " +
        "propositions in the next node, you'll cite sources from this list. memory_emit " +
        "hashes each cited source file at emit time for per-proposition provenance, so " +
        "there's no pre-registration step: read, track the path, emit when ready.",
    },
    compiling: {
      description: "Emit propositions about what you learned from the source files.",
      instructions:
        "Reason about what you read. Write self-contained propositions in natural prose, " +
        "each about 1-2 entities. Use memory_emit to write them to Memory, passing " +
        "context.collection as the collection parameter. For each proposition's sources " +
        "field, cite the file paths from context.filesReadPaths that the proposition was " +
        "actually derived from (memory_emit will hash them at emit time for per-proposition " +
        "provenance). Update context.propositionsEmitted with the total emitted so far.",
    },
    evaluating: {
      description: "Check coverage — are there areas not yet compiled?",
      instructions:
        "Review what you've compiled so far against the original query. " +
        "Are there source files you haven't read yet that are relevant? " +
        "Are there entities or behaviors you noticed but haven't emitted propositions about? " +
        "Set context.coverageSatisfied to true if coverage is adequate.",
    },
    complete: {
      description: "Compilation complete.",
    },
  },

  edges: {
    filesRead: {
      label: "files-read",
      description: "At least one source file has been read.",
    },
    propositionsEmitted: {
      label: "propositions-emitted",
      description: "Propositions have been written to memory.",
    },
    coverageSatisfied: {
      label: "coverage-satisfied",
      description: "All relevant source material has been compiled.",
    },
    gapsRemain: {
      label: "gaps-remain",
      description: "More source files need to be read.",
    },
  },
} as const;

export const recallMessages = {
  description:
    "Query-driven knowledge recall. Searches existing memory, reads provenance sources, " +
    "identifies gaps between what's known and what the sources say about the query, " +
    "and emits new propositions to fill the delta.",

  nodes: {
    recalling: {
      description: "Search memory for existing knowledge related to the query.",
      instructions:
        "Use memory_browse and memory_inspect to find entities and propositions " +
        "related to the query, passing context.collection as the collection parameter. " +
        "Catalog what's already known — these are the propositions " +
        "from prior compilations. Note the source files listed in each entity's " +
        "inspect response (source_files) — you'll read those next. " +
        "Update context.recalledEntities and context.recalledPropositions with counts.",
    },
    sourcing: {
      description: "Read source files guided by provenance from recalled propositions.",
      instructions:
        "Read the source files identified during recall (from source_files on each entity's inspect response). " +
        "If recall found no prior knowledge, read sources relevant to the query on your own. " +
        "Focus on understanding what the sources say about the query subject matter — " +
        "not on indexing the files themselves. After each read, call freelance_context_set " +
        "to append the file path to context.sourcesReadPaths. The path list is your " +
        "working set — when you fill gaps in the next nodes, cite sources from this list " +
        "(memory_emit hashes them at emit time).",
    },
    comparing: {
      description: "Compare existing knowledge against what sources say about the query.",
      instructions:
        "This is the core step. Think of a venn diagram: " +
        "left circle is what existing propositions already capture about the query, " +
        "right circle is what the source files say about the query. " +
        "Your job is to identify the right-side crescent — facts the sources reveal " +
        "about the query that aren't covered by existing propositions. " +
        "If existing knowledge fully covers the query, set context.coverageSatisfied = true. " +
        "If there are gaps, leave it false and proceed to fill them.",
    },
    filling: {
      description: "Emit new propositions to cover the delta.",
      instructions:
        "Emit propositions for the gaps identified in the comparison step, passing " +
        "context.collection as the collection parameter to memory_emit. " +
        "Each proposition should be a self-contained claim about 1-2 entities, " +
        "capturing knowledge the sources reveal about the query that wasn't " +
        "previously compiled. For each proposition's sources field, cite the file paths " +
        "from context.sourcesReadPaths that the proposition was actually derived from " +
        "(memory_emit hashes them at emit time for per-proposition provenance). " +
        "Don't re-emit what's already known — focus on the delta. " +
        "Update context.gapsFilled with the number of new propositions emitted.",
    },
    evaluating: {
      description: "Evaluate whether the query is now adequately covered.",
      instructions:
        "Review the full picture: recalled propositions plus newly emitted ones. " +
        "Does this body of knowledge adequately answer the query? " +
        "Are there source files you haven't read yet that are relevant? " +
        "If coverage is adequate, set context.coverageSatisfied = true. " +
        "If more sources need to be read, leave it false.",
    },
    complete: {
      description: "Recollection complete.",
    },
  },

  edges: {
    recalled: {
      label: "recalled",
      description: "Existing knowledge cataloged, proceed to read sources.",
    },
    sourcesRead: {
      label: "sources-read",
      description: "Sources read, ready to compare against existing knowledge.",
    },
    fullyCovered: {
      label: "fully-covered",
      description: "Existing knowledge already covers the query.",
    },
    gapsIdentified: {
      label: "gaps-identified",
      description: "Delta identified between known propositions and source content.",
    },
    gapsFilled: {
      label: "gaps-filled",
      description: "New propositions emitted, evaluate coverage.",
    },
    coverageSatisfied: {
      label: "coverage-satisfied",
      description: "Query is fully covered by existing and new propositions.",
    },
    moreSourcesNeeded: {
      label: "more-sources-needed",
      description: "Additional sources needed to cover the query.",
    },
  },
} as const;
