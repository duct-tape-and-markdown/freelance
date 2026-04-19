# Decisions Log

Durable design decisions and cross-file invariants. The canonical home for WHY-context that applies beyond a single file or outlasts the PR that introduced it. See `CLAUDE.md` § "WHY-comments vs decisions log" for the inline-vs-doc test.

## Format

Each entry:

- **Short heading** — the invariant or decision in a phrase
- One or two paragraphs of prose explaining the decision, the tradeoffs considered, and what would break if it were reversed
- Optional link to the PR or issue that decided it

Append chronologically. When a later decision supersedes an earlier one, add a new entry that references and replaces the old — don't rewrite history. An entry that's been superseded is a breadcrumb for future readers wondering why the code looks the way it does.

## Entries
