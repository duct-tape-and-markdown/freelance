# Security Policy

## Reporting a vulnerability

If you've found a security issue in `freelance-mcp`, please report it **privately** — do not open a public GitHub issue.

Use GitHub's [private security advisory](https://github.com/duct-tape-and-markdown/freelance/security/advisories/new) feature to submit a report. You'll get an acknowledgment within a few business days.

## Scope

In scope:

- The `freelance-mcp` npm package and its published binaries
- The MCP server (stdio transport) and its tool surface
- Graph loading, expression evaluation, and source-binding validation
- The SQLite memory store and its FTS5 query surface
- Claude Code plugin artifacts under `plugins/freelance/`

Out of scope:

- Issues in dependencies — please report those upstream
- Abuse of features working as designed (e.g., an agent choosing to emit harmful propositions into memory — that's a workflow-design question, not a vulnerability in this package)
- Social engineering of maintainers

## Supported versions

Only the latest minor release on `main` receives security fixes. Fixes are issued as patch releases.
