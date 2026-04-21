# Freelance Plugin for Claude Code

Graph-based workflow enforcement for AI coding agents.

## Install

### From this repo (marketplace)

```
/plugin marketplace add duct-tape-and-markdown/freelance
/plugin install freelance@freelance-plugins
```

### Local development

```bash
claude --plugin-dir ./plugins/freelance
```

## What's Included

| Component | Purpose |
|-----------|---------|
| **Driving skill** (`skills/freelance/SKILL.md`) | Teaches the agent to drive any Freelance workflow via the `freelance` CLI; auto-activates on workflow-related prompts |
| **SessionStart hook** | Shows active workflows on session start |
| **PostCompact hook** | Re-orients the agent after context compaction |

## Writing your own hooks

The built-in hooks are intentionally minimal. If you want reactive behaviour — nudging the agent after certain tool calls, polling for stuck traversals, auto-advancing on external signals — author a hook script against the `freelance inspect --active [--waits]` CLI. It returns a deterministic JSON array of every active traversal (with `waitStatus`, `waitingOn[]`, `timeout`, and `lastUpdated` for wait nodes) that your hook can filter however you like.

## Project Setup

After installing the plugin, scaffold the project with the CLI:

```bash
npx -y freelance-mcp@latest init --client claude-code --scope project --yes
```

Creates `.freelance/` with a starter workflow, installs the driving skill into `.claude/skills/freelance/`, and appends a Freelance section to `CLAUDE.md`. Then add your own `.workflow.yaml` files. Run `freelance guide` for the graph definition format.

## Non-Claude-Code Clients

For Cursor, Windsurf, or Cline, the same CLI command handles setup:

```bash
npx -y freelance-mcp@latest init --client cursor   # or windsurf, cline
```

The driving skill is Claude-Code-specific; other clients use the CLI directly (`freelance status`, `freelance start`, `freelance advance`, etc. — run `freelance --help` for the full surface).
