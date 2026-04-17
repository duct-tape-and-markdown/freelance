# Ablation Mapping (researcher-private)

**Do not read this file during an experiment run.** It contains the assignment
of variant labels to ablation conditions, which would bias subagent runs if
the subagent sees it.

## Ablation 1 — Lens directive (completed)

| Variant | Graph ID | Condition |
|---|---|---|
| alpha | `compile:alpha` | Lens directive ON |
| beta  | `compile:beta`  | Lens directive OFF |

**Finding:** no measurable delta. Lens stripped from sealed workflow.

## Ablation 2 — Proposition rubric (completed)

| Variant | Graph ID | Condition |
|---|---|---|
| **alpha** | `compile:alpha` | Rubric ON (baseline) |
| **beta**  | `compile:beta`  | Rubric OFF (ablation) |

**Finding:** rubric is effective (+17% claims, +20% entities, structural hubs).
Rubric kept and tightened.

## Ablation 3 — Stage/address split

Testing whether the two-phase workflow (staging raw claims into context, then
addressing with entity vocabulary before calling memory_emit) produces better
knowledge than a single-phase approach where the agent extracts claims and
emits in one step.

| Variant | Graph ID | Condition | Topology |
|---|---|---|---|
| **alpha** | `compile:alpha` | Two-phase (baseline) | exploring -> staging -> addressing -> evaluating |
| **beta**  | `compile:beta`  | Single-phase (ablation) | exploring -> compiling -> evaluating |

### What differs between variants

Alpha (two-phase):
- `staging` node: agent extracts atomic claims, pushes to context.stagedClaims
- `addressing` node: onEnter populates context.entities, agent reviews staged
  claims against entity vocabulary, calls memory_emit, clears stagedClaims
- context includes `stagedClaims: []` field

Beta (single-phase):
- `compiling` node: agent extracts claims AND plans entities AND calls
  memory_emit in one step. Gets entity vocabulary from onEnter memory_browse.
- No `stagedClaims` context field (no intermediate staging)

### What is identical
- exploring node (same prose, same onEnter hooks, same edges)
- evaluating node (same prose, same edges)
- complete node (terminal)
- Proposition rubric (full rubric in both variants)
- Entity guidance prose (search hubs, reuse existing, etc.)
- All onEnter hooks (memory_status, memory_browse, memory_by_source)
- Name, description (blinded — both say "Compile Knowledge")

### Isolation protocol (post-collections)
Collections have been removed from the memory system. Isolation is now
sequential with reset:
1. Call memory_reset (confirm: true) to clear the db
2. Run variant A, snapshot results to JSON
3. Call memory_reset (confirm: true) again
4. Run variant B, snapshot results to JSON
Both variants use experiments/.freelance/memory/memory.db.

### Run order
Beta first (single-phase), then alpha (two-phase). This follows the
convention of running the ablation condition first so the baseline doesn't
benefit from a warmer entity vocabulary (though memory_reset clears
entities between runs anyway).

### Metrics to compare
- Claim count (total, per source file)
- Avg tokens per proposition (atomicity proxy)
- Conjunction rate ("and", "also", "plus" in proposition content)
- Entity count, connectivity distribution
- Entity vocabulary quality (search hubs vs config-key names)
- Tool call count (proxy for agent reasoning overhead)
