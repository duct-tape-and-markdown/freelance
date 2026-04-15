# Memory Architecture Review

**Date:** 2026-04-14
**Version analyzed:** freelance v1.3.0 (onEnter hooks, programmatic nodes)
**Scope:** Compare freelance memory against the 2024–2025 state of the art and against the Runner project's compiler-strategy evolution, then identify integration opportunities.

This is a strategic review. For the tactical, prose-level companion, see `memory-prose-porting.md`.

## Where freelance memory stands today

Freelance memory is a **bipartite proposition graph on SQLite+FTS5**. Propositions link 1–4 entities via an `about` junction; provenance is per-proposition with `(path, content_hash, mtime_ms)` triples; staleness is a two-tier check (mtime fast-path → SHA256 slow-path); two sealed workflows (`memory:compile`, `memory:recall`) drive the build/recall lifecycle; onEnter hooks (new in v1.3.0) can fire scripts with a 5s default timeout.

### What it already gets right

These align with where the field converged in 2024–2025:

- **Propositions as the first-order artifact.** Dense X Retrieval (EMNLP 2024), HippoRAG 2, and HyperGraphRAG are all converging on atomic-claim indexing over passage chunking. Freelance already stores claims, not chunks.
- **N-ary claims** via the `about` junction (1–4 entities per prop). This is hyperedge-lite and matches HyperGraphRAG's atomicity win: "X was prescribed Y at dosage Z for condition W" is one claim, not four binary edges.
- **Provenance as data, not metadata.** `proposition_sources` is a topology edge, not a metadata field. Blast radius is a join, not a scan.
- **Content-hash dedup + idempotent emit.** Clean write path; same emit twice is a no-op.
- **Gated emit tool.** `memory_emit` requires an active memory workflow traversal. This discipline — preventing off-the-books knowledge creation — is something most agent-memory systems lack.
- **Passive sink principle.** The store has no extraction, no summarization, no embedding. Policy lives in the workflow layer. This is a virtue and worth preserving as we add capability.

### What it's missing vs. the field

| Capability | State of the art | Freelance today |
|---|---|---|
| Consolidation vocabulary | mem0's ADD/UPDATE/DELETE/NOOP; Graphiti's add/merge/invalidate/skip | ADD only (via hash dedup) |
| Temporal model | Graphiti bi-temporal (`t_valid` / `t_invalid` + `t_created` / `t_expired`) | Single `created_at`; staleness is a read-time boolean |
| Semantic retrieval | Vector + BM25 + graph fused, reranked | FTS5 only — no embeddings |
| Entity resolution cascade | Runner's exact → normalized → containment → vector (0.92 auto / 0.50–0.92 LLM confirm) → create | exact → normalized → create |
| Adaptive read strategy | ConnectRoot2 v6's warm / cold / mixed dispatch | Monolithic compile path |
| Graph-aware read | ConnectRoot2 v5: source reads return what the graph already knows | `memory_by_source` exists but isn't woven into the compile loop |
| Procedural memory | LangMem's prompt-as-memory | Not modeled |

Runner's own evolution — from the archived `attributed` / `interleaved` / `separated` strategies to the current unified pipeline — independently rediscovered the same patterns: pre-lock entity vocabulary, separate extract/address/emit, use format-resilient structured output, branch on retrieval depth. ConnectRoot2's six-version workflow progression (`knowledge-compilation-v3` through `v6`) is the testbed that proved it. Every one of those workflows is already a freelance traversal — the shape is already portable.

## Integration opportunities

The onEnter hook is the right vector for most of this. The governing principle:

> Anything deterministic stays in `onEnter` code. Anything probabilistic becomes one scoped LLM call per node with a narrow decision vocabulary.

Avoid the MemGPT failure mode of letting the agent free-roam over memory operations — it's expensive and drifts.

### 1. Adaptive cold / warm / mixed dispatch at node entry

**Source:** ConnectRoot2 `knowledge-compilation-v6.workflow.yaml`, `strategy-decision` node.

