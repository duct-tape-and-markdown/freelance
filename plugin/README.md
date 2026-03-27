# Freelance Plugin for Claude Code

Graph-based workflow enforcement for AI coding agents.

## Install

### From this repo (marketplace)

```
/plugin marketplace add Jwcjwc12/graph-engine --path plugin
/plugin install freelance@freelance-plugins
```

### Local development

```bash
claude --plugin-dir ./plugin
```

## What's Included

| Component | Purpose |
|-----------|---------|
| **MCP Server** | 9 tools for workflow traversal (`freelance_list`, `freelance_start`, `freelance_advance`, etc.) |
| **SessionStart hook** | Reminds the agent about active workflows on session start |
| **UserPromptSubmit hook** | Checks for active workflows before each prompt |
| **`/freelance:freelance-guide`** | Workflow usage instructions (auto-invoked by Claude) |
| **`/freelance:freelance-init`** | Scaffold `.freelance/graphs/` and starter templates |

## Project Setup

After installing the plugin, run `/freelance:freelance-init` to create the graphs directory in your project, or manually:

```bash
mkdir -p .freelance/graphs
```

Then add `.workflow.yaml` files to define your workflows. See [the spec](https://github.com/Jwcjwc12/graph-engine/blob/main/docs/SPEC.md) for the full graph definition format.

## Non-Claude-Code Clients

For Cursor, Windsurf, or Cline, use the CLI setup instead:

```bash
npx -y freelance-mcp@latest init
```
