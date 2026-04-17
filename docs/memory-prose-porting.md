# Memory Prose Porting Plan

**Date:** 2026-04-14
**Version analyzed:** freelance v1.3.0
**Scope:** Prompt-engineering level changes to `src/memory/messages.ts` and the `memory:compile` workflow, drawn from prose that proved out in ConnectRoot2's knowledge-compilation workflows and Runner's archived strategies.

This is the tactical companion to `memory-architecture-review.md`. Where that doc is strategic ("what could this become"), this doc is copy-paste actionable ("what to port today").

## Motivating result

Runner's archived `AttributedStrategy` hit **1.00 entity-name consistency** across benchmark runs, specifically because its Phase C Turn 1 locked an entity vocabulary before emission. The strategy was archived for other reasons (Phase B markdown-parsing fragility), but the entity-planning prose that produced that 1.00 number is exactly what's missing from freelance today. That's the strongest empirical evidence that this porting work pays off.

## What freelance's PROPOSITION_RUBRIC already nails

`src/memory/messages.ts:17-30` is genuinely good on two axes:

1. **Concrete compound-splitting example.** The Biome paragraph split into 4 atomic props with entity arrays is excellent teaching prose. It shows, not tells.
2. **Entity-array discipline.** "Never pack extra entities to justify a compound prop — split the compound instead" is the right framing, and most systems miss it.

Where it's thin:

- It teaches **what** atomic means but not **how to decompose**.
- It says nothing about **entity planning** (count, hub concepts, reuse, merge rules).
- The `compiling` node instruction is `${PROPOSITION_RUBRIC}` + "cite sources, call `memory_emit`, update counter." No guidance on what entities to pick, how many, or how to relate them to what's already in the graph.

## Missing prose categories

Four artifacts from ConnectRoot2 each do a specific job freelance currently hand-waves.

### 1. The independence test — the decomposition procedure

**Source:** `.freelance/sources/emission-guidance.md:3-7`

> "Could either claim be true while the other is false?" If yes — two propositions, not one.

This is the underlying semantic check. Freelance's current rule ("if you'd write 'and'…") is a surface pattern match. The two should coexist: the surface check is fast, the independence test is the backstop.

### 2. The split/keep catalog

**Source:** `.freelance/sources/emission-guidance.md:9-17`

```
Split aggressively:
- "X calls Y, then does Z" → "X calls Y" + "after Y, X does Z"
- "X handles A, B, and C" → three props, one per responsibility
- A method AND what happens after it → separate props

Keep together when splitting destroys meaning:
- "validates X by checking Y" — one action with its mechanism
- "delegates to Y via Z" — one relationship
```

This is the subtle one. Freelance's current rubric implies "always split" — but action-with-mechanism and relationship-via-intermediary are correctly single props. Without these exceptions, an agent following the rubric will over-split relationship claims, which is worse than under-splitting: relationships lose their edges when atomized into facts about each entity separately. The relationship **is** the knowledge; don't destroy it.

### 3. The lens directive — vocabulary by intent

**Source:** `.freelance/compilation-stage-and-address.workflow.yaml:26-31`

```
- dev: extract implementation detail, code names, internal structure
- support: extract ONLY user-facing behavior and business rules.
  NO code names, file paths, or internal details.
- qa: extract testable behaviors, validation rules, edge cases
```

The single highest-impact piece of prose ConnectRoot2 has that freelance lacks.

One compiled codebase yields radically different knowledge depending on audience. Without a lens, the agent defaults to a muddled middle-ground that serves nobody well. The lens is ~60 tokens and flips output quality substantially — proven across v3 through v6 iterations.

There's a related-but-distinct concept in `knowledge-compilation-v6.workflow.yaml`: the `queryIntent` classifier (`implementation | architecture | procedural | diagnostic`). That one is for tuning **retrieval**. The lens directive is for shaping **emission**. Freelance should have both, settable on the collection config or on the traversal's start-context.

### 4. Entity planning — hub concepts, ratios, merge rules

