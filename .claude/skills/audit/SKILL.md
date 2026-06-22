---
name: audit
description: Run a read-only quality audit of a TypeScript project and report findings ranked P1–P4. Use when the user says "audit", "quality audit", "quality review", "health check", "code review the repo", "static analysis report", or asks for a skimmable rundown of what's wrong with the codebase. Never fixes anything and never commits.
---

# TypeScript quality audit

Produce a skimmable, actionable report. **Never fix anything. Never commit anything.** The user decides what to do with findings.

## Tool policy — use the right tool for each check

- **`npx tsc --noEmit`** — baseline correctness. Run first. If it fails, stop and report the errors; don't dig further.
- **`npm test`** — baseline behavioral check. Run second. Report pass/fail count; don't investigate individual failures unless asked.
- **`npx --yes knip@latest --no-progress`** — unused files, unused exports, unused exported types, unlisted/unused dependencies. Start here for dead-code surface.
- **`npx --yes madge --circular --extensions ts src/`** — circular imports.
- **LSP tool (`findReferences`)** — VERIFY every knip "unused export" before calling it dead. Zero external refs with local usage = un-export candidate, not deletion. Refs that knip missed (barrels, re-exports) = false positive. Use `workspaceSymbol` / `documentSymbol` to locate symbols by name. LSP diagnostics can be stale — cross-check against `tsc` before reporting content errors.
- **ast-grep (`sg run -p '<pattern>' -l ts src/`)** — structural patterns text search can't express. Patterns must be valid standalone TS nodes; `catch` alone won't parse — wrap as `try { $$$A } catch ($E) { }`. Use `$X` for a single node, `$$$X` for a list. If a pattern with many `$`-vars fails to run, fall back to `$$$PARAMS` or heuristic Grep.
- **Grep** — only for literal strings (comments, error messages, console calls, TODOs, config keys). Never for TS symbol usage — use LSP.

## Checks

### 1. Correctness & type safety
- `tsc --noEmit` clean?
- ast-grep: `$E as any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`.
- ast-grep: `$E!` (non-null assertions). Read ±5 lines for each hit; classify as (a) guarded by a preceding check, (b) load-bearing on an external invariant, (c) genuinely risky. Only (c) is a finding. Flag inconsistent sites where one path asserts and a near-identical path throws a typed error.
- ast-grep: `JSON.parse($E)`. Classify by trust boundary — user input must be wrapped with a friendly error; persisted-by-us may fail loud; config files should point at the file in the error. Unwrapped parses on untrusted input are findings.
- ast-grep: `try { $$$A } catch ($E) { }` and `try { $$$A } catch { }` — empty catches swallow bugs. Bodies that set an intentional default are fine; note but don't flag.
- ast-grep: `$E as $T` — filter out `as const`, SQL aliases inside template literals, legitimate `unknown`-narrowing (IPC results, `JSON.parse`, DB rows from better-sqlite3). Remaining casts without runtime validation at a trust boundary are findings.

### 2. Dead code
- knip's unused files, unused exports, unused exported types.
- For every knip "unused export" run LSP `findReferences` on the definition site.
  - Zero refs → safe to delete.
  - Refs only in the defining file → un-export, don't delete.
  - Refs via a re-export barrel knip missed → false positive, skip.
- Before flagging a knip "unused file", check whether it's referenced from non-TS config (plugin manifests, package.json, CI YAML).

### 3. Dependency hygiene
- knip's "Unlisted dependencies" — any package imported but not in `package.json` is a supply-chain risk (currently resolves via a transitive dep that can disappear on any upgrade). **P1.**
- Missing `@types/*` packages (knip flags these as unlisted too).
- Cross-check `package.json` deps against actual imports.

### 4. Structure
- madge circular-import output. Most TS cycles come from barrels re-exporting from siblings that import back — look for that pattern.
- `find src -name '*.ts' -printf '%s %p\n' | sort -rn | head -15` — any file >500 LOC or >15KB is worth a skim for SRP violations; not an automatic finding.
- Functions with 5+ parameters. Use ast-grep; if the pattern fails to run, fall back to `awk`/Grep on multi-line signatures. 5+ params is usually a sign the caller should pass an options object.

### 5. Tests
- Vitest / test runner: pass/fail count.
- Use `workspaceSymbol` to list exported functions from `src/`, then literal-string grep under `test/` for their names. Report the top 5 most important public-API coverage gaps — don't enumerate all of them.

### 6. Logging & debug hygiene
- Grep for `console.log`, `console.debug`, `console.info` in `src/`. Any hits are findings (CLI output should go through a project output module).
- Grep for `TODO`, `FIXME`, `XXX`, `HACK` in `src/`. Report counts and the first few.

## Output format

Open with a baseline line:

```
baseline: tsc: <pass/fail> | tests: <n passed / n total> | files: <n> | LOC: <n>
```

Then findings in P1 → P4 order, each in this exact block:

```
[P1|P2|P3|P4] <one-line title>
  where: <file>:<line> (or multiple)
  what:  <one sentence>
  why:   <one sentence — what breaks or degrades>
  fix:   <one sentence — concrete change, not a principle>
  verified: <"LSP findReferences" | "tsc" | "manual read" | "heuristic only">
```

Close with a **Clean** section listing every check that came back empty, one line each. Don't pad.

## Severity rubric

- **P1** — correctness bug, supply-chain risk, data-loss path, broken build.
- **P2** — structural smell that blocks future work (cycles, missing deps that happen to resolve, swallowed errors on user input).
- **P3** — dead code, unused exports, unwrapped parses on user input, inconsistent error hygiene.
- **P4** — cosmetic: long files, stylistic casts, type declarations that could be tighter, deprecation warnings without breakage.

## Constraints

- **Verify before calling something dead.** An unverified "unused export" is P4 at most, not P3.
- **Don't propose rewrites, architecture changes, or abstractions** — only fixes for things that are actually wrong.
- **Skip findings you can't state in one sentence each.** If it takes a paragraph to explain why it matters, it probably doesn't.
- **If a check returns clean, say so in one line under Clean.** Don't pad.
- **No action items beyond "report".** The user will decide what to fix.
- **Run independent checks in parallel.** tsc, tests, knip, and madge have no dependencies on each other — issue them in one batch.
