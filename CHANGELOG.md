# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`freelance inspect` flag parity restored (#122).** Threads the
  engine-level inspect parameters through to the CLI surface, closing
  the regression introduced when MCP was removed in #116:
  - `--fields <name>` (repeatable; `currentNode | neighbors |
    contextSchema | definition`) — additive projections on
    position/history responses. Unknown values emit `INVALID_FLAG_VALUE`
    (exit 5) via the unified envelope.
  - `--limit <n>` / `--offset <n>` — pagination on
    `--detail history`'s `traversalHistory` (default 50, max 200).
    Parsed through the shared `parseIntArg` helper; typos surface as
    `INVALID_FLAG_VALUE` exit 5 instead of silent `NaN`.
  - `--include-snapshots` — opt-in inclusion of per-step
    `contextSnapshot` in history entries (quadratic size; off by
    default).
  - `freelance status` surfaces `loadErrors: [{file, message}]` when
    any workflow yaml in the graphs dir fails to parse or validate —
    previously such files were silently dropped from the `graphs`
    listing. The field is elided when empty, preserving the pre-#122
    success shape.
- **Lean response projection on the hot path (`--minimal`).** `freelance
  advance`, `freelance context set`, and `freelance inspect` now accept
  `--minimal`, which drops the full-context echo and the `node`
  NodeInfo blob from success / gate-blocked / updated / position-
  detail responses. Minimal success and blocked shapes carry
  `contextDelta`: the list of keys written this turn (caller updates
  union hook writes), so hook activity stays visible without echoing
  unchanged state. Default remains the full echo for backwards
  compatibility; clients opt in per call. Compaction recovery:
  `freelance inspect` (no flag) resyncs to the full shape. Library
  callers access the same behavior via the new `responseMode: "full" |
  "minimal"` option on `GraphEngine.advance / contextSet / inspect`
  and `TraversalStore.advance / contextSet / inspect`. See issue #81.
- **Canonical `EngineError` code catalog.** `src/error-codes.ts`
  exports `ENGINE_ERROR_CODES` (codes grouped by exit-code category),
  `EngineErrorCode` (union type), and `EC` (symbol aliases used at
  throw sites). `EngineError.code` is typed as `EngineErrorCode` so
  typos are caught at compile time, and `mapEngineErrorToExit` is
  derived from the grouping — adding a new code in the wrong group,
  or a new category without an exit mapping, is a compile error.
  Wire format unchanged; the refactor is source-internal. See issue
  #117.
- **Single driving skill + `freelance init` wires it up.** Ships
  `plugins/freelance/skills/freelance/SKILL.md` with the plugin and
  `templates/skills/freelance/SKILL.md` for CLI users. The skill teaches
  the invariant protocol for driving any Freelance workflow via the
  `freelance` CLI — discover, start, loop, recover, exit — and branches
  on the semantic exit codes shipped in the previous CHANGELOG entry.
  `freelance init --client claude-code` now copies the skill into
  `.claude/skills/freelance/SKILL.md` (project scope) or
  `~/.claude/skills/freelance/SKILL.md` (user scope), so agents can
  drive workflows without per-turn MCP tool-definition weight. Other
  clients (Cursor / Windsurf / Cline) skip skill installation — they
  don't consume Claude Agent Skills. See issue #115.
- **Byte caps on context writes.** Every write to session context —
  `freelance_context_set`, `contextUpdates` on `freelance_advance`,
  `initialContext` on `freelance_start`, and onEnter hook return
  values — is now checked against a per-value cap (default 4 KB) and a
  post-merge total cap (default 64 KB). Over-cap writes throw
  `EngineError` with codes `CONTEXT_VALUE_TOO_LARGE` or
  `CONTEXT_TOTAL_TOO_LARGE` *before* the bad value persists, so a
  misbehaving hook or runaway write can't silently inflate every
  subsequent advance/inspect response. Configure via
  `context.maxValueBytes` / `context.maxTotalBytes` in `config.yml`.
  See issue #83.
- **`freelance memory prune --keep <ref>`** — manual, user-initiated
  cleanup for `proposition_sources`. Deletes a row only when its
  `content_hash` doesn't match the file at **any** location the caller
  declared live: the current working tree on disk *or* the tip of any
  `--keep` ref. Implementation reads blobs via `git cat-file --batch` —
  no branch switching, no working-tree churn; the user's current
  checkout stays untouched while prune inspects every preserve ref.
  Rebase-, squash-, and amend-robust by construction: those workflows
  rewrite commit SHAs but preserve tree content, and prune asks about
  content, not SHAs. Unresolvable `--keep` refs hard-error before
  touching the db; source roots outside a git checkout hard-error
  (prune is a git-scoped operation). Config default under
  `memory.prune.keep: [ref, ...]`; CLI `--keep` flags concatenate on
  top. See issue #78 and `docs/memory-intent.md` § "Knowledge is
  append-only across corpus frames" for why the store stays additive
  at emit time.
