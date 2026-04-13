# Freelance

Graph-based workflow enforcement for AI coding agents.

## Development

- `npm run build` — compile TypeScript
- `npm test` — run all tests
- `npm run dev` — run in development mode

## Code navigation

Prefer AST-aware tools over plain text search when exploring or refactoring TypeScript:

- **LSP tool** (`LSP`) — use for semantic queries: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, and call hierarchy (`prepareCallHierarchy` / `incomingCalls` / `outgoingCalls`). Better than Grep for "where is X used" or "what does this type resolve to".
- **ast-grep** (`sg` on PATH) — use for structural search/rewrite: `sg run -p '<pattern>' -l ts src/`. Better than Grep when the match depends on syntax shape rather than a literal string (e.g. call sites of a specific method, JSX props, type annotations).

Fall back to Grep only for literal strings, comments, or non-code files.

## Running

### Configuration

Two config files in `.freelance/`, same schema, layered:
- `config.yml` — team-shared (committed)
- `config.local.yml` — machine-specific (gitignored)

Precedence: CLI flags > env vars > config.local.yml > config.yml > defaults

Schema: `workflows` (string[]), `memory.enabled` (bool), `memory.dir` (string), `memory.ignore` (string[]), `memory.collections` (CollectionConfig[])

Arrays concatenate across files. Scalars use highest-precedence value.

### Graph Directory Resolution

Graphs can be loaded from multiple directories in cascading order (later directories shadow earlier ones):

**Automatic resolution** (no flags needed):
1. `./.freelance` (project-level, if exists)
2. `~/.freelance` (user-level, if exists)
3. Additional dirs from `config.yml` / `config.local.yml` `workflows:` key

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
- `src/state/` — Stateless traversal store (JSON files on disk)
  - `traversal-store.ts` — Multi-traversal management, loads/saves state per operation
  - `db.ts` — StateStore interface + JSON-directory and in-memory backends
- `src/builder.ts` — Programmatic workflow graph construction (GraphBuilder)
- `src/config.ts` — Unified config loader (config.yml + config.local.yml schema, merging, writing)
- `src/graph-resolution.ts` — Graph directory resolution and loading (env var, project, user, config cascading)
- `src/server.ts` — MCP tool surface (21 tools: traversal, guide, distill, sources, validate, plus memory)
- `src/cli/` — CLI subcommand handlers (init, validate, visualize, traversals, stateless, memory, config, output, setup)
  - `cli/program.ts` — Commander program construction (imported by `bin.ts`)
  - `cli/clients.ts` — Client detection (claude-code, cursor, windsurf, cline) and display helpers
- `src/index.ts` — Pure library entry (re-exports, no side effects)
- `src/bin.ts` — CLI bin entry (shebang, imports and runs `program`)
- `templates/` — Starter graph templates and shell completions

## Graph definitions

Graph files use `.workflow.yaml` extension. See `test/fixtures/` for examples.
See `src/schema/graph-schema.ts` for the full schema definition.
