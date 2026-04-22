---
name: Freelance
description: Drive a Freelance workflow — graph-based gated traversals for structured multi-step work. Activate when the user names a workflow to run, describes a task matching a loaded workflow, asks to compile or recall knowledge into Freelance memory, or wants to continue an in-flight traversal.
allowed-tools: Bash
version: 1.0.0
---

# Driving Freelance workflows

Freelance is graph-based workflow enforcement for AI agents. The **workflow graph** carries the domain knowledge (what to do at each step, when to gate, which edges to take). This skill carries the **invariant protocol** for driving any workflow via the `freelance` CLI.

**Key idea:** the workflow is the teacher. Every `advance` response returns the new node's full teaching surface — `instructions`, `suggestedTools`, valid edges with descriptions, sources. Read the response, follow the instructions, pick the edge, advance. You don't need prior knowledge of any specific workflow.

## Discover loaded workflows

```bash
freelance status
```

Returns `{ graphs: [...], activeTraversals: [...] }`. Each graph has `id`, `name`, `description`, `version`. Active traversals carry `traversalId`, `graphId`, `currentNode`, `meta`.

## Start a traversal

```bash
freelance start <graphId> \
  [--context '<json object>'] \
  [--meta key=value [--meta key=value]...]
```

Response shape:

```json
{
  "traversalId": "tr_xxxxx",
  "status": "started",
  "currentNode": "<node id>",
  "node": { "instructions": "...", "suggestedTools": [...], "sources": [...] },
  "validTransitions": [
    { "label": "...", "target": "...", "condition": "...", "conditionMet": true, "description": "..." }
  ],
  "context": { ... },
  "meta": { ... }
}
```

Record the `traversalId`. If the graph declares `requiredMeta`, start rejects calls missing those keys with exit code 5 — pass them via `--meta`.

## The driving loop

Every `advance`, `context set`, and `inspect` response has the same shape as `start` above. The loop:

1. **Read `node.instructions`.** This is what the workflow wants you to do at this step.
2. **Do the work.** Use whatever tools (`Read`, `Grep`, `Edit`, etc.) the instructions call for.
3. **Record outcomes in context.** Values that gates or edge conditions will check:
   ```bash
   freelance context set testsPass=true coverage=0.92
   ```
   Values are JSON-coerced: `true`/`false` become booleans, numerics become numbers, anything else stays a string.
4. **Pick an edge.** From `validTransitions`, find the one whose `conditionMet: true` matches your outcome. Consult `condition` and `description` to disambiguate.
5. **Advance.**
   ```bash
   freelance advance <edge-label>
   ```
6. **Parse the new response.** Return to step 1 with the new `node.instructions`.

Repeat until you reach a terminal node (`status: "complete"`).

To preview the current node's edges without advancing, call `freelance advance` with no edge — the response returns `{ traversalId, validTransitions }` only.

## Output conventions

- **stdout** — every runtime verb emits a JSON object. Always parseable; shape is verb-specific.
- **stderr** — breadcrumbs (memory enabled, graphs loaded). Ignore unless debugging.
- **Exit codes** — branch on these before parsing stdout:
  - `0` success
  - `1` internal error — report to the user, don't retry
  - `2` blocked — an edge condition, wait condition, validation, or return schema blocked the advance. Fix context (see `validTransitions[i].condition` and the error message), retry the same edge.
  - `3` validation failed — graph structural validation (authoring-time, rare during a live traversal)
  - `4` not found — traversal id, graph id, or edge doesn't exist. Usually means a stale id or a typo; don't retry.
  - `5` invalid input — the call was malformed (bad JSON, missing `=` in key=value, unknown shell for completion). Fix the call, retry.

## Error shape on stdout

Every error — whether a gate-block on `advance` or a structural failure anywhere — carries the same envelope:

```json
{
  "isError": true,
  "error": { "code": "...", "message": "...", "kind": "blocked" | "structural" }
}
```

Branch on `error.kind` before anything else:

- `"blocked"` — the traversal is fine; the last op can't proceed given current state. Fix context and retry. Exit 2. Response carries extra fields (`status: "error"`, `currentNode`, `validTransitions`, `context`) so you can pick a different edge or adjust context without another round-trip.
- `"structural"` — something's wrong (bad graph id, unknown edge, malformed input, broken hook). Retrying won't help; report to the user.

Common codes:

- `WAIT_BLOCKING` / `RETURN_SCHEMA_VIOLATION` / `VALIDATION_FAILED` / `EDGE_CONDITION_NOT_MET` — gate blocks on `advance`. Kind `"blocked"`. Exit 2. Read the message and `validTransitions` to decide the next move.
- `NO_EDGES` — the current node is terminal. Kind `"blocked"`. Exit 2.
- `EDGE_NOT_FOUND` — the edge label doesn't exist on the current node. Kind `"structural"`. Exit 4. Check `validTransitions`.
- `TRAVERSAL_NOT_FOUND` / `NO_TRAVERSAL` / `AMBIGUOUS_TRAVERSAL` — traversal id issue. Kind `"structural"`. Exit 4 or 5.
- `STRICT_CONTEXT_VIOLATION` — tried to write a key the graph's context schema doesn't declare. Kind `"structural"`. Exit 5.
- `CONTEXT_VALUE_TOO_LARGE` / `CONTEXT_TOTAL_TOO_LARGE` — write exceeds the byte cap. Kind `"structural"`. Exit 5. Shrink the value or split across calls.
- `REQUIRED_META_MISSING` — `start` without required meta keys. Kind `"structural"`. Exit 5. Rerun with `--meta k=v`.
- `HOOK_FAILED` / `HOOK_IMPORT_FAILED` / `HOOK_BAD_SHAPE` — an `onEnter` hook is broken. Kind `"structural"`. Exit 1. Surface to the user; don't loop.

