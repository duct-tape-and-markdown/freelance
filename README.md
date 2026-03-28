<p align="center">
  <h1 align="center">Freelance</h1>
  <p align="center">Graph-based workflow enforcement for AI coding agents</p>
</p>

<p align="center">
  <a href="https://github.com/jwcjwc12/freelance/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/freelance-mcp"><img src="https://img.shields.io/npm/v/freelance-mcp.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/freelance-mcp"><img src="https://img.shields.io/npm/dm/freelance-mcp.svg" alt="npm downloads"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-green.svg" alt="MCP Compatible"></a>
</p>

---

State lives server-side — it can't be compacted away, forgotten, or bypassed. The agent calls tools, the server tells it where it is and what's valid. Define workflows in YAML, enforce them at tool boundaries via MCP.

## Why Freelance?

AI coding agents lose instruction compliance over long sessions. Context compaction destroys behavioral directives — rules are followed before compaction, violated after. Freelance sidesteps this entirely:

| Problem | How Freelance Solves It |
|---------|------------------------|
| Context compaction drops instructions | State lives server-side, not in the context window |
| Agents skip steps in complex workflows | Gate nodes block advancement until conditions are met |
| No visibility into agent progress | `freelance_inspect` returns position, history, and valid actions |
| Workflows are hardcoded or fragile | YAML-defined graphs — add a workflow by adding a file |
| Locked into one agent framework | Pure MCP over stdio — works with any MCP client |

### Key Capabilities

- **7 MCP tools** for workflow traversal, inspection, and context management
- **5 node types** — action, decision, gate, terminal, wait
- **Subgraph composition** — nest workflows within workflows with context/return mapping
- **Expression evaluator** — edge conditions and validations against session context
- **Daemon mode** — persistent traversal state across agent restarts
- **Hot reload** — graph files are watched and reloaded on change
- **Agent-agnostic** — Claude Code, Cursor, Windsurf, Cline, or any MCP client

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

```
┌──────────────────────────────────────────────┐
│            MCP Client (any agent)             │
│                                               │
│  freelance_start → freelance_advance → ...    │
└──────────────────┬───────────────────────────┘
                   │ stdio (JSON-RPC)
┌──────────────────▼───────────────────────────┐
│          Freelance MCP Server                 │
│                                               │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐   │
│  │ Engine   │  │ Session  │  │ Graph      │   │
│  │ Core     │  │ State    │  │ Loader     │   │
│  │          │  │          │  │            │   │
│  │ validate │  │ position │  │ YAML parse │   │
│  │ advance  │  │ context  │  │ validate   │   │
│  │ evaluate │  │ history  │  │ compose    │   │
│  └─────────┘  └──────────┘  └────────────┘   │
│                                               │
│  Loaded at startup: *.workflow.yaml           │
└───────────────────────────────────────────────┘
```

1. Define workflows as directed graphs in YAML (`.workflow.yaml` files)
2. Freelance loads them and exposes 7 MCP tools to the agent
3. The agent calls `freelance_start` to begin a workflow, `freelance_advance` to move between nodes
4. Gate nodes block advancement until conditions are met — quality enforcement without documentation
5. After context compaction, the agent calls `freelance_inspect` and re-orients instantly

### Example Workflow

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

## API Reference

Freelance exposes 7 MCP tools. All responses are JSON.

### `freelance_list`

Discover available workflow graphs.

```
→ freelance_list()
← { graphs: [{ id, name, description, version, nodeCount }] }
```

### `freelance_start`

Begin traversing a graph. Creates a new session.

```
→ freelance_start({ graphId: "my-workflow" })
← { traversalId, position: { nodeId, type, description, instructions, edges } }
```

### `freelance_advance`

Move to the next node via a labeled edge. Validates gate conditions before allowing the transition.

```
→ freelance_advance({ traversalId: "tr_abc123", edge: "done" })
← { position: { nodeId, type, description, instructions, edges } }
```

Returns `isError: true` with structured errors if validations fail or the edge is invalid.

### `freelance_context_set`

Update session context without advancing. Used to record progress that gate validations check.

```
→ freelance_context_set({ traversalId: "tr_abc123", values: { taskDone: true } })
← { context: { taskDone: true } }
```

### `freelance_inspect`

Read-only introspection. Returns position, history, context, or the full graph structure.

```
→ freelance_inspect({ traversalId: "tr_abc123", view: "position" })
← { nodeId, type, description, instructions, edges, context }
```

Views: `position` | `history` | `graph` | `full`

### `freelance_reset`

Clear traversal state and start over.

```
→ freelance_reset({ traversalId: "tr_abc123" })
← { reset: true }
```

### `freelance_guide`

Get authoring guidance for writing workflow graphs.

```
→ freelance_guide()
← { guide: "..." }
```

## Node Types

| Type | Purpose | Edges | Validations |
|------|---------|-------|-------------|
| **action** | The agent performs work | Yes | Optional |
| **decision** | Evaluate conditions, pick a route | Yes | No |
| **gate** | Like action, but blocks until validations pass | Yes | Required |
| **terminal** | End state | No | No |
| **wait** | Pause until external signal or timeout | Yes | Optional |

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

## Workflow Directory Resolution

Workflows load automatically from these directories (no flags needed):

1. `./.freelance/` — project-level workflows
2. `~/.freelance/` — user-level workflows (shared across projects)

Subdirectories are scanned recursively. Later directories shadow earlier ones by graph ID.

```bash
# Or specify directories explicitly
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

| Command | Description |
|---------|-------------|
| `freelance init` | Interactive project setup |
| `freelance validate <dir>` | Validate graph definitions |
| `freelance visualize <file>` | Render graph as Mermaid or DOT |
| `freelance inspect` | Show active traversals from persisted state |
| `freelance mcp` | Start standalone MCP server |
| `freelance mcp --connect <host:port>` | Start MCP proxy to daemon |
| `freelance daemon start\|stop\|status` | Manage the daemon |
| `freelance traversals list\|inspect\|reset` | Manage traversals (requires daemon) |
| `freelance completion bash\|zsh\|fish` | Output shell completion script |

## Documentation

| Guide | Description |
|-------|-------------|
| [Full Specification](docs/SPEC.md) | Graph schema, expression language, subgraph composition, return schemas, architecture |

## Project Structure

```
src/
├── schema/           # Zod schemas (single source of truth for types + validation)
├── engine/           # Core traversal engine
│   ├── engine.ts     # Orchestrator (start, advance, reset, inspect)
│   ├── gates.ts      # Pre-advance checks (validations, edge conditions)
│   ├── subgraph.ts   # Stack push/pop with context and return mapping
│   ├── state.ts      # Context updates, strict context enforcement
│   ├── transitions.ts # Edge evaluation with default-edge logic
│   ├── wait.ts       # Wait condition evaluation and timeout handling
│   └── returns.ts    # Return schema validation
├── server.ts         # MCP tool surface (7 tools wrapping TraversalManager)
├── traversal-manager.ts  # Multi-traversal management with persistence
├── daemon.ts         # HTTP daemon server
├── proxy.ts          # MCP proxy (stdio ↔ daemon HTTP)
├── loader.ts         # YAML graph loader with structural validation
├── evaluator.ts      # Expression evaluator for conditions
├── cli/              # CLI subcommand handlers
└── index.ts          # CLI entry point
templates/            # Starter graph templates and shell completions
test/fixtures/        # Example workflow YAML files
```

## License

MIT
