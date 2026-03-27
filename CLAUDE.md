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
1. `./.freelance/graphs` (project-level, if exists)
2. `~/.freelance/graphs` (user-level, if exists)

**Explicit directories** (CLI):
```bash
# Load from multiple directories (repeatable)
freelance mcp --graphs ./.freelance/graphs --graphs ~/.freelance/graphs
```

### Commands

```bash
# Validate graph definitions
freelance validate ./path/to/graphs/

# Visualize a graph
freelance visualize ./graphs/my.workflow.yaml --format mermaid

# Start standalone MCP server (auto-loads from ./graphs + ~/.freelance/graphs)
freelance mcp

# Start standalone with explicit directories
freelance mcp --graphs ./graphs --graphs ~/.freelance/graphs

# Start daemon (long-running, multi-traversal, persisted)
freelance daemon start --graphs ./graphs/ --port 7433

# Start MCP proxy connecting to daemon
freelance mcp --connect localhost:7433

# Daemon management
freelance daemon stop
freelance daemon status

# Traversal management (requires running daemon)
freelance traversals list
freelance traversals inspect tr_a1b2c3d4
freelance traversals reset tr_a1b2c3d4

# Project setup
freelance init
```

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
- `src/traversal-manager.ts` — Multi-traversal management with GUID addressing and persistence
- `src/graph-resolution.ts` — Graph directory resolution and loading (env var, project, user cascading)
- `src/daemon.ts` — HTTP daemon server wrapping TraversalManager, PID file management, shutdown handlers
- `src/proxy.ts` — MCP proxy that bridges stdio to daemon HTTP API
- `src/server.ts` — MCP tool surface (6 tools wrapping TraversalManager)
- `src/cli/` — CLI subcommand handlers (init, validate, visualize, daemon, traversals, output)
  - `cli/clients.ts` — Client detection (claude-code, cursor, windsurf, cline) and display helpers
- `src/index.ts` — CLI entry point (Commander.js, command dispatch only)
- `templates/` — Starter graph templates and shell completions

## Graph definitions

Graph files use `.workflow.yaml` extension. See `test/fixtures/` for examples.
See `docs/SPEC.md` for the full specification.