- **`freelance validate` eager-imports every script hook at validate
  time (#123).** `validateHookImports` walks each `onEnter` script,
  imports it, and verifies the default export is a function —
  surfacing syntax errors, missing deps, and non-function defaults
  at authoring time instead of deep inside a traversal. Hook bodies
  are never invoked; Node's import cache keys by URL so the subsequent
  runtime load is free. Runtime keeps its own check as a second line
  of defense for callers that bypass `validate` (direct engine
  construction, programmatic use).
- **`TRAVERSAL_CONFLICT` error code (#124).** Exit 5 (`INVALID_INPUT`).
  Emitted when a stale read-modify-write races another writer against
  the same traversal JSON; the caller should re-read and retry.
- **Memory read pagination and `--shape` projection (#125).**
  `freelance memory inspect`, `memory by-source`, and `memory related`
  accept `--limit` (default 50, cap 200) and `--offset`, matching
  `memory browse`'s shape. Every response carries `total` so callers
  can decide whether to page further. `memory inspect` also accepts
  `--shape minimal|full` (default `full`) — `minimal` trims the
  per-proposition `source_files` details when response size matters
  more than full provenance. The `memory_inspect` onEnter hook
  defaults to `minimal` (to keep `freelance advance` responses under
  the 50 KB ceiling) and exposes `shape: "full"` for recall-style
  hooks that need provenance in-context. `memory_by_source` stays
  fixed at minimal — that wire shape is a contract warm-path callers
  rely on. `inspect`'s `source_files` list now spans the entity's
  full proposition set regardless of pagination (was silently shifting
  per offset). `EC.INVALID_SHAPE` surfaces `--shape` typos.
- **`FREELANCE_HOOKS_ALLOW_SCRIPTS` opt-out for script hooks (#126).**
  Setting the env var to `0`, `false`, or `no` makes graph load reject
  every `onEnter` entry that resolves to a local script, leaving
  built-in hooks as the only runnable surface. Default is allowed —
  the flag is opt-in to stricter handling for shared-graph-registry
  and untrusted-contributor scenarios, not default-deny. See
  `docs/decisions.md` § "Hook trust model".
- **Minimal-mode advance errors carry the unified `error.kind`
  envelope (#130 follow-up).** `AdvanceErrorMinimalResult` now exposes
  `error: { code, message, kind: "blocked" }` matching the full-mode
  contract from #134, so skills can branch on `error.kind` without
  knowing which response mode they're in. See #137.
- **`EC.INVALID_FLAG_VALUE` error code for malformed CLI numeric
  flag inputs (#139).** Exit 5 (`INVALID_INPUT`). Surfaces when
  `--limit`, `--offset`, or another integer flag receives a
  non-integer value — a specific subclass of invalid input that
  skills can branch on without regex-parsing the message.

### Changed

- **Unified CLI error envelope.** Every error — whether a gate-block
  on `advance` (in-band) or a thrown `EngineError` (structural) —
  now carries the same wire shape: `{ isError: true, error: { code,
  message, kind } }` where `kind` is `"blocked"` (traversal is fine;
  fix context and retry) or `"structural"` (stop and report). The
  in-band gate-block response still carries `status: "error"`,
  `currentNode`, `validTransitions`, and `context` on top of the
  envelope so a skill can decide the next move without another
  round-trip; `reason` stays populated (duplicates `error.message`)
  for pre-#95 readers. Four new codes surface gate blocks with the
  same stability promise as the others — `WAIT_BLOCKING`,
  `RETURN_SCHEMA_VIOLATION`, `VALIDATION_FAILED`,
  `EDGE_CONDITION_NOT_MET`, all grouped under the `BLOCKED`
  category that maps to exit 2. Skills no longer branch on two
  shapes; they read `error.kind` and the exit code. See issue #95.
- **All CLI verbs are JSON-only (BREAKING).** Every handler —
  `status`, `start`, `advance`, `context set`, `meta set`, `inspect`,
  `reset`, `memory *`, `init`, `validate`, `visualize`, `config`,
  `sources *`, `guide`, `distill` — emits structured JSON to stdout
  with semantic exit codes (0 success, 1 internal, 2 blocked, 3
  validation, 4 not found, 5 invalid input). The dual-mode
  (`--json` vs human-readable) branching is removed; `--json` and
  `--no-color` flags are deleted. The architectural commitment in
  `docs/decisions.md` § "CLI is the execution surface for agents"
  is that no human is driving this API — the skill loop is the
  only consumer. Error responses use the canonical shape
  `{ isError: true, error: { code, message } }`, so a skill
  consuming the CLI sees the same contract across every verb. See
  issue #99 Phase 1.
- **`visualize --open` removed.** The browser-rendering path was a
  human-only affordance; the JSON response carries the diagram
  inline (or `--output <path>` writes the raw artifact to disk for
  pipeline integration).
- **`freelance_inspect --detail=history` paginates `traversalHistory`
  and strips snapshots by default.** `traversalHistory` is sliced by
  `limit` (default 50, max 200) and `offset`. Per-entry
  `contextSnapshot` — which made the response grow quadratically on
  long traversals — is omitted by default; opt back in with
  `includeSnapshots: true` when you genuinely need per-step state.
  `contextHistory` ships in full (entries are small — key + value +
  two timestamps). The response reports `totalSteps` and
  `totalContextWrites` so callers can sense the traversal's size and
  page `traversalHistory` further if needed. See issue #84.
- **`freelance_inspect` separates state from projection (BREAKING).**
  `detail` is now just `"position"` (default) or `"history"` — `"full"`
  is removed. A new optional `fields` parameter projects graph-
  structure pieces on top: `currentNode` (full NodeDefinition of the
  active node), `neighbors` (one-edge-away NodeDefinitions),
  `contextSchema` (declared schema), `definition` (entire
  GraphDefinition — the escape hatch). The old `detail: "full"` was
  the single largest response any tool emitted, and the caller almost
  never actually wanted every node in the graph. Callers should
  replace `detail: "full"` with `fields: ["definition"]` (and
  typically with a narrower projection like `fields: ["currentNode"]`
  or `["neighbors"]`). See issue #85.
- **`memory_browse` now hides orphan entities by default** — those whose
  `valid_proposition_count` is 0 because every linked proposition is
  derived from a source file that has since drifted. Without the filter
  the vocabulary returned to the agent (and surfaced as
  `context.entities` on `memory:compile` / `memory:recall`) leaked
  names from superseded drafts — e.g. a rename in a spec file left the
  old entity visible indefinitely because `emit()` is append-only per
  source. Pass `includeOrphans: true` (hook arg) or
  `--include-orphans` (CLI) to see all entities — useful for audit
  tooling that wants to find prune candidates.
- **Read-side queries use a temp table for stale-proposition exclusion
  (#131).** `browse`, `getNeighbors`, and `countValidForEntity` used
  to build a dynamic `NOT IN (?, ?, ?, …)` clause with one parameter
  per stale proposition id, which would hit
  `SQLITE_MAX_VARIABLE_NUMBER` on large stale sets (e.g. after a
  major refactor that touched many sourced files) and churn the
  prepared-statement cache across differently-sized stale sets.
  `getStalePropositionIds` now materializes the set into a
  connection-scoped `_stale_prop_ids` TEMP TABLE; reads `NOT EXISTS`
  against it. One fixed SQL string, zero stale-id parameters bound,
  regardless of cardinality. Inserts batch at 500 ids per call.
- **`parseIntArg` + `collectRepeatable` CLI helpers (#139).** The
  `opts?.foo ? parseInt(opts.foo, 10) : undefined` idiom at nine sites
  across `src/cli/` collapsed into a single `parseIntArg(opts?.foo)`
  helper in `src/cli/output.ts`; the ad-hoc repeatable-option parsers
  (`--meta`, `--keep`, `--workflows`, `--filter`) collapsed to one
  `collectRepeatable` in `src/cli/program.ts`. Pure refactor — no
  wire change.

### Removed

- **`freelance inspect --detail full` is gone.** The `"full"` level had
  already been silently coerced to `"position"` after #111 split
  detail from field projections, so the flag was a trap — accepted at
  parse time but ignored at runtime. Callers replacing `--detail full`
  should pick the explicit shape they actually want: `--detail
  position` (default) for the active node + validTransitions, or
  `--fields definition` (on the library API) for the full
  GraphDefinition escape hatch. See issue #81.
- **MCP server and all MCP tools (BREAKING for library consumers).** The
  MCP surface is gone: the `freelance mcp` subcommand, the
  `createServer` / `startServer` library exports, every `freelance_*`
  and `memory_*` MCP tool, and the `plugins/freelance/.mcp.json`
  launcher. The Claude Agent Skill from #115 + the `freelance` CLI is
  now the sole execution surface, per `docs/decisions.md` §
  "CLI is the execution surface for agents" (#99, #116).

  **Migration.** Agents that invoked `freelance_*` or `memory_*` MCP
  tools should switch to the shell-out CLI verbs the skill
  documents — `freelance status`, `freelance start <graphId>`,
  `freelance advance <edge>`, `freelance context set k=v`,
  `freelance inspect`, `freelance memory status|browse|emit|…`, etc.
  Every runtime verb emits structured JSON on stdout with semantic
  exit codes (0/1/2/3/4/5). Clients previously wired through
  `.mcp.json` can remove that block and run `freelance init --client
  claude-code` to install the driving skill. Plugin users upgrade
  transparently via `/plugin update` — the plugin version pins the
  exact CLI version.

  Claude Desktop doesn't offer a shell tool, so this removes Freelance
  support on that client. A minimal-surface fallback was considered in
  #99 Phase 3 and declined in favor of one execution surface.
  Reopen #116 if Desktop usage data shows the fallback is load-bearing.
- **Vestigial `src/watcher.ts` hot-reload primitive (#127).** The
  graph-file watcher had no production caller after MCP removal
  (#121); its only importer was its own test file. Leaving it in
  place would trap a future re-wire in the silent orphan-handling
  bug #90 describes. Deleted alongside the decisions-log entry that
  locks in the constraint on any future hot-reload surface. See
  `docs/decisions.md` § "Graph hot-reload is not a runtime concept".
- **`PropositionInfo.collection` field dropped (BREAKING wire) (#135).**
  The `propositions.collection` column, the `idx_prop_hash_coll`
  unique index, and `idx_prop_collection` are gone; schema migration
  detects the column via `PRAGMA table_info` and drops it in place on
  next open of a pre-migration db. Every existing row had
  `collection = 'default'`, so `content_hash` alone stays unique and
  no data is lost. Stale `--collection` filters at call sites no
  longer have any effect; `memory.collections` config keys are
  silently ignored (Zod drops unknown fields). External consumers
  that depended on the literal `'default'` string in wire responses
  must update. CLAUDE.md had always declared memory as a single flat
  namespace; the schema finally matches.

### Fixed

- **Atomic read-modify-write on traversal JSON (#124).** Until now the
  per-file rename inside `put` was atomic but the
  `load → mutate → save` window wasn't, so two writers racing against
  the same traversal (CLI invocation + a hook that shells out to
  `freelance`; two CLI invocations from different shells; any
  concurrent `TraversalStore` caller) could drop one update.
  Every `TraversalRecord` now carries a monotonic `version` bumped on
  each `put`; `StateStore.putIfVersion(record, expectedVersion)`
  check-and-writes and throws `EngineError(TRAVERSAL_CONFLICT)` when
  the observed version is stale. `TraversalStore.saveEngine` and
  `setMeta` use it. `advance` additionally takes a per-id async
  mutex so same-process callers serialize instead of racing. Legacy
  on-disk records without `version` read as version 0; first write
  bumps to 1. `TRAVERSAL_CONFLICT` classifies under `INVALID_INPUT`
  (exit 5) — transient, caller can re-read and retry.
- **`MemoryStore.resetAll` now runs in a transaction (#129).** The
  two back-to-back `DELETE` statements had a partial-state window: a
  mid-reset crash (process killed, disk pressure, FK trigger fault)
  could leave zero propositions but the full entity set — all of
  which are now unreachable since `about.proposition_id` cascaded
  away with the propositions. Reset was meant to be the recovery
  tool; leaving it non-atomic meant the recovery tool itself was
  unreliable. Both deletes now run under `BEGIN/COMMIT/ROLLBACK`,
  matching the existing pattern in `prune()`.
- **Memory drift detection no longer trusts mtime.** The staleness
  check used an mtime fast-path — if the file's current mtime matched
  what was recorded at emit time, it skipped the content hash and
  returned "not changed". But mtime is routinely preserved across real
  edits: `git checkout`, `rsync -t`, `touch -r`, archive extraction,
  package managers, and filesystems with coarse mtime resolution all
  leave an edited file with its original mtime. In those cases the
  fast-path silently marked stale content as `current_match: true`,
  defeating the one promise the API makes to readers. Drift is now
  detected by re-hashing content every time; the per-call cache in
  `StalenessCache` amortizes reads across source files shared by
  multiple propositions in one query, so the honest check is cheap in
  practice. The `mtime_ms` column on `proposition_sources` stays in
  the schema for existing databases but is no longer written or read.
- **`.freelance/.gitignore` now upserts when stale.** Previously
  create-if-missing, so pre-1.3 installs carried a legacy file ignoring
  `.state/` — a path that no longer exists — while the new `memory/`
  and `traversals/` runtime dirs went untracked and cluttered
  `git status`. `ensureGitignore` now rewrites files that start with
  the `# Generated by Freelance` marker and leaves user-authored files
  (no marker) alone. To opt out of future rewrites, delete the marker
  line.

## [1.3.3] - 2026-04-17

Plugin-only patch. Server code is unchanged from 1.3.2 — this release
exists to propagate the `.mcp.json` pinning mechanism to users whose
`/plugin update` was silently no-op'ing on stale npx cache entries.

### Changed

- **Plugin `.mcp.json` now pins an exact `freelance-mcp` version** instead
  of the `^1` range. Caught by a field report after 1.3.2: npx keys its
  `_npx/<hash>` cache on the raw spec string, so `freelance-mcp@^1`
  reuses whatever 1.x is already cached and never re-resolves against
  the registry — a known npm/cli bug ([#7838], [#6804]). Result: the
  1.3.2 plugin hotfix landed correctly but the *server* running inside
  it could still be 1.3.0 code on machines that used the plugin during
  the 1.3.0 → 1.3.1 window. Exact pinning changes the cache key on
  every release and forces a fresh registry fetch, so `/plugin update`
  actually delivers server-side fixes. `scripts/sync-plugin-version.mjs`
  now rewrites the pin from `package.json#version` on every
  `npm version`, alongside `plugin.json` and `marketplace.json`.

[#7838]: https://github.com/npm/cli/issues/7838
[#6804]: https://github.com/npm/cli/issues/6804

### User action — stuck on cached 1.3.0?

If `/plugin update` to 1.3.2 didn't surface the PR #63/#64 server fixes,
your npx cache still has 1.3.0. Once you're on 1.3.3 (or any future
release) the cache key changes and the problem goes away — but to clear
an already-stale 1.3.0 entry now:

```sh
# 1. Kill any lingering freelance-mcp processes.
#    macOS/Linux:
pkill -f freelance-mcp || true
#    Windows (PowerShell):
# Get-CimInstance Win32_Process |
#   Where-Object { $_.CommandLine -like '*freelance-mcp*' } |
#   ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2. Clear the stale npx cache entry. `npm cache clean` does NOT touch
#    _npx — it's a separate directory (npm/cli#6664).
rm -rf ~/.npm/_npx
# Windows: rm -rf "$env:LOCALAPPDATA\npm-cache\_npx"

# 3. Restart Claude Code. npx re-resolves and pulls the current version.
```

## [1.3.2] - 2026-04-17

Hotfix release for two regressions shipped in 1.3.1.

### Fixed

- **Plugin `.mcp.json` launcher (#70).** The 1.3.1 plugin shipped with
  hardcoded author-machine dev paths in `plugins/freelance/.mcp.json`
  instead of the `npx -y freelance-mcp@^1 mcp` launcher. Any fresh
  install on a different machine would fail to start. Existing installs
  also stayed pinned to whatever `freelance-mcp` npx resolved under
  1.3.0 and never saw fixes from later patches. Restored the npx
  launcher so `^1` resolves to the latest on next launch.
- **Cross-graph validation no longer fails on sealed-memory subgraph
  refs (#69).** User workflows that referenced `memory:compile` or
  `memory:recall` as a subgraph target failed to load with an
  "unknown graph" error because cross-graph validation ran before the
  MCP server's sealed-workflow injection step. Sealed workflows were
  available at runtime but invisible to the loader. Loader now injects
  sealed graphs *before* cross-graph validation, and a new
  `src/memory/sealed.ts` centralizes the sealed-graph registry so the
  loader, server, and CLI share one source of truth.

## [1.3.1] - 2026-04-16

The memory-architecture port. Pushed memory intelligence out of the agent's
round-trip path and into the traversal layer while preserving the store's
passive-sink principle. Ablation-driven throughout: decisions (and retractions)
are documented in `experiments/FINDINGS.md`; design intent lives in
`docs/memory-intent.md`.

### Added

- **Four new built-in onEnter hooks**: `memory_search`, `memory_related`,
  `memory_inspect`, `memory_by_source`. `HookMemoryAccess` narrows the full
  public read surface of `MemoryStore`. `memory_by_source` diverges from the
  single-path MCP tool on purpose: the hook takes `paths: string[]` (capped
  at 50) so a single onEnter declaration can fan out over
  `context.filesReadPaths`.
- **Graph-aware reads** on `memory:compile`. `exploring` node gets a
  `memory_by_source` onEnter keyed by `context.filesReadPaths`, populating
  `context.priorKnowledgeByPath`. The agent emits only deltas.
- **Warm-exit edges** on both sealed workflows. `memory:compile` adds
  `exploring → evaluating` gated on `coverageSatisfied` (skip compile/emit
  when priorKnowledgeByPath shows full coverage). `memory:recall` adds
  `recalling → evaluating` on the same flag (skip sourcing/comparing/filling
  when recalled propositions cover the query). Fixes the stuck-at-sourcing
  state when memory already satisfies the query.
- **Proposition dedup normalizes superficial variance** — the memory
  store hashes proposition content with stricter normalization
  (lowercase, whitespace collapse, trailing punctuation strip) so
  "X validates Y" and "x validates y." collide on the same hash. Each
  transform is binary — no thresholds. Source-file hashing still uses
  minimal CRLF→LF + trimEnd normalization; file drift detection needs
  to notice real edits.
- **`PROPOSITION_RUBRIC`** — atomicity directive + independence test +
  relationship exception (~60 tokens). Deliberately minimal based on
  ablation evidence (see below). Shared across both sealed workflows.
- **Programmatic `onEnter` on `GraphBuilder`**. `NodeInput` now exposes
  `onEnter`, and `build()` resolves built-in hook references.
- **`memory_reset` MCP tool** — clears propositions and entities on the
  live db handle (no split-brain from deleting files under a running
  server). Gated by `confirm: true`.
- **Sealed compile workflow uses full authoring surface**: `suggestedTools`
  on exploring (`Read`, `freelance_context_set`) and compiling
  (`memory_emit`); `maxTurns` on both action nodes as runaway guards.
- **`docs/memory-intent.md`** — design intent: architectural invariants,
  emergent output qualities, agent interaction qualities, where memory
  earns its keep, anti-patterns.
- **`experiments/`** — ablation infrastructure + 11-run findings
  (`experiments/FINDINGS.md`).

### Changed

- **Sealed workflows keep a single `compiling` node** (previously staging +
  addressing). The two-phase split cost +25% tokens and +40% wall time
  without producing better knowledge (ablation 3).
- **Sealed workflows never wiped by watcher reloads.** `injectSealedGraphs`
  now runs at startup AND on every `.workflow.yaml` reload — previously
  any file change under the watched dir cleared `memory:compile` and
  `memory:recall` from the graphs map until restart.
- **`memory_emit` gate widened** from "must be in memory:compile or
  memory:recall" to "must be in ANY active traversal". Preserves the
  intentional-write invariant while letting user-authored workflows
  (experiments, domain-specific compiles) write memory without being
  allow-listed. The gate still prevents writes outside any structured flow.
- **`memory:compile` and `memory:recall` no longer instruct the agent to
  manually call `memory_status` / `memory_browse` / `memory_inspect` /
  `memory_related` as a "first step".** Those round-trips fire as onEnter
  hooks. `memory_inspect` and `memory_related` stay as suggested tools
  because they need a specific entity arg the agent must pick from the
  populated vocabulary. Closes #53.

### Removed

- **Collections concept** — config surface and interface burden not
  justified by the capability. Memory is a single flat namespace.
  `memory.collections` config field, `memory_emit.collection` param, and
  all per-collection scoping on read tools removed.
- **Lens directive** (`dev`/`support`/`qa`) — ablation 1 showed no
  measurable effect. Removed from context, prose, and config.
- **Stage/address split** — ablation 3 showed two-phase cost +25% tokens,
  +40% time, fewer claims. Merged into single `compiling` node.
- **Rubric prose reduced from ~400 tokens to ~60.** Ablations 5, 7a, 7b,
  and 11 converged on the same finding: only entity guidance (in the
  compiling node) reliably moves the needle (-35% entity fragmentation,
  ablation 4). The knowledge-types taxonomy, WRONG/RIGHT Biome example,
  and an earlier content-vs-graph-structure addition were stripped or
  retracted. The retained rubric has the atomicity directive, the
  independence test, and the relationship exception (which prevents
  "A depends on B" from being atomized into disconnected per-entity
  fragments — structural, not stylistic).

### Fixed

- `GraphBuilder` silently dropped `onEnter` hooks — the field wasn't on
  `NodeInput` and `build()` didn't thread it through. Programmatic graphs
  built with hook declarations appeared to succeed but never ran the hooks.
  Fixed as part of the memory port.
- Root terminal auto-GC: when a traversal reaches a root terminal node,
  the engine now clears the stack so the persisted record is removed on
  save. Previously terminal traversals cluttered `freelance_list` forever.

### Upgrade notes

- Existing `memory.db` files keep working but propositions emitted before
  this release were hashed under the older minimal normalization. Same-
  content propositions emitted after the upgrade may not dedupe against
  the old rows (they'll hash to a different value under the stricter
  proposition-dedup normalization). To rebuild under the new regime,
  run `freelance memory reset --confirm` and re-compile. Not required —
  both hash formats remain valid data.
- `memory.collections` in `config.yml` is a no-op now and will be ignored.

### Follow-ups (tracked)

- #65 — Staleness hash caching + watched invalidation (read-path perf)
- #66 — Section-level source provenance for memory propositions
- #67 — Ablations 8-10: warm-path efficiency tests

## [1.3.0] - 2026-04-14

A consolidation release. The original scope paid down architectural debt —
removing the hidden daemon/proxy surface, dropping `better-sqlite3` in favor
of JSON files (traversal state) and `node:sqlite` (memory), splitting the
library entry cleanly from the CLI bin, and removing the session machinery
from the memory store in favor of strictly per-proposition provenance. Also
hardened the stdio server lifecycle so parent-disconnect, crashes, and
respawn loops no longer leave orphaned processes or WAL sidecar files on
disk.

Shipped as `1.3.0-beta.0` under the `beta` dist-tag for bake-in, then
substantially expanded during the beta window with a workflow-level
extensibility mechanism (`onEnter` hooks), a real composition root and DI
cleanup pass, a flattened `.freelance/` artifact layout with an
auto-migration path from the legacy `.state/` subdirectory, and a set of
config-surface improvements (`maxDepth` in `config.yml`, symmetric
`--memory`/`--no-memory` CLI flags, `hooks.timeoutMs`). The `1.3.0` stable
release below is the promotion of beta.0 plus that follow-on work, as one
coherent consolidation release.

`npx freelance-mcp@latest mcp` no longer has a native compile step.

### Beta → stable additions

All of the following landed between `1.3.0-beta.0` and `1.3.0` stable:

- **`onEnter` hooks.** Any node can now declare an `onEnter: [{ call, args }]`
  list of hooks that fire on node arrival, before the agent sees the node.
  `call` resolves to either a built-in hook (`memory_status`, `memory_browse`
  — thin wrappers over the corresponding memory tools) or a relative path to
  a local script (`./scripts/foo.js`). Scripts are ES modules with a
  default-export async function receiving a narrow `HookContext` (resolved
  args, live context, narrow read-only memory interface, graphId, nodeId).
  Return-value is merged into session context via the existing
  `applyContextUpdates` path, so strict-context enforcement applies uniformly
  to agent-driven and hook-driven writes. Args with string values matching
  `context.foo.bar` are dereferenced against live context before the hook
  runs. Per-hook timeout defaults to 5000ms, configurable via
  `hooks.timeoutMs` in `config.yml`. See `freelance_guide onenter-hooks` for
  the full authoring guide.
- **Engine `start()` and `advance()` are now async.** The hook runner is on
  the node-arrival hot path; requiring async propagated cleanly through
  `TraversalStore.createTraversal` / `advance`, the MCP tool handlers in
  `src/tools/start.ts` + `advance.ts`, the CLI `freelance start` / `advance`
  subcommands, and every engine test in `test/engine.test.ts` +
  `test/subgraph.test.ts` + `test/wait.test.ts` + `test/returns.test.ts` +
  `test/graph-sources.test.ts`. Library consumers calling `engine.start()` /
  `engine.advance()` directly must now `await` them.
- **`HookRunner` + `HookContext` + `HookMemoryAccess` in `src/engine/hooks.ts`.**
  The runner owns dynamic-import of script hooks (relying on Node's native
  `import()` cache — no explicit script cache), arg-path resolution, timeout
  enforcement via `Promise.race`, and error wrapping into `EngineError`.
  `HookContext.memory` is the narrow two-method interface
  (`status()` + `browse()`) rather than the concrete `MemoryStore`, so hook
  scripts can't reach into write paths like `emit()`.
- **Composition root extracted to `src/compose.ts`.** The single `composeRuntime`
  factory wires the full runtime (state backend → memory store → hook runner
  → traversal store) and returns a `Runtime` object with an idempotent
  `close()`. Both the MCP server (`src/server.ts::createServer`) and the CLI
  (`src/cli/setup.ts::createTraversalStore`) now call it. Entry-point-specific
  concerns — file watcher, MCP tool registration, CLI argv parsing, output
  rendering — stay in the respective callers. Eliminates duplicate wiring
  between the two entry points.
- **DI cleanup pass**:
  - `MemoryStore` constructor now takes a `Db` handle (from
    `openDatabase(path)`) + a **required** `sourceRoot: string`. The
    constructor no longer opens a database file or falls back to
    `process.cwd()`. All I/O lives in `composeRuntime`.
  - `JsonDirectoryStateStore` constructor is pure; `fs.mkdirSync` moved into
    the `openStateStore` factory in `src/state/db.ts`.
  - `hookRunner` is required (not optional) in `GraphEngineOptions` and
    `TraversalStore`'s options. No more `?? new HookRunner()` fallbacks in
    domain classes — callers must inject explicitly. Tests inject
    `new HookRunner()` directly. Removes the silent-skip footgun where a
    graph with `onEnter` hooks could be constructed against an engine
    without a runner and the hooks would silently never fire.
- **Flat `.freelance/` artifact layout with auto-migration.** The
  `.state/` subdirectory is gone. Runtime artifacts live as peer subdirs of
  source artifacts under `.freelance/`:
  \`\`\`
  .freelance/
  ├── config.yml           # source (committed)
  ├── config.local.yml     # source (gitignored)
  ├── *.workflow.yaml      # source (committed)
  ├── .gitignore           # auto-generated
  ├── memory/              # runtime (gitignored)
  │   ├── memory.db
  │   ├── memory.db-shm
  │   └── memory.db-wal
  └── traversals/          # runtime (gitignored)
      └── tr_*.json
  \`\`\`
  Source vs generated distinction is maintained via the generated
  `.gitignore`, not via directory nesting. On startup, `composeRuntime`
  detects a legacy `.freelance/.state/` layout and migrates it in place:
  `.state/memory.db{,-shm,-wal}` → `memory/memory.db{,-shm,-wal}`,
  `.state/traversals/` → `traversals/`, vestigial `state.db{,-shm,-wal}`
  from the pre-stateless-store era deleted, empty `.state/` removed. Best
  effort; logs one stderr line on success and an actionable error message
  on failure. Transparent to users — no manual steps required.
- **Config surface additions**:
  - **`maxDepth`** is now readable from `config.yml` at the top level
    (previously CLI-flag-only via `--max-depth`). CLI flag still wins when
    set. Default remains `5`.
  - **`hooks.timeoutMs`** config field for per-hook timeout (default
    5000ms). Config-only — no CLI flag — documented per-field in
    `src/config.ts` and `README.md`.
  - **Symmetric `--memory` / `--no-memory` CLI flags.** Previously only
    `--no-memory` existed (Commander's auto-negation of `--memory`). Now
    both are explicit options on `freelance mcp`, and the CLI flag always
    wins over `memory.enabled` in `config.yml` in both directions.
  - Dead `memory.ignore` field removed from `README.md` and
    `templates/config.yml` (it was documented but never implemented).
- **`freelance memory reset --confirm` CLI subcommand.** Deletes
  `.freelance/memory/memory.db` + sidecars without opening the database,
  so it works even when `checkSchemaCompatibility` would reject the
  current file (the canonical "I upgraded Freelance and the old db schema
  is incompatible" recovery path). Next run re-initializes from scratch.
- **`freelance_guide` gains a new `onenter-hooks` topic** covering the full
  hook authoring surface: schema, built-ins, local script contract,
  `HookContext` shape, args path resolution, timeout + error handling,
  when-to-use-hooks guidance, and the trust model for local scripts. Also
  cross-referenced from the `basics` topic so agents discover the feature
  during foundational reading.
- **`HistoryEntry` unchanged.** No session-shape break — existing
  traversals survive the upgrade.
- **Composition root return shape cleanup.** `createServer` now returns
  `{ server, stopWatcher?, runtime }`. The transitional flat
  `memoryStore` / `manager` fields from the beta.0 shape are dropped; all
  tests migrated to destructure `runtime` instead.
- **Per-field config precedence table** in `README.md` and inline
  per-field comments in `src/config.ts`, documenting which knobs accept
  which override layers (CLI flag, env var, config file).
- **Test helpers consolidation.** `test/helpers.ts` gains `loadFixtureGraphs`
  and `makeEngine` helpers, collapsing identical `makeEngine` boilerplate
  from five engine-test files (`test/engine.test.ts`,
  `test/subgraph.test.ts`, `test/wait.test.ts`, `test/returns.test.ts`,
  `test/graph-sources.test.ts`) into two-line delegates. Fixes a temp-dir
  leak in `test/cli-visualize.test.ts`.
- **Library rename**: `ensureStateDir` → `ensureFreelanceDir`,
  `resolveStateDir` → `resolveTraversalsDir` in `src/cli/setup.ts`. Call
  sites in the CLI and tests updated. No behavior change beyond the flat
  layout semantics.
- **Tests**: 583 → 589, with new coverage for onEnter hooks, layout
  migration, config precedence (C3 `maxDepth`, C6 symmetric `--memory`,
  `hooks.timeoutMs`), narrow `HookMemoryAccess` interface, and the
  `memory reset` CLI subcommand.

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
- **Subpath exports narrowed.** `package.json#exports` previously had five
  entries: `.`, `./core`, `./state`, `./memory`, `./server`. The latter three
  are dropped. `./core` stays public (engine + schema with no persistence —
  smaller import for consumers that only need the graph primitives). The
  root `.` entry still re-exports `TraversalStore`, `MemoryStore`,
  `createServer`, and `startServer`, so everything the dropped subpaths
  exposed is still reachable via `import { X } from "freelance-mcp"`.
  Consumers using `import { X } from "freelance-mcp/state"` (or
  `./memory`, `./server`) must switch to the root import.
- **`memory.ignore` config field removed.** After the sessions removal in
  `11de30c`, the ignore patterns were only consulted by
  `memory_register_source` — a tool that doesn't persist state and therefore
  couldn't meaningfully filter anything. `memory_emit` never checked the
  patterns. Users with `memory.ignore` in their `config.yml` or
  `config.local.yml` should remove the field; Zod will silently drop
  unknown fields, so configs won't break, but the ignore patterns will no
  longer have any effect. Filtering source files from memory is now a
  workflow concern (decline to cite them as proposition sources) rather
  than a store concern. Also drops `picomatch` and `@types/picomatch` from
  the dependency list — they were only used by the removed `isIgnored`
  helper.

### Removed

- **Daemon, proxy, and PID-file infrastructure** — `src/daemon.ts`,
  `src/proxy.ts`, `src/cli/daemon.ts`, `src/paths.ts`, and six test files.
- **Memory sessions** — `sessions` and `session_files` tables,
  `propositions.session_id` column, `getStaleSessionIds`, `end()`,
  `requireActiveSession`, and the session-files fallback branch in
  `enrichProposition`.
- **`memory_register_source` MCP tool removed** along with
  `MemoryStore.registerSource`, `RegisterSourceResult`, the `freelance
  memory register <file>` CLI subcommand, and the hidden `freelance
  memory-register <file>` hot-path command that existed as a target for
  a never-wired Claude Code `PreToolUse` hook. The sessions removal in
  `11de30c` had already made this a stateless echo — hash a file, return
  the hash, persist nothing. Nothing downstream consulted its result:
  `memory_emit` re-hashes every cited source at emit time for
  per-proposition provenance, so pre-registration was ceremonial. Rather
  than keep a tool the workflow instructions explicitly told the agent
  was optional, it's deleted. Memory tool count: 9 → 7 (sessions removal
  dropped `memory_end`, this removal drops `memory_register_source`).
  The sealed `memory:compile` workflow instruction that mentioned
  register_source is rewritten to reflect the new reality: "read files,
  track their paths in context.filesReadPaths, cite them in memory_emit
  when ready."
- **`better-sqlite3`** and `@types/better-sqlite3` dependencies. Zero native
  deps in the runtime install.
- **`EXIT.DAEMON_ERROR`**, `loadGraphsOrFatal` (only caller was daemon start),
  `parseDaemonConnect`, and `src/lib.ts` (orphaned library entrypoint
  superseded by the subpath exports).
- **`snapshotGraphs` deep-clone-per-operation** in `TraversalStore`. Was
  protecting a property (in-flight definition pinning) the JSON-file
  persistence model already provides and the synchronous engine never
  actually exposed to race conditions.
- **`propositions_au` AFTER UPDATE trigger** in the memory schema. It
  was defined to keep the FTS mirror in sync on UPDATEs of
  `propositions.content`, but `memory_emit` uses `ON CONFLICT DO
  NOTHING` and nothing else UPDATEs that column, so the trigger was
  dormant since `d1af397`. Older databases get the trigger dropped
  explicitly on next open via `DROP TRIGGER IF EXISTS`, so the schema
  state is deterministic.

### Added

- **Proposition rubric in sealed memory workflows** — the `compiling` node
  in `memory:compile` and the `filling` node in `memory:recall` now carry
  an explicit atomicity rubric instructing the agent to emit ONE factual
  claim per proposition (single sentence preferred, two max) and to split
  compound thoughts into separate propositions. Includes a negative
  example (four facts mashed into one prop) and four atomic rewrites as
  counterpoint. The rubric is a shared constant in `src/memory/messages.ts`
  so changes propagate to both sealed workflows atomically. Surfaced by a
  self-review of an earlier compilation pass whose props averaged
  paragraph-length — the sealed workflow correctly shaped the process
  (read → emit → evaluate) but the instructions never defined what a
  well-formed proposition looks like, so quality was delegated to agent
  judgment with no rubric to apply.
- **`EmitResult.warnings`** — `memory_emit` now returns a `warnings`
  array alongside the existing result fields when non-fatal conflicts
  are surfaced. Currently the only warning type is
  `entity_kind_conflict`: emitted when a proposition cites an entity
  with a `kind` that differs from the entity's previously recorded
  kind. The store keeps the first-recorded kind (first-wins, no
  reconciliation) and surfaces the disagreement so the caller can
  decide what to do — re-emit with a correction, escalate to a user,
  ignore. Aligns with the broader design principle that the store
  reports ground truth and the workflow/agent layer reconciles.

### Changed

- **`memory_emit.entities` cap raised from 2 to 4.** The old `1-2` cap
  was under-constraining atomicity (paragraph-sized props sneak through
  on two entities) and over-constraining relationship density (legitimate
  three- or four-way relationship claims like "A was replaced by B via
  mechanism C" couldn't be expressed). The new cap permits multi-party
  relationship propositions while the rubric and Zod `.describe()` make
  clear that splitting compounds is always preferred over packing extra
  entities, and that >4 entities in one prop usually means it's a hub and
  should be split. The `content` and `entities` `.describe()` strings
  both carry the updated guidance inline for agents that read parameter
  docs without looking at the tool description. The `memory_emit` tool
  description itself is rewritten to open with "ONE atomic factual claim
  in natural prose" rather than the previous "self-contained claim"
  phrasing, which had been interpreted as "stands alone" rather than
  "single fact."
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
- **Lifecycle breadcrumbs on stderr.** `startServer` now writes a one-line
  `freelance-mcp <version> started pid=<pid>` on startup and a matching
  `freelance-mcp shutdown pid=<pid> reason=<reason>` from inside the
  idempotent shutdown path. Reasons cover every exit route — `sigint`,
  `sigterm`, `sighup`, `stdin-end`, `stdin-close`, `stdin-ebadf`,
  `stdin-epipe`, `stdout-ebadf`, `stdout-epipe`, `uncaught-exception`,
  `unhandled-rejection`. By MCP stdio convention, stderr is forwarded to
  the client's MCP log and not shown to the user, so a rapid respawn loop
  becomes a readable timeline in the log (and stale cached versions become
  obvious from the version string).

### Fixed

- **MCP stdio server no longer orphans on parent disconnect.** When a parent
  process exited without sending `SIGINT`/`SIGTERM` (e.g. a backgrounded
  shell that then exited, a macOS terminal close revoking the fd, an MCP
  client crashing), the stdio server kept running indefinitely — holding
  file handles on `memory.db` and its WAL sidecar. On Windows this made
  `memory.db{,-shm,-wal}` undeletable with cryptic `EBUSY` errors. All
  disconnect flavors now funnel into a single idempotent `shutdown()`:
  `SIGINT`/`SIGTERM`/`SIGHUP`, `process.stdin` `end`/`close`,
  `process.stdin`/`process.stdout` `error` with `EBADF`/`EPIPE`, plus
  `uncaughtException` and `unhandledRejection` so thrown errors take the
  clean path instead of killing the process mid-write.
- **`memory.db-wal` / `memory.db-shm` sidecar cleanup.** The memory database
  now runs `PRAGMA wal_checkpoint(TRUNCATE)` before closing so the sidecar
  files don't linger after the process exits. Also tightens
  `wal_autocheckpoint` from the 1000-page default (≈4 MB) to 200 pages
  (≈800 KB), so long-running sessions recycle the WAL more aggressively —
  matching an in-the-wild observation of a 385 KB DB with a 4.25 MB WAL.
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
