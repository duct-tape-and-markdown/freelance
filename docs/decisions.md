# Decisions Log

Durable design decisions and cross-file invariants. The canonical home for WHY-context that applies beyond a single file or outlasts the PR that introduced it. See `CLAUDE.md` § "WHY-comments vs decisions log" for the inline-vs-doc test.

## Format

Each entry:

- **Short heading** — the invariant or decision in a phrase
- One or two paragraphs of prose explaining the decision, the tradeoffs considered, and what would break if it were reversed
- Optional link to the PR or issue that decided it

Append chronologically. When a later decision supersedes an earlier one, add a new entry that references and replaces the old — don't rewrite history. An entry that's been superseded is a breadcrumb for future readers wondering why the code looks the way it does.

## Entries

### CLI is the execution surface for agents

Freelance drives its workflow loop through a **single Claude Agent Skill + the pure CLI** (`freelance advance`, `freelance inspect`, etc., emitting structured JSON). The skill body composes CLI invocations into the loop; this is the execution surface, not one of several.

The rationale is a token budget asymmetry. Any mechanism that ships a fixed per-turn registration payload — tool definitions, schemas, per-session metadata — compounds linearly in session size. For a 30-turn workflow with ~2-3K tokens of tool definitions, that's ~75K per session just for registration metadata, before the agent does anything. The skill + CLI path is 0 per-turn registration tokens; the skill itself is a ~2K one-session fixed cost. The audience is overwhelmingly shell-capable (Claude Code CLI/IDE, Cursor, Windsurf, Cline, Agent SDK in remote or managed contexts, CI-driven agents) — pure-CLI is reachable from every realistic client.

**What this reshapes:**

- **CLI runtime verbs are primary.** `freelance advance/context set/inspect/...` are the surfaces the skill drives. Their output shape, exit codes, and error contract are first-class and committed.
- **Workflow prose is JIT teaching, not per-turn tool metadata.** The sealed workflows' node instructions (`src/memory/messages.ts`) arrive fresh in each `advance` response, so per-node teaching doesn't need to live in tool descriptions or the skill body. The "one skill for invariants + workflows for domain" framing preserves this separation.

