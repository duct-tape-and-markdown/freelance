# Freelance

Graph-based workflow enforcement for AI coding agents.

## Development

- `npm run build` — compile TypeScript
- `npm test` — run all tests
- `npm run dev` — run in development mode

After a non-trivial batch of code changes (multiple files or a cohesive multi-step edit), run `/simplify` before reporting the task complete. Skip for single-line fixes, test-only tweaks, or pure config/docs edits.

## Design iteration

When iterating on a design (proposal, issue body, new mode/option, added column), check each addition against existing system invariants **before** drafting. If the case the addition addresses isn't expressible in the current schema or types, the addition is solving an imaginary problem — kill it at the premise, not at review. Memory invariants live in `docs/memory-intent.md` (architectural qualities + anti-patterns) and in the schemas under `src/memory/` + `src/schema/`; read both before proposing a new mode, column, or tool. Concrete example: `memory_emit` requires `sources: [min 1]` on every proposition, so there is no "non-source-aligned" proposition — a prune mode scoped to that case would be solving a case the schema makes malformed.

## Releases

npm publishing is **CI-driven by GitHub Releases** (`.github/workflows/publish.yml` fires on `release: published` and runs `npm publish --provenance`). Do NOT `npm publish` from a local machine — the workflow uses an OIDC token and provenance that local publishes won't produce.

Flow for a patch release (e.g. 1.3.2 → 1.3.3):

1. Graduate `[Unreleased]` in `CHANGELOG.md` to `[<version>] - YYYY-MM-DD`. Leave a fresh empty `[Unreleased]` above it.
2. `npm version patch --no-git-tag-version` — bumps `package.json` + `package-lock.json`, runs the `version` script which invokes `scripts/sync-plugin-version.mjs` to rewrite `plugin.json`, `marketplace.json`, and `plugins/freelance/.mcp.json` (exact pin `freelance-mcp@<version>`).
3. The `version` script only `git add`s `plugin.json` — **manually stage the rest**: `git add CHANGELOG.md package.json package-lock.json .claude-plugin/marketplace.json plugins/freelance/.mcp.json`.
4. `git commit -m "release: <version>"` and `git tag v<version>`.
5. Push main + tag: `git push origin main v<version>`.
6. `gh release create v<version> --title "v<version>" --notes "$(...)"` — CI workflow picks this up and publishes to npm.

