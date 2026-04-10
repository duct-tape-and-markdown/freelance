# Spec: CLI parity with MCP tools

## Problem

Freelance requires an MCP client (Claude Code, Cursor, etc.) for traversal operations. The existing `traversals` CLI subcommand group exposes only `list`, `inspect`, and `reset` — and even those are hidden. Users without MCP clients, CI pipelines, and automation scripts have no way to drive most workflow operations from the terminal.

This spec focuses on the CLI command surface: making every MCP tool available as a CLI command. Daemon stabilization (lifecycle, PID management, testing, unhiding) is tracked separately in #27.

## Goals

1. **Full CLI surface** — every MCP tool has a CLI equivalent
2. **No daemon required** — CLI operates directly on the SQLite state DB, same as the MCP server
3. **Consistent UX** — auto-resolution, output format, and error messages match MCP behavior

## Current state

### CLI commands vs MCP tools

The `traversals` subcommand group (hidden) exposes only `list`, `inspect`, and `reset`. The full gap:

| MCP tool | CLI command | Status |
|----------|-------------|--------|
| `freelance_list` | `traversals list` | Exists (hidden) |
| `freelance_start` | — | **Missing** |
| `freelance_advance` | — | **Missing** |
| `freelance_context_set` | — | **Missing** |
| `freelance_inspect` | `traversals inspect <id>` | Exists (hidden) |
| `freelance_reset` | `traversals reset <id>` | Exists (hidden) |
| `freelance_guide` | — | **Missing** |
| `freelance_distill` | — | **Missing** |
| `freelance_validate` | `validate <dir>` | Exists (public) |
| `freelance_sources_hash` | — | **Missing** |
| `freelance_sources_check` | — | **Missing** |
| `freelance_sources_validate` | — | **Missing** |
| `memory_register_source` | — | **Missing** |
| `memory_emit` | — | **Missing** |
| `memory_end` | — | **Missing** |
| `memory_browse` | — | **Missing** |
| `memory_inspect` | — | **Missing** |
| `memory_by_source` | — | **Missing** |
| `memory_search` | — | **Missing** |
| `memory_related` | — | **Missing** |
| `memory_status` | — | **Missing** |

### Key insight: no daemon needed

Traversal state is persisted in SQLite via `TraversalStore` (`src/state/traversal-store.ts`). Memory state is persisted in SQLite via `MemoryStore` (`src/memory/store.ts`). The MCP server (`src/server.ts`) instantiates both stores directly — no daemon involved. The daemon (`src/daemon.ts`) is just an HTTP wrapper around `TraversalStore`.

CLI commands can do the same thing: load graphs, open the SQLite DBs, perform the operation, close. This eliminates the daemon as a dependency entirely and makes every command self-contained.

## Design

### Architecture: direct SQLite access

Every CLI command follows the same pattern as the MCP server:

1. Resolve graph directories (same cascading logic as `freelance mcp`)
2. Load graphs from disk
3. Open SQLite DBs (`.freelance/.state/state.db` for traversals, `.freelance/.state/memory.db` for memory)
4. Instantiate `TraversalStore` / `MemoryStore` as needed
5. Perform the operation
6. Close and exit

No daemon, no HTTP, no long-running process. The SQLite DBs are the shared state between the MCP server and CLI — they can coexist because SQLite handles concurrent access via WAL mode.

### Command structure

Register new top-level commands alongside existing ones. The hidden `traversals` subcommand group is removed (nobody depends on it):

