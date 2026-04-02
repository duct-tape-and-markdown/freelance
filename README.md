# Freelance

Graph-based workflow enforcement for AI coding agents.

Skills tell an agent *what* to do. Freelance tells it *how* — and holds it accountable. Define structured workflows in YAML, enforce them at tool boundaries via MCP, and take back control of how your agent works through complex, multi-step tasks.

State lives server-side. It can't be compacted away, forgotten, or bypassed. The agent calls tools, the server tells it where it is and what's valid. When context compacts mid-task, the agent calls `freelance_inspect` and picks up exactly where it left off.

## Quick Start

### Claude Code (plugin — recommended)

```
/plugin marketplace add duct-tape-and-markdown/freelance --path plugin
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
2. Freelance loads them and exposes MCP tools to the agent
3. The agent calls `freelance_start` to begin a workflow, `freelance_advance` to move between nodes
4. Gate nodes block advancement until conditions are met — enforcing quality without relying on the agent's memory
5. Context fields travel with the traversal, keeping the agent's working state structured and lightweight

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

## What You Get

**Workflow enforcement** — Nodes, edges, gates, and validations define exactly what the agent can do and when. No skipping steps, no drifting off-task.

**Surviving context compaction** — Traversal state is server-side. When the agent's context window compacts, `freelance_inspect` restores full orientation instantly.

**Context management** — Structured context fields travel with the traversal, reducing what the agent needs to hold in its own window. The server manages it, the agent reads it.

**Source provenance** — Bind source files to nodes, validate their integrity, and ensure the agent is working from the right material. Sources can be hashed, checked, and enforced at the graph level.

**Composable workflows** — Subgraph composition lets you build complex workflows from reusable pieces, with scoped context and return value mapping.

## MCP Tools

| Tool | Description |
|------|-------------|
| `freelance_list` | Discover available workflow graphs |
| `freelance_start` | Begin traversing a graph |
| `freelance_advance` | Move to the next node via a labeled edge |
| `freelance_context_set` | Update session context without advancing |
| `freelance_inspect` | Read-only introspection (position, history, or full graph) |
| `freelance_reset` | Clear traversal and start over |
| `freelance_guide` | Authoring guidance for writing graphs |
| `freelance_distill` | Distill a task into a new workflow, or refine an existing one after a guided run |
| `freelance_sources_check` | Verify source file availability |
| `freelance_sources_validate` | Validate source integrity against expectations |
| `freelance_sources_hash` | Compute hashes for source binding |

## Workflow Directory Resolution

Workflows load automatically from these directories (no flags needed):

1. `./.freelance/` — project-level workflows
2. `~/.freelance/` — user-level workflows (shared across projects)

Subdirectories are scanned recursively, so you can organize however you like (e.g., `.freelance/reviews/`, `.freelance/releases/`). Later directories shadow earlier ones by graph ID.

You can also specify directories explicitly:

```bash
freelance mcp --workflows ./my-workflows/
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

The full specification (graph schema, expression language, subgraph composition, return schemas, architecture) is available via `freelance_guide` or by running `freelance --help` on individual commands.

## License

MIT
