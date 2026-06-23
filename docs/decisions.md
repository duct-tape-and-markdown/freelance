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

### Each runtime verb has one identity; `advance` writes, `inspect` reads

A corollary of the committed verb surface above: a verb does one thing, and argument presence does not fork its meaning. `freelance advance` used to reinterpret a *missing* edge as a read-only probe returning `{ traversalId, validTransitions }` (#258) — so the same verb meant "move" or "describe" depending on whether an edge was passed. That is removed: a missing edge is now an `INVALID_INPUT` error like any other missing required argument, and `inspect --minimal` is the read surface for previewing `validTransitions` (it returns a strict superset — `currentNode`, `turnCount`, wait info — that the probe dropped).

The agent-efficiency framing matters here because the agent is the *only* CLI consumer (human ergonomics are a no-op): the worry was added round-trips. The opposite holds — every `start` and `advance` response already carries the node's `validTransitions` (plus instructions/sources), so the loop is read-response → pick-edge → advance with **no** separate preview call. `inspect --minimal` is only for re-checking state after a compaction or out-of-band change. SKILL.md (both byte-identical copies) teaches this.

**What would break if reversed:** a verb whose contract forks on argument presence forces every caller (skill, shell script) to special-case "advance with no edge is a no-op," and undercuts `inspect --minimal`'s reason for existing as the lean read surface (#81).

Anchors: `src/cli/traversals.ts` (`traversalAdvance`), `src/engine/context.ts` (minimal inspect), SKILL.md § the loop. Closes #258.

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

### Library code returns diagnostics as data; the CLI owns the output stream

Functions exported from `src/core/index.ts` (the public lib surface) must not write to `process.stderr`/`stdout` — they return warnings/errors as data and let the caller decide where they go. The choice of stream (and whether `--quiet` suppresses it) belongs at the CLI boundary, not inside a library function a consumer can't silence without monkey-patching. `loadGraphs` used to `process.stderr.write` a "N graph(s) failed validation" warning; that's removed (#276). The multi-file loaders now route through one `collectGraphs` core that returns `{ graphs, errors }` (including shadowing as a warning entry), and `loadGraphsCollecting` — the production path via `loadGraphsGraceful` — surfaces that data; `loadGraphs` keeps only its fail-loud throw (nothing loaded, or a cross-graph structural error).

**What would break if reversed:** a lib function emitting to stderr re-creates the asymmetry where the same logical event ("some graph failed to validate") prints from one loader and is returned as data from another, and gives lib consumers noise they can't gate. The open sibling #235 (`config set-local memory.dir` writing to stderr, bypassing `info()`/`--quiet`) is the CLI-side instance of the same posture.

Anchors: `src/loader.ts` (`collectGraphs`, `loadGraphs`, `loadGraphsCollecting`), `src/core/index.ts`. Closes #276 (and #274/#278 consolidation: three multi-file loaders → one core + two dispositions; the unused `loadGraphsLayered` is deleted).

### An `undefined` context write is a no-op; all surfaces agree "undefined = not set"

A context write of `{ key: undefined }` (from `contextUpdates`, `context set`, or a hook return) is stripped at a single write seam (`omitUndefined`, consumed by `applyContextUpdates` in `src/engine/context.ts`) before it is materialized. The key is never assigned to `session.context`, never recorded in `contextHistory`, never surfaced in `contextDelta`, and never echoed by the clone/inspect path. This was previously inconsistent (#301): `enforceContextCaps`, `evaluateWaitConditions`, and `validateReturnSchema` treated `undefined` as absent (matching JSON missing-key semantics, which the cap code documented), but `applyContextUpdates` materialized it as a present key with value `undefined` — so the same advance's wait/return gate saw the key as unset while `contextDelta` reported it written and `inspect` echoed it present.

There is now one definition of "what counts as a context write," and all six surfaces (caps, apply, history/delta, clone/inspect, wait, return) agree. `undefined` is *skip*, not *delete* — there is deliberately no key-deletion-via-undefined feature; if true deletion is ever needed it must be an explicit mechanism, not value coercion.

**What would break if reversed:** materializing `undefined` re-opens the split where a gate considers a key unsatisfied while the wire reports it written — the exact divergence #301 documents.

Anchors: `src/engine/context.ts` (`omitUndefined`, `applyContextUpdates`). Closes #301.

### `contextCaps` is single-sourced; the engine asserts the engine/runner coupling

Byte caps on context writes are enforced at two sites — `GraphEngine` for caller writes, `HookRunner` for hook-return writes — and per the hook convention caps are *configuration* the `HookRunner` holds (not a `runHooksFor` capability). That leaves the two enforcement sites each holding their own `ContextCaps`, kept equal only because `composeRuntime` is the single fan-out that passes one resolved value to both. A direct construction (`new GraphEngine(...)` + `new HookRunner(...)`, a supported path) could set them to different values, silently accepting or rejecting an identical-size write based purely on whether a caller or a hook produced it.

Three changes close this (#302): the default lives in one resolver (`resolveContextCaps`, used by both); `HookRunner` exposes its resolved caps via a `resolvedContextCaps` getter; and `GraphEngine`'s constructor asserts the injected runner's caps deep-equal its own, throwing `EngineError`/`INTERNAL` on divergence. The coupling fails loud at the point the two objects are combined instead of mis-capping at runtime.

**What would break if reversed:** dropping the assert lets engine-caps and runner-caps diverge undetected, making cap enforcement depend on the write's origin — observable as inconsistent gate behavior, not a clean error.

Anchors: `src/engine/engine.ts` (constructor assert), `src/engine/hooks.ts` (`resolvedContextCaps`), `src/engine/context.ts` (`resolveContextCaps`), `src/compose.ts` (single fan-out). Closes #302.

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

### Source-path resolution is one helper; boundary enforcement is the caller's policy

"User-supplied source path → absolute path" resolves through a single helper, `resolveSourcePath` in `src/sources.ts`. Whether an escape outside the source root is *rejected* is a per-caller flag, not a property of the helper — and the two callers diverge deliberately:

- **Graph source bindings** (`hashSource`, drift checking) resolve **without** boundary enforcement. Graph yaml is authored by the trusted repo owner; a binding to a sibling directory outside `.freelance/`'s parent (e.g. `../shared-docs/spec.md`) is a legitimate monorepo pattern, not an attack.
- **Memory `emit` / `bySource`** (`src/memory/store.ts` `prepareSourcePath`) resolve **with** `enforceBoundary: true`. Those paths arrive in agent-supplied payloads inside a running workflow and must not escape the source root — `../../etc/passwd` throws `SOURCE_OUTSIDE_ROOT` on both writes and reads.

Before this, the two operations had independent implementations with opposite policies and no cross-reference (#254): a contributor reading one side couldn't see the other's stance. Now there is one resolver, the boundary check has one implementation (suffix match on `root + path.sep`, so `/root-evil` can't bypass `/root`), and the policy choice is named at both call sites with a pointer to this entry.

**What would break if reversed:** folding enforcement into the helper unconditionally would reject legitimate sibling-dir graph bindings; dropping it entirely would let agent payloads read arbitrary files. The split keeps the trust boundary where it belongs — at the caller that knows who authored the path.

Anchors: `src/sources.ts` (`resolveSourcePath`), `src/memory/store.ts` (`prepareSourcePath`). Closes #254.

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

### Read-time staleness is scoped to the query's reachable propositions

Every filtering memory read used to compute staleness over the **entire** `proposition_sources` table — `readFileSync` + SHA-256 of every distinct source file in the DB — regardless of how narrow the query was (#314). Since the DB opens lazily and every `freelance` verb is a fresh process (§ "Memory database opens lazily on first access"), there is no cross-call amortization: each `memory inspect SomeEntity` re-paid the full O(distinct-source-files) hash cost from cold. That scales with total corpus — the exact dimension memory-intent.md stakes the product on.

`getStalePropositionIds` / `primeStaleFilter` now take an optional `scope?: { sql; params }`. The scan becomes `… FROM proposition_sources WHERE proposition_id IN (<scope.sql>)`; absent a scope it is byte-identical to the old full scan. The staleness predicate is unchanged — `isFileChanged` still re-hashes the file on disk and compares to the stored `content_hash`. The hash stays the **sole authoritative frame selector**; no mtime, no flag, no schema change. Per-path scopes: `inspect`/`related` = the entity's props (`about WHERE entity_id=?`), `bySource` = props citing the file, `browse` *with* a name/kind filter = props of matching entities, `search` = the FTS match set. `status` and **unfiltered** `browse` stay corpus-wide.

Two load-bearing rules a future contributor must not break:

1. **Scope by `proposition_id`, never by `file_path` on the outer scan.** The scope subquery picks proposition ids; the scan then pulls *all* source rows for those props. A proposition sourced from a clean file A and a drifted file B must still read stale when queried via A — file_path-scoping the outer scan would mark it valid.
2. **A scope MUST be a superset of the domain its count ranges over.** `valid_proposition_count` is an entity-wide total, not page-scoped. An empty `_stale_prop_ids` slot is read as *valid* (`notStaleExists` returns TRUE), so under-scoping silently *inflates* valid counts with no error. `_stale_prop_ids` now means "stale within this read's scope"; each public read owns exactly one scope per call and materializes immediately before the joins that consume it. The per-path scoped-vs-full-scan equality test is the only guard against a future scope being narrowed too far.

A persistent advisory `(size,mtime)→hash` cache (the one design that could also speed unfiltered `browse`/`status`) was **deferred** — it reintroduces read-path write contention and a `valid_count` correctness residual on mtime collisions, and doesn't decouple cost from corpus size. Revisit only if profiling shows those two corpus-wide paths dominate (tracked in `docs/debt.md`).

**What would break if reversed:** unscoping returns every selective read to O(corpus) cold-start hashing; file_path-scoping or under-scoping silently corrupts `valid_proposition_count` rather than failing.

Anchors: `src/memory/staleness.ts` (`getStalePropositionIds`, `primeStaleFilter`, scope param), `src/memory/store.ts` (per-path scopes), `src/memory/enrichment.ts` (one-scope-per-call header note). Closes #314.

### `memory search` observes the paginated-read contract

`search()` was the outlier among the paginated reads — it bypassed `clampLimit`, skipped the stale filter, returned no `total`, and took no `shape` (#316, #237). memory-intent.md ("Orphan hiding is a lens") explicitly names "the analogous filters on `memory_search`, `memory_inspect`" as part of the default orphan-hiding lens, so the divergence was a drift from stated intent, not a deliberate exception. `search` now: clamps `limit` to the shared `[1, MAX_PAGE_LIMIT]` ceiling; hides stale rows **by default** via a stale filter *scoped to the FTS match set* (the #314 mechanism), with `includeOrphans` to opt in; returns `total` (respecting the same filter as the page) so truncation is observable; and threads `shape`, defaulting to `full` for CLI parity and `minimal` for the `memory_search` built-in hook (the #87 response-size precedent the other `memory_*` built-ins already follow).

**What would break if reversed:** an unbounded `search` limit escapes the response-size ceiling on a verb the sealed `memory:recall` workflow drives; a missing `total` makes silent truncation unobservable to an agent deciding whether recall is complete.

Anchors: `src/memory/store.ts` (`search`), `src/engine/builtin-hooks.ts` (`memory_search` minimal default), `src/cli/program.ts` (--limit help). Builds on § "Projection vocabulary is a deliberate three-way split". Closes #316, #237.

### Recovery lives in `envelopeSlots`, never in `error.message`

The wire contract (§ "Error envelope is the wire contract") says `recoveryVerb` is a literal CLI template, interpolated against root-level slots the throw site populates via `EngineError.context.envelopeSlots`. The corollary: a throw site whose recovery requires a parameter (a traversalId to reset, a graphId to restart, a list of candidates to choose among) MUST populate the matching slot. Recovery instructions in `error.message` prose — `"Run \`freelance reset <id> --confirm\`"` baked into the message string — fail the contract: the skill renders the template by literal field lookup, has no parser for the prose, and falls back to surfacing the message verbatim or asking the operator. Either way, the catalog template stops being load-bearing.

Three rules fall out of this:

1. **Per-shape codes, not overloaded ones.** When a single code's recovery shape splits in two — e.g., `GRAPH_NOT_FOUND` for `start <typo>` (no recovery verb, nothing to clear) vs. an orphaned traversal whose graph yaml went missing (verb `reset {traversalId} --confirm`, kind `clear`) — split the code. One code per recovery shape; the catalog refuses to encode "sometimes the verb is null, sometimes it's a template" against a single entry.
2. **Storage backends agree on rejection codes.** A guard on the JSON backend that's silent on the in-memory backend (or vice versa) makes the wire contract environment-dependent — the test suite catches one shape, prod hits the other. Both backends throw the same code for the same shape; if a guard belongs at the boundary, route it through the catalog (`INVALID_FLAG_VALUE` for caller-supplied input, not raw `Error` collapsing to `INTERNAL`).
3. **Race shapes are distinguishable from version drift.** `putIfVersion` against a deleted record is `TRAVERSAL_NOT_FOUND` (`recoveryKind: clear`, the dead handle drops); against a version-drifted record is `TRAVERSAL_CONFLICT` (`recoveryKind: retry`, re-read and try again). Collapsing both into `TRAVERSAL_CONFLICT` makes the skill loop one extra hop on a dead handle before the second-hop `loadEngine` resolves it correctly. The resurrection-rejection invariant from § "Observable state transitions are durable before side effects" (#163) is preserved either way — the missing-record path still rejects the write — but the wire shape now matches the operator's intent.

`AMBIGUOUS_TRAVERSAL` follows the same rule: `envelopeSlots.candidates` (an array of `{traversalId, graphId, currentNode, meta}` mirroring `freelance status`'s `activeTraversals`) plus a representative `traversalId` slot for the verb template — the skill picks from the structured array instead of regex-parsing a prose summary.

**What would break if reversed:** reverting any of the three rules re-opens the freeform-parsing antipattern the wire contract escapes — the skill's branching on `recoveryKind` becomes lossy, recovery commands become per-call prose the skill has to grep, and the catalog's `recoveryVerb` template is decoration rather than the source of truth. Most concretely, a code with `verb: "reset {traversalId} --confirm"` whose throw site doesn't supply `traversalId` renders as the literal string `"reset {traversalId} --confirm"` to the skill — visible regression, not silent.

Anchors: `src/state/traversal-store.ts` (`resolveTraversalId`, `loadEngine`), `src/state/db.ts` (`assertSafeId`, `putIfVersion`, `TraversalDeletedMidWriteError`, `TraversalConflictError`), `src/error-codes.ts` (`TRAVERSAL_ORPHANED`, `RECOVERY` entries with `{slot}` templates), `test/envelope-contract.test.ts` (wire-level coverage per code). Closes #188, #189, #191, #192. Builds on § "Error envelope is the wire contract".

### `arethetypeswrong` runs from a pinned local install, with `fflate` overridden to 0.8.2

The CI `arethetypeswrong` step validates published type resolution. attw reads the package as a tarball and decompresses it with fflate's streaming `Gunzip`, keeping only the **last** emitted chunk (`unzipped = chunk`) — a workaround for [fflate#207](https://github.com/101arrowz/fflate/issues/207) that assumes the whole payload arrives in one callback. fflate **0.8.3** changed `Gunzip` to emit a trailing empty chunk, so the kept chunk is empty, `untar` returns `[]`, and attw crashes on `data[0].filename` with `Cannot read properties of undefined (reading 'filename')`. The break is total (it fails on a two-file package), version-independent across attw releases (the bug is in attw, the trigger is its transitive fflate), and unrelated to package contents — it surfaced the moment fflate auto-resolved to 0.8.3.

The fix has two coupled halves that must stay together: `package.json#overrides["@arethetypeswrong/core"].fflate = "0.8.2"` pins the working fflate, and `@arethetypeswrong/cli` is a pinned devDependency so the CI step runs the **local** binary (`npx attw`) whose dependency tree honors that override. The previous `npx -y @arethetypeswrong/cli` form re-resolved fflate fresh into npx's own cache, bypassing the override and re-breaking — so the npx form and the override are mutually exclusive; do not revert to `-y`.

**What would break if reversed:** dropping the override (or letting it float to `^0.8.3`), or switching the CI step back to `npx -y`, re-crashes the attw step and red-walls every PR (the failure is on the base, not the diff). Lift the pin only after attw ships a release that concatenates Gunzip chunks instead of keeping the last; verify by removing the override, `npm install`, and running `npx attw --pack .` against this package.

Anchors: `.github/workflows/ci.yml` (`arethetypeswrong` step), `package.json` (`overrides`, `devDependencies`).

### Catalog actionability signals must be coherent

Every error envelope carries three actionability signals the driving skill reads together: `errorKind` (`blocked`|`structural`, derived from the `ENGINE_ERROR_CODES` category), `exit` (derived from the same category), and `recoveryKind` (`retry`|`fix-context`|`report`|`clear`, authored in the `RECOVERY` sidecar). The `satisfies` checks guarantee every code *has* all three, but nothing stopped them from *contradicting*. #337 shipped `STACK_DEPTH_EXCEEDED` in the `BLOCKED` category — so `errorKind: "blocked"` (= "traversal state is fine; fix context and re-advance the same edge") and `exit: 2` — while its `RECOVERY` said `{ verb: null, kind: "report" }` (= "stop and surface to the operator"). A skill branching on `errorKind` retries; a skill branching on `recoveryKind` reports; they can't both be right.

The resolution has two parts. First, the per-code fix: stack-depth overflow is genuinely structural — re-advancing the same edge re-triggers the same subgraph push and fails identically, so the only fix is to the graph's recursion bound (an authoring action). It moved from `BLOCKED` to `CLI_STRUCTURAL` (`errorKind: structural`, `exit: 1`, `recoveryKind: report` — all coherent). The `CLI_` prefix is historical; that bucket is the home for any structural report-and-stop code regardless of which surface raises it (it already houses engine-domain `INTERNAL`). Second, and more durable: a coherence test (`test/catalog.test.ts` § "catalog actionability coherence") asserts the invariant **`errorKind: "blocked"` ⟹ `recoveryKind ∈ {fix-context, retry}`** across every code. `blocked` is a promise that the operation can proceed once context is fixed or after a transient retry; `report` and `clear` (drop a stale pointer) belong to structural codes and contradict that promise.

Note the asymmetry: the reverse — `report` with a non-null `verb` — is *not* incoherent and is deliberately allowed. `GRAPH_STRUCTURE_INVALID` is `{ verb: "validate {graphDir}", kind: "report" }`: stop the run, but the verb tells the operator how to *see* the full validation errors. A recovery verb on a report code is a diagnostic aid, not a retry instruction, so the coherence test does not forbid it.

**What would break if reversed:** without the test, the next code added to `BLOCKED` with a `report`/`clear` recovery (or moved into `BLOCKED` without revisiting its recovery) silently re-opens the split-brain — the bug is invisible because each signal is independently well-formed; only their *combination* is wrong. The test makes the contradiction a compile-adjacent failure at authoring time.

Anchors: `src/error-codes.ts` (`ENGINE_ERROR_CODES.CLI_STRUCTURAL`, `RECOVERY`), `test/catalog.test.ts` (coherence test). Closes #337; #336 (the unpopulatable `{traversalId}` slot on `TRAVERSAL_ACTIVE`) is an application of § "Recovery lives in `envelopeSlots`, never in `error.message`" — the engine-level throw site has no traversalId, so the verb became slot-free (`reset`). Builds on § "Error envelope is the wire contract".

### Malformed graphs are rejected at load, not silently degraded at runtime

A graph that parses (Zod-valid) can still be semantically broken in ways the runtime then *ignores* rather than surfaces: a field that doesn't apply to the node's type, a context descriptor with a typo'd `type`, a cycle with no way out, an expression referencing a field that doesn't exist. Each one "works" — it just does nothing, or silently resolves to null — so the authoring mistake ships and only shows up as a workflow that mysteriously never advances. The load pipeline (`validateAndBuild`: `validateContextDescriptors` → `validateReturnSchemas` → `validateExpressions` → `buildAndValidateGraph`) is the place to convert these into `GRAPH_STRUCTURE_INVALID` at `freelance validate` / first load, where the author is looking, instead of mid-traversal where the agent is.

Four such degradations were closed, each guarding against a different silent-ignore:

- **Type-incompatible node fields (#338).** The node schema is one flat object — every type-specific field is optional on every type — so `waitOn`/`timeout` on a non-wait node, or `subgraph` on a wait node, pass Zod and are then never read at runtime. `buildAndValidateGraph` rejects fields the runtime only reads for another type. (A discriminated-union schema would encode this in Zod directly, but it would ripple `NodeDefinition` narrowing across every engine read site; the explicit construction-time checks match the existing idiom — terminal-without-edges, gate-without-validations — at far lower blast radius.)
- **Context descriptor coherence (#339).** `context` values are `union([descriptor, unknown])`, so a descriptor with a typo'd `type` (`strng`) falls through to the `unknown` arm and is silently treated as a literal value — the intended default never applies. `validateContextDescriptors` rejects an object that *looks* like a descriptor (has `type` + `enum`/`default`) but fails descriptor parsing, and checks a valid descriptor's `default` against its declared `type` and `enum`. A bare `{type: "x"}` with no enum/default is left alone — indistinguishable from a literal object that happens to have a `type` field.
- **Inescapable cycles (#340).** Cycle validity is whether the loop has an *exit edge* (some member node points outside the SCC), not whether it contains a decision/gate/wait node. The old type-based proxy was wrong both ways: it rejected a bounded `action` retry loop that has a real exit, and accepted a decision/wait loop whose every edge stays inside it.
- **Undeclared expression paths under strictContext (#280).** `strictContext` already guarantees every settable key is declared, so an expression referencing `context.X` for an undeclared `X` is a typo — `validateExpressions` rejects it. Crucially this is gated on `strictContext`: without it, `X` could legitimately be set at runtime (initialContext / contextSet / a hook), so the cross-check would false-positive. The soundness comes from an existing invariant, not a new assumption.

**What would break if reversed:** each removed check returns its degradation to runtime, where it reads as "the workflow is stuck" with no pointer to the authoring mistake — exactly the failure mode `freelance validate` exists to prevent. The strictContext gate on #280 is load-bearing: dropping it would reject graphs that populate context at runtime.

Anchors: `src/graph-construction.ts` (`buildAndValidateGraph`, `validateCycles`), `src/graph-validation.ts` (`validateContextDescriptors`, `validateExpressions`), `src/evaluator.ts` (`referencedContextFields`), `test/loader.test.ts` (§ "load-time strictness"), `test/wait.test.ts` (#338 cases). Closes #280, #338, #339, #340.
