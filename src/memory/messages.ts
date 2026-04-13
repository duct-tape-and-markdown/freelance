/**
 * Agent-facing prose for the sealed memory workflows.
 *
 * Separated from workflow.ts / recollection.ts so that tweaking an
 * instruction is a single-file edit that never touches the structural
 * code (node topology, edge wiring, setContext defaults).
 */

/**
 * The rubric the agent reads when it's about to emit propositions.
 * Shared by memory:compile (compiling node) and memory:recall (filling
 * node) because the atomicity rule is identical across both workflows
 * and the rubric is the product definition of a well-formed proposition.
 *
 * Changes here affect both sealed workflows atomically — by design.
 */
const PROPOSITION_RUBRIC =
  "Emit ATOMIC propositions: ONE factual claim per proposition, one sentence strongly preferred, two sentences maximum. " +
  "If your thought uses 'and', 'also', 'plus', lists multiple facts, or tries to explain both WHAT and WHY in the same breath, SPLIT it into separate propositions. " +
  "Each prop should survive independently: if a single sub-claim changes later, only that one prop should have to go stale.\n\n" +
  "The `entities` array names the things the claim is genuinely about. One entity for 'X does Y' claims; two or more for relationship claims like 'A depends on B', 'A was replaced by B via C', 'A uses B in the presence of C'. " +
  "Multi-entity propositions are valuable — they make the knowledge graph denser and enable relationship queries via memory_related. " +
  "Name every entity the claim is actually about, up to 4. Never pack extra entities to justify a compound prop — split the compound instead.\n\n" +
  "WRONG (four independent facts mashed into one prop):\n" +
  '  "Biome was added as the linter with space/2 indent, simple-git-hooks runs it as a pre-commit gate, the format pass touched 72 files, and noNonNullAssertion is disabled because its auto-fix broke type narrowing."\n\n' +
  "RIGHT (four atomic props, one fact each):\n" +
  '  1. "Biome v2 is the format and lint tool, configured with space/2 indent and line width 100." — entities: ["Biome", "biome.json"]\n' +
  '  2. "simple-git-hooks runs `biome check` as a pre-commit gate." — entities: ["simple-git-hooks", "Biome"]\n' +
  '  3. "The initial Biome format pass touched 72 files with zero semantic changes." — entities: ["Biome"]\n' +
  '  4. "Biome\'s noNonNullAssertion rule is disabled because its auto-fix converted `!` to `?.` and broke TypeScript narrowing." — entities: ["noNonNullAssertion", "Biome"]';

export const compileMessages = {
  description:
    "Read source files, reason about them, and emit propositions to Memory. " +
    "Use this workflow to build persistent knowledge about the codebase.",

  nodes: {
    buildManifest: {
      description:
        "Pre-populate context.manifest with the top entities already in the target " +
        "collection. Runs server-side before any agent turn — no LLM budget is spent " +
        "here. The manifest primes the exploring node so the agent can reuse existing " +
        "entity names instead of accidentally creating parallel hubs for the same concept.",
    },
    exploring: {
      description: "Read source files relevant to the query.",
      instructions:
        "Before reading files: inspect context.manifest, a list of the top entities " +
        "already in this collection (populated automatically before you arrived at this " +
        "node). If it's non-empty, these are the hubs you should reuse by name when you " +
        "emit new propositions — don't invent parallel entities for concepts that already " +
        "exist. If it's empty, the collection is fresh and you're compiling from scratch.\n\n" +
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
        `${PROPOSITION_RUBRIC}\n\n` +
        "Cite sources from context.filesReadPaths — only the files each prop was actually derived from. " +
        "Call memory_emit with context.collection as the collection parameter. " +
        "Update context.propositionsEmitted with the running total.",
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
    manifestReady: {
      label: "manifest-ready",
      description: "Entity manifest fetched from the target collection; proceeding to exploration.",
    },
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
        `${PROPOSITION_RUBRIC}\n\n` +
        "This is a gap-filling step: emit only NEW propositions — facts the sources reveal about the query that the recalled set doesn't already cover. Don't re-emit what's already known.\n\n" +
        "Cite sources from context.sourcesReadPaths — only the files each prop was actually derived from. " +
        "Call memory_emit with context.collection as the collection parameter. " +
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
