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
freelance status --json
```

Returns `{ graphs: [...], activeTraversals: [...] }`. Each graph has `id`, `name`, `description`, `version`. Active traversals show `traversalId`, `graphId`, `currentNode`, `meta`.

## Start a traversal

```bash
freelance start <graphId> --json \
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
    { "label": "...", "target": "...", "condition": "...", "conditionMet": true/false, "description": "..." }
  ],
  "context": { ... },
  "meta": { ... }
}
```

Record the `traversalId`. If `requiredMeta` is declared on the graph, start will reject calls missing those keys — pass them via `--meta`.

## The driving loop

Every `advance`, `context set`, and `inspect` response has the same shape as `start` above. The loop:

1. **Read `node.instructions`.** This is what the workflow wants you to do at this step.
2. **Do the work.** Use whatever tools (`Read`, `Grep`, `Edit`, etc.) the instructions call for.
3. **Record outcomes in context.** Values that gates or edge conditions will check:
   ```bash
   freelance context set testsPass=true coverage=0.92 --json
   ```
4. **Pick an edge.** From `validTransitions`, find the one whose `conditionMet: true` matches your outcome. Consult `condition` and `description` to disambiguate.
5. **Advance.**
   ```bash
   freelance advance <edge-label> --json
   ```
6. **Parse the new response.** Return to step 1 with the new `node.instructions`.

Repeat until you reach a terminal node (`status: "complete"`).

## Recoverable errors

If `advance` returns `isError: true` with `status: "error"`, the engine blocked the advance. The `reason` field tells you why:

- **Edge condition not met** — fix the relevant context, retry the same edge.
- **Validation failed** — a gate's validation expression evaluated false. The message names the validation; set the context value it expects.
- **Waiting for external signals** — a `wait` node's conditions aren't satisfied yet. Check `waitingOn` for what's needed.
- **Return schema violation** — a subgraph's returnMap has missing/wrong-typed fields. Fix context keys the returnMap expects.

The current node does not change on a blocked advance. Fix state and retry.

## Recovery from context compaction

If you lose track of where a traversal is:

```bash
freelance inspect [<traversalId>] --detail position --json
```

Returns the current node, full context, valid transitions, stack depth, and any active wait conditions. Resume the loop.

For a deeper picture:
- `--detail history` — every step taken + every context write.
- `--detail full` — the entire graph definition plus context.

## Subgraphs

Some workflows push subgraph calls. Responses include:
- `subgraphPushed: { graphId, startNode, stackDepth }` when a subgraph begins.
- `status: "subgraph_complete"` with `completedGraph` and `returnedContext` when a subgraph's terminal is reached and values flow back to the parent.
- `stackDepth` shows nesting depth.

You drive the same way regardless of depth — read the new node's instructions, advance.

## Meta tags

Meta is opaque key/value tagging for external lookup (PR urls, ticket ids). Freelance never interprets meta; it's purely for you or external systems to find a traversal by a known key later. Set at start or mid-traversal:

```bash
freelance meta set prUrl=https://... branch=feature/x --json
```

## Memory operations

When a workflow involves memory (`memory:compile`, `memory:recall`, or user workflows that use memory), the node instructions will tell you to emit or query. Write propositions from a JSON file:

```bash
freelance memory emit --file /tmp/props.json --json
freelance memory emit - --json < /tmp/props.json   # via stdin
```

Read operations:

```bash
freelance memory status --json
freelance memory browse [--name X] [--kind Y] --json
freelance memory search "<query>" --limit 20 --json
freelance memory inspect <entityIdOrName> --json
freelance memory related <entityIdOrName> --json
freelance memory by-source <filePath> --json
```

`memory emit` is gated server-side on "must be inside an active traversal." The skill activation already implies one; nothing further to do.

## Exit

Reach a terminal node — the response has `status: "complete"` and carries a `traversalHistory` summary. Traversal is done; nothing to clean up.

Avoid `freelance reset --confirm` except to abandon a traversal that's genuinely stuck. Reset destroys context; it's not the normal exit.

## Authoring and refinement (meta-operations)

If the user asks to *author* a workflow or *refine* one after running:

```bash
freelance guide [topic]              # authoring help, see `guide` with no topic for TOC
freelance distill --mode distill     # prompt for distilling an ad-hoc task into a workflow
freelance distill --mode refine      # prompt for improving a workflow after running it
```

These return Markdown prompts. Read them, follow the instructions, edit `.workflow.yaml` files accordingly.

## Output conventions

- `--json` — structured response on stdout. Always use this; parsing prose is fragile.
- Exit codes are semantic: `0` success, `2` gate/edge blocked, `3` validation failed, `4` not found, `5` invalid input, `1` internal error.
- stderr carries breadcrumbs (config load, memory enabled messages) — ignore unless debugging.

## The only thing to remember

The workflow leads. Read each response's `node.instructions`, follow them, record outcomes, advance. This skill is just the protocol for talking to the engine; the engine's responses carry the domain knowledge JIT.
