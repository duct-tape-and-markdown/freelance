# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-04-10

### Added

- **Unified config system** — Two layered config files per `.freelance/` directory: `config.yml` (committed, team-shared) and `config.local.yml` (gitignored, machine-specific)
- **`freelance config show`** — Display resolved configuration with sources
- **`freelance config set-local <key> <value>`** — Modify `config.local.yml` programmatically for plugin hooks
- **`workflows:` config key** — Declare additional workflow directories in config, enabling zero-config plugin workflow discovery
- **`memory.enabled` config key** — Disable memory via config file (previously CLI-only)
- **`memory.dir` config key** — Override memory.db location via config file
- **Auto-generated `.freelance/.gitignore`** — Covers `.state/` and `config.local.yml`
- **Shared test helpers** — `tmpFreelanceDir` and `withTmpEnv` in `test/helpers.ts`
- **632 tests** across 36 test files

### Changed

- Config precedence is now: CLI flags > env vars > `config.local.yml` > `config.yml` > defaults
- Arrays (`workflows`, `ignore`, `collections`) concatenate across config files; scalars use highest-precedence value
- Watcher now monitors `config.local.yml` changes in addition to `config.yml`
- Config reload uses fully merged config across all graphsDirs (was single-dir only)
- `memory-register` hot path reduced from 4 config file reads to 2 per invocation
- Eliminated triple config load on MCP server startup

### Removed

- `parseMemoryOverlay` — replaced by unified config loader
- `layers.yml` support — replaced by `config.yml` `workflows:` key

## [1.1.3] - 2026-04-10

### Fixed

- Session-start hook called nonexistent `inspect --active --oneline` — now calls `status`
- Hook idempotency marker didn't match actual command, causing duplicates on re-init
- Shell completions (bash/zsh/fish) referenced removed `traversals` subgroup — rewritten for current CLI
- CONTRIBUTING.md wrong package name (`npx freelance` -> `npx freelance-mcp`)
- Stale test mocks (`INIT_DEFAULTS` missing `hooks`, `validate` missing `fix`/`basePath` keys)

### Removed

- Dead code: `src/cli/inspect.ts` (pre-SQLite), `TRAVERSALS_DIR` export, stale spec

## [1.1.2] - 2026-04-10

### Fixed

- Publish workflow authentication for npm trusted publishing
- Added `NPM_TOKEN` for registry auth

## [1.1.1] - 2026-04-10

### Fixed

- `better-sqlite3` moved from optional peer dependency to regular dependency — fixes `npx` installs where the native module wasn't being installed

## [1.1.0] - 2026-04-09

### Added

- **Persistent memory system** — SQLite-backed knowledge graph with source provenance and drift detection
- **Memory collections** — Named partitions for organizing propositions, with per-collection dedup
- **Entity kinds** — Typed entity classification for browsing and filtering
- **Graph navigation** — `memory_related` tool for entity co-occurrence and connection strength
- **Full-text search** — FTS5 index on proposition content via `memory_search`
- **Zero-config memory** — Enabled by default with `--memory-dir` and `--no-memory` flags
- **Hot-reload config** — `config.yml` memory settings reload without server restart
- **`freelance_validate` MCP tool** — Validate graph definitions from within the agent
- **CLI parity** — All 21 MCP tools available as CLI commands
- **Source provenance** — Per-proposition file attribution with content hash validation
- **Memory compilation workflows** — `memory:compile` and `memory:recall` sealed workflows
- **Graph load error surfacing** — Structured errors in `freelance_list` response

## [1.0.0] - 2026-04-02

### Added

- **Core engine** — Graph loader, expression evaluator, session state manager, traversal engine
- **MCP server** — Standalone stdio transport with 6 tools: `graph_list`, `graph_start`, `graph_advance`, `graph_context_set`, `graph_inspect`, `graph_reset`
- **`graph_guide` tool** — Contextual guidance for agents at each workflow node
- **CLI commands** — `init`, `validate`, `visualize`, `inspect`, plus shell completions (bash/zsh/fish)
- **Starter templates** — `blank.workflow.yaml`, `migrate-context-enums.workflow.yaml`, `migrate-shorthand-maps.workflow.yaml`
- **Expression language** — Supports context references, comparisons, logical operators, array operations, and string matching in edge conditions and validation rules
- **Subgraph support** — Nested graph execution with context passing
- **CI pipeline** — GitHub Actions with Node 20/22/24 matrix, 90% coverage threshold, template validation, CLI smoke tests
- **514 tests** across 31 test files