## Recovery from context compaction

If you lose track of where a traversal is:

```bash
freelance inspect [<traversalId>]                # current node + validTransitions
freelance inspect [<traversalId>] --detail history   # step history + context writes
freelance inspect [<traversalId>] --detail history --limit 10 --offset 0
                                                 # paginate traversalHistory (default 50, max 200)
freelance inspect [<traversalId>] --detail history --include-snapshots
                                                 # include per-step contextSnapshot (opt-in: quadratic size)
freelance inspect [<traversalId>] --fields currentNode --fields neighbors
                                                 # additive projections (repeatable):
                                                 # currentNode | neighbors | contextSchema | definition
```

`--active` lists every active traversal with its current node. `--waits` filters that list to traversals sitting on a wait node.

`freelance status` includes a `loadErrors: [{file, message}]` array if any workflow yaml in the graphs dir failed to parse or validate. The field is elided when empty — its presence means at least one file was silently dropped from the `graphs` listing.

`freelance status` also includes an `orphanedTraversals: [{traversalId, graphId, currentNode, lastUpdated, ...}]` array when any traversal record points at a graph that isn't loaded (yaml deleted, renamed, or in `loadErrors`). Also elided when empty. Orphans are _not_ in `activeTraversals` — reporting them distinctly tells the user the traversal can't advance without operator action: either restore the graph yaml, or run `freelance reset <traversalId> --confirm` to clear. Calling `freelance advance` / `freelance inspect` on an orphan fails with `GRAPH_NOT_FOUND` (structural, exit 4) and the message repeats the same two recovery options.

## Lean responses (`--minimal`)

`freelance advance`, `freelance context set`, and `freelance inspect` accept `--minimal`. The response drops the full `context` echo and the `node` NodeInfo blob (instructions, suggestedTools, sources) and returns `{ currentNode, validTransitions, contextDelta, status, ... }`. `contextDelta` names the keys written this turn — your own updates plus anything an `onEnter` hook wrote — so hook activity stays visible without re-shipping unchanged state.

Use it on the steady-state loop once you've seen the node's `instructions` at least once and you're just picking edges. Drop `--minimal` (or call `freelance inspect`) to resync to the full shape after compaction or when you land on a new node you haven't seen yet.

### Three projection verbs, three axes

- Response size → `--minimal` (bool, hot-path verbs: `advance`, `context set`, `inspect`)
- Extra fields → `--fields <name>` (repeatable, inspect only)
- Memory provenance depth → `--shape minimal|full` (memory inspect only)

They don't substitute. `advance --shape` and `memory inspect --minimal` both fail `INVALID_FLAG_VALUE`.

## Subgraphs

Some workflows push subgraph calls. Responses include:

- `subgraphPushed: { graphId, startNode, stackDepth }` when a subgraph begins.
- `status: "subgraph_complete"` with `completedGraph` and `returnedContext` when a subgraph's terminal is reached and values flow back to the parent.
- `stackDepth` shows nesting depth.

You drive the same way regardless of depth — read the new node's instructions, advance.

## Meta tags

Meta is opaque key/value tagging for external lookup (PR urls, ticket ids, branch names). Freelance never interprets meta; it's purely for the agent or external tools to find a traversal by a known key later. Set at start or mid-traversal:

```bash
freelance meta set prUrl=https://... branch=feature/x
```

## Memory operations

When a workflow involves memory (`memory:compile`, `memory:recall`, or user workflows that use memory), the node instructions will tell you to emit or query. Propositions come from a JSON file or stdin:

```bash
freelance memory emit /tmp/props.json
freelance memory emit -     # read from stdin
```

Read operations (available any time):

```bash
freelance memory status
freelance memory browse [--name X] [--kind Y] [--limit N] [--offset N]
freelance memory search "<query>" [--limit N]
freelance memory inspect <entityIdOrName> [--limit N] [--offset N] [--shape minimal|full]
freelance memory related <entityIdOrName> [--limit N] [--offset N]
freelance memory by-source <filePath> [--limit N] [--offset N]
```

`--shape minimal` on `memory inspect` trims per-proposition source details when you want the entity graph but not full provenance; default is `full`.

Maintenance:

- `freelance memory prune --keep <ref> [--keep <ref>]... [--dry-run | --yes]` — remove source rows whose content no longer matches either the working tree or any `--keep` ref. Always preview with `--dry-run` before running with `--yes`.
- `freelance memory reset --confirm` — delete the db + WAL/SHM sidecars. Recovery path for schema-mismatch after an upgrade. Destroys all memory; the user should be aware.

`memory emit` is gated server-side on "must be inside an active traversal". Skill activation implies one; nothing further to do.

## Exit

Reach a terminal node — the response has `status: "complete"` and carries a `traversalHistory` summary. Traversal is done; nothing to clean up.

Avoid `freelance reset --confirm` except to abandon a traversal that's genuinely stuck. Reset destroys context; it's not the normal exit.

## Authoring and refinement (meta-operations)

If the user asks to *author* a workflow or *refine* one after running:

```bash
freelance guide [topic]              # authoring help; no topic for TOC
freelance distill --mode distill     # prompt for distilling an ad-hoc task into a workflow
freelance distill --mode refine      # prompt for improving a workflow after running it
```

These return Markdown prompts. Read them, follow the instructions, edit `.workflow.yaml` files accordingly.

## The only thing to remember

The workflow leads. Read each response's `node.instructions`, follow them, record outcomes, advance. This skill is just the protocol for talking to the engine; the engine's responses carry the domain knowledge JIT.
