# Memory: Intent and Intended Qualities

**Scope:** What the freelance memory system should *embody* and *produce* — the qualities we're designing for, not the mechanics that achieve them.

This doc is the north star. It's what survives changing tools, changing ablation results, and changing fixtures. Implementation choices (which prose, which node topology, which onEnter hooks) should be evaluated against whether they serve these qualities.

For the strategic roadmap (what freelance memory could *become*), see `memory-architecture-review.md`. For the tactical porting plan (what prose to move where), see `memory-prose-porting.md`.

## Architectural qualities

These are the non-negotiables — the spine the rest hangs from.

### The store is a passive sink

MemoryStore has no extraction, no summarization, no embedding, no policy. It owns: atomic writes, content-hash dedup, provenance joins, FTS5 index, staleness detection. It does not own: what counts as a proposition, what counts as an entity, when to emit vs update, what to retrieve for a query.

**Why this matters:** policy drifts. Stores persist. Keeping policy in the workflow layer means we can evolve compile/recall strategies without migrating data.

### Emit is gated by traversal

`memory_emit` requires an active workflow traversal — the sealed `memory:compile` or `memory:recall`, or any user-authored graph. There is no off-the-books knowledge creation from bare conversation turns.

The gate used to allow-list only the sealed memory workflows. It was widened to "any structured flow" so user-authored workflows (domain-specific compiles, experiments, ablations) can write memory without being registered in code. The invariant that matters stays the same: emission happens inside a workflow the caller deliberately started, not as an incidental side effect.

**Why this matters:** gating forces intentional knowledge capture. Off-the-cuff emissions produce noise that degrades recall. Allow-listing by graph id would re-create the collection-management burden under a different name — workflow registration — which isn't the invariant worth defending.

### Propositions are first-order, claims not chunks

Knowledge is stored as atomic factual claims linked to 1–4 entities, not as passages indexed by vector similarity. A proposition is a sentence with provenance; entities are the nouns it connects.

**Why this matters:** recall operates on claims with citations, not snippets without context. An agent answering a question can name what it knows and point to where it came from.

### Provenance is topology, not metadata

Source attribution lives in `proposition_sources` as a join table with `(path, content_hash, mtime_ms)`. Staleness is a read-time join, not a metadata field. "What did this file contribute?" is a one-query answer.

**Why this matters:** provenance as data means blast radius (what to invalidate when a file changes) is cheap. Provenance as metadata means scans.

### Knowledge is append-only across corpus frames

A `proposition_sources` row — `(proposition_id, file_path, content_hash)` — is a coordinate in **corpus-version space**. It says "this claim was derivable from `file_path` when the file hashed to H." The `content_hash` is not metadata; it IS the frame of reference.

Staleness is frame-relative, not terminal. `isFileChanged` asks "does the stored hash match the file on disk *right now*?" — not "was this claim ever true?" When the file reverts (branch switch, `git revert`, checkout of an older tag), rows that matched the old hash become current again. No data loss, no recompile.

**Why this matters:** real codebases are multi-frame. A developer on a feature branch recompiles against the new spec. Main-branch knowledge doesn't become wrong — it becomes *relative to a different frame*. Switching back makes the old frame current again. Deleting rows at emit time collapses a multi-frame store into a single-frame one and turns every branch switch into a recompile.

**Consequences:**

- **Emits are additive.** `memory_emit` only INSERTs. A file that used to yield P1 and now yields P2 produces *both* rows — `(P1, X, H_old)` and `(P2, X, H_new)`. Whichever `content_hash` matches the file on disk is the one currently visible. The read-time staleness join is the lens; the rows are the history.
- **Orphan hiding is a lens, not a cleanup.** The default `valid_proposition_count == 0` filter on `memory_browse` (and the analogous filters on `memory_search`, `memory_inspect`) chooses *which frame to show*; it does not delete. Flipping branches flips what appears.
- **Unbounded accumulation is a real but separate concern.** Over a long project with many branch switches, source rows accumulate. A future user-initiated, scope-bounded prune tool ("drop rows whose hash isn't reachable from any tracked ref"; "drop rows older than N days") can handle this — explicitly, never as a side effect of writes.