An `onEnter` script on a `classify-retrieval` node runs `memory_search` + `memory_related` against the query, counts hits above a score threshold, and sets `context.retrievalDepth = cold | warm | mixed`. The traversal then branches to a direct-emit subgraph or a stage-and-address subgraph. Zero LLM calls, pure code, ~50ms.

This is the single biggest win. The classifier rule is already written:

- **cold** — 0–2 results, or results are low-relevance (score < 0.3)
- **warm** — 5+ high-scoring results covering the core question
- **mixed** — some coverage but clear gaps

It needs to be ported as a hook script, and the two target subgraphs templated from `compilation-direct-emit.workflow.yaml` and `compilation-stage-and-address.workflow.yaml`.

### 2. Consolidation vocabulary on write

**Source:** mem0's ADD/UPDATE/DELETE/NOOP; Graphiti's add/merge/invalidate/skip.

Today, `memory_emit` either creates or dedups via content hash. Add an UPDATE/INVALIDATE path: `onEnter` of a `reconcile` node fetches top-k similar existing propositions (once embeddings land — see #4), runs one LLM call with `{ADD, UPDATE, INVALIDATE, NOOP}` as the decision vocabulary, and applies the op. The existing `entity_kind_conflict` warning path is the natural hook — today it just logs; it should route to reconcile.

The explicit 4-op consolidation vocabulary is what mem0 credits for its 26% quality improvement and 90% token savings over naive memory layers. The key is that the LLM must pick one op — it cannot silently duplicate.

### 3. Bi-temporal propositions

**Source:** Zep / Graphiti.

Add `valid_from`, `valid_to`, `invalidated_at`, `invalidated_by` to the `propositions` table. Never DELETE on contradiction — invalidate. Staleness stops being "`current_match: false` on read" and becomes "edge closed at `t`."

This gives you:

- **Audit** — "what did we believe when?" is trivially answerable.
- **Non-destructive update** — UPDATE and INVALIDATE from #2 become schema operations rather than destructive writes.
- **Temporal traversal** — "what did this file contribute before the refactor?" is a time-filtered join.

Bigger schema lift but architecturally the most consequential. It's the one piece Zep ships that nobody else has matched, and it pairs naturally with #2.

### 4. Entity resolution cascade with embeddings

**Source:** Runner `src/graph/resolution.ts`.

Freelance stops at normalized match. Runner runs exact → normalized → vector (auto-merge ≥0.92, LLM-confirm 0.50–0.92, fallback ≥0.85) → create, logging a `MergeEvent` at each tier. The cascade is pure code once embeddings exist; LLM-confirm only fires in the gray band.

Prerequisites: an embedding column on `entities`, a vector index, an embedding provider. Everything else ports directly from `src/graph/resolution.ts:131-242`.

### 5. Graph-aware reads

**Source:** ConnectRoot2 `knowledge-compilation-v5.workflow.yaml`.

Today the compile loop reads a file then emits. The v5 pattern: `onEnter` of the `exploring` node, for each path in `context.filesReadPaths`, the script calls `memory_by_source` and attaches existing propositions to context. The agent sees "here's what we already know about this file" alongside the source, and only stages deltas. Warm exit becomes automatic when the delta is empty. Pure code, no new LLM calls.

This is also cheap — the infrastructure (`memory_by_source`) already exists; only the hook is missing.

### 6. PPR-lite for memory_related

**Source:** HippoRAG / HippoRAG 2.

Current `memory_related` is degree-1 co-occurrence. A small Personalized PageRank over the entity graph (seeds = query-matched entities, 2–3 iterations, walks edges weighted by shared-proposition count) gives multi-hop associativity for almost no cost. Pure SQL + a numpy-equivalent loop in an `onEnter` script.

The HippoRAG insight is that PPR encodes multi-hop associativity as a single linear-algebra op, which is dramatically cheaper than LLM-mediated traversal.

### 7. Procedural memory via onEnter rewrites

**Source:** LangMem (LangChain).

A terminal-node `onEnter` script reads traversal context (what worked, what looped, what failed the coverage check) and writes back **guidance deltas** into a per-collection "procedural memory" table. The next traversal's `begin-session` `onEnter` reads those and injects them into the first node's instructions.

This is the feedback loop that turns freelance memory from a knowledge store into a learning system. Nobody except LangMem has named this primitive explicitly; freelance is structurally well-positioned because nodes are data and `onEnter` is programmatic. Speculative — unproven at scale anywhere — but cheap to prototype and meaningfully differentiating if it works.

## Sequencing recommendation

| Order | Item | Why here |
|---|---|---|
| 1 | #1 Adaptive dispatch | Pure code, already proven in ConnectRoot2, unlocks the branching structure the others slot into |
| 2 | #5 Graph-aware reads | Pure code, makes warm-exit behavior emergent |
| 3 | #4 Entity resolution cascade with embeddings | The one infrastructure investment that unblocks #2 and #6 |
| 4 | #2 Consolidation vocabulary | Paired with #3 into a single schema migration |
| 5 | #3 Bi-temporal propositions | Highest-ceiling architectural change; wants a clean commit |
| 6 | #6 PPR-lite | Nice-to-have once embeddings exist |
| 7 | #7 Procedural memory | The speculative bet |

## What to preserve

Freelance's emit path is intentionally a **passive sink** — no extraction, no summarization, no embedding. That's a real virtue and worth preserving.

Everything above can be done in the **workflow layer** (onEnter hooks, staged subgraphs) without polluting the store with policy. The line to hold:

> The store stays dumb and idempotent. Intelligence lives in the traversal.

## Sources

### Agent memory systems
- [Letta / MemGPT](https://docs.letta.com/concepts/letta/) — OS-inspired tiered memory, self-editing state
- [arXiv 2504.19413: mem0](https://arxiv.org/abs/2504.19413) — extraction + explicit 4-op consolidation
- [arXiv 2501.13956: Zep](https://arxiv.org/abs/2501.13956) — bi-temporal knowledge graph
- [Graphiti](https://github.com/getzep/graphiti) — Zep's graph engine, open source
- [Cognee ECL](https://www.cognee.ai/blog/deep-dives/grounding-ai-memory) — extract-cognify-load pipeline
- [LangMem SDK](https://blog.langchain.com/langmem-sdk-launch/) — episodic / semantic / procedural primitives

### Retrieval / knowledge compilation
- [arXiv 2405.14831: HippoRAG](https://arxiv.org/abs/2405.14831) — PPR over extracted KG
- [arXiv 2502.14802: HippoRAG 2](https://arxiv.org/html/2502.14802v1) — non-parametric continual learning
- [arXiv 2404.16130: GraphRAG](https://arxiv.org/html/2404.16130v2) — community detection + hierarchical summaries
- [arXiv 2503.21322: HyperGraphRAG](https://arxiv.org/abs/2503.21322) — n-ary hyperedges for atomic claims
- [ACL 2024: Dense X Retrieval](https://aclanthology.org/2024.emnlp-main.845/) — propositions as retrieval units
- [arXiv 2401.18059: RAPTOR](https://arxiv.org/abs/2401.18059) — recursive abstractive tree
- [arXiv 2410.05779: LightRAG](https://arxiv.org/abs/2410.05779) — dual-level retrieval, incremental updates

### Internal references
- Runner strategy evolution: `C:\Users\JohnC\Repos\runner\docs\STRATEGY-DECISION.md`
- Runner unified pipeline: `C:\Users\JohnC\Repos\runner\src\compiler\pipeline.ts`
- Runner entity resolution: `C:\Users\JohnC\Repos\runner\src\graph\resolution.ts`
- ConnectRoot2 workflows: `C:\Users\JohnC\ConnectRoot2\connect\.freelance\knowledge-compilation-v{3,4,5,6}.workflow.yaml`
- ConnectRoot2 subgraphs: `C:\Users\JohnC\ConnectRoot2\connect\.freelance\compilation-{direct-emit,stage-and-address}.workflow.yaml`
- ConnectRoot2 emission guide: `C:\Users\JohnC\ConnectRoot2\connect\.freelance\sources\emission-guidance.md`