**Source:** `.freelance/compilation-stage-and-address.workflow.yaml:64-80`

```
GOOD entities (hub concepts a person searches for):
  "Project Settings", "TED", "Enterprise Features", "Branding"

BAD entities (per-field granularity — these are proposition content):
  "Visual Theme Setting", "String Set Setting", "Dashboard Time Zone",
  "Project Codename Setting", "Product Files Setting"

Rules:
- Reuse existing entities whenever possible — same name, exactly
- Each entity MUST connect to 3+ propositions. If it doesn't, merge
  it into a broader concept. "Visual Theme" → "Branding". "Dashboard
  Timezone" → "Project Settings".
- Maximum entity count: propositions / 3, rounded up.
  20 propositions → max 7 entities. 30 → max 10.
- 1-2 entities per proposition. Most propositions share entities.
```

Three rules of astonishing leverage:

1. **3+ propositions per entity floor.** Prevents the "each setting is its own entity" failure mode that destroys `memory_related`'s usefulness. An entity with one proposition is a content fragment masquerading as a hub.
2. **`propositions / 3` entity ceiling.** Hard upper bound makes the agent **plan** instead of improvise. 20 props → max 7 entities. 30 → max 10.
3. **Concrete GOOD/BAD pairs from the actual domain.** The agent pattern-matches these. This is where teaching-by-example earns its keep.

## The structural reason the entity prose can't currently land

`memory:compile` has a single `compiling` node that does everything: atomicity checking, source citation, and (implicitly) entity selection. When entity planning competes with atomicity checking and source citation for the agent's attention, planning loses.

ConnectRoot2's `compilation-stage-and-address` puts entity planning in its own node. `stage` emits raw propositions **without entities** (5–15 per file, independence test applied). `address` then does a single batch pass over the whole staged set where the agent has nothing to do **except** plan entities — and that's when the "3+ connections or merge" rule starts biting.

Without this structural split, the entity prose above has nowhere to live. Porting the rules alone without the node split will under-deliver.

## Concrete porting plan

### Phase 1: Prose-only additions (no structural change)

Low-lift. Addresses the decomposition gap immediately.

1. **Create `src/memory/emission-guidance.md`** — port the independence test, split/keep catalog, and anti-patterns verbatim from ConnectRoot2's `emission-guidance.md`. Either load it as a sidecar resource or concatenate it into `PROPOSITION_RUBRIC` in `messages.ts`.

