# CLI shape under option E

The single-skill + pure-CLI integration assumes the CLI is **agent-shell-out-first**, not human-UX-first. Today's CLI serves the latter. This file enumerates what has to change for the skill path to work.

These changes are **enabling work for option E, not optional polish.** The skill body in `skills/freelance/SKILL.md` assumes them.

## What needs to change

### 1. JSON-first output for runtime verbs

Today:
```bash
freelance advance foo        # pretty-printed
freelance advance foo --json # opt-in JSON
```

Option E:
```bash
freelance advance foo          # JSON on stdout (default)
freelance advance foo --human  # opt-in pretty-print for interactive use
```

Flipping the default removes a flag from every agent call and prevents accidentally-pretty-printed output from breaking JSON parsing downstream. Authoring commands (`init`, `validate`, `visualize`) keep human-friendly output as default because humans run them.

### 2. Semantic exit codes

Today: mostly 0 (success) or 1 (error).

Option E:
- `0` — success
- `1` — internal error (bug in Freelance)
- `2` — gate or edge condition blocked advancement (recoverable; fix context and retry)
- `3` — validation failed (return schema, strict context, required meta)
- `4` — not found (traversal id, graph id, entity id)
- `5` — invalid input (malformed JSON, unknown edge)

Agents check exit codes first; stdout JSON carries the detail. This mirrors the engine's `AdvanceErrorResult`-vs-thrown-`EngineError` split (issue #95) at the CLI boundary.

### 3. stderr discipline

Today: some commands mix informational and error output on stderr.

Option E:
- **stdout:** structured JSON response only. Always parseable JSON on both success and error paths.
- **stderr:** breadcrumbs only (e.g. "Freelance: memory enabled at /path"). Never carries structured data the agent needs.
- **On error:** stdout emits `{ error: { code, message, ... }, isError: true }` matching MCP's shape (issue #95).

### 4. Structured errors matching MCP

CLI error wire shape mirrors MCP:

```json
{
  "error": {
    "code": "EDGE_NOT_FOUND",
    "message": "Edge 'foo' not found on node 'bar'",
    "availableEdges": ["baz", "qux"]
  },
  "isError": true
}
```

Agents write one error-handling shape across both surfaces.

### 5. Input streaming for high-fanout verbs

`memory emit` keeps its current shape — reads file or stdin, emits JSON response. The skill body teaches which form to use:

```bash
freelance memory emit --file /tmp/props.json --json
# or
echo '[...]' | freelance memory emit - --json
```

## Scope

- **In scope:** runtime verbs (`status`, `start`, `advance`, `context set`, `meta set`, `inspect`, `reset`, `memory *`).
- **Out of scope:** authoring verbs (`init`, `validate`, `visualize`, `config`, `completion`, `sources hash`) — these are human-first; keep pretty-print default.

## Measurement plan (feeds #99)

Before committing to the single-skill path:

1. **Per-call token cost** — one `Bash: freelance advance foo --json` vs one MCP `freelance_advance` for the same semantic operation. Measure tool-use envelope + response size on each side.
2. **Cold-start wall time** — `time freelance advance foo --json` on a warm filesystem. If it's 300ms+, evaluate `freelance daemon` + unix-socket.
3. **Definition-weight delta** — 0 tokens (pure skill path) vs current ~2.5K tokens. Multiply by session turns to get session-level savings.
4. **Claude Desktop fallback cost** — if option E ships, the fallback surface in `minimal-server.ts` is the cost Desktop users pay. Measure whether the 4-tool fallback is usable or whether Desktop needs a richer surface.

Numbers drive #99's final shape. If shell-out cost ≥ MCP cost per call, the daemon path becomes a prerequisite.