```
# Traversal commands (operate on SQLite state DB)
freelance start <graphId>           [--context '{}']
freelance advance [<edge>]          [--context '{}'] [--traversal <id>]
freelance context set <updates...>  [--traversal <id>]
freelance inspect [<traversalId>]   [--detail position|full|history]
freelance reset [<traversalId>]     [--confirm]
freelance status

# Memory commands (operate on SQLite memory DB)
freelance memory status              [--collection <name>]
freelance memory browse              [--name <pattern>] [--kind <kind>] [--collection <name>]
freelance memory inspect <entity>    [--collection <name>]
freelance memory search <query>      [--collection <name>] [--limit <n>]
freelance memory related <entity>
freelance memory by-source <file>    [--collection <name>]
freelance memory register <file>
freelance memory emit <file>         (JSON from file or stdin via -)
freelance memory end

# Graph commands (operate on graph files only)
freelance guide [<topic>]
freelance distill <file>            [--mode distill|refine] [--graph <id>]
freelance sources hash <file>
freelance sources check <file>
freelance sources validate

# Existing commands (unchanged)
freelance validate <directory>
freelance init
freelance visualize <file>
freelance mcp
freelance completion <shell>
```

Notable decisions:

- **`status` instead of `list`** — `list` is ambiguous (graphs? traversals?). `status` clearly means "show me what's going on" and returns both loaded graphs and active traversals, matching the MCP `freelance_list` behavior.
- **`context set` takes variadic `key=value` pairs** — e.g. `freelance context set foo=1 bar=true done='"yes"'`. Multiple pairs in one call, matching the MCP tool's `updates` object. Values are parsed as JSON where possible, falling back to string.
- **`distill` takes a file positional arg** — the task description or conversation to distill. Use `-` for stdin. This is the primary input; `--mode` and `--graph` are optional modifiers.
- **`memory` is a subcommand group** — keeps the 9 memory tools namespaced under `freelance memory`. Read tools (`browse`, `inspect`, `search`, `related`, `by-source`, `status`) are the primary CLI use case. Write tools (`register`, `emit`, `end`) support scripting and CI pipelines.
- **`memory emit` takes JSON from file or stdin** — the propositions schema is complex (array of objects with content, entities, sources). A positional `<file>` arg (or `-` for stdin) is the right input method rather than trying to express this via CLI flags.

### Traversal auto-resolution

Match the MCP behavior for commands that take an optional `--traversal`:
- 0 active traversals: error with clear message
- 1 active traversal: use it automatically
- 2+ active traversals: error listing them, prompt user to specify `--traversal <id>`

### Output format

All commands support `--json` for machine-readable output (existing global flag). Human-readable output is default, using `cli/output.ts` helpers for consistent formatting.

## Implementation

### 1. Extract shared setup helper

The MCP server's graph loading + store creation logic needs to be reusable by CLI commands. Extract a helper (e.g., in `src/cli/setup.ts` or similar):

```typescript
function createTraversalStore(graphsDirs: string[]): { store: TraversalStore; graphs: Graph[] }
function createMemoryStore(graphsDirs: string[]): { store: MemoryStore }
```

Resolves graph directories, loads graphs, opens the relevant SQLite DB, returns a ready-to-use store. This is the same setup path as `src/server.ts` minus the MCP server.

### 2. Add traversal CLI handlers

**`src/cli/traversals.ts`** — replace the daemon-based HTTP handlers with direct store access:
- `traversalStart(store, graphId, context?)` — `store.start()`
- `traversalAdvance(store, id, edge, context?)` — `store.advance()`
- `traversalContextSet(store, id, updates)` — `store.contextSet()`
- `traversalInspect(store, id, detail?)` — `store.inspect()`
- `traversalReset(store, id)` — `store.reset()`
- `traversalStatus(store)` — `store.list()`

Each handles auto-resolution (0/1/2+ traversals) and human/JSON output formatting.

### 3. Add memory CLI handlers

**`src/cli/memory.ts`** (new) — handlers for memory subcommand group:
- `memoryStatus(store, collection?)` — `store.status()`
- `memoryBrowse(store, opts)` — `store.browse()` with name/kind/collection/limit/offset
- `memoryInspect(store, entity, collection?)` — `store.inspect()`
- `memorySearch(store, query, opts)` — `store.search()`
- `memoryRelated(store, entity)` — `store.related()`
- `memoryBySource(store, filePath, collection?)` — `store.bySource()`
- `memoryRegister(store, filePath)` — `store.registerSource()`
- `memoryEmit(store, file, collection)` — reads JSON from file/stdin, calls `store.emit()`
- `memoryEnd(store)` — `store.end()`

