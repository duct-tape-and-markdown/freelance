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
  "Emit ATOMIC propositions — one factual claim each, a single sentence preferred.\n\n" +
  "## The independence test\n" +
  'For every candidate claim, ask: "Could either half be true while the other is false?" If yes, split. ' +
  "This is the semantic rule behind the surface 'no and/also/plus' heuristic — use it whenever you feel the urge to conjoin facts. " +
  "The exception is relationship claims like 'A depends on B' or 'A was replaced by B via C' — the edge IS the knowledge, and atomizing it into per-entity facts destroys the graph's connectivity.\n\n" +
  "## Knowledge types to notice\n" +
  "Claims can be factual ('X is configured to Y'), conceptual ('X exists because Y'), procedural ('to do X, run Y then Z'), or metacognitive ('this is uncertain because we couldn't reproduce X'). The metacognitive bucket is the one most extractors silently drop — emit it explicitly when you have it.\n\n" +
  "## WRONG vs RIGHT\n" +
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
    exploring: {
      description: "Read source files relevant to the query.",
      instructions:
        "## What you arrive with\n" +
        "Three onEnter hooks have already populated this node's context for you, so you don't burn turns on routine lookups:\n" +
        "- context.total_propositions / valid_propositions / stale_propositions / total_entities (from memory_status) — the rough size of the existing knowledge.\n" +
        "- context.entities (from memory_browse, up to 50) — the existing entity vocabulary. Skim these names; they are what the addressing node will steer toward when it plans hubs.\n" +
        "- context.priorKnowledgeByPath (from memory_by_source) — propositions already known per file in context.filesReadPaths (each entry is { id, content } — no hashes, no timestamps; content is what you need to judge overlap). See the graph-aware reading section below.\n\n" +
        "## Warm start — if you already know which files you want to compile\n" +
        "Pass them as `initialContext.filesReadPaths` when calling freelance_start. The onEnter hooks fire AFTER initialContext is applied, so priorKnowledgeByPath is populated on your very first arrival — no wasted lap. Without initialContext, filesReadPaths starts empty and the first arrival's priorKnowledgeByPath is `{}`; hooks only re-fire on node arrival, so setting filesReadPaths via freelance_context_set does NOT re-query memory_by_source until you loop back through staging/addressing/evaluating and land on exploring a second time.\n\n" +
        "## What this node does\n" +
        "Read files related to the compilation query using your native Read tool. " +
        "After each read, call freelance_context_set to append the file path to " +
        "context.filesReadPaths. The path list is your working set — when you emit " +
        "propositions in the next node, you'll cite sources from this list. memory_emit " +
        "hashes each cited source file at emit time for per-proposition provenance, so " +
        "there's no pre-registration step: read, track the path, emit when ready.\n\n" +
        "## Graph-aware reading — stage only deltas\n" +
        "Every time you arrive at this node, an onEnter hook calls memory_by_source for " +
        "every path currently in context.filesReadPaths and writes the result to " +
        "context.priorKnowledgeByPath as { <path>: [{id, content}, ...] }. Read this BEFORE " +
        "deciding what to stage:\n" +
        "- If a file's prior-knowledge list already covers the claim you were about to stage, " +
        "skip it. Re-emitting hashes to the same content_hash and is a no-op, but it wastes " +
        "agent turns and clouds the staged set.\n" +
        "- Stage only DELTAS: claims the file actually says that the existing propositions " +
        "do not already capture.\n\n" +
        "## Warm exit — zero-delta shortcut\n" +
        "If every file in priorKnowledgeByPath is already comprehensively covered (nothing to stage), take the `warm-exit` edge directly from here to `evaluating` — pass `{ coverageSatisfied: true }` in the same freelance_advance call. This skips staging/addressing/memory_emit entirely. It's the right path when a prior compile run already covered the same files and the sources haven't drifted since. A one-step warm exit costs one tool call instead of the 3–4 it takes to loop through the normal staging path.\n\n" +
        "If context.priorKnowledgePathsTruncated is true, the path list exceeded the 50-path " +
        "cap and not every file was checked — fall back to manual judgment for the unchecked tail.",
    },
    staging: {
      description: "Stage atomic claims in context.",
      instructions:
        `${PROPOSITION_RUBRIC}\n\n` +
        "## What this node does\n" +
        "Push atomic claim objects to context.stagedClaims via freelance_context_set. Each claim:\n" +
        "  { content: string, sources: string[], draftEntities?: string[] }\n" +
        "- content: the claim itself, per the rubric above.\n" +
        "- sources: cite only the files in context.filesReadPaths this claim was actually derived from.\n" +
        "- draftEntities: optional — names you noticed while writing. The addressing node reviews and rewrites these against the full vocabulary.\n\n" +
        "Let the query shape what kind of claims you extract. When you've staged every claim this batch of files deserves, advance.",
    },
    addressing: {
      description: "Review the staged claims, plan entities, emit.",
      instructions:
        "## What you arrive with\n" +
        "- context.stagedClaims — the claim objects you wrote in staging.\n" +
        "- context.entities — the existing entity vocabulary (populated by an onEnter memory_browse).\n\n" +
        "## What this node does\n" +
        "Read both. Decide which entity names each claim should link to, then call memory_emit once with every staged claim, attaching entities per claim. Clear context.stagedClaims afterward.\n\n" +
        "## How to think about entities\n" +
        "Reuse existing entity names verbatim — context.entities shows what's already there, and same-name reuse is the single highest-leverage move you can make for graph density.\n\n" +
        "Good entities are **search hubs** — concepts someone would look up when trying to learn about this area. Bad entities are setting-names or field-names, which belong inside claim content, not as entities. If an entity name reads like a config key, it's content, not a hub.\n\n" +
        "A hub that only shows up on one claim in the batch is usually a fragment masquerading as a hub — roll it into a broader concept that recurs across claims.",
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
    claimsStaged: {
      label: "claims-staged",
      description: "Raw claims have been pushed into context.stagedClaims.",
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
        "The next node will read those source files. " +
        "Update context.recalledEntities (the count you actually inspected) and context.recalledPropositions (sum across the inspects).",
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
