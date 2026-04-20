---
name: Freelance — Compile Knowledge
description: Compile atomic factual propositions from source files into the Freelance knowledge graph. Activate when the user asks to capture, extract, compile, or persist knowledge from docs, code, markdown, or other source material into memory.
allowed-tools: mcp__freelance__freelance_start, mcp__freelance__freelance_inspect, Bash, Read, Grep
version: 1.0.0
---

# Compile knowledge into Freelance memory

This skill drives the sealed `memory:compile` workflow — extracts atomic claims from source files and writes them to the memory knowledge graph with per-proposition provenance.

## When to use

Activate when the user asks you to:

- Capture/compile/extract knowledge from a file or directory
- Build up a memory graph before a later recall session
- Refresh propositions after source files changed

**Do not** activate for:

- One-shot questions answerable by reading the file directly (use `freelance-memory-recall` or direct Read instead).
- Freeform conversation — memory writes require a structured traversal.

## Execution

### 1. Verify prerequisites

Run once:

```bash
freelance memory status --json
```

If the response errors with "memory disabled," stop and ask the user to enable memory in `.freelance/config.yml`.

### 2. Start the traversal

Via MCP:

```
freelance_start(
  graphId: "memory:compile",
  initialContext: { sourcePaths: [<files the user wants compiled>] }
)
```

Response includes `traversalId`, the start-node instructions, and `validTransitions`. Note the `traversalId` — every subsequent CLI call omits it only when it's the sole active traversal.

### 3. Drive the workflow via CLI

After start, every verb is a Bash invocation with `--json`:

```bash
freelance advance <edge> --json
freelance context set key=value [key=value...] --json
freelance memory emit --file <path-or-stdin> --json
freelance memory browse [--name ...] [--kind ...] --json
freelance inspect --detail position --json
```

Parse each JSON result; its `validTransitions` tells you the legal next edges and which ones have `conditionMet: true`.

### 4. Node-by-node recipe

The `memory:compile` graph has these phases (verify via `freelance_inspect` on start):

- **exploring** — read sources, list entities found, browse memory for existing vocabulary. `onEnter` pre-populates `context.priorKnowledgeByPath`.
  - *Warm-exit:* if every source in `priorKnowledgeByPath` has complete coverage, take `warm-exit` to `evaluating` directly.
  - *Cold path:* take `to-compiling` to proceed.
- **compiling** — emit propositions. Use `freelance memory emit` with a JSON file containing the proposition list. Each proposition needs `content` (1 atomic claim), `entities` (1-4 names), `sources` (file paths).
- **evaluating** — a gate node. Reflect on whether emission covered the source material. If gaps remain, loop back to `compiling`; otherwise advance to `complete`.

The agent provides the judgment (atomicity, entity choice, coverage assessment). The graph provides the gates.

### 5. Recovery

If context is compacted mid-traversal:

```
freelance_inspect(traversalId: <id>, detail: "position")  # via MCP
```

…returns full context and the current node. Resume from there.

## Atomicity guidance

Apply the **independence test** per proposition: *if either half of the claim could be true while the other is false, it's two propositions, not one.*

Exception: relationship claims like "A depends on B" — the edge IS the knowledge; splitting destroys graph connectivity.

Anti-patterns that break graph structure:

- Enumerations: "The three pillars of X are A, B, C" — duplicates the edge set the per-pillar props already carry.
- Conjunctions of independent topics: "X was built by Y, and Z runs it, and the pass did Q."

See `references/atomicity.md` for the full rubric.

## Source-path resolution

Paths in `sources` resolve against the configured `sourceRoot` (usually the project root). Relative paths are normalized before hashing.

## When to stop

Exit via `complete` when:

- The agent's proposition emissions cover the source material at the level of the atomic-claim rubric.
- `memory status` shows the new propositions reflected in `total_propositions`.

Reset (`freelance reset --confirm`) only if the traversal hit a dead end and the graph authoring needs refinement — not as a normal workflow exit.

## References

- `references/atomicity.md` — the full independence-test rubric with examples
- `references/entity-guidance.md` — "navigable hubs, not fragments" — how to name entities
- `references/proposition-shapes.md` — what a well-shaped proposition looks like

(Reference files not included in this prototype; would ship alongside SKILL.md.)
