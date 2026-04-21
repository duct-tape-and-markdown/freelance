# Debt backlog

Refactors, simplifications, and follow-ups surfaced by `/simplify` (or ad-hoc review) that weren't fixed on the PR where they were found. Prevents the "decided against on this PR" bucket from vanishing. See `CLAUDE.md` § "Refactor backlog" for the convention.

## Format

One line per entry:

```
<file>:<line> — <finding> — <rationale for skipping>
```

Flat list. No categories, no status column, no prioritization. Delete entries when fixed (git history preserves them). Scan when you want to refactor-hunt.

## Entries

- `src/memory/staleness.ts:~32` / `src/memory/prune.ts:~60,~153` — `readFileSync(path, "utf-8")` and `bytes.toString("utf-8")` coerce non-UTF-8 bytes to U+FFFD before hashing, making hashes meaningless for binary source files. Inherited across the whole memory system (emit, staleness, prune); fixing only one site would create inconsistency. Needs a coordinated switch to raw-byte hashing end-to-end.
- `src/memory/git.ts:~80-120` — hand-rolled parser for `git cat-file --batch` output. Format is stable and we only ever request blobs, so safe today; if we ever ask for trees/commits or git adds header fields, silent mis-threading. Swap to per-spec `git show` (simpler, slower) or a library if this becomes a liability.
- `src/config.ts:~120` — `memory.prune.keep` concatenates across config files without dedup, so `[main]` in project + `[main]` in local yields `[main, main]`. Harmless (duplicates resolve to the same SHA) but ugly in `freelance config show`. Dedup with a `Set`.
- `src/compose.ts:~4-7`, `src/cli/setup.ts:~6,~174`, `src/cli/traversals.ts:~65`, `src/engine/context.ts:~52,~199`, `src/types.ts:~34`, `src/core/index.ts:~4`, `src/engine/builtin-hooks.ts:~126,~134`, `src/memory/suppress-warnings.ts:~6` — stale comments reference an MCP boundary/surface that was removed in #116. Phrasing drift only, not load-bearing; sweep in a follow-up doc-cleanup PR.
