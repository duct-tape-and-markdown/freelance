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

# Start MCP server
node dist/index.js --graphs ./path/to/graphs/
```

## Project structure

- `src/schema/` — Zod schemas for graph definitions (single source of truth for types + validation)
- `src/evaluator.ts` — Expression evaluator for edge conditions and validations
- `src/loader.ts` — YAML graph loader with structural validation
- `src/engine.ts` — Core traversal engine (session state, advance logic, gate enforcement)
- `src/server.ts` — MCP tool surface (6 tools wrapping the engine)
- `src/index.ts` — CLI entry point

## Graph definitions

Graph files use `.graph.yaml` extension. See `test/fixtures/` for examples.
See `docs/SPEC.md` for the full specification.