Why `.mcp.json` pins exactly (not `^<major>`): npx keys its `_npx/<hash>` cache by the raw spec string, so a range reuses any satisfying cached version and never re-resolves (npm/cli#7838, #6804). Exact pinning changes the cache key each release so `/plugin update` actually delivers the new server. See CHANGELOG [1.3.3] and the file-header comment in `scripts/sync-plugin-version.mjs`.

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

Schema: `workflows` (string[]), `memory.enabled` (bool), `memory.dir` (string), `maxDepth` (number), `hooks.timeoutMs` (number).

Arrays concatenate across files. Scalars use highest-precedence value. Per-field CLI/env/config surface is documented in `src/config.ts` and in the README's Configuration section.

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
- `src/evaluator.ts` — Expression evaluator for edge conditions and validations; exports `CONTEXT_PATH_PATTERN` + `resolveContextPath` for hook arg resolution
- `src/loader.ts` — YAML graph loader with structural validation; threads `resolveGraphHooks` results into `ValidatedGraph.hookResolutions`
- `src/hook-resolution.ts` — Load-time hook path resolver: classifies `onEnter[].call` as built-in name or local script path, stats scripts, merges into the `ValidatedGraph`
- `src/compose.ts` — **Composition root.** Single `composeRuntime` factory that wires state backend → memory store → hook runner → traversal store and returns a `Runtime` with an idempotent `close()`. Also owns `buildMemoryStore` (shared with CLI memory commands) and `migrateLegacyLayout` (transparent `.state/` → flat layout migration). Both `src/server.ts` and `src/cli/setup.ts` call `composeRuntime`.
- `src/engine/` — Core traversal engine, decomposed into focused modules:
  - `engine.ts` — Orchestrator (async `start`, async `advance` dispatch, reset, contextSet, inspect)
  - `gates.ts` — Pre-advance checks (wait blocking, return schema, validations, edge conditions)
  - `subgraph.ts` — Stack push/pop with context and return mapping; `maybePushSubgraph` fires onEnter hooks for the pushed child's start node
  - `context.ts` — Context updates, strict context enforcement, inspect builders
  - `transitions.ts` — Edge evaluation with default-edge logic
  - `wait.ts` — Wait condition evaluation and timeout handling
  - `returns.ts` — Return schema validation
  - `hooks.ts` — `HookRunner`, `HookContext`, `HookMemoryAccess` narrow read interface, `resolveHookArgs`, timeout + error wrapping. Required injection on `GraphEngineOptions`.
  - `builtin-hooks.ts` — `BUILTIN_HOOKS` map of name → `HookFn` (`memory_status`, `memory_browse`); `requireMemory` guard helper
  - `helpers.ts` — Shared utilities (cloneContext, toNodeInfo)
- `src/state/` — Stateless traversal store (JSON files on disk under `.freelance/traversals/`)
  - `traversal-store.ts` — Multi-traversal management, loads/saves state per operation; owns `setMeta` (merge semantics) and meta enrichment of `inspect` / `advance` / `list` responses
  - `db.ts` — `StateStore` interface + JSON-directory and in-memory backends; `TraversalRecord` carries an optional `meta: Record<string,string>` of opaque caller-supplied lookup tags (Freelance never interprets them — see `freelance_guide meta`); `openStateStore` factory owns the `mkdirSync` (constructor is pure)
- `src/memory/` — Persistent knowledge graph (SQLite under `.freelance/memory/`)
  - `store.ts` — `MemoryStore` constructor takes an already-opened `Db` handle + required `sourceRoot` (I/O lives in `composeRuntime`). Memory is a single flat namespace — no collections. Proposition dedup hashes a normalized form of content (lowercase, whitespace collapse, trailing punctuation strip) so superficial variance doesn't create duplicates; source-file hashing uses the minimal `hashContent` in `sources.ts` where stricter normalization would mask real drift.
  - `db.ts` — `openDatabase` with schema compatibility check
- `src/builder.ts` — Programmatic workflow graph construction (GraphBuilder)
- `src/config.ts` — Unified config loader (config.yml + config.local.yml schema, merging, writing); per-field CLI/env/config surface documented inline
- `src/graph-resolution.ts` — Graph directory resolution and loading (env var, project, user, config cascading)
- `src/server.ts` — MCP tool surface (traversal, guide, distill, sources, validate, memory); calls `composeRuntime` and registers tools
- `src/cli/` — CLI subcommand handlers (init, validate, visualize, traversals, stateless, memory, config, output, setup)
  - `cli/program.ts` — Commander program construction (imported by `bin.ts`)
  - `cli/setup.ts` — `createTraversalStore` + `createMemoryStore`; layout helpers (`ensureFreelanceDir`, `resolveTraversalsDir`, `memoryDbPathFor`); `resolveMemoryConfig` with symmetric `--memory`/`--no-memory` precedence
  - `cli/memory.ts` — Memory subcommand handlers including `memory reset --confirm` for schema-mismatch recovery
  - `cli/clients.ts` — Client detection (claude-code, cursor, windsurf, cline) and display helpers
- `src/index.ts` — Pure library entry (re-exports, no side effects)
- `src/bin.ts` — CLI bin entry (shebang, imports and runs `program`)
- `templates/` — Starter graph templates and shell completions

## `.freelance/` directory layout

```
.freelance/
├── config.yml           # source (committed)
├── config.local.yml     # source (gitignored)
├── *.workflow.yaml      # source (committed)
├── .gitignore           # auto-generated
├── memory/              # runtime (gitignored) — SQLite db + sidecars
└── traversals/          # runtime (gitignored) — one JSON file per active traversal
```

Legacy `.freelance/.state/` layouts from pre-1.3 installs are auto-migrated on startup — see `migrateLegacyLayout` in `src/compose.ts`.

## Graph definitions

Graph files use `.workflow.yaml` extension. See `test/fixtures/` for examples.
See `src/schema/graph-schema.ts` for the full schema definition.

Nodes support an optional `onEnter: [{ call, args }]` list of hooks that fire on node arrival. See `freelance_guide onenter-hooks` for the full authoring guide, or `src/engine/hooks.ts` for the runner implementation.
