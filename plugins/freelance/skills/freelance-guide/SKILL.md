---
name: freelance-guide
description: How to use Freelance workflow enforcement and memory. Claude should read this when working with graph workflows, traversals, memory tools, or when Freelance MCP tools are available.
---

# Freelance — Workflow Enforcement & Memory

Freelance is a graph engine MCP that enforces structured workflows and builds a persistent knowledge graph. State is server-side — it survives context compaction.

## Workflow Tools

- `freelance_list` — List available workflows and active traversals
- `freelance_start` — Begin a workflow traversal
- `freelance_advance` — Move to the next node via an edge label
- `freelance_context_set` — Update traversal context as you complete work
- `freelance_inspect` — Check current traversal state (node, context, available edges)
- `freelance_reset` — Reset or abandon a traversal (`{ confirm: true }`)
- `freelance_guide` — Get graph authoring help
- `freelance_distill` — Distill a task into a new workflow, or refine an existing one
- `freelance_validate` — Validate graph definitions
- `freelance_sources_hash` — Content provenance stamping
- `freelance_sources_check` — Validate source bindings
- `freelance_sources_validate` — Check source hashes across loaded graphs

## Memory Tools

Memory is a persistent knowledge graph backed by SQLite. The agent reads source files, reasons about them, and writes propositions. Every proposition tracks its source files and their content hashes — when files change, propositions are marked stale.

Write tools (gated by an active `memory:compile` or `memory:recall` traversal):

- `memory_register_source` — Hash one or more source files and return their content hashes (stateless echo)
- `memory_emit` — Write propositions about 1-2 entities with per-file source attribution

Read tools (available anytime):

- `memory_browse` — Find entities by name or kind, optionally scoped to a collection
- `memory_inspect` — Full entity details with propositions, neighbors, and deduped source files
- `memory_by_source` — All propositions linked to a source file
- `memory_related` — Entity graph navigation — co-occurring entities with connection strength
- `memory_search` — Full-text search across proposition content (FTS5)
- `memory_status` — Knowledge graph health: total, valid, stale counts

### Memory Workflows

Two sealed workflows are available as subgraphs:
- `memory:compile` — Read sources, emit propositions, evaluate coverage
- `memory:recall` — Recall existing knowledge, read provenance sources, compare, fill delta

### Collections

Propositions can be scoped to named collections (e.g., "default", "spec"). All read tools accept an optional `collection` parameter to filter results.

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
Call `memory_status` to check the knowledge graph health.
