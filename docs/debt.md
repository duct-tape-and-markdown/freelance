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
- `src/memory/workflow.ts:90`, `src/memory/recollection.ts:48,103` — `suggestedTools` lists MCP-era tool tokens (`memory_emit`, `memory_inspect`, `memory_related`); post-MCP these are CLI verbs (`freelance memory emit/inspect/related`) and some collide with onEnter built-in hook names. #308 only de-MCP'd the `freelance_*` tokens; decide whether suggestedTools should carry CLI verbs, drop the memory_* tokens, or whether the field is MCP-vestigial entirely.
- `src/cli/validate.ts:43-61,204` — `validate` emits a `ValidateResult` report shape (not the error envelope) and calls `process.exit(EXIT.VALIDATION)` directly. This is a conscious structural exception: validate is a multi-error report (one bad file shouldn't abort the batch), so a single-throw envelope doesn't fit. Recorded so the surviving `process.exit(EXIT.*)` isn't read as an oversight. If validate ever needs to conform, the dir-missing/no-files pre-checks (43-61) are the single-failure cases that could route through `fatal()` with FILE_NOT_FOUND/NO_GRAPHS_DIR — but that changes their exit code (3→4) and wire shape, so it's a contract decision, not a cleanup.
- `src/cli/output.ts:197-205` (`CliExit.exitCode`) — the dual-payload exit is hand-passed at `traversals.ts` and `memory.ts`, not derived from the payload's `error.code`. Today the two agree, but it's the same un-derived-exit shape #335 closed for `fatal()`. Derive `CliExit`'s exit from the payload code (when it carries one) to close the latent divergence.
- `src/sources.ts` (`hashSources` combined top-level `hash`) — #334: the sorted combined digest is consumed by nothing (schema stores per-source hashes; every drift path compares per-source; `sources hash` output is the only emitter and authors copy the per-source value). Vestigial, but `hashSources` is re-exported from `src/core/index.ts`, so dropping the field is a breaking public-lib change. Parked pending sign-off on whether the lib surface may break; until then it's a no-op field, not a bug.
- `src/sources.ts:~307` (`resolveContent`) — #331 bonus: on a section *miss* (resolver returns null), the whole-file fallback `fs.readFileSync` re-reads bytes the caching resolver already read, so a missing-section binding reads its file twice. Only triggers on the miss path (an authoring error), so low impact; the per-run cache already eliminates the N·M parse cost on the hit path. Fold the whole-file read into the same per-run cache if this ever shows up.
