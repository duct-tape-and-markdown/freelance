---
name: Freelance — Workflow Runner
description: Drive a user-authored Freelance workflow graph through its nodes, gates, and decision points via CLI. Activate when the user asks to run, start, continue, or drive a named workflow that is not one of the sealed memory workflows.
allowed-tools: mcp__freelance__freelance_list, mcp__freelance__freelance_start, mcp__freelance__freelance_inspect, Bash
version: 1.0.0
---

# Drive a user-authored Freelance workflow

This is the catch-all skill for non-sealed workflows — any `.workflow.yaml` the user or team has authored (e.g. `bug-fix`, `feature-implementation`, `code-review`). Each workflow defines its own node topology and instructions; this skill teaches the general driving pattern.

*(Alternative: each user workflow codegens its own skill from the `.workflow.yaml` definition. See `README.md` for that follow-up.)*

## When to use

Activate when:

- The user names a workflow and asks to run it ("run the bug-fix workflow for this issue").
- There is an active traversal of a user-authored workflow and the user is asking to continue it.

**Do not** activate for:

- Sealed memory workflows — those have their own skills (`freelance-memory-compile`, `freelance-memory-recall`).
- Authoring a new workflow — use `freelance_guide` via MCP for that.

## Execution

### 1. Discover available workflows

```
freelance_list()    # via MCP
```

Response lists every loaded graph's `id`, `name`, `description`, plus any active traversals. If the user's requested workflow isn't listed, tell them.

### 2. Start the traversal

Some workflows declare `requiredMeta` — keys that must be supplied at start. If so, collect the values from the user first.

```
freelance_start(
  graphId: "<workflow-id>",
  initialContext: { <any initial keys the workflow's start node expects> },
  meta: { <required meta keys, e.g. externalKey: "PR-123"> }
)
```

Record the returned `traversalId`; every CLI call after this can omit it only when it's the sole active traversal.

### 3. Drive the loop

The workflow's structure decides the shape. General loop:

```bash
# Read the current node's instructions and validTransitions (from start response,
# or via `freelance inspect --detail position --json` on recovery)

# Do the work the node describes.

# Record results the next gate/edge will check:
freelance context set key=value [...] --json

# Advance to the next node:
freelance advance <edge> --json
```

Nodes have types: `action` (do work), `decision` (route on context), `gate` (checkpoint — must pass validations to advance), `wait` (paused on external signal), `terminal` (end).

On a `gate` node that blocks advancement, the response will include a `reason` explaining which validation failed. Fix the relevant context and retry.

### 4. Recovery from context compaction

```
freelance_inspect(traversalId: <id>, detail: "position")   # via MCP
```

Returns the current node, full context, valid transitions, and stack depth. Resume the loop from that state.

### 5. Exit

Reach a `terminal` node naturally. Avoid `freelance reset --confirm` unless the traversal is truly abandoned.

## Meta tags and external identity

If the workflow operates on something with an identity in an external system (a PR, a ticket, a doc path), the workflow likely declares `requiredMeta` at start. Pass the external id as `meta: { externalKey: "<id>" }`. Other agents/users can later find the traversal by that key instead of the opaque `tr_xxxx`.

If a meta tag becomes known mid-traversal:

```bash
freelance meta set prUrl=https://... --json
```

## When the workflow feels wrong

If the workflow's topology fights the work (gates firing on wrong criteria, missing edges, vague instructions):

1. Complete or abandon the current traversal.
2. Invoke `freelance_distill --mode=refine` via MCP for the review prompt.
3. Edit the `.workflow.yaml` per the prompt's guidance.

Don't work around the workflow by skipping `advance` calls — that defeats the purpose of structural enforcement.

## Output shape reminder

Every CLI verb with `--json` returns structured JSON on stdout. Errors go to stderr. Exit codes are semantic (0 success, 2 gate-blocked, 3 validation-failed, 4 not-found, 1 internal).

Parse stdout; read stderr only for breadcrumbs.
