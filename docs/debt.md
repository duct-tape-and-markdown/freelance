# Debt backlog

Refactors, simplifications, and follow-ups surfaced by `/simplify` (or ad-hoc review) that weren't fixed on the PR where they were found. Prevents the "decided against on this PR" bucket from vanishing. See `CLAUDE.md` § "Refactor backlog" for the convention.

## Format

One line per entry:

```
<file>:<line> — <finding> — <rationale for skipping>
```

Flat list. No categories, no status column, no prioritization. Delete entries when fixed (git history preserves them). Scan when you want to refactor-hunt.

## Entries

- `src/sources.ts` (`hashSourceFile`) / `src/memory/prune.ts:~152` (`bytes.toString("utf-8")`) — the UTF-8 coercion corrupts non-UTF-8 bytes to U+FFFD before hashing, so hashes on binary source files are meaningless. The on-disk hashing is now one helper; the binary-safe fix is switching it + the `cat-file` bytes-to-hash bridge in prune.ts to raw-byte hashing end-to-end.
- `src/memory/git.ts:~75-134` — hand-rolled parser for `git cat-file --batch` output. Format is stable and we only ever request blobs, so safe today; if we ever ask for trees/commits or git adds header fields, silent mis-threading. Swap to per-spec `git show` (simpler, slower) or a library if this becomes a liability.
- `src/memory/db.ts` (`countQuery`) — re-prepares the statement on every call; no caching. Most read methods invoke it 1-2× per call (status: 2×; browse/inspect/bySource/related: 1× each). Prepare cost is microseconds and dominated by query execution, but a small SQL-keyed LRU on `db.prepare` (or pushing `countQuery` to accept a pre-prepared `Stmt`) would tighten hot paths if profiling ever shows it. Out of scope on the helper-introduction PR.
- `src/types.ts:90-140` — `AdvanceSuccessResult` / `AdvanceSuccessMinimalResult` carry 9 branch-specific optional fields (`subgraphPushed`, `completedGraph`, `returnedContext`, `stackDepth`, `resumedNode`, `waitingOn`, `timeout`, `timeoutAt`, `traversalHistory`) that only apply for specific `status` values. A discriminated union by `status` would narrow each variant to only its actually-valid fields — and would let `BaseAdvanceFields` in `helpers.ts` follow suit. Out of scope on #181 because narrowing the helper alone leaves the real leak at the wire-type boundary.
- `src/engine/gates.ts` (`makeAdvanceError`) — error-side twin of `buildAdvanceSuccessResult` (same `cloneContext` + optional-graphSources spread). A sibling `buildAdvanceErrorResult` helper would cover the last paired full/minimal site. Log it; fold in next time anything touches gates.ts.
- `src/engine/subgraph.ts` (`popSubgraph`) — never emits `traversalHistory` even when popping to a terminal, while `engine.ts` standard-arrival does. Pre-existing asymmetry, not introduced by #181. Check intent before fixing — may be deliberate (subgraph_complete isn't a root terminal).
