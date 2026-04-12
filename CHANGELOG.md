# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-04-12

A consolidation release that pays down substantial architectural debt. Removes
the hidden daemon/proxy surface, drops the `better-sqlite3` native dependency
in favor of JSON files (for traversal state) and `node:sqlite` (for memory),
splits the library entry cleanly from the CLI bin, and removes the session
machinery from the memory store in favor of strictly per-proposition
provenance.

`npx freelance-mcp@latest mcp` no longer has a native compile step.

### Breaking

- **Existing `memory.db` files from pre-1.3 releases must be deleted.** The
  memory store opens with a schema-compatibility check and throws a clear
  error if the legacy `sessions` / `session_files` tables are present. Re-run
  the `memory:compile` workflow against your sources to repopulate.
- **Daemon mode removed.** `freelance daemon start|stop|status` and the hidden
  `freelance mcp --connect host:port` option are gone. With JSON-file
  traversal state, every stdio MCP client shares state through the filesystem
  — the daemon's original purpose.
- **`memory_end` tool removed.** Each `memory_emit` stands on its own; there
  is no start/end bracketing any more.
- **`memory_status` fields `active_session` and `total_sessions` removed.**
- **`memory_inspect.source_sessions` replaced with `source_files`** — a
  deduped `string[]` of file paths that produced any of the entity's
  propositions.
- **`memory_register_source` status enum narrowed** from
  `"registered" | "updated" | "skipped"` to `"registered" | "skipped"`. There
  is no prior state to be "updated" against.
- **Minimum Node version bumped to `>=22.12.0`** where `node:sqlite` is
  unflagged. Node 20 is dropped from the CI matrix.

### Removed

- **Daemon, proxy, and PID-file infrastructure** — `src/daemon.ts`,
  `src/proxy.ts`, `src/cli/daemon.ts`, `src/paths.ts`, and six test files.
- **Memory sessions** — `sessions` and `session_files` tables,
  `propositions.session_id` column, `getStaleSessionIds`, `end()`,
  `requireActiveSession`, and the session-files fallback branch in
  `enrichProposition`. Memory tool count: 9 → 8.
- **`better-sqlite3`** and `@types/better-sqlite3` dependencies. Zero native
  deps in the runtime install.
- **`EXIT.DAEMON_ERROR`**, `loadGraphsOrFatal` (only caller was daemon start),
  `parseDaemonConnect`, and `src/lib.ts` (orphaned library entrypoint
  superseded by the subpath exports).
- **`snapshotGraphs` deep-clone-per-operation** in `TraversalStore`. Was
  protecting a property (in-flight definition pinning) the JSON-file
  persistence model already provides and the synchronous engine never
  actually exposed to race conditions.

### Changed

- **Traversal state moved from SQLite to JSON files.** New `StateStore`
  interface in `src/state/db.ts` with two backends: `JsonDirectoryStateStore`
  (one file per traversal under `.state/traversals/`, atomic writes via
  tmp+rename) and `InMemoryStateStore` (for the `:memory:` sentinel and
  tests). A `listIds()` fast path lets `resolveTraversalId` avoid parsing
  every record on the common "single active traversal" code path.
- **Memory store moved from `better-sqlite3` to `node:sqlite`.** Schema,
  FTS5, and triggers unchanged. A thin `Db`/`Stmt` adapter centralises the
  `SQLInputValue` / `SQLOutputValue` casts so `store.ts` keeps its own row
  types without re-casting at every call site. A small `suppress-warnings`
  helper filters the `ExperimentalWarning` while preserving the default
  printer for unrelated warnings.
- **`memory_emit` uses constraint-based upsert**:
  `INSERT ... ON CONFLICT (content_hash, collection) DO NOTHING RETURNING
  id`. The batch transaction wrapper is gone — every write in the emit loop
  is idempotent under retry via content-hash dedup + `INSERT OR IGNORE` on
  `about` and `proposition_sources`, so partial failures converge on the
  correct state when the caller retries. `DO NOTHING` (not `DO UPDATE`) is
  deliberate: it skips firing the `propositions_au AFTER UPDATE` trigger
  on dedup hits, avoiding FTS churn for no-op writes.
- **`memory_register_source` is now a zero-state hash echo.** Hashes the
  file(s), returns `{file_path, content_hash, status}`, persists nothing.
  The sealed `memory:compile` workflow still calls it as a nudge step, but
  the store no longer tracks session-level registration. Workflow gating
  moves to `TraversalStore.hasActiveTraversalForGraph`, which was already
  there.
