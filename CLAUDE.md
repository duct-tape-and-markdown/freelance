# Graph Engine

A domain-agnostic, YAML-defined, graph-traversal MCP server.

## Development

- `npm run build` — compile TypeScript
- `npm test` — run all tests
- `npm run dev` — run in development mode

## Running

```bash
# Validate graph definitions
node dist/index.js --graphs ./path/to/graphs/ --validate

# Start standalone MCP server (per-session state, no daemon)
node dist/index.js --graphs ./path/to/graphs/

# Start daemon (long-running, multi-traversal, persisted)
node dist/index.js daemon --graphs ./graphs/ --port 7433

# Start MCP proxy connecting to daemon
node dist/index.js mcp --connect localhost:7433

# Daemon management
node dist/index.js daemon stop
node dist/index.js daemon status

# Traversal management (requires running daemon)
node dist/index.js traversals list
node dist/index.js traversals inspect tr_a1b2c3d4
node dist/index.js traversals reset tr_a1b2c3d4
```

## Project structure

- `src/schema/` — Zod schemas for graph definitions (single source of truth for types + validation)
- `src/evaluator.ts` — Expression evaluator for edge conditions and validations
- `src/loader.ts` — YAML graph loader with structural validation
- `src/engine.ts` — Core traversal engine (session state, advance logic, gate enforcement)
- `src/traversal-manager.ts` — Multi-traversal management with GUID addressing and persistence
- `src/daemon.ts` — HTTP daemon server wrapping TraversalManager
- `src/proxy.ts` — MCP proxy that bridges stdio to daemon HTTP API
- `src/server.ts` — MCP tool surface (6 tools wrapping TraversalManager)
- `src/index.ts` — CLI entry point with subcommands

## Graph definitions

Graph files use `.graph.yaml` extension. See `test/fixtures/` for examples.
See `docs/SPEC.md` for the full specification.