### 4. Add graph CLI handlers

**`src/cli/stateless.ts`** (new) — handlers for graph-only commands:
- `guideShow(graphsDirs, topic?)` — load graphs, display guide content
- `distillRun(graphsDirs, file, mode?, graphId?)` — load file (or stdin), run distill, output result
- `sourcesHash(graphsDirs, file)` — compute and display hash
- `sourcesCheck(graphsDirs, file, expectedHash)` — validate hash
- `sourcesValidate(graphsDirs)` — validate all source bindings

### 5. Register commands in `src/index.ts`

- Add `start`, `advance`, `context`, `inspect`, `reset`, `status` as top-level commands
- Add `memory` subcommand group with all 9 subcommands
- Add `guide`, `distill`, `sources` commands
- Remove hidden `traversals` subcommand group
- All commands share `--workflows <dir>` for graph directory override (same as `freelance mcp`)

## Files changed

- `src/cli/traversals.ts` — rewrite from daemon HTTP to direct store access; add start, advance, context set, status handlers
- `src/cli/memory.ts` (new) — memory subcommand handlers (browse, inspect, search, related, by-source, status, register, emit, end)
- `src/cli/stateless.ts` (new) — guide, distill, sources handlers
- `src/cli/setup.ts` (new) — shared graph loading + store creation helpers
- `src/index.ts` — register new top-level commands, memory subcommand group, remove `traversals` group
- `test/cli-commands.test.ts` (new) — CLI command tests

## Files NOT changed

- `src/daemon.ts` — daemon is a separate concern (#27)
- `src/server.ts` — MCP tool surface unchanged
- `src/proxy.ts` — proxy unchanged
- `src/engine/` — engine internals unchanged
- `src/state/` — state layer unchanged (CLI is a new consumer, not a change)
- `src/memory/` — memory store unchanged (CLI is a new consumer, not a change)

## Out of scope

- **Daemon stabilization** — lifecycle, PID management, testing. Tracked in #27. The daemon becomes an optional deployment mode, not a requirement for CLI usage.

## Test plan

- Unit: `freelance start <graph>` creates traversal, returns ID
- Unit: `freelance advance <edge>` moves traversal forward
- Unit: `freelance context set foo=1 bar=2` updates multiple keys
- Unit: `freelance inspect` shows current position
- Unit: `freelance reset --confirm` clears traversal
- Unit: `freelance status` shows loaded graphs and active traversals
- Unit: auto-resolution works for 0, 1, 2+ traversals
- Unit: `freelance guide` prints help text, `freelance guide <topic>` filters
- Unit: `freelance distill <file>` produces workflow YAML; `--mode refine` updates existing graph
- Unit: `freelance distill -` reads from stdin
- Unit: `freelance sources validate` catches invalid bindings
- Unit: `freelance sources hash` and `sources check` round-trip correctly
- Unit: `freelance memory status` shows proposition/entity counts
- Unit: `freelance memory browse --name X` filters entities by name
- Unit: `freelance memory inspect <entity>` shows propositions and neighbors
- Unit: `freelance memory search <query>` returns FTS matches
- Unit: `freelance memory related <entity>` shows co-occurring entities
- Unit: `freelance memory by-source <file>` shows propositions from file
- Unit: `freelance memory register <file>` registers source, starts session if needed
- Unit: `freelance memory emit <file>` reads JSON, writes propositions
- Unit: `freelance memory end` closes session with stats
- Unit: all commands support `--json` output
- Integration: full traversal lifecycle via CLI: start → advance → inspect → context set → reset
- Integration: full memory lifecycle via CLI: register → emit → end → search → inspect
- Integration: CLI and MCP server coexist on same SQLite DBs without corruption
