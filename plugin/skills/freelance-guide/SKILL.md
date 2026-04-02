---
name: freelance-guide
description: How to use Freelance workflow enforcement. Claude should read this when working with graph workflows, traversals, or when Freelance MCP tools are available.
---

# Freelance — Workflow Enforcement

Freelance is a graph engine MCP that enforces structured workflows. State is server-side — it survives context compaction.

## Available Tools

- `freelance_list` — List available workflows
- `freelance_start` — Begin a workflow traversal
- `freelance_advance` — Move to the next node via an edge label
- `freelance_context_set` — Update traversal context as you complete work
- `freelance_inspect` — Check current traversal state (node, context, available edges)
- `freelance_reset` — Reset or abandon a traversal (`{ confirm: true }`)
- `freelance_guide` — Get graph authoring help
- `freelance_distill` — Distill a task into a new workflow, or refine an existing one
- `freelance_sources_hash` — Content provenance stamping
- `freelance_sources_check` — Validate source bindings
- `freelance_sources_validate` — Check source hashes across loaded graphs

## During a Traversal

1. Read the instructions at each node and execute them
2. Update context via `freelance_context_set` as you complete work
3. Advance via `freelance_advance` with the appropriate edge label
4. If `freelance_advance` returns an error, read it — it tells you what's wrong
5. Never skip nodes. Never guess at transitions
6. Call `freelance_inspect` if you lose track of where you are
7. Call `freelance_reset({ confirm: true })` to start over or switch workflows

## Getting Started

Call `freelance_list` to see available workflows, then `freelance_start` to begin one.
Call `freelance_guide` for help authoring new graph definitions.
