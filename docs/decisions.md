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
