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
  "## The independence test\n" +
  'For every candidate proposition, ask: "Could either claim be true while the other is false?" If yes — two propositions, not one. ' +
  "This is the semantic backstop behind the surface 'no and / also / plus' rule above. Use it whenever the surface check feels ambiguous.\n\n" +
  "## Split aggressively\n" +
  '- "X calls Y, then does Z" — two props: "X calls Y", "after Y, X does Z"\n' +
  '- "X handles A, B, and C" — three props, one per responsibility\n' +
  "- A method AND what happens after it — separate props\n\n" +
  "## Keep together when splitting destroys meaning\n" +
  '- "validates X by checking Y" — one action with its mechanism\n' +
  '- "delegates to Y via Z" — one relationship\n' +
  "Relationship claims are KNOWLEDGE IN THEMSELVES. Don't atomize 'A depends on B' into separate facts about A and B — the edge IS the claim. " +
  "Atomizing relationships into per-entity facts destroys the graph's connectivity and is worse than under-splitting.\n\n" +
  "## Knowledge types\n" +
  "Propositions can be factual ('X is configured to Y'), conceptual ('X exists because Y'), procedural ('to do X, run Y then Z'), or metacognitive ('this is uncertain because we couldn't reproduce X'). The metacognitive bucket is the one most extractors silently drop — emit it explicitly when you have it.\n\n" +
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
    exploring: {
      description: "Read source files relevant to the query.",
      instructions:
        "Read files related to the compilation query using your native Read tool. " +
        "After each read, call freelance_context_set to append the file path to " +
        "context.filesReadPaths. The path list is your working set — when you emit " +
        "propositions in the next node, you'll cite sources from this list. memory_emit " +
        "hashes each cited source file at emit time for per-proposition provenance, so " +
        "there's no pre-registration step: read, track the path, emit when ready.\n\n" +
        "## Graph-aware reading — stage only deltas\n" +
        "Every time you arrive at this node, an onEnter hook calls memory_by_source for " +
        "every path currently in context.filesReadPaths and writes the result to " +
        "context.priorKnowledgeByPath as { <path>: [<existing propositions>] }. Read this BEFORE " +
        "deciding what to stage:\n" +
        "- If a file's prior-knowledge list already covers the claim you were about to stage, " +
        "skip it. Re-emitting hashes to the same content_hash and is a no-op, but it wastes " +
        "agent turns and clouds the staged set.\n" +
        "- Stage only DELTAS: claims the file actually says that the existing propositions " +
        "do not already capture.\n" +
        "- If every file you read has empty deltas, the staged set will be empty too — that's " +
        "the warm-exit signal. Set context.coverageSatisfied = true and the next eval will " +
        "route straight to complete instead of looping.\n" +
        "If context.priorKnowledgePathsTruncated is true, the path list exceeded the 50-path " +
        "cap and not every file was checked — fall back to manual judgment for the unchecked tail.",
    },
    staging: {
      description: "Stage raw claims in context — no entity planning, no memory_emit yet.",
      instructions:
        `${PROPOSITION_RUBRIC}\n\n` +
        "## Lens directive — what to extract\n" +
        "Read context.lens and shape your stagings accordingly. If context.lens is empty, default to dev.\n" +
        "- dev: extract implementation detail, code names, internal structure.\n" +
        "- support: extract ONLY user-facing behavior and business rules. NO code names, file paths, or internal details.\n" +
        "- qa: extract testable behaviors, validation rules, edge cases.\n" +
        "The lens flips output quality substantially — without it the agent defaults to a muddled middle-ground that serves nobody. Pick one and commit to it for every claim in this run.\n\n" +
        "## What this node does\n" +
        "STAGING is the raw-claim pass. You are NOT yet calling memory_emit. You are pushing atomic claim objects into context.stagedClaims via freelance_context_set, where the next node (`addressing`) will read them, plan entity hub-concepts across the whole staged set, and call memory_emit once with planned entities.\n\n" +
        "Per-claim schema:\n" +
        "  { content: string, sources: string[], draftEntities?: string[] }\n" +
        "- content: the atomic claim itself, obeying the rubric above.\n" +
        "- sources: cite from context.filesReadPaths — only files each claim was actually derived from.\n" +
        "- draftEntities: optional — names you informally noticed are involved. The addressing node will rewrite these against the full vocabulary; do not over-think them here.\n\n" +
        "Aim for 5–15 staged claims per file, applying the independence test aggressively. Splitting now is cheap; under-splitting is expensive because it forces the addressing node to atomize after the fact.\n\n" +
        "When all relevant claims from this batch of files are staged, advance.",
    },
    addressing: {
      description: "Plan entity hub-concepts across the staged claim set, then emit.",
      instructions:
        "## What this node does\n" +
        "ADDRESSING drains context.stagedClaims, plans the entity vocabulary across the full set, and calls memory_emit ONCE with planned entities. This node exists separately from staging because entity planning needs to see the whole batch — it cannot succeed claim-by-claim.\n\n" +
        "Before the agent saw this node, an onEnter hook called memory_browse and populated context.entities with the existing entity vocabulary in the collection. Read those names first — reusing existing entity names verbatim is the single highest-leverage thing you can do for graph density.\n\n" +
        "## Hub-concept rules (these are leverage rules — follow them mechanically)\n" +
        "1. Reuse existing entities whenever possible. Same name, exactly. context.entities already shows you what's there.\n" +
        "2. Each entity MUST connect to 3+ propositions across the staged set. If it doesn't, merge it into a broader concept. An entity with one proposition is a content fragment masquerading as a hub.\n" +
        "3. Maximum entity count is staged-claim-count divided by 3, rounded up. 20 staged claims → max 7 entities. 30 → max 10. This is a HARD ceiling — it forces planning instead of improvising.\n" +
        "4. 1–2 entities per proposition. Most propositions share entities with their neighbors.\n\n" +
        "## GOOD vs BAD entities (pattern-match these to your domain)\n" +
        "GOOD entities (hub concepts a person would search for):\n" +
        '  "User Authentication", "Payment Processing", "Onboarding Flow", "Configuration"\n' +
        "BAD entities (per-field granularity — these belong inside proposition CONTENT, not as entities):\n" +
        '  "JWT Token Expiry Setting", "Stripe API Key Field", "Welcome Email Subject Line"\n' +
        "Rule of thumb: if an entity's name reads like a setting name or a field name, it is content, not a hub. Roll it up.\n\n" +
        "## Procedure\n" +
        "1. Read context.entities (existing vocabulary from the onEnter memory_browse).\n" +
        "2. Read context.stagedClaims (this batch's raw claims).\n" +
        "3. Plan the entity set: count claims, divide by 3, that's your ceiling. List candidate hubs. Strike anything that fails the 3+ floor or looks like a setting name. Prefer existing names.\n" +
        "4. Call memory_emit ONCE with all staged claims, attaching the planned entities to each. Cite sources from each claim's sources field.\n" +
        "5. Update context.propositionsEmitted with the running total. Clear context.stagedClaims (set to []) so the next loop iteration starts clean.",
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
