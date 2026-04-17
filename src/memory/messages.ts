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
// The rubric is the only prose that demonstrably shapes agent behavior
// (ablation 4 confirmed entity guidance moves the needle; ablation 7a/7b
// showed knowledge-types and independence-test sub-parts are noise or
// inverse). Kept minimal: one directive + one semantic check + its
// relationship exception. The relationship exception is structural —
// without it, agents atomize "A depends on B" into per-entity fragments,
// destroying edges the graph needs.
const PROPOSITION_RUBRIC =
  "Emit atomic propositions — one factual claim each. " +
  'Apply the independence test: for each candidate claim, ask "could either half be true while the other is false?" If yes, split.\n\n' +
  "Exception: relationship claims like 'A depends on B' or 'A was replaced by B via C' — the edge IS the knowledge. Atomizing them into per-entity facts destroys graph connectivity.";

export const compileMessages = {
  description:
    "Read source files, reason about them, and emit propositions to Memory. " +
    "Use this workflow to build persistent knowledge about the codebase.",

  nodes: {
    exploring: {
      description: "Read source files relevant to the query.",
      instructions:
        "## What you arrive with\n" +
        "Three onEnter hooks have already populated this node's context for you, so you don't burn turns on routine lookups:\n" +
        "- context.total_propositions / valid_propositions / stale_propositions / total_entities (from memory_status) — the rough size of the existing knowledge.\n" +
        "- context.entities (from memory_browse, up to 50) — the existing entity vocabulary. Skim these names; they are what the compiling node will steer toward when it plans hubs.\n" +
        "- context.priorKnowledgeByPath (from memory_by_source) — propositions already known per file in context.filesReadPaths (each entry is { id, content } — no hashes, no timestamps; content is what you need to judge overlap). See the graph-aware reading section below.\n\n" +
        "## Warm start — if you already know which files you want to compile\n" +
        "Pass them as `initialContext.filesReadPaths` when calling freelance_start. The onEnter hooks fire AFTER initialContext is applied, so priorKnowledgeByPath is populated on your very first arrival — no wasted lap. Without initialContext, filesReadPaths starts empty and the first arrival's priorKnowledgeByPath is `{}`; hooks only re-fire on node arrival, so setting filesReadPaths via freelance_context_set does NOT re-query memory_by_source until you loop back through compiling/evaluating and land on exploring a second time.\n\n" +
        "## What this node does\n" +
        "Read files related to the compilation query using your native Read tool. " +
        "After each read, call freelance_context_set to append the file path to " +
        "context.filesReadPaths. The path list is your working set — when you emit " +
        "propositions in the next node, you'll cite sources from this list. memory_emit " +
        "hashes each cited source file at emit time for per-proposition provenance, so " +
        "there's no pre-registration step: read, track the path, emit when ready.\n\n" +
        "## Graph-aware reading — emit only deltas\n" +
        "Every time you arrive at this node, an onEnter hook calls memory_by_source for " +
        "every path currently in context.filesReadPaths and writes the result to " +
        "context.priorKnowledgeByPath as { <path>: [{id, content}, ...] }. Read this BEFORE " +
        "deciding what to emit:\n" +
        "- If a file's prior-knowledge list already covers the claim you were about to emit, " +
        "skip it. Re-emitting hashes to the same content_hash and is a no-op, but it wastes " +
        "agent turns.\n" +
        "- Emit only DELTAS: claims the file actually says that the existing propositions " +
        "do not already capture.\n\n" +
        "## Warm exit — zero-delta shortcut\n" +
        "If every file in priorKnowledgeByPath is already comprehensively covered (nothing to emit), take the `warm-exit` edge directly from here to `evaluating` — pass `{ coverageSatisfied: true }` in the same freelance_advance call. This skips compiling/memory_emit entirely. It's the right path when a prior compile run already covered the same files and the sources haven't drifted since. A one-step warm exit costs one tool call instead of the 2–3 it takes to loop through the normal compiling path.\n\n" +
        "If context.priorKnowledgePathsTruncated is true, the path list exceeded the 50-path " +
        "cap and not every file was checked — fall back to manual judgment for the unchecked tail.",
    },
    compiling: {
      description: "Extract claims, plan entities, emit propositions.",
      instructions:
        `${PROPOSITION_RUBRIC}\n\n` +
        "## What this node does\n" +
        "For each file you read in the exploring node, extract atomic claims and emit them via memory_emit in a single step. For each claim, decide:\n" +
        "1. The claim content (per the rubric above).\n" +
        "2. Which source files it was derived from (cite only files in context.filesReadPaths).\n" +
        "3. Which entity names to link it to.\n\n" +
        "## How to think about entities\n" +
        "context.entities shows the existing entity vocabulary (populated by an onEnter memory_browse). " +
        "Reuse existing entity names verbatim — same-name reuse is the single highest-leverage move you can make for graph density.\n\n" +
        "Good entities are **search hubs** — concepts someone would look up when trying to learn about this area. Bad entities are setting-names or field-names, which belong inside claim content, not as entities. If an entity name reads like a config key, it's content, not a hub.\n\n" +
        "A hub that only shows up on one claim in the batch is usually a fragment masquerading as a hub — roll it into a broader concept that recurs across claims.\n\n" +
        "Let the query shape what kind of claims you extract. Call memory_emit with all your claims when ready, then advance.",
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
      description: "Propositions have been written to memory with planned entities.",
    },
    coverageSatisfied: {
      label: "coverage-satisfied",
      description: "All relevant source material has been compiled.",
    },
    gapsRemain: {
      label: "gaps-remain",
      description: "More source files need to be read.",
    },
    warmExit: {
      label: "warm-exit",
      description:
        "priorKnowledgeByPath already covers every file, nothing to stage — skip directly to evaluating.",
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
      description: "Plan deeper inspection from the auto-populated vocabulary.",
      instructions:
        "## What you arrive with\n" +
        "Two onEnter hooks have already populated this node's context — you don't need to call memory_status or memory_browse manually:\n" +
        "- context.total_propositions / valid_propositions / stale_propositions / total_entities (from memory_status) — the rough size of what's known.\n" +
        "- context.entities (from memory_browse, up to 50) — the existing entity vocabulary.\n\n" +
        "## What this node does\n" +
        "Skim context.entities against the query. For the 1–5 entities most likely to carry relevant knowledge, call memory_inspect (and memory_related when you want neighbor context) to pull their full proposition lists and source files. " +
        "These targeted inspect calls are the agent's job — there's no good way to pre-fetch them automatically because we don't know which entities matter until we read context.entities.\n\n" +
        "Catalog what's already known from those inspects — the propositions and the source_files lists. " +
        "Update context.recalledEntities (the count you actually inspected) and context.recalledPropositions (sum across the inspects).\n\n" +
        "## Warm exit — memory already covers the query\n" +
        "If the recalled propositions comprehensively answer the query — no gaps, no need to re-read sources to find new facts — take the `warm-exit` edge directly to `evaluating`. Pass `{ coverageSatisfied: true }` in the same freelance_advance call. This skips sourcing/comparing/filling entirely; the evaluating node will confirm and route to complete. Use this when the existing memory is sufficient.\n\n" +
        "Otherwise, take the `recalled` edge — the sourcing node will read the source_files from your inspects to check for gaps.",
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
    warmExit: {
      label: "warm-exit",
      description:
        "Recalled propositions already cover the query — skip sourcing/comparing/filling, route straight to evaluating.",
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
