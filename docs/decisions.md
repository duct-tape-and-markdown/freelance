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