**What would break if reversed:** Reintroducing any parallel runtime surface — MCP as a first-class alternative, a second binary, a socket RPC layer — would re-invite the per-turn registration-weight cost for every user regardless of client. The recent PRs that trimmed tool descriptions (#109), added field projections (#111), and paginated history (#112) were hedges against that cost. The decision here is to stop hedging and commit.

See issue [#99](https://github.com/duct-tape-and-markdown/freelance/issues/99) for the decision record.

### MCP server and tool surface deleted

The MCP server (`src/server.ts`), all `freelance_*` / `memory_*` MCP tools, `plugins/freelance/.mcp.json`, and the `freelance mcp` subcommand are gone. The skill + CLI path above is now the only execution surface.

Motivation: MCP was duplicate plumbing. Every tool handler wrapped an engine method the CLI already exposed, and the CLI runtime verbs had adopted the same JSON wire shape + semantic exit codes that MCP tools emitted (#114). Keeping both surfaces meant twice the test surface, twice the opportunity for drift between handlers, and ongoing investment in a code path the architectural commitment above calls vestigial. The library-consumer break is real but small — nothing outside this repo imported `createServer`/`startServer`.

A minimal Desktop fallback surface was considered in #99 Phase 3 and declined. Claude Desktop is the only non-shell client in the realistic audience, and the maintenance burden of even a 4-tool subset didn't earn its keep against measurable Desktop usage. If usage data later argues otherwise, the right move is a fresh minimal-surface fallback, not a restoration of the full 21-tool surface.

See issue [#116](https://github.com/duct-tape-and-markdown/freelance/issues/116).

### Graph hot-reload is not a runtime concept

Post-MCP-removal, Freelance has no long-running server process — every CLI invocation loads graphs fresh from disk and exits. There is no in-flight "reload" to reconcile against active traversals. `src/watcher.ts` (the `watchGraphs` primitive that debounced file-system events and called `manager.updateGraphs`) was deleted alongside this decision; its only caller was the MCP server, and it left a sharp edge without one: a re-wire would silently invalidate active traversals whose `graphId` disappeared, throwing `GRAPH_NOT_FOUND` at the next advance (the failure mode #90 describes).

The residual concern the issue captures — a user starts a traversal, edits/renames the graph, runs the next verb — still exists, but at CLI-invocation boundaries. The current behavior there is already fail-loud: `GRAPH_NOT_FOUND` on the next `advance` or `inspect`. Improving that UX (surfacing orphaned traversals on `status`, adding actionable error messages, optionally migrating by nearest-matching id) is a separate design question that belongs on its own issue if and when observed pain warrants it.

**What would break if reversed:** reintroducing a watcher without an explicit orphan-handling policy re-opens #90. Any future hot-reload surface must decide up front whether it (a) refuses to reload when active traversals reference the departing graph, (b) marks orphans but continues serving, or (c) auto-resets orphans loudly.

See issue [#90](https://github.com/duct-tape-and-markdown/freelance/issues/90).

### Config changes take effect on the next CLI invocation

Freelance config (`.freelance/config.yml`, `.freelance/config.local.yml`) is read at CLI startup and flows into `composeRuntime` → `HookRunner` / `GraphEngine` / `MemoryStore` for the duration of that invocation. There is no long-running process to hot-patch — each `freelance advance` / `freelance status` / etc. reloads config from disk before wiring the runtime. "Config reload" is therefore not a runtime concern; it's "run the next verb."

Historical note (closed by #121 and #90): an MCP-server era `onConfigChange` handler in `src/server.ts` logged `"Freelance: config reloaded"` on `config.yml` / `config.local.yml` edits but never re-threaded the new values into the live `HookRunner` or `GraphEngine` — edits looked like they applied and didn't. #91 called that out. The handler was deleted with the MCP server (#121); the watcher that would have invoked it was deleted with #90. A future re-introduction of any long-running surface must either (a) plumb the new config through every downstream that consumed it (hook timeouts, maxDepth, memory dir — with the caveat that some fields can't hot-swap, e.g. memory db path reopening) or (b) log `"Freelance: config changed on disk — restart to apply"` and leave the mutation out. Silent reload-without-apply is the specific trap to avoid.

See issue [#91](https://github.com/duct-tape-and-markdown/freelance/issues/91).

### Hook trust model: built-ins curated, script hooks full-privilege, sandbox deferred

`onEnter` hooks have two tiers with deliberately different trust postures:

- **Built-in hooks** (`src/engine/builtin-hooks.ts`) are part of the package surface. They run against a narrow read interface over memory (`HookMemoryAccess`) plus an explicit meta collector — not the whole `MemoryStore` — so a built-in can't reach write methods, the SQLite handle, or process globals. They're reviewed at every release.
- **Local script hooks** (`./scripts/foo.js`) are user code loaded via `import()` into the same Node process. They get filesystem, network, subprocess, and environment at full privilege. The 5-second `hooks.timeoutMs` only bounds the promise race; side effects initiated before the timeout still run to completion.

This asymmetry is intentional. Collapsing the tiers either way is worse: sandboxing built-ins adds indirection with no security win (they're curated), and sandboxing user scripts requires real isolation (`isolated-vm`, subprocess with `--permission`, or a WASM runtime) — that's architecture work, not a patch, and doesn't fit in a P2 issue.

What ships today is the assertion surface, not the sandbox:

- `FREELANCE_HOOKS_ALLOW_SCRIPTS=0` at the environment makes `resolveGraphHooks` reject every `kind: "script"` entry at graph load with a clear error. Operators that can't vet every contributed workflow (shared graph registry, multi-agent marketplace scenarios from #45) set the flag and get a built-ins-only runtime. Default is allowed — the flag is an opt-in to stricter handling, not a default-deny, because the dominant single-user case is a trusted repo.
- The README's "Trust model for hook scripts" paragraph names the line explicitly so a graph author can't claim they didn't know.
- A real sandbox (isolate scripts in a subprocess or VM with no ambient authority) is the right answer for the marketplace scenario. Tracking as a milestone feature, not a patch on this PR.

**What would break if reversed:** Making user scripts sandboxed-by-default would require picking a sandbox technology now — each option has real tradeoffs (vm2 is unmaintained, isolated-vm is a native dep, subprocess adds IPC overhead to every hook) and picking wrong is worse than the honest "no sandbox, don't load untrusted graphs" stance.

See issue [#89](https://github.com/duct-tape-and-markdown/freelance/issues/89).

### Memory database opens lazily on first access

`MemoryStore`'s constructor accepts a `() => Db` thunk alongside the eager `Db` form. `composeRuntime` passes the thunk so the SQLite handle is only opened when a memory method is actually invoked. Non-memory CLI verbs (`freelance status`, `visualize`, `validate`) then never touch `memory.db` — which shrinks the cross-process collision surface on WAL-mode open-time locks. That surface is real: `PRAGMA journal_mode = WAL` takes a write lock, last-connection WAL checkpoint takes an exclusive lock, and crash recovery bypasses the busy handler entirely (see `sqlite.org/wal.html` §5). Two concurrent `freelance status` calls used to race each other on a db neither one read.

Two adjacent mitigations travel with the lazy open: (a) `PRAGMA busy_timeout = 5000` is now set *before* `PRAGMA journal_mode = WAL` in `openDatabase` — previously, a losing writer's WAL switch returned `SQLITE_BUSY` immediately because the busy handler hadn't been installed yet; (b) `openDatabase` retries the entire open on SQLITE_BUSY (3 × 50 ms) and, if every attempt is busy, throws `EngineError(EC.DATABASE_BUSY)` so the CLI error envelope replaces the raw `ERR_SQLITE_ERROR` stack trace.

**What would break if reversed:** eager opens re-expose every CLI verb to the open-time races, re-surface the uncaught `ERR_SQLITE_ERROR` stack traces, and drag every invocation's startup cost up by the WAL setup and schema-compatibility checks even when they never read memory.

See issue [#138](https://github.com/duct-tape-and-markdown/freelance/issues/138).

### Memory directory creation lives in `buildMemoryStore`, never in `resolveMemoryConfig`

`resolveMemoryConfig` (in `src/cli/setup.ts`) is pure: it returns the resolved db path without touching the filesystem. The `mkdirSync` for the parent directory lives inside `buildMemoryStore`'s thunk in `src/compose.ts`, so the dir is created exactly when (and only when) the SQLite handle is about to open.

Any CLI verb that needs to *resolve* a path without *opening* the db must be free to do so without leaving artifacts behind. The motivating case is `freelance memory reset`: the recovery path for "old memory.db schema is incompatible with the current build" deliberately bypasses `composeRuntime` and unlinks the files directly. Pre-fix, `resolveMemoryConfig` performed an `mkdirSync` as a side effect of every config branch, so `memory reset --confirm` on a clean repo *created* the very `memory/` directory it had just unlinked.

**What would break if reversed:** any future helper added to `setup.ts` that calls `mkdirSync` to "make sure the path is ready" re-introduces the same bug class. The invariant is not "memory reset is special" — it's "path resolution is pure; I/O is `composeRuntime`'s budget."

See issue [#197](https://github.com/duct-tape-and-markdown/freelance/issues/197).

### Sealed memory workflows are runtime-injected freelance primitives

`memory:compile` and `memory:recall` live in code (`src/memory/sealed.ts` + `src/memory/recollection.ts` + `src/memory/workflow.ts`) and are merged into the loaded graphs map at runtime via `mergeSealedGraphs`. Validate / visualize / sources_validate special-case their ids via `extraAvailableIds` so user workflows can reference them as subgraphs without seeing "unknown graph" errors at load time.

This is deliberate, not an artifact. Sealed workflows are freelance-domain **primitives** the user composes *with*, not starter templates the user customizes. Shipping them as YAML in `.freelance/` would:

- Invite divergent local edits that break the release-cycle guarantee — every freelance install on the same version emits identical memory teaching prose (atomicity rubric, entity guidance, warm-path edges).
- Turn `freelance` upgrades into silent no-ops for users whose local sealed files have drifted.
- Make community packs that reference `memory:compile` as a subgraph a gamble on whichever variant the installing user happens to be running. The marketplace case (#45) depends on sealed behavior being uniform across installs.
- Expose the memory system's internal prose to casual modification, where subtle edits (the atomicity rubric's WRONG/RIGHT examples, the entity-reuse prose) degrade recall quality in ways that don't surface until much later.

The `extraAvailableIds` allow-list is not a leak; it's the mechanism by which user workflows can legitimately reference a sealed subgraph without a local copy. The three special-cases in validate / visualize / sources_validate are the cost of maintaining the primitive/user boundary — a cost worth paying.

**What would break if reversed:** shipping sealed as templates erases the sealed-vs-user distinction, makes sealed prose version-drift a silent failure mode, and requires a `freelance memory refresh-sealed` lifecycle verb whose only job is to un-break installs where the user edited sealed files without understanding the contract. The current injection is simpler than any template variant that preserves the invariant.

See issue [#92](https://github.com/duct-tape-and-markdown/freelance/issues/92).

### Expression language stop-line: predicates, not computations

`src/evaluator.ts` is a hand-rolled tokenizer plus recursive-descent parser — literals, `context.` property access, `&& || !`, `== != > < >= <=`, and a single built-in `len()`. Every request to extend it (add `startsWith`, add regex, add arithmetic, add array membership) has to answer the same question: what's the stop-line? Without one, the language ratchets outward one operator at a time until it's a general-purpose mini-language with its own tokenizer bugs and security surface. Three rules, in order:

1. **Expressions are predicates, not computations.** The evaluator returns `boolean`. No arithmetic, no string construction, no value transformations. If a graph needs `lowercase(x)` or `a + b`, that work belongs in a hook that writes the derived value back to context; the edge condition then compares the derived field. This keeps the parser's output type trivially checkable at load time and keeps graph authors from debugging subtle coercion in a DSL they didn't know they were writing.
2. **Built-in functions must be total and side-effect free.** `len()` qualifies — it's defined for every input (returns 0 for non-array-non-string), throws nothing, reads nothing outside its argument. A hypothetical `fileExists()` or `fetchStatus()` would not; those belong in hooks where the failure mode is a visible hook error, not a silent `false`. New built-ins must clear both bars: total (defined everywhere, no throw paths) and side-effect free (no I/O, no globals, no `Date.now()`).
3. **Context is the only data source.** No environment variables, no `process.env`, no `Date.now()`, no filesystem reads. An expression evaluated twice with the same context must return the same value. This makes graphs reproducible — replay the same context, get the same routing decision — and keeps the attack surface tiny (a malicious graph can't exfiltrate env via an edge condition).

The rationale is cumulative: small surface (one parser, one evaluator, bounded grammar), small attack area (no I/O primitive a graph author can reach), auditable load-time validation (`extractPropertyComparisons` can statically enumerate every comparison because the grammar is closed), and forced separation of concerns (derivations live in hooks, which have a trust model, timeouts, and a test story — see "Hook trust model" above).

**What would break if reversed:** Adding a `startsWith` or regex operator looks cheap in isolation. The second operator has to decide whether it composes with the first (is `!startsWith(x, "http")` valid? how about `startsWith(lower(x), "http")`?); the third has to decide whether built-ins can take other built-ins as arguments. Each choice accretes parser complexity and user-facing surprise. Keeping the grammar closed and pushing derivations to hooks means the extension point is `onEnter` hooks — which already have a trust model, a timeout, and a well-defined error envelope — rather than an ever-growing DSL.

See issue [#93](https://github.com/duct-tape-and-markdown/freelance/issues/93).

### Source root binds to first graphsDir's parent

Relative source paths in graph `sources:` bindings resolve against the **source root**, which defaults to the parent of the *first* graphsDir in the resolution cascade. Under multi-dir cascade (`./.freelance` + `~/.freelance` + workflow dirs), graphs in later dirs resolving their sources relative to their *own* dir get stale/missing reads — the loader doesn't rewrite per-graph.

Workflows intended to ship in user-level or plugin directories must use absolute paths or set a shared source root via `--source-root <path>` (CLI) or `sourceRoot` on `composeRuntime`.

**What would break if reversed:** per-graph source roots would let plugin authors ship workflows with sources co-located in the plugin directory, but introduces ambiguity when a user-level workflow references a project-level source file. The first-graphsDir rule is a single anchor; every graph author knows where their paths resolve from.

Anchors: `src/graph-resolution.ts`, `src/sources.ts`, `src/compose.ts` (sourceRoot plumbing), README § "Workflow directories". Closes #98.

### Subgraph traversal is a session-boundary crossing; returnMap is the explicit contract

A subgraph push is a traversal-session boundary. `freelance inspect --detail history` treats the push as a boundary marker — context writes inside the subgraph are visible via the subgraph's own history, and values flow back to the parent *only* through the explicit `returnMap` declared on the subgraph node.

Implicit context bleed (subgraph writes a key, parent reads it on resume) is not supported. Callers that want cross-boundary data pass it via `returnMap: { parentKey: childKey }`; the engine validates the shape and fails loudly on missing return keys.

**What would break if reversed:** implicit bleed makes subgraphs non-reusable — a subgraph's internal context keys become an API the parent depends on. `returnMap` as the explicit contract means a subgraph can refactor its internals without breaking callers, and a parent knows exactly which keys it receives.

Anchors: `src/engine/subgraph.ts` (push/pop + returnMap validation), `src/schema/graph-schema.ts` (SubgraphNode schema), `src/engine/engine.ts` (pop path). Closes #96.

### Projection vocabulary is a deliberate three-way split

Three projection flags, three non-overlapping axes — don't unify:

- `--minimal` (bool) = response-size tier on the hot path (`advance`, `context set`, `inspect`)
- `--fields <name>` (repeatable) = opt-in graph-piece projections on inspect (`currentNode | neighbors | contextSchema | definition`)
- `--shape minimal|full` (enum) = memory-specific provenance detail level (`memory inspect`)

They don't substitute. `advance --shape` and `memory inspect --minimal` both fail `INVALID_FLAG_VALUE`. SKILL.md teaches the one-sentence mental model; the flags map to different surfaces and different caller contracts.

**Rejected proposal: unify on a single projection verb (e.g. `--shape` everywhere).** The three flags cover three axes: response-size tier, additive graph-piece projection, memory provenance detail. Collapsing them erases axis distinctions and breaks caller contracts — `memory_inspect` onEnter defaults to `shape: "minimal"` for response-ceiling reasons specific to memory; `--fields` on inspect must be repeatable because callers combine projections; `--minimal` is a bool on the hot path because that's what per-turn size-tier branching needs. Any future proposal to unify must first specify which of these three contracts it breaks and why the break is worth it.

**What would break if reversed:** a single projection verb collapses three axes into one; callers lose the per-surface defaults and additivity they rely on.

Anchors: `src/types.ts` (minimal response shapes), `src/memory/types.ts` (PropositionShape), `src/cli/output.ts`, SKILL.md § "Three projection verbs, three axes".

### Observable state transitions are durable before side effects

Once an advance mutates `session.currentNode` past an edge, the traversal record is persisted **before** any code that can throw runs — specifically before `runArrivalHooks` fires onEnter hooks on the new node, and before the child-start onEnter fires on a subgraph push. Hook-collected context and meta writes persist on a second save after the hooks resolve.

The rationale is log-then-apply on visible state. `advance` splits into two phases: `advanceTransition` (sync — mutates `session.currentNode`, records the history entry, returns), then `runArrivalHooks` (async — fires onEnter for the arrived node, merges hook writes). The traversal store persists between them. Two saves per successful advance; one save (the transition only) on a hook throw.

Alternatives considered and rejected:

- **Pre-transition hooks** — looks clean but hooks have external side effects (HTTP, `memory_emit`, filesystem writes from script hooks). Firing those for a transition that then aborts on a later hook's throw is a worse invariant — work done for a trip not taken.
- **Save-in-finally** — preserves partial hook writes across a throw, but "disk reflects a transition that partially ran" is exactly the failure mode this contract is trying to escape.

Under log-then-apply:

- **Success:** two saves (post-transition record, then post-hook record carrying context + meta writes).
- **Hook throw:** one save (the transition). Disk truth is "arrived at target, no hook writes." The envelope carries `currentNode = new node`, matching disk, with an `error.hook` sub-object naming the broken hook.
- **Subgraph push:** same invariant. `maybePushSubgraph` mutates the stack, persists, then fires the child's onEnter.

This contract applies to *traversal state only*. Memory emits are not traversal state and must not be entangled with transition outcomes — see § "Memory emit attribution is emit-time, not transition-time".

**What would break if reversed:** collapsing the two saves into one re-opens the race where `advance` mutates in-memory state, fires a hook that throws, and returns an error while disk stays at the previous node. In-memory and on-disk diverge; the next CLI invocation loads a stale record and retries against a stale node.

Anchors: `src/engine/engine.ts` (`advanceTransition` + `runArrivalHooks`), `src/engine/subgraph.ts` (`maybePushSubgraph`), `src/state/traversal-store.ts` (persist call site).

### Error envelope is the wire contract

The CLI error envelope is `{ isError: true, error: { code, message, kind, recoveryVerb, recoveryKind } }` where `code: EngineErrorCode` (the discriminated union exported from `src/error-codes.ts`) and `kind: "blocked" | "structural"`. Every code is grouped under exactly one exit category in `ENGINE_ERROR_CODES`, which `mapEngineErrorToExit` derives from — adding a code in the wrong group, or a new category without an exit mapping, is a compile error, not a runtime bug.

No code emitted by the CLI or any library surface may be string-typed or absent from the catalog. A contract test (`test/envelope-contract.test.ts`) walks every throw site in `src/` and asserts the thrown code is a member of `ENGINE_ERROR_CODES`. Ad-hoc strings in error messages are fine; the `code` field is not freeform.

Every `EngineErrorCode` entry carries two non-optional recovery fields, sourced from a sidecar `RECOVERY` table the `freelance catalog --json` verb emits verbatim:

- `recoveryVerb: string | null` — literal CLI the caller runs next (template-interpolated against root-level envelope fields; e.g. `"advance --traversal {traversalId}"`, `"{commandName} --confirm"`). `null` means no verb recovers this code — skill reports and stops.
- `recoveryKind: "retry" | "fix-context" | "report" | "clear"` — classifier the skill branches on (transient retry vs operator-fixable context vs stop-and-report vs stale-state-clear).

`EngineError.context` has two subfields distinguished by spread target: `context.hook` nests under `envelope.error.hook` (HOOK_* throws); `context.envelopeSlots` spreads at `envelope` root next to `isError` (carries the template interpolation values — `commandName`, `traversalId`, `candidates`, `graphId`, `graphDir`). Slot names are `{camelCase}` and match envelope root field names verbatim — no casing translation, skill substitutes by literal lookup.

The CLI exposes the catalog via `freelance catalog --json` as the single source of truth. SKILL.md cites the command and the recovery pattern once; it does not restate per-code recovery prose.

**What would break if reversed:** string-typed codes re-introduce pre-#118's typo-at-throw-site failure mode. Dropping `recoveryVerb` forces SKILL.md to restate per-code recovery prose that drifts silently. Collapsing `recoveryKind` into the verb (e.g. just emitting "no-op verb" for report-only codes) makes the skill parse the verb string to decide whether to retry — exactly the freeform-parsing antipattern the envelope is escaping. Spreading `envelopeSlots` into `error.*` instead of root hides the template fields under a layer the skill has to unwrap, and collides with future `error.*` field additions.

Anchors: `src/error-codes.ts` (`RECOVERY`, `HookErrorContext`), `src/errors.ts` (`EngineErrorContext`), `src/cli/output.ts` (`errorEnvelope`, `outputError` spread logic), `src/cli/catalog.ts`, `test/envelope-contract.test.ts`, `test/catalog.test.ts`. Closes #95, #117, #118, #134, #137.

### Destructive verbs gate on `--confirm`

Every destructive CLI operation (`freelance reset`, `freelance memory reset`, `freelance memory prune`) requires `--confirm` to actually mutate. Without it the verb emits a preview / plan and exits non-zero with `CONFIRM_REQUIRED` (`kind: "structural"`, exit 5, `recoveryVerb: "{commandName} --confirm"`, `recoveryKind: "fix-context"`). `commandName` — the literal CLI path the operator used — is carried on envelope root via `EngineError.context.envelopeSlots` so the skill interpolates the template once and gets the right retry command regardless of which verb triggered the throw.

`--yes` was removed in 1.4. Prior to 1.4 some destructive verbs accepted `--yes` as a synonym for confirmation; the two-flag surface made every destructive-action error message ambiguous about which flag was canonical. The migration cost is zero — every `--yes` invocation becomes `--confirm`.

Single recovery verb across destructive ops means SKILL.md teaches "on `CONFIRM_REQUIRED`, add `--confirm`" once, not per-verb.

**What would break if reversed:** dropping the `commandName` slot forces per-verb recovery templates in `RECOVERY`, which defeats the "teach once" property above.

Anchors: `src/cli/program.ts` (flag registration), `src/cli/memory.ts` (`memoryPrune`, `memoryReset`), `src/cli/traversals.ts` (`traversalReset`), `src/error-codes.ts` (`CONFIRM_REQUIRED` + `RECOVERY[CONFIRM_REQUIRED]`).

### Prune is content-reachability, not commit-reachability; schema unchanged

The #80 design proposed capturing a `git_ref` on each `proposition_sources` row at emit time so prune could later ask "is the commit that produced this row still reachable?" Empirical work during implementation pivoted to **content-reachability**: "are these bytes live anywhere — disk or any declared-live ref?" No schema change; `content_hash` already carries the information.

The pivot is forced by git's history-rewriting workflows. Rebase, squash-merge, and amend all *rewrite commit SHAs* while *preserving tree content*. A `git_ref` column captured at emit time would become unreachable after any of these, classifying live knowledge as stale. Content-reachability sidesteps the entire class by asking about bytes, not commits.

**What would break if reversed:** re-adding a `git_ref` column re-introduces the rebase/squash/amend footgun. The column drifts out-of-sync with reality on every history rewrite, leaving the user to choose between "prune aggressively and lose knowledge" or "never prune and accumulate forever." Neither is acceptable.

Anchors: `src/memory/prune.ts`, `src/memory/git.ts`, `docs/memory-intent.md` § "Knowledge is append-only across corpus frames". Commit `10beb0e` documents the pivot in its body despite a misleading subject line. Closes #80.

### Prune does not GC entities — entity survival preserves branch-switch re-linkability

`prune` never deletes entity rows. It removes stale `proposition_sources` rows (and, when an entity's last valid proposition goes, that entity becomes orphaned in the read-time filter sense) but the entity row survives. Prune output reports `entities_now_orphaned` — a count of entities that transitioned to zero valid propositions as a result of this prune — not `entities_orphaned` or `entities_pruned`; the tense is load-bearing.

The rule is a direct consequence of `docs/memory-intent.md` § "Knowledge is append-only across corpus frames". An entity is a coordinate a proposition links to, not a fact in itself; deleting it would break re-linking when a reverted branch or future emit re-introduces propositions that cite the same name. The default orphan-hiding filter on `memory_browse` (`valid_proposition_count > 0`, `src/memory/store.ts`) is the *lens* that controls visibility; the row's continued existence is what makes the lens reversible.

**What would break if reversed:** emit-time or prune-time entity GC collapses the multi-frame store into single-frame — branch switch, `git revert`, or a re-emit after temporary removal would have to *recreate* the entity, breaking any external reference (saved workflow context, agent transcript) that named it by id. Orphan accumulation is the cost; it's bounded by the fact that entities are small and name-deduped.

Anchors: `src/memory/prune.ts`, `src/memory/store.ts`, `docs/memory-intent.md` § "Knowledge is append-only across corpus frames" and § "Not an emit-time garbage collector".

### Memory emit attribution is emit-time, not transition-time

`memory_emit` writes the proposition at the node the caller was on when emit fired, independent of any subsequent traversal move. A prop emitted at node N persists even if the caller's next `freelance advance` fails a gate (edge condition, wait, return schema, validation) or throws `HOOK_FAILED`. Memory writes are not part of the traversal transition — they are not rolled back when a later transition fails.

The rationale is the append-only-across-corpus-frames contract from `docs/memory-intent.md`. A proposition captures *what the agent derived while reasoning at N*. That reasoning happened regardless of whether the agent successfully left N afterward. Coupling emit to "the next successful advance" would make the knowledge graph speculative on every workflow step and collide with § "The store is a passive sink" — the store does not track traversal outcomes and must not.

This complements § "Observable state transitions are durable before side effects": traversal state is transitional and persists via log-then-apply; memory state is not transitional and persists on emit regardless of what happens next.

**What would break if reversed:** any mechanism tying emit durability to transition success re-introduces speculative writes — the agent sees "emitted" but the row vanishes if the next advance blocks. Worse: a `HOOK_FAILED` on the next node swallows the emit the caller believed was durable.

Anchors: `src/memory/store.ts` (emit is synchronous, transaction-scoped to the emit call alone, no traversal-id entanglement), `docs/memory-intent.md` § "Append-only across corpus frames", § "The store is a passive sink", § "Not an emit-time garbage collector".

### mtime_ms column removed from `proposition_sources`

Post-#74 the `mtime_ms` column was neither written nor read — drift detection now re-hashes content per-call via `StalenessCache` amortization. The column was retained only as a no-op for existing databases. 1.4 drops it outright with an in-place migration matching the `propositions.collection` pattern (#135).

**What would break if reversed:** re-adding the column re-introduces the mtime fast-path footgun (#74 rationale: mtime is preserved across real edits by `git checkout`, `rsync -t`, `touch -r`, etc.). The column has no legitimate use absent that fast path.

Anchors: `src/memory/db.ts`, `src/memory/sources.ts`.

### Extensions register capabilities; memory is the first conformance test

Freelance ships two extensibility surfaces today — graph dirs (`.freelance/*.workflow.yaml` cascade) and script hooks loaded by path. What it lacks is a packaging unit that bundles a graph + its hooks + a stateful host capability (a SQLite store, a credentialed API client, an HTTP-backed cache) + a skill snippet as one installable thing, plus a way for hooks contributed by one extension to consume services contributed by another. The decision: generalize `composeRuntime` from "memory is hardcoded" to "extensions register capabilities, hooks declare requirements, framework wires the graph."

The shape adopted has two layers — a deeper primitive and a registration surface. The **primitive** is event + handler: the engine exposes a lifecycle dispatch table where events have a name, a node-attribute schema, and a fire-point in the traversal loop; handlers subscribe to events by name. Today's `onEnter` becomes an instance of this primitive — freelance vendors a `node:enter` event in-tree (attribute schema is `HookSpec[]`, fire-point is the existing arrival site), and the graph-yaml syntax (`onEnter: [{ call: memory_status }]`) is unchanged. Named hooks stop being the registration primitive and become a vendored ergonomic over the underlying event+handler model — `call: memory_status` resolves to a handler whose `name` field matches.

The **registration surface** is `package.json#freelance.provides`, listing **capabilities** (`{ name, module }`, where the module exports `async activate(ctx)` returning `Promise<{ value, close? }>`) and **handlers** (`{ event, module, requires: ["cap_name"], name? }` — `name` is the optional yaml-addressable identifier; omitting it makes the handler subscribe-only). `composeRuntime` activates each capability in declaration order, collects results into a frozen `caps: Record<string, unknown>` bag threaded into the handler invocation context, and validates every handler's `requires:` against the bag at registration time — a missing capability is a loud throw at compose, not a runtime `undefined` deref inside the handler body. Activate is uniformly async — capabilities are exactly where slow startup work (credential validation, schema migration check, remote registry fetch) belongs, and the honest signature says so; sync caps write `async activate() { return { value: ... } }` and pay nothing measurable. `composeRuntime` itself becomes async with one `await` per CLI-verb setup call site; downstream `Runtime` methods stay sync. CLI verbs an extension contributes are namespaced behind the extension name with a colon (`freelance gh:status`), matching the Claude Code plugin precedent (`/my-plugin:hello`) and rejecting Pi's load-order-suffix scheme (`/review:1`) — namespacing is mandatory, not collision-triggered, so the routing is deterministic.

Memory is the first conformance test. The current shape (`src/compose.ts:169-218`) hardcodes one capability: `composeRuntime` builds a `MemoryStore` from `MemoryConfig`, threads it into `HookRunner` as a named field, and `HookContext.memory: HookMemoryAccess` exposes a narrow read interface to built-ins (§ "Hook trust model: built-ins curated, script hooks full-privilege, sandbox deferred"). The migration generalizes in place: `MemoryStore` becomes the value returned by a `memory` capability's `activate()`; the bag's `caps.memory` field replaces `HookContext.memory`; the seven `memory_*` handlers in `src/engine/builtin-hooks.ts` subscribe to `node:enter`, declare `requires: ["memory"]`, and read the narrow interface from `caps`. Memory handlers still ship in-tree — vendored, not unbundled — but they consume the public event+handler+capability API the way a community extension would. If a hypothetical second extension wanting the same shape (a `github` capability backing `gh_pr_status` handlers, a `vault` capability backing credential reads) can't be expressed against this surface, the API has a gap and the entry is wrong. Memory alone is N=1; the API cannot be proven correct against a single sample. The architectural milestone bundles **the engine's dispatch refactor + `composeRuntime` generalization + the discovery layer (`node_modules/freelance-ext-*` convention + `.freelance/extensions/*` auto-load + explicit `config.yml#extensions:` listing) + at least one external example extension** as a single release. Sequencing into separate PRs is a review-hygiene concern, not a release concern — partial landing leaves the API unproven against the case it was built for.

The pattern is VS Code's, not Pi's. VS Code's `activate()` returns an API object that other extensions reach via `extensions.getExtension('id').exports`, with `extensionDependencies` in `package.json` declaring the link — typed, dependency-checked, proven across thousands of extensions. Pi's docs explicitly omit a service-registry pattern ("No service-registry pattern is documented; state sharing relies on closure variables or persisted session entries"); their inter-extension primitive is an events bus, which is too weak when the consumer needs a typed handle to a stateful store. Closure sharing also forces single-process lifecycle coupling that collides with the CLI-is-stateless invariant (§ "Config changes take effect on the next CLI invocation").

This decision **does not relax** the hook trust model. Handlers shipped by an extension are reviewed at the same release-time bar as in-tree handlers only when the extension itself is in-tree (memory); third-party extension handlers are tier-2, gated by the same `FREELANCE_HOOKS_ALLOW_SCRIPTS` opt-out — see § "Extension code is tier-2: full-privilege, opt-out, audit-by-source". The extension packaging layer is orthogonal to script sandboxing; real isolation remains milestone work, not this decision.

The architecture is staged. **Phase 1** ships the event+handler primitive with `node:enter` as the only registered event — memory restructured against the new API, discovery layer, one external example extension, all as one release. **Phase 2** extends it: extensions register additional events (`node:leave`, `node:error`, `edge:traverse`, etc.) with their own fire-points the engine commits to and other extensions' handlers can subscribe to. The Phase 1 dispatch refactor is designed so Phase 2 is a schema registration plus a new fire-point, not an engine reshape. **Phase 3** — extensions adding **new top-level node attributes** with their own schema — does not ship until its own stop-line entry (modeled on § "Expression language stop-line: predicates, not computations") answers the questions it depends on: namespace mandatory or optional? Validation strict or permissive when extension-contributed attributes conflict on a node? What fire-point contract is the engine willing to commit to forever per event? Without those answers, attribute extensibility is the open-the-DSL footgun freelance has otherwise refused to make. The Phase 1 commitment leaves the door open; the Phase 3 trigger is a separate decision pending its own analysis.

**What would break if reversed:** keeping memory hardcoded means the second feature wanting the same shape gets a second one-off field on `ComposeConfig`, a second branch in `composeRuntime`, and a second optional field on `HookContext`. The two-tier "first-party features get capability threading; extensions don't" framing leaks into every subsequent design decision and trains contributors to special-case rather than generalize. Picking "named hook" as the registration primitive instead of event+handler closes Phase 2 off — every event-taxonomy expansion would require a parallel registration system rather than a new event entry against an existing primitive, which is exactly the special-casing this entry rejects. The single-API path also means a community extension that needs e.g. memory access can declare `requires: ["memory"]` and have the framework wire it without importing freelance internals — the latter being how plugin ecosystems calcify into one-extension-deep dependency trees.

Anchors: `src/engine/engine.ts` (event dispatch table; `runArrivalHooks` becomes `dispatchEvent("node:enter", ...)`), `src/compose.ts` (capability bag collector + handler registration replace memory-specific wiring), `src/engine/hooks.ts` (`HookContext.caps` bag; `HookRunner.builtinHooks` becomes `{ event, fn, requires? }` indexed by handler name), `src/engine/builtin-hooks.ts` (memory handlers subscribe to `node:enter`, declare `requires: ["memory"]`, read narrow interface from `ctx.caps.memory`), `package.json#freelance` (extension manifest field, mirrored at `.claude-plugin/plugin.json`'s position in the CC plugin convention). VS Code precedent: [activate() exports + extensionDependencies](https://code.visualstudio.com/api/references/vscode-api). Pi.dev negative example: [extensions doc](https://pi.dev/docs/latest/extensions) (no service-registry pattern).

### Recovery lives in `envelopeSlots`, never in `error.message`

The wire contract (§ "Error envelope is the wire contract") says `recoveryVerb` is a literal CLI template, interpolated against root-level slots the throw site populates via `EngineError.context.envelopeSlots`. The corollary: a throw site whose recovery requires a parameter (a traversalId to reset, a graphId to restart, a list of candidates to choose among) MUST populate the matching slot. Recovery instructions in `error.message` prose — `"Run \`freelance reset <id> --confirm\`"` baked into the message string — fail the contract: the skill renders the template by literal field lookup, has no parser for the prose, and falls back to surfacing the message verbatim or asking the operator. Either way, the catalog template stops being load-bearing.

Three rules fall out of this:

1. **Per-shape codes, not overloaded ones.** When a single code's recovery shape splits in two — e.g., `GRAPH_NOT_FOUND` for `start <typo>` (no recovery verb, nothing to clear) vs. an orphaned traversal whose graph yaml went missing (verb `reset {traversalId} --confirm`, kind `clear`) — split the code. One code per recovery shape; the catalog refuses to encode "sometimes the verb is null, sometimes it's a template" against a single entry.
2. **Storage backends agree on rejection codes.** A guard on the JSON backend that's silent on the in-memory backend (or vice versa) makes the wire contract environment-dependent — the test suite catches one shape, prod hits the other. Both backends throw the same code for the same shape; if a guard belongs at the boundary, route it through the catalog (`INVALID_FLAG_VALUE` for caller-supplied input, not raw `Error` collapsing to `INTERNAL`).
3. **Race shapes are distinguishable from version drift.** `putIfVersion` against a deleted record is `TRAVERSAL_NOT_FOUND` (`recoveryKind: clear`, the dead handle drops); against a version-drifted record is `TRAVERSAL_CONFLICT` (`recoveryKind: retry`, re-read and try again). Collapsing both into `TRAVERSAL_CONFLICT` makes the skill loop one extra hop on a dead handle before the second-hop `loadEngine` resolves it correctly. The resurrection-rejection invariant from § "Observable state transitions are durable before side effects" (#163) is preserved either way — the missing-record path still rejects the write — but the wire shape now matches the operator's intent.

`AMBIGUOUS_TRAVERSAL` follows the same rule: `envelopeSlots.candidates` (an array of `{traversalId, graphId, currentNode, meta}` mirroring `freelance status`'s `activeTraversals`) plus a representative `traversalId` slot for the verb template — the skill picks from the structured array instead of regex-parsing a prose summary.

**What would break if reversed:** reverting any of the three rules re-opens the freeform-parsing antipattern the wire contract escapes — the skill's branching on `recoveryKind` becomes lossy, recovery commands become per-call prose the skill has to grep, and the catalog's `recoveryVerb` template is decoration rather than the source of truth. Most concretely, a code with `verb: "reset {traversalId} --confirm"` whose throw site doesn't supply `traversalId` renders as the literal string `"reset {traversalId} --confirm"` to the skill — visible regression, not silent.

Anchors: `src/state/traversal-store.ts` (`resolveTraversalId`, `loadEngine`), `src/state/db.ts` (`assertSafeId`, `putIfVersion`, `TraversalDeletedMidWriteError`, `TraversalConflictError`), `src/error-codes.ts` (`TRAVERSAL_ORPHANED`, `RECOVERY` entries with `{slot}` templates), `test/envelope-contract.test.ts` (wire-level coverage per code). Closes #188, #189, #191, #192. Builds on § "Error envelope is the wire contract".

### Extension code is tier-2: full-privilege, opt-out, audit-by-source

§ "Hook trust model: built-ins curated, script hooks full-privilege, sandbox deferred" splits the in-process surface into two tiers. Extensions (§ "Extensions register capabilities; memory is the first conformance test") add a third path that collapses into tier-2 from a privilege standpoint but keeps an audit-time distinction:

- **Tier 1 — in-tree built-ins** (`src/engine/builtin-hooks.ts`, plus any capability whose module ships from the freelance package itself — memory included, even after it migrates to the capability API). Curated, reviewed at every release.
- **Tier 2 — extension code** (named hooks registered via `package.json#freelance.provides.hooks`, capability `activate()` bodies, CLI verb handlers, and script hooks declared in extension manifests). Full-privilege Node imports; no sandbox; no curation. Privilege-equivalent to local script hooks declared inline in a graph today.

The collapse is intentional: a hook named `gh_pr_status` looks like a built-in syntactically (`call: gh_pr_status`) but ships from third-party code, and conflating it with tier-1 trust by virtue of the bare-identifier form would be the trust-elevation footgun the sandbox-deferred posture is trying to avoid. The audit distinction is "what package did this module come from" — `freelance-mcp` itself (tier 1) vs. `freelance-ext-*` or `.freelance/extensions/*` (tier 2). The engine doesn't enforce the distinction; the operator audits it.

`FREELANCE_HOOKS_ALLOW_SCRIPTS=0` generalizes its semantics: setting it makes graph load reject any `kind: "script"` onEnter entry **and** makes `composeRuntime` refuse to activate any capability or register any hook from a non-tier-1 source. The flag's name doesn't change because the operator-facing semantics don't — "no contributed code runs" is what the flag has always meant; extensions are a new shape of contributed code, not a new threat model. A built-ins-only runtime is one flag away regardless of how the untrusted code reaches the process. Splitting into two flags (`...ALLOW_SCRIPTS` + `...ALLOW_EXTENSIONS`) would let an operator allow extensions but block scripts, which is exactly the half-measure the trust model rejects: tier-2 is tier-2 by privilege, not by declaration syntax.

A real sandbox (subprocess isolation, `--permission`-mode child, isolated-vm, WASM runtime) remains the right answer for the marketplace scenario and remains milestone work; § "Hook trust model" describes the tradeoffs and they apply identically to extension code. The marketplace scenario (#45) that motivated the original opt-out flag now reads as "shared graph registry + shared extension registry" — both gated by the same flag, both blocked until real isolation lands.

**What would break if reversed:** treating extension-registered named hooks as tier-1 because they share the syntactic form of built-ins would mean any `npm install freelance-ext-foo` silently elevates `foo`'s capability bodies and hook implementations to the same trust as in-tree code. The split-flag alternative would let an operator believe scripts are blocked while extensions still ship script-equivalent code through a different door. Both shapes collapse the audit-by-source distinction the entry depends on.

Anchors: `src/cli/setup.ts` (extension loader; respects `FREELANCE_HOOKS_ALLOW_SCRIPTS` as the single privilege gate), `src/engine/builtin-hooks.ts` (in-tree tier-1 surface), `package.json#freelance` (tier-2 registration site). Builds on § "Hook trust model: built-ins curated, script hooks full-privilege, sandbox deferred" and § "Extensions register capabilities; memory is the first conformance test".