- **`memory_emit` attaches sources at emit time.** Each proposition's source
  files are hashed at emit and recorded in `proposition_sources`. Staleness
  is computed per-proposition against the current filesystem —
  `getStalePropositionIds()` replaces `getStaleSessionIds()`.
- **Root export split.** `src/index.ts` is now a pure library entry —
  importing it has no side effects, no CLI auto-launch. The CLI bin lives
  at `src/bin.ts` (shebang shim), which imports `src/cli/program.ts`
  (Commander construction). `package.json#bin.freelance` →
  `dist/bin.js`; `main` and the `.` subpath export still point at
  `dist/index.js` (the library).
- **Plugin layout: `plugin/` → `plugins/freelance/`.** Matches the canonical
  Anthropic plugin layout used in `anthropics/claude-code/plugins/*` and
  `upstash/context7`. Added `scripts/sync-plugin-version.mjs` and wired it
  into the `version` + `prepublishOnly` npm lifecycle hooks so plugin.json
  stays in lockstep with package.json on every release.
- **Plugin `.mcp.json` pinned to `freelance-mcp@^1`** (was `@latest`).
  Prevents `npx` from auto-upgrading installed plugin users into a future
  breaking change.
- **`@inquirer/prompts` moved to `optionalDependencies`.** Only the
  interactive `freelance init` path uses it. A new `loadPrompts` helper
  surfaces a friendly "install it or use --yes" hint if it's absent
  instead of a cryptic ESM resolution error.
- **`resolveTraversalId` fast path.** The explicit-id branch no longer does
  a redundant existence check (loadEngine's ENOENT covers it); the no-id
  branch uses `listIds()` first and only parses full records when the
  result is genuinely ambiguous.
- **`JsonDirectoryStateStore.put()` writes minified JSON** rather than
  2-space pretty-printed — roughly halves write size on every save.
- **`loadMemoryOverlay` helper** (later superseded by main's unified config
  system in #42, which already landed before this rework).

### Added

- **`mcpName: "io.github.duct-tape-and-markdown/freelance"`** in
  `package.json` for MCP registry identity.
- **`publishConfig.access: "public"`** as a defensive guard against
  accidental scoped publishes.
- **`.nvmrc`** pinning Node 22 for consistent local dev.
- **`SECURITY.md`** with GitHub private-advisory reporting instructions.
- **`scripts/sync-plugin-version.mjs`** — plugin version sync helper,
  idempotent, runs via `npm version` and `prepublishOnly` hooks.
- **`src/memory/suppress-warnings.ts`** — filters the `node:sqlite`
  `ExperimentalWarning` while preserving the default warning printer.
- **`TraversalStore.hasActiveTraversalForGraph(...graphIds)`** — preserved
  from main's #43, now implemented over the `StateStore.list()` interface
  instead of a SQL query. Used to gate memory-write tools and the
  `memory-register` hot path.

### Fixed

- **`npx freelance-mcp mcp` no longer has a native compile step** and
  cannot fail with `better-sqlite3` install errors.
- **`npm run dev` (tsx) now works for commands that reach the loader.**
  The `@dagrejs/graphlib` CJS bundle carries `cjs-module-lexer` named-export
  hints that Node's native ESM loader reads but `tsx` does not; named
  imports of `Graph` / `alg` worked in the built `node dist/…` path but
  failed in tsx. `src/loader.ts` now uses `createRequire` to force CJS
  semantics under both loaders, with types preserved via
  `typeof import("@dagrejs/graphlib")`.
- **Narrative comments cleaned up** across `state/db.ts`, `memory/db.ts`,
  `memory/store.ts`, `traversal-store.ts`, `cli/init.ts`, and `cli/program.ts`
  (header blocks explaining the WHY now match project guidelines; comments
  narrating history removed).
- **Dead reference `docs/SPEC.md` in `CLAUDE.md`** updated to point at
  `src/schema/graph-schema.ts` (the Zod schema is the actual source of truth).

## [1.2.1] - 2026-04-10

### Fixed

- **Memory enabled-by-default** — Memory gate in server checked `enabled && db` instead of `enabled !== false && db`, preventing zero-config memory activation when `memory.enabled` was unset

### Changed

- **`memory_register_source` accepts arrays** — `file_path` parameter now accepts a single path or an array of paths, reducing round-trips during compilation workflows

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
