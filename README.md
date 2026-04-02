# Freelance

Graph-based workflow enforcement for AI coding agents.

State lives server-side — it can't be compacted away, forgotten, or bypassed. The agent calls tools, the server tells it where it is and what's valid. Define workflows in YAML, enforce them at tool boundaries via MCP.

## Quick Start

### Claude Code (plugin — recommended)

```
/plugin marketplace add Jwcjwc12/freelance --path plugin
/plugin install freelance@freelance-plugins
```

This installs the MCP server, hooks, and skills automatically. Run `/freelance:freelance-init` to scaffold your first workflow.

### Other clients (Cursor, Windsurf, Cline)

```bash
npm install -g freelance-mcp
cd /path/to/your/project
freelance init
```

## How It Works

1. Define workflows as directed graphs in YAML (`.workflow.yaml` files)
2. Freelance loads them and exposes 7 MCP tools to the agent
3. The agent calls `freelance_start` to begin a workflow, `freelance_advance` to move between nodes
4. Gate nodes block advancement until conditions are met — quality enforcement without documentation
5. After context compaction, the agent calls `freelance_inspect` and re-orients instantly

```yaml
id: my-workflow
version: "1.0.0"
name: "My Workflow"
description: "A simple two-step workflow"
startNode: start

context:
  taskDone: false

nodes:
  start:
    type: action
    description: "Do the work"
    instructions: "Complete the task and set context.taskDone = true."
    edges:
      - target: review
        label: done

  review:
    type: gate
    description: "Review the work"
    validations:
      - expr: "context.taskDone == true"
        message: "Task must be completed before review."
    edges:
      - target: complete
        label: approved

  complete:
    type: terminal
    description: "Workflow complete"
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `freelance_list` | Discover available workflow graphs |
| `freelance_start` | Begin traversing a graph |
| `freelance_advance` | Move to the next node via a labeled edge |
| `freelance_context_set` | Update session context without advancing |
| `freelance_inspect` | Read-only introspection (position, history, or full graph) |
| `freelance_reset` | Clear traversal and start over |
| `freelance_guide` | Get authoring guidance for writing graphs |

## Workflow Directory Resolution

Workflows load automatically from these directories (no flags needed):

1. `./.freelance/` — project-level workflows
2. `~/.freelance/` — user-level workflows (shared across projects)

Subdirectories are scanned recursively, so you can organize however you like (e.g., `.freelance/reviews/`, `.freelance/releases/`). Later directories shadow earlier ones by graph ID.

You can also specify directories explicitly:

```bash
freelance mcp --workflows ./my-workflows/
```

## Running Modes

### Standalone MCP server (stdio)

For single-session use. Process starts with the agent, dies with the agent. Graphs auto-reload when files change.

```bash
freelance mcp
```

## MCP Configuration

Run `freelance init` to auto-detect your client and generate the config. Supports Claude Code, Cursor, Windsurf, and Cline.

To configure manually, add to your client's MCP config (e.g., `.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor):

```json
{
  "mcpServers": {
    "freelance": {
      "command": "freelance",
      "args": ["mcp"]
    }
  }
}
```

## CLI Reference

```
freelance init                       # Interactive project setup
freelance validate <dir>             # Validate graph definitions
freelance visualize <file>           # Render graph as Mermaid or DOT
freelance inspect                    # Show active traversals from persisted state
freelance mcp                        # Start standalone MCP server
freelance completion bash|zsh|fish   # Output shell completion script
```

## Node Types

- **action** — The agent performs work. Has instructions, edges out.
- **decision** — The agent evaluates conditions and picks an edge. No work, just routing.
- **gate** — Like action, but requires validations to pass before any edge can be taken.
- **terminal** — End state. No edges out.
- **wait** — Pauses traversal until an external signal or timeout.

## Documentation

See [docs/SPEC.md](docs/SPEC.md) for the full specification including graph schema, expression language, subgraph composition, return schemas, and architecture.

## License

MIT
