# Freelance

Graph-based workflow enforcement for AI coding agents.

State lives server-side — it can't be compacted away, forgotten, or bypassed. The agent calls tools, the server tells it where it is and what's valid. Define workflows in YAML, enforce them at tool boundaries via MCP.

## Quick Start

```bash
# Clone and install
git clone https://github.com/Jwcjwc12/freelance.git
cd freelance
npm install && npm run build
npm link

# Set up Freelance in your project
cd /path/to/your/project
freelance init
```

## How It Works

1. Define workflows as directed graphs in YAML (`.graph.yaml` files)
2. Freelance loads them and exposes 7 MCP tools to the agent
3. The agent calls `graph_start` to begin a workflow, `graph_advance` to move between nodes
4. Gate nodes block advancement until conditions are met — quality enforcement without documentation
5. After context compaction, the agent calls `graph_inspect` and re-orients instantly

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
| `graph_list` | Discover available workflow graphs |
| `graph_start` | Begin traversing a graph |
| `graph_advance` | Move to the next node via a labeled edge |
| `graph_context_set` | Update session context without advancing |
| `graph_inspect` | Read-only introspection (position, history, or full graph) |
| `graph_reset` | Clear traversal and start over |
| `graph_guide` | Get authoring guidance for writing graphs |

## Graph Directory Resolution

Graphs load automatically from these directories (no flags needed):

1. `./.freelance/graphs/` — project-level graphs
2. `~/.freelance/graphs/` — user-level graphs (shared across projects)

Later directories shadow earlier ones by graph ID, so user-level graphs can override project defaults.

You can also specify directories explicitly:

```bash
freelance mcp --graphs ./my-graphs/
```

## Running Modes

### Standalone MCP server (stdio)

For single-session use. Process starts with the agent, dies with the agent. Graphs auto-reload when files change.

```bash
freelance mcp
```

### Daemon mode (multi-session, persistent)

Long-running server with traversal persistence across agent restarts. An agent that crashes resumes at the exact node it left off.

```bash
# Start daemon
freelance daemon start

# Connect via MCP proxy (stdio bridge to daemon HTTP API)
freelance mcp --connect localhost:7433

# Management
freelance daemon status
freelance daemon stop
freelance traversals list
freelance traversals inspect tr_a1b2c3d4
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
freelance mcp --connect <host:port>  # Start MCP proxy to daemon
freelance daemon start|stop|status   # Manage the daemon
freelance traversals list|inspect|reset  # Manage traversals (requires daemon)
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
