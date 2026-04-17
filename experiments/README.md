# Freelance Experiments

Behavioral ablation experiments against the freelance MCP. Each experiment
isolates a single sub-strategy of the real compile workflow and measures
whether it earns its complexity budget by running two blind variants of
the same workflow against a controlled fixture and diffing the outputs.

These are **not** unit tests. They don't run under `npm test` and don't
ship in the npm tarball. They exist so we can empirically study agent
behavior against controlled inputs and measure the effect of individual
design decisions.

## Layout

```
experiments/
├── .freelance/                    # project-local freelance config
│   ├── compile-alpha.workflow.yaml
│   ├── compile-beta.workflow.yaml
│   ├── memory/                    # runtime, gitignored
│   └── traversals/                # runtime, gitignored
├── fixtures/
│   └── ablation-1/                # shared fixture for ablation #1
│       ├── physiology.md
│       └── run-sync.js
├── ablation-1/                    # per-experiment artifacts
│   └── runs/                      # run reports go here
└── _private/                      # researcher-only notes (do NOT read during runs)
    └── mapping.md                 # variant → condition mapping
```

## Blinding

Variants for a single ablation share **identical** `name`, `description`,
and topology. The only visible difference is the graph id (e.g.
`compile:alpha` vs `compile:beta`). A subagent running one of them cannot
tell by metadata inspection which condition it's in. The researcher
records the condition mapping in `_private/mapping.md` — subagents are
instructed not to read that file.

## Memory isolation

Each run loads from `experiments/.freelance/`, which has its own
`memory/memory.db` separate from the main project memory. Nothing bleeds
into the main workspace. Delete the memory dir to reset between runs.

## Adding a new experiment

1. Add a fixture snapshot under `experiments/fixtures/<name>/`.
2. Clone the baseline workflow yaml as a new pair of variants in
   `experiments/.freelance/`, toggling a single sub-strategy between them.
3. Both variants must share identical name + description.
4. Document the mapping in `_private/mapping.md` — which variant is which
   condition, what the ablated variable is, what metrics to compare.
5. Run both variants with fresh subagents, dump outputs to
   `experiments/<name>/runs/`, diff and report.

## Running an experiment

For a given ablation:

1. Clear `experiments/.freelance/memory/memory.db` (cold-start state).
2. Spawn a subagent with access to the freelance MCP, give it the fixture
   paths, the graph id to run (alpha or beta — do not reveal which is
   baseline), the target collection, and the query.
3. Let the subagent drive the traversal: read files, stage claims, plan
   entities, emit via memory_emit, reach terminal.
4. After terminal, snapshot the collection (propositions + entities +
   source attributions) to a run report.
5. Clear memory db, repeat for the other variant.
6. Compare the two reports.

The runner infrastructure for steps 1-5 is currently manual — the
researcher drives each run via subagent spawns. A headless CLI runner
that scripts the whole cycle is a future addition.
