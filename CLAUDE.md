# Freelance

Graph-based workflow enforcement for AI coding agents.

## Development

- `npm run build` — compile TypeScript
- `npm test` — run all tests
- `npm run dev` — run in development mode

## Running

### Graph Directory Resolution

Graphs can be loaded from multiple directories in cascading order (later directories shadow earlier ones):

**Automatic resolution** (no flags needed):
1. `./.freelance` (project-level, if exists)
2. `~/.freelance` (user-level, if exists)

**Explicit directories** (CLI):
```bash
# Load from multiple directories (repeatable)
freelance mcp --workflows ./.freelance --workflows ~/.freelance
```

### Commands

```bash
# Validate graph definitions
freelance validate ./path/to/graphs/

# Visualize a graph
freelance visualize ./graphs/my.workflow.yaml --format mermaid

# Start standalone MCP server (auto-loads from ./graphs + ~/.freelance)
freelance mcp

# Start standalone with explicit directories
freelance mcp --workflows ./graphs --workflows ~/.freelance

# NOTE: daemon mode exists but is hidden/untested — not yet public
# Commands: daemon start|stop|status, traversals list|inspect|reset, mcp --connect

# Project setup
freelance init
```

### Source Path Resolution

Source bindings in graphs use relative paths (e.g. `docs/topics/training.md`). These resolve relative to the **source root**, which defaults to the parent of the first graphsDir:

- `./.freelance/` → source root is `./` (project root)
- `../dev-docs/.freelance/` → source root is `../dev-docs/`
- `~/.freelance/` → source root is `~/`

Override with `--source-root <path>` (CLI) or `sourceRoot` (ServerOptions).

## Project structure

- `src/schema/` — Zod schemas for graph definitions (single source of truth for types + validation)
- `src/evaluator.ts` — Expression evaluator for edge conditions and validations
- `src/loader.ts` — YAML graph loader with structural validation
- `src/engine/` — Core traversal engine, decomposed into focused modules:
  - `engine.ts` — Orchestrator (start, advance dispatch, reset, contextSet, inspect)
  - `gates.ts` — Pre-advance checks (wait blocking, return schema, validations, edge conditions)
  - `subgraph.ts` — Stack push/pop with context and return mapping
  - `state.ts` — Context updates, strict context enforcement, inspect builders
  - `transitions.ts` — Edge evaluation with default-edge logic
  - `wait.ts` — Wait condition evaluation and timeout handling
  - `returns.ts` — Return schema validation
  - `helpers.ts` — Shared utilities (cloneContext, toNodeInfo)
- `src/state/` — Stateless traversal store backed by SQLite
  - `traversal-store.ts` — Multi-traversal management, loads/saves state per operation
  - `db.ts` — SQLite schema for traversal state
- `src/builder.ts` — Programmatic workflow graph construction (GraphBuilder)
- `src/graph-resolution.ts` — Graph directory resolution and loading (env var, project, user cascading)
- `src/daemon.ts` — HTTP daemon server wrapping TraversalStore, PID file management, shutdown handlers
- `src/proxy.ts` — MCP proxy that bridges stdio to daemon HTTP API
- `src/server.ts` — MCP tool surface (6 tools wrapping TraversalStore)
- `src/cli/` — CLI subcommand handlers (init, validate, visualize, daemon, traversals, output)
  - `cli/clients.ts` — Client detection (claude-code, cursor, windsurf, cline) and display helpers
- `src/index.ts` — CLI entry point (Commander.js, command dispatch only)
- `templates/` — Starter graph templates and shell completions

## Graph definitions

Graph files use `.workflow.yaml` extension. See `test/fixtures/` for examples.
See `docs/SPEC.md` for the full specification.
