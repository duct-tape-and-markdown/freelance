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

- `memory_emit` — Write propositions about 1-2 entities with per-file source attribution (sources are hashed at emit time for per-proposition provenance)

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

## onEnter Hooks

Any node can declare `onEnter: [{ call, args }]` hooks that run automatically on node arrival — **before the agent sees the node**. Use them to populate context from external state so the agent arrives with everything it needs for the next step, instead of spending a turn fetching data.

- `call` resolves to either a **built-in hook** (`memory_status`, `memory_browse`) or a **relative path** to a local script (`./scripts/foo.js`). The script is an ES module with a default-export async function; it receives `{ args, context, memory, graphId, nodeId }` and returns a plain object merged into session context.
- `args` values matching the string pattern `context.foo.bar` are resolved against live context at invocation time; everything else is a literal.
- Hooks run sequentially. Each hook's return value is merged before the next fires, so later hooks can read earlier hooks' writes.
- Per-hook timeout defaults to 5000ms, configurable via `hooks.timeoutMs` in `config.yml`.
- A throwing or timing-out hook aborts node arrival with an `EngineError` — the traversal stays on the previous node.

**When to use a hook** instead of agent-driven context updates: when the data is always needed at this node, comes from a deterministic source (memory, filesystem, well-known API), and would otherwise cost an extra agent round-trip with no decision value. Don't use hooks when the agent needs to reason about whether/how to fetch, when the operation is user-visible or has side effects, or when the result determines routing.

**Trust model**: local script hooks execute with full Node.js privileges. A `.workflow.yaml` that references a local script is trusted code — treat it like a `package.json` scripts block.

Call `freelance_guide onenter-hooks` for the full authoring guide (schema, script contract, execution semantics, anti-patterns).

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
