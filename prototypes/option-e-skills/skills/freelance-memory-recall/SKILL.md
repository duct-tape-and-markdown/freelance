---
name: Freelance — Recall Knowledge
description: Query the Freelance memory graph to answer a question using previously-compiled propositions. Activate when the user asks a question that could plausibly be answered from memory the team has already built up, especially about domains larger than fits comfortably in context.
allowed-tools: mcp__freelance__freelance_start, mcp__freelance__freelance_inspect, Bash
version: 1.0.0
---

# Recall knowledge from Freelance memory

This skill drives the sealed `memory:recall` workflow — queries the knowledge graph topologically (entity joins, provenance edges) and textually (FTS5) to assemble an answer grounded in cited propositions.

## When to use

Activate when:

- The user asks a question whose answer would live in compiled memory.
- The corpus the question concerns is larger than would fit in context comfortably.
- The user wants an answer with provenance citations (entity + source file).

**Do not** activate when:

- The answer is obviously in a single file the user has already referenced — direct `Read` is cheaper.
- No memory has been compiled yet. Check first: `freelance memory status --json`.

## Execution

### 1. Check memory has content

```bash
freelance memory status --json
```

If `total_propositions` is 0 or very small, tell the user memory is empty and suggest `freelance-memory-compile` first.

### 2. Start the traversal

```
freelance_start(
  graphId: "memory:recall",
  initialContext: { question: "<user's question verbatim>" }
)
```

### 3. Drive via CLI

```bash
freelance advance <edge> --json
freelance memory search "<query>" --limit 20 --json
freelance memory inspect <entity> --json
freelance memory related <entity> --json
freelance context set coverageSatisfied=true --json
```

### 4. Node-by-node recipe

The `memory:recall` graph phases:

- **sourcing** — `memory_search` and `memory_browse` onEnter hooks pre-populate context with top candidate propositions and entity vocabulary. The agent's job is to judge whether what's returned covers the question.
  - *Warm-exit:* if the pre-populated results are comprehensive, take `warm-exit` to `evaluating`.
  - *Cold path:* take `to-expanding` to query further.
- **expanding** — use `memory_related` and `memory_inspect` to navigate the graph sideways. Stop when coverage feels adequate.
- **evaluating** — gate. Reflect on whether the assembled propositions answer the question. If yes, advance to `answering`; if no, loop back to `expanding`.
- **answering** — synthesize the answer. Cite propositions by entity and source file path. Do NOT paraphrase sources — quote propositions verbatim where they carry the claim.

## Citation discipline

Every factual statement in your answer must trace to one or more proposition IDs you surfaced during the traversal. If you find yourself generating a claim without a proposition to back it, stop — either the memory doesn't cover that point (say so) or you need to expand further.

## Staleness awareness

Propositions can be marked `valid: false` when their source file has drifted on disk. If key propositions are stale, surface that to the user:

> "This answer draws on propositions compiled from `<file>`. Memory indicates the file has changed since compile; the answer may be out of date."

## References

- `references/citation-format.md` — how to format proposition citations in responses
- `references/staleness.md` — what stale propositions mean for recall quality

(Reference files not included in this prototype; would ship alongside SKILL.md.)
