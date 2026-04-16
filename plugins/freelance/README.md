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
| **MCP Server** | 21 tools for workflow traversal, memory, and source provenance |
| **SessionStart hook** | Reminds the agent about active workflows on session start |
| **PostCompact hook** | Re-orients the agent after context compaction |
| **PostToolUse hook** | Nudges the agent when a tool call may satisfy an active `wait` node |
| **UserPromptSubmit hook** | Nudges the agent about traversals stuck on a wait node |
| **`/freelance:freelance-guide`** | Workflow usage instructions (auto-invoked by Claude) |
| **`/freelance:freelance-init`** | Scaffold `.freelance/` and starter templates |

## Project Setup

After installing the plugin, run `/freelance:freelance-init` to create the graphs directory in your project, or manually:

```bash
mkdir -p .freelance
```

Then add `.workflow.yaml` files to define your workflows. Use `/freelance:freelance-guide` for the full graph definition format.

## Non-Claude-Code Clients

For Cursor, Windsurf, or Cline, use the CLI setup instead:

```bash
npx -y freelance-mcp@latest init
```
