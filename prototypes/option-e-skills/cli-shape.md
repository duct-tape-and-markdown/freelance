# CLI shape for option E

For option E to work, the CLI's runtime verbs need to be **agent-shell-out-first**, not human-UX-first. These are different design disciplines; the current CLI serves the latter.

## What needs to change

### 1. JSON-first output

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

The agent's default call pattern is `freelance <verb> [args] --json` today; flipping the default removes a flag from every call and makes accidentally-pretty-printed output (which breaks JSON parse) impossible.

### 2. Semantic exit codes

Today: mostly 0 (success) or 1 (error).

Option E:
- `0` — success
- `1` — internal error (bug in Freelance)
- `2` — gate or edge condition blocked advancement (recoverable; fix context and retry)
- `3` — validation failed (return schema, strict context, required meta)
- `4` — not found (traversal id, graph id, entity id)
- `5` — invalid input (malformed JSON, unknown edge)

Agents parse exit codes before parsing stdout. Exit code determines the response-category branch; stdout JSON carries the detail.

This mirrors the current MCP `AdvanceErrorResult` vs thrown-`EngineError` distinction (issue #95) — semantic exit codes are the CLI analog.

### 3. stderr discipline

Today: some commands mix informational output and errors on stderr.

Option E:
- **stdout:** structured JSON response only. Always parseable JSON in all success paths; always parseable JSON-or-empty on error paths (see below).
- **stderr:** breadcrumbs only ("Freelance: memory enabled at /path"). Never carries structured data the agent needs. Agent ignores unless debugging.
- **On error:** stdout emits an `{ error: { code, message, ... } }` JSON object that mirrors MCP's `errorResponse` shape. Exit code carries the category.

### 4. Structured errors matching MCP

MCP errors today:

```json
{
  "error": "Edge 'foo' not found on node 'bar'",
  "isError": true
}
```

CLI errors today:

```
Error: Edge 'foo' not found on node 'bar'
```

Option E, CLI matches MCP:

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

The wire format is identical across surfaces. Agents write one error handler.

### 5. Input streaming for high-fanout verbs

`memory emit` today reads a file path or stdin. Option E keeps this; JSON body is piped in from the agent's Bash invocation:

```bash
echo '[...]' | freelance memory emit --stdin --json
# or
freelance memory emit --file /tmp/props.json --json
```

The skill body teaches the agent which variant to use.

## What this is NOT

- Not a rewrite of every CLI subcommand. Authoring commands (`init`, `validate`, `visualize`, `config`) stay human-UX-first because humans use them. The rewrite scope is runtime verbs only: `status`, `start`, `advance`, `context set`, `meta set`, `inspect`, `reset`, and `memory *` subcommands.
- Not a deprecation of the current CLI. It's a **mode flip** — same binary, JSON becomes default for runtime verbs, `--human` for interactive.
- Not blocked by issue #99's option B. In fact, B completes first (deprecate duplication, clean up the surface), THEN E rebuilds runtime CLI as agent-shell-out-first on a clean slate.

## Measurement plan (for #99)

Before committing:

1. **Per-call cost of `Bash: freelance advance foo --json`** vs MCP `freelance_advance`. Measure token usage of the Bash tool-use block + CLI output vs the MCP tool-use + tool-result pair, for identical semantic operations.
2. **Cold-start wall time.** `time freelance advance foo --json` on a warm filesystem. If it's 300ms+ per call, consider `freelance daemon` + unix-socket RPC.
3. **Definition-weight reduction.** Token cost of the 4-tool minimal MCP surface vs the current 21-tool surface.

Numbers feed #99's decision. If shell-out cost ≥ MCP cost per call, option E needs the daemon path to be worthwhile.
