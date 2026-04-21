# Debt backlog

Refactors, simplifications, and follow-ups surfaced by `/simplify` (or ad-hoc review) that weren't fixed on the PR where they were found. Prevents the "decided against on this PR" bucket from vanishing. See `CLAUDE.md` § "Refactor backlog" for the convention.

## Format

One line per entry:

```
<file>:<line> — <finding> — <rationale for skipping>
```

Flat list. No categories, no status column, no prioritization. Delete entries when fixed (git history preserves them). Scan when you want to refactor-hunt.

## Entries

- `src/sources.ts` (`hashSourceFile`) / `src/memory/prune.ts:~150` (`bytes.toString("utf-8")`) — the UTF-8 coercion corrupts non-UTF-8 bytes to U+FFFD before hashing, so hashes on binary source files are meaningless. The on-disk hashing is now one helper; the binary-safe fix is switching it + the `cat-file` bytes-to-hash bridge in prune.ts to raw-byte hashing end-to-end.
- `src/memory/git.ts:~80-120` — hand-rolled parser for `git cat-file --batch` output. Format is stable and we only ever request blobs, so safe today; if we ever ask for trees/commits or git adds header fields, silent mis-threading. Swap to per-spec `git show` (simpler, slower) or a library if this becomes a liability.
- `src/config.ts:~120` — `memory.prune.keep` concatenates across config files without dedup, so `[main]` in project + `[main]` in local yields `[main, main]`. Harmless (duplicates resolve to the same SHA) but ugly in `freelance config show`. Dedup with a `Set`.
- `src/cli/memory.ts:~50-108` — `opts?.limit ? parseInt(opts.limit, 10) : undefined` repeated 5× across memory handlers. Same pattern in `src/cli/traversals.ts` for `--limit`/`--offset`. Pull a shared `parseIntArg(opts.foo)` helper; low-value until the third call site, so skipping on this PR.
