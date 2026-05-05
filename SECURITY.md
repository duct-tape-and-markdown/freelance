# Security Policy

## Reporting a vulnerability

If you've found a security issue in `freelance-mcp`, please report it **privately** — do not open a public GitHub issue.

Use GitHub's [private security advisory](https://github.com/duct-tape-and-markdown/freelance/security/advisories/new) feature to submit a report. You'll get an acknowledgment within a few business days.

## Scope

`freelance-mcp` is a CLI-only package. There is no long-running server and no MCP/stdio transport — that surface was removed in #121 (see `docs/decisions.md` § "MCP server and tool surface deleted"). The npm package name is historical; the binary is `freelance`.

In scope:

- The `freelance-mcp` npm package and its published binaries
- The `freelance` CLI verbs and their JSON wire format
- Graph loading, expression evaluation, and source-binding validation
- `onEnter` hook resolution and execution (path restrictions, the `FREELANCE_HOOKS_ALLOW_SCRIPTS` trust gate)
- The SQLite memory store and its FTS5 query surface
- Claude Code plugin artifacts under `plugins/freelance/`

Out of scope:

- Issues in dependencies — please report those upstream
- Abuse of features working as designed (e.g., an agent choosing to emit harmful propositions into memory — that's a workflow-design question, not a vulnerability in this package)
- Author-controlled hook scripts running with full Node privileges — this is the documented trust model (see README "Trust model for hook scripts"); deployments that can't vet workflow authors set `FREELANCE_HOOKS_ALLOW_SCRIPTS=0`
- Social engineering of maintainers

## Supported versions

Only the latest minor release on `main` receives security fixes. Fixes are issued as patch releases.