2. **Add `context.lensDirective` to `memory:compile`** — enum with domain-appropriate values (start with `dev | support | qa`, or map to your collection's audience). Wire into `workflow.ts:setContext` and inject the lens prose into the `compiling` node's instructions based on the value.

3. **Add a knowledge-types taxonomy note to the rubric.** ConnectRoot2's guide mentions "factual, conceptual, procedural, metacognitive." The metacognitive bucket is the interesting one — it's the "how I figured this out" or "this is uncertain because X" claims that most extractors silently drop. Worth calling out as a legal category.

### Phase 2: Structural change that unlocks entity planning prose

Medium-lift. This is the change that makes entity planning a first-class concern.

4. **Split `compiling` into `staging` and `addressing` nodes** in `memory:compile`. The shape:

   ```
   exploring → staging → addressing → evaluating → complete
                                  ↑                      ↓
                                  └── gaps-remain ───────┘
   ```

   - `staging` emits atomic propositions without entities. Needs a variant of `memory_emit` that accepts empty entity arrays, or a staging-only store that holds raw claims until the address pass.
   - `addressing` calls `memory_browse` to see existing vocabulary, then emits a final pass with planned entities. The entity-planning prose (hub concepts, 3+ floor, `propositions/3` ceiling, GOOD/BAD examples) lives here.

   The ConnectRoot2 yaml at `compilation-stage-and-address.workflow.yaml` is effectively a blueprint — transliterate the nodes into `GraphBuilder` calls in `workflow.ts`, and the prose into `messages.ts` under a new `staging` and `addressing` key.

5. **Parameterize the GOOD/BAD entity examples per collection.** The reason ConnectRoot2's "Project Settings" vs "Visual Theme Setting" works is that those are real terms from the real domain. Generic examples won't land as hard. Options:
   - Store exemplars in collection config (e.g. a `prose.entityExamples` field).
   - Autogenerate them by querying the top-N most-connected entities in the collection and injecting them as GOOD examples at addressing-node entry (see Phase 3).

### Phase 3: onEnter automation

The payoff layer. Pure-code hooks that don't cost agent tool calls.

6. **`addressing` node onEnter: inject current vocabulary.** A script calls `memory_browse({ collection, limit: 50 })` and injects the results directly into the node's instruction text as "current vocabulary — reuse these entity names when claims overlap." This is the automation equivalent of what ConnectRoot2's v6 does with `compiler_browse_entities` as an agent call — but as a hook it's free, fast, and guaranteed to fire.

7. **`exploring` node onEnter: attach prior knowledge per file.** For each path the agent has added to `context.filesReadPaths`, a script calls `memory_by_source` and attaches the existing propositions to context. The agent sees "here's what we already know about this file" alongside the source content and only stages deltas. Warm exit is emergent when the delta is empty. See `memory-architecture-review.md` §5 for the broader context.

## Priority pick

If you port exactly one thing from this doc, port the **independence test plus split/keep catalog** into `PROPOSITION_RUBRIC`. It's one prose block, changes no schemas, requires no new nodes, and directly fixes the failure mode you'll hit the moment you start compiling a real domain: agents over-atomizing relationships into disconnected facts about each entity separately.

The diff is approximately:

```typescript
// src/memory/messages.ts — append to PROPOSITION_RUBRIC
const PROPOSITION_RUBRIC =
  "Emit ATOMIC propositions: ONE factual claim per proposition, one sentence strongly preferred, two sentences maximum. " +
  // ... existing rubric ...

  // NEW: independence test
  "\n\n## The independence test\n" +
  "For every candidate proposition, ask: \"Could either claim be true while the other is false?\" " +
  "If yes — two propositions. This is the semantic backstop behind the 'no and / also / plus' surface rule.\n\n" +

  // NEW: split/keep catalog
  "## Split aggressively\n" +
  "- \"X calls Y, then does Z\" — two props: X calls Y; after Y, X does Z\n" +
  "- \"X handles A, B, and C\" — three props, one per responsibility\n" +
  "- A method AND what happens after it — separate props\n\n" +
  "## Keep together when splitting destroys meaning\n" +
  "- \"validates X by checking Y\" — one action with its mechanism\n" +
  "- \"delegates to Y via Z\" — one relationship\n" +
  "Relationship claims are knowledge IN THEMSELVES. Don't atomize 'A depends on B' into separate facts about A and B — the edge IS the claim.";
```

That's the minimum viable port. Phase 2 and Phase 3 are where the real leverage is, but this paragraph alone is worth doing today.

## References

- Freelance current rubric: `C:\Users\JohnC\Repos\freelance\src\memory\messages.ts:17-30`
- Freelance sealed workflow: `C:\Users\JohnC\Repos\freelance\src\memory\workflow.ts`
- ConnectRoot2 emission guide: `C:\Users\JohnC\ConnectRoot2\connect\.freelance\sources\emission-guidance.md`
- ConnectRoot2 stage-and-address subgraph: `C:\Users\JohnC\ConnectRoot2\connect\.freelance\compilation-stage-and-address.workflow.yaml`
- ConnectRoot2 unified v6 workflow: `C:\Users\JohnC\ConnectRoot2\connect\.freelance\knowledge-compilation-v6.workflow.yaml`
- Runner strategy decision (1.00 consistency result): `C:\Users\JohnC\Repos\runner\docs\STRATEGY-DECISION.md`
- Runner archived AttributedStrategy: `C:\Users\JohnC\Repos\runner\src\compiler\strategies\archived\attributed.ts`