This principle is what makes the bi-temporal roadmap (#54 §3 — `valid_from` / `valid_to` / `invalidated_at`) a formalization of what's already latent in the schema, rather than a new direction. Provenance-hash-as-frame is the informal version; bi-temporal columns are the explicit version.

## Emergent qualities — what the output should look like

These are qualities the system should *produce* through correct usage, not enforce through mechanical rules.

### Content does not duplicate graph structure

This is the subtle principle that governs atomicity. Relational structure between entities is carried by the graph — by the set of entities that share a proposition, and by the edges formed across propositions. **Propositions should not restate relational information the graph already encodes.**

A compound like "the four pillars of aerobic adaptation are A, B, C, and D" looks coherent but is redundant: if each pillar also has its own proposition linked to Aerobic Adaptation, the graph already carries "these are the four pillars" as an edge set. The enumeration prop duplicates.

Similarly, "requires CLIENT_ID and CLIENT_SECRET plus stored tokens" is three requirement edges, not one compound claim. Each edge (the script requires this thing) is independently navigable; the enumeration adds nothing.

### Atomic as default, coherent-compounds narrowly defined

Atomic is the default, not a bias. The independence test ("could either half be false?") is the right semantic check. Most compounds fail it.

The narrow set of legitimate "keep together" cases are ones where splitting creates fragments that lose meaning — not ones where the compound merely enumerates edges:

- **Action-with-mechanism**: "validates X by checking Y" — the mechanism isn't a separate claim; it's how the action is performed.
- **Relationship-via-intermediary**: "delegates to Y via Z" — one relationship, not two.

These survive because splitting them produces isolated facts that read wrong without the other half.

The failure modes are symmetric:
- **Over-atomize a relationship**: "A depends on B" split into per-entity facts destroys the edge.
- **Under-atomize an enumeration**: "A has pillars X, Y, Z" kept together duplicates what individual propositions + shared entity links already carry.

### Not all compounds are equally damaging

There is a hierarchy of failure modes the rubric should prevent in order of severity:

1. **Enumerations that duplicate graph structure** — "the three pillars are X, Y, Z" restates what the edge set already carries. This is actively damaging: recall has to dedup these against the per-member props; refresh creates canonical ambiguity. **Must prevent.**
2. **Conjunctions of independent topics** — "X was added as Y, and Z ran it, and the pass did Q" mashes unrelated facts. Splits cleanly; there's no cost. **Should prevent.**
3. **Single-subject multi-fact compounds** — "Women have less Type II fiber and lower glycogen storage" — two facts about one subject. Each is independently defeasible but the compound doesn't corrupt graph structure. **Acceptable as residual noise.**

The rubric teaches the structural failures (1 and 2) with concrete examples. It does not attempt to catalog every compound pattern. Chasing residual (3)-class compounds to zero requires either ever-growing example lists (unsustainable) or expensive enforcement (post-emit validation, self-revision loops). The cost exceeds the benefit.

**Target:** drive (1) to ~0% via explicit enumeration guidance. Accept ~15-25% residual (3)-class compounds as the cost of first-pass compilation speed. The graph's structural integrity depends on eliminating (1), not on achieving perfect atomicity.

**Observed in practice:** our ablation runs emitted compounds like "requires X and Y plus Z" and "the N pillars of A are X, Y, Z" even with the full rubric. On re-inspection, ~20-25% of propositions were enumerations that restate graph structure. The rubric's original WRONG/RIGHT example taught splitting conjunctions but did not teach splitting enumerations — the agent pattern-matched "coherent topic" and kept them compound. This is a teaching gap in the rubric, not a case for tolerating compounds. The rubric now includes a second WRONG/RIGHT example specifically for the enumeration pattern:

> WRONG: "Endurance performance is determined by three pillars: VO2max, Running Economy, and Lactate Threshold."
> RIGHT: three content-specific propositions, each linking one pillar to Endurance Performance. The "three pillars" relationship is carried by the edge set.

### Entities as navigable hubs

Entities should be concepts someone would search for to learn about an area — not config keys, not per-field labels, not fragment names. An entity with one proposition attached is a fragment; an entity with 5+ is a hub worth navigating to.

This shape should *emerge* from the agent thinking "what would a reader look up?", not be enforced by arbitrary counting rules. Entity guidance prose teaches the pattern; the agent's judgment does the work.

**Observed in practice:** entity guidance reduced entity fragmentation 35% on our fixture (26 scattered entities → 17 navigable hubs) with the same claim count. The guidance is doing the shaping.

### Reuse over creation

Same-name reuse is the single highest-leverage move for graph density. Before creating a new entity, the agent should scan `context.entities` and reuse existing names verbatim where they apply. `memory_related` queries across shared propositions — if every claim about VO2max uses a different entity name, the graph becomes a collection of islands.

### Knowledge shape reflects the corpus

The resulting graph is a function of the source material. Rich, dense sources produce rich, dense knowledge. Sparse sources produce sparse knowledge. We do not aim for a target claim count or entity count. We aim for correct representation of what's actually in the sources.

Some structures in the source (frameworks, taxonomies, oscillations, 5-way enumerations) resist atomization — not because the agent is failing but because the structure is genuinely compound at the source level. Accept this.

## Agent interaction qualities — what using the system should feel like

These are qualities of the workflow experience, not the output.

### First-pass correctness

The agent should formulate well-shaped propositions on the first attempt. Guidance prose should be clear enough that work doesn't need to be undone. "Reasoning for 3 minutes because a few compound props slipped through" is a failure.

The corollary: we accept occasional imperfection (a compound prop that should have been split) as the cost of keeping wall time sane. Perfection pursued at the cost of 10x reasoning overhead is a bad trade.

### Deterministic pre-population via onEnter

Anything the agent would deterministically look up at node entry — memory_status, entity vocabulary, prior knowledge per file — should fire as an onEnter hook. The agent arrives with context already populated and spends its turns on probabilistic work (judging atomicity, planning entities, synthesizing answers), not on routine lookups.

**Observed in practice:** onEnter hooks on exploring (status + browse + by_source) replaced three manual agent calls per compile iteration.

### Warm paths for work already done

Re-compiling a file whose knowledge is already captured should be cheap. Recalling against a query that's already well-covered should skip sourcing. Both workflows need warm-exit edges that bypass the main loop when the delta is empty.

**Observed in practice:** recall without warm-exit got stuck at sourcing when memory covered the query. The warm-exit fix routed recall to evaluating directly when `coverageSatisfied = true`.

### Minimal decision vocabulary

When a node requires a judgment, the agent should face a narrow choice (advance one of 2–3 edges, set one flag), not free-form reasoning about what to do next. Free-form navigation burns tokens and drifts. Workflows exist to compress the decision space.

## Where memory earns its keep

Memory is not universally better than direct source access. It has a distinct operating regime.

### Memory wins when
- **The corpus exceeds context** — thousands of files, millions of lines. Raw files cannot fit; compiled claims can.
- **Knowledge spans sessions** — decisions made in one conversation need to persist to another. Files don't remember what you concluded about them.
- **Synthesis has been reasoned over** — compiled propositions represent work already done. Raw files require re-doing that work.
- **Provenance-linked reasoning matters** — "what changed and what does it affect?" is a topology query memory answers cheaply.

### Direct read wins when
- **The corpus fits in context.** On our ablation fixture (260 lines, 2 files), direct Read was 2x faster and 2x cheaper than memory:recall.
- **The knowledge isn't compiled yet.** Recall can't surface what compile hasn't captured.
- **The query is a one-shot.** No cross-session persistence needed.

**Implication:** memory's pitch is not "better than grep". It's "navigable knowledge that outlasts context". Positioning and tooling should reflect that.

## Anti-patterns — what we are not trying to be

Naming the shape we're avoiding.

### Not a vector store with extra steps
We index claims, not passages. Retrieval is topological (entity joins, provenance edges) and textual (FTS5), not semantic similarity. Embeddings may come (see architecture review), but they supplement — they don't replace — the graph.

### Not a prescriptive shape enforcer
We do not impose "3+ propositions per entity" as a rule. We do not cap entities at `propositions / 3`. We do not score content similarity against a threshold. Numeric thresholds that shape **knowledge** force the agent to reason about compliance instead of content — an anti-pattern.

Runtime safety limits are a different category. `maxTurns` on a cycling action node is a runaway guard (prevents infinite loops when the agent fails to set the cycle-exit flag), not a shape constraint. Same for the 50-path cap on `memory_by_source` onEnter hook arguments (bounds hook latency against the 5s timeout). These exist to keep the system behaviorally bounded, not to filter knowledge. When the number leaks into knowledge shape ("only keep entities with 3+ propositions"), that's the anti-pattern.

### Not a transcript recorder
Every claim is a reasoned fact about the source, not a log entry of what the agent read. "I read file X" is not a proposition. "File X validates Y by checking Z" is.

### Not a duplicator of graph edges
Propositions carry what is **content-specific** to each edge. The existence of the relationship between entities is carried by the graph. Enumerations that restate "these N things are the N members of X" are redundant with the edge set already formed by the member propositions.

### Not a ledger of conversation
Memory is knowledge derived from sources, not a history of what was discussed. Cross-session continuity means "the distilled facts persist" — not "the entire conversation persists".

### Not autonomous
The store does not write itself. All writes route through the gated emit path. The workflow layer decides what to persist. An agent cannot spontaneously commit knowledge without a memory workflow traversal.

### Not an emit-time garbage collector
`memory_emit` never removes stale provenance. A proposition whose source file no longer derives it stays at its original `content_hash`, flagged stale against the current frame and hidden by the default orphan filter — but recoverable the instant the file reverts. Emit-time deletion would coerce a multi-frame store into a single-frame one and break the branch-switch reversibility that "append-only across corpus frames" depends on. Pruning — if we ever ship it — is an explicit, scope-bounded, user-initiated operation, never a side effect of a normal write.

## How this doc should be used

When evaluating a proposed change to memory (prose, topology, tool, schema), ask:

1. Does it serve an architectural quality above? (store stays dumb, emit stays gated, etc.)
2. Does it help produce an emergent quality? (atomic-coherent claims, navigable hubs, corpus-reflective shape)
3. Does it improve the agent interaction? (first-pass correctness, warm paths, deterministic pre-population)
4. Does it clarify where memory earns its keep? Or does it blur that boundary?
5. Does it cross an anti-pattern line?

Changes that serve these qualities earn their place. Changes that just add capability should be questioned.

## References

- `memory-architecture-review.md` — strategic roadmap and field comparison
- `memory-prose-porting.md` — tactical porting plan from ConnectRoot2
- `experiments/` — ablation runs and findings
- `experiments/_private/mapping.md` — variant → condition mapping
