# Ablation Findings

Empirical results from blind A/B ablation runs against the freelance
memory:compile workflow. Each ablation isolated a single sub-strategy
and measured the behavioral delta on a fixed fixture (physiology.md +
run-sync.js, ~260 lines total) run by a subagent with no visibility
into the condition.

For design philosophy, see `docs/memory-intent.md`. For per-experiment
variant mapping, see `_private/mapping.md` (researcher-private).

## Summary table

| # | Sub-strategy | Finding | Action |
|---|---|---|---|
| 1 | Lens directive (dev/support/qa) | No measurable effect (±8% = noise) | **Removed** |
| 2 | Full proposition rubric ON/OFF | +17% claims, +20% entities with rubric | Kept (then trimmed — see #7) |
| 3 | Stage/address split vs single-phase compile | Two-phase cost +25% tokens, +40% wall time, produced 28% fewer claims | **Merged** into single `compiling` node |
| 4 | Entity guidance prose | -35% entity fragmentation (26 → 17 entities, same claim count) | **Kept — strongest effect** |
| 5 | WRONG/RIGHT conjunction example (Biome) | Marginal entity consolidation (-21% entities, same claims) | Subsequently stripped (#7) |
| 6 | Recall vs direct Read | Direct Read: 2 tool calls, 25K tokens, 50s. Recall: 11 calls, 52K tokens, 87s. Recall workflow also had no warm-exit — got stuck at sourcing. | Added recall warm-exit edge; memory is net-negative on small fixtures |
| 7a | Knowledge types taxonomy (factual/conceptual/procedural/metacognitive) | No effect (differences within noise) | **Removed** |
| 7b | Independence test | Removing INCREASED claim count +33% — the test is a brake, not an atomizer | Kept for its semantic role; not as quantity driver |
| 8 | Content-vs-graph-structure + enumeration WRONG/RIGHT | Added after finding ~20% of alpha props were enumerations; reduced tier-1 enumerations from ~20% → ~3% | **Retracted** — premise was wrong (enumerations name authoritative sets, which is content, not duplication) |
| 11 | Minified vs full rubric | Minified (6-line rubric): 80 props, 38 entities. Full (full rubric): 61 props, 32 entities. Comparable structure, 62% less YAML. | **Rubric stripped** to minimum; most prose doesn't earn its tokens |

## Ablation detail

### Ablation 1: Lens directive

Tested whether a workload-specific lens ("dev" / "support" / "qa") changed
what the agent extracted. Variants differed only in the lens prose
injected into the compiling instruction.

**Result:** no measurable delta. Claim counts, entity counts, and
vocabulary overlap all within ~8% (run-to-run noise). The lens prose
wasn't steering extraction meaningfully.

**Action:** stripped the lens directive, context field, and config
schema entirely.

### Ablation 2: Full proposition rubric ON/OFF

Tested whether the PROPOSITION_RUBRIC as a whole (independence test +
knowledge types + WRONG/RIGHT + entity guidance) changed output vs a
bare "extract factual claims" instruction.

**Result:** rubric-ON produced +17% claims and +20% entities with
better hub distribution. Proven the rubric as a whole was earning its
keep. Later ablations (7a, 7b, 8) decomposed which sub-parts were
carrying the effect.

### Ablation 3: Stage/address split vs single-phase compile

Tested the two-phase pattern (staging raw claims → addressing with
entity vocabulary → memory_emit) against a single-phase compile node
that does all three in one step.

**Result:** single-phase dominated.
- Two-phase: 47 props, 22 entities, 11 tool calls, 51K tokens, 190s
- Single-phase: 60 props, 22 entities, 9 tool calls, 41K tokens, 136s

Same entity count; single-phase produced +28% more claims at -25%
tokens and -40% wall time. The staging→addressing handoff was pure
overhead — serializing claims to context, re-reading them, then
planning entities is work single-phase does in one pass.

**Action:** merged staging + addressing into a single `compiling`
node in the sealed workflow. Removed `stagedClaims` context field.

### Ablation 4: Entity guidance prose

Tested whether the "search hubs / reuse existing names / fragment
detection" prose affected output. This is the strongest finding.

**Result:**
- With guidance: 50 props, **17 entities** (navigable hubs: Aerobic
  Adaptation Pillars 9 props, Female Physiology 9 props)
- Without guidance: 52 props, **26 entities** (fragmented: separate
  Mitochondrial Biogenesis, AMPK, Fat Oxidation, Capillary Density,
  Muscle Fiber Plasticity entities)

Same claim count — the guidance reshaped graph structure without
changing write-side volume. This is the only prose intervention that
reliably moves the needle across all ablations. It teaches a pattern
(hub thinking) that the agent doesn't default to, and entity identity
requires semantic judgment that can't be mechanized.

**Action:** kept.

### Ablation 5: WRONG/RIGHT example block (Biome)

Tested whether the concrete Biome WRONG/RIGHT example (4-way conjunction
split into 4 atomic props) added value beyond the independence test alone.

**Result:** marginal.
- With example: 53 props, 22 entities
- Without example: 51 props, 28 entities

Same claim count; slightly more entity consolidation with the example.
The example appears to reinforce entity-reuse patterns (Biome appears
in all 4 split props) more than atomicity. Effect smaller than
entity-guidance-itself.

**Action at the time:** kept (low cost). **Subsequent decision:**
removed when the full rubric was stripped (ablation 11 + principled
design shift).

### Ablation 6: Recall vs direct Read

The write-side vs read-side utility test. Same query to two subagents:
alpha uses memory:recall workflow, beta uses direct Read on source files.

**Results:**
- Direct Read: 2 tool calls, 25,024 tokens, 50s, 10 detailed decisions
- memory:recall v1 (broken): 11 tool calls, 51,387 tokens, 80s, stuck
  at sourcing (workflow had no memory-sufficient exit)
- memory:recall v2 (with warm-exit fix): 11 tool calls, 52,289 tokens,
  87s, terminal reached via warm-exit

**Two findings:**

1. **Recall workflow was structurally broken.** It had no path from
   recalling to terminal when memory already covered the query — the
   `sourcing` node required source reads even when unnecessary. Added
   a `recalling → evaluating` warm-exit edge gated on
   `coverageSatisfied`. Now symmetric with compile's warm-exit.

2. **Memory is net-negative on small fixtures.** On a 260-line corpus
   that fits easily in context, direct Read is 2x faster, 2x cheaper,
   and produces comparable answer quality. Memory's pitch isn't
   "better than grep" — it's "navigable knowledge that outlasts
   context". See `docs/memory-intent.md` → "Where memory earns its
   keep".

### Ablation 7a: Knowledge types taxonomy

Tested whether naming the four knowledge types (factual / conceptual /
procedural / metacognitive) affected what the agent extracted,
especially metacognitive claims ("this is uncertain because...").

**Result:** no effect within noise.
- With taxonomy: 65 props, 33 entities
- Without taxonomy: 70 props, 36 entities

Both runs surfaced the same contested-knowledge claims (Zone 3 debate,
ADS prevalence stats). The taxonomy's supposed unique contribution —
flagging metacognitive claims — appeared in both variants.

**Action:** removed.

### Ablation 7b: Independence test

Tested whether removing the independence test ("could either half be
true while the other is false?") degraded atomicity.

**Surprising result:**
- With independence test: 64 props, 34 entities
- Without: 85 props, 34 entities

Removing the test produced **more** claims, not fewer. The test acts
as a brake on over-emission, not as an atomization enforcer. With the
test, the agent scrutinizes each claim and skips ones that don't pass;
without it, the agent emits freely.

**Action:** kept for its semantic role (preventing relationship edge
destruction via over-atomization), but with no illusion that it
improves atomicity metrics.

### Ablation 8: Content-vs-graph-structure + enumeration WRONG/RIGHT (retracted)

Quality audit of ablation 7b alpha output revealed ~20-25% of
propositions were "enumerations" like "Endurance has 3 determinants:
VO2max, Running Economy, Lactate Threshold" — compounds that listed
graph edges in the content.

Hypothesized these were redundant with graph structure (the entities
are linked to shared propositions; "the three determinants" is
already in the edge set). Added a "Content vs graph structure"
principle and a WRONG/RIGHT enumeration example to the rubric.

**Result:** tier-1 enumeration rate dropped from ~20% to ~3%.

**Retraction:** the premise was wrong. Enumerations NAME authoritative
sets — the graph only knows three entities share edges, not that
they're "THE three determinants" vs correlates, influences, or
components. A 4th study's prop linking Heart Rate to Endurance would
create a 4th edge; the enumeration's content names the privileged set.

The addition moved the metric in the desired direction but for the
wrong reason — and the metric wasn't the right target anyway. Removed.

### Ablation 11: Minified rubric

After recognizing the prose-iteration ceiling (ablation findings showed
only entity guidance reliably helped; everything else was noise or
inverse), tested a minified rubric — ~50 tokens of essentials vs
~400 tokens of sealed rubric.

**Result:**
- Minified: 80 props, 38 entities, 128s, 55K tokens
- Full sealed rubric: 61 props, 32 entities, 117s, 53K tokens

Minification produced **more** claims and entities in comparable time.
Entity hub structure held up (Female Physiology 10 vs 9, VO2max 6 vs 7,
run-sync.js 20 vs 15). The 400 extra tokens of rubric prose didn't
earn their keep.

**Action:** stripped the sealed rubric to its load-bearing minimum:
atomicity directive + independence test + relationship exception.
Retracted ablation 8's content-vs-graph additions as part of this
strip.

## Methodological observations

### The atomicity metric was wrong

Much of the ablation work measured write-side properties — claim count,
entity count, conjunction rate, enumeration rate. Mid-experiment it
became clear these don't map to the real objective (read-side utility).

Re-framed in `docs/memory-intent.md`: the rubric teaches the agent to
interact with memory_emit correctly; well-shaped knowledge is a
byproduct. The quality we care about is "does each proposition carry
content-specific meaning that serves a reader?" — which is context-
dependent (different readers want different grain).

### Prose-iteration has a ceiling

Every prose addition after ablation 4 (entity guidance) produced
marginal, null, or inverse effects. The rubric was iterated to
~400 tokens; ablation 11 showed ~50 tokens works comparably well.
Evidence points to: agents already know atomicity heuristics; the
prose adds context noise without changing behavior.

The one exception — entity guidance — teaches a pattern the agent
doesn't default to (hub-thinking vs per-field-labeling). That earns
its tokens.

### Structural fixes beat prose

During ablation 6 the recall workflow turned out to have a topology
bug (no warm-exit path). One edge added was worth more than any
amount of recall prose tuning. Similarly, the watcher bug (sealed
graphs wiped on reload) was surfaced mid-ablation; fixing the topology
was higher leverage than adjusting the workflow's instructions.

### Single-run variance is large

Run-to-run variance across identical conditions appeared to be ~±15%
on claim count. Many sub-part ablations (7a, 7b, 5, 11) produced
deltas within that noise floor. Meaningful findings required either
large effects (entity guidance) or architectural shifts (stage/address
split, merged compiling).

## Methodology

Each ablation ran two blind variants (compile:alpha, compile:beta) that
differed only in the toggled sub-strategy. Subagents had no visibility
into the condition. Memory was reset between runs (post-collections;
earlier runs used collections for isolation).

Metrics captured: proposition count, entity count, entity distribution,
tool calls, tokens, wall time. For some ablations, individual
propositions were inspected for qualitative patterns (compounds,
enumerations, coherent atoms).

Fixture: two snapshotted files from another project (runner-lib) —
physiology.md (~80 lines of dense endurance physiology prose) and
run-sync.js (~180 lines of Node.js connector script). The mix of prose
and code was deliberate: physiology tests conceptual-claim extraction;
run-sync tests code-fact extraction.

## Remaining untested

These ablations remain potential work but don't block the current
principled-design shift:

- **Ablation 8 (priorKnowledgeByPath warm-path)**: does the onEnter
  hook actually prevent re-emission on a second compile run?
- **Ablation 9 (warm-exit actual firing)**: does the exploring →
  evaluating edge fire when coverage is satisfied on a re-run?
- **Ablation 10 (onEnter hook value vs agent-driven)**: does
  pre-populating context.entities beat the agent calling memory_browse
  manually?

These are efficiency tests — they measure whether specific
optimizations work, not knowledge shape. Could be grouped as a single
"efficiency batch" if/when run.
