# Graph Engine

A domain-agnostic, YAML-defined, graph-traversal MCP server that enforces structured workflows on AI coding agents. State lives server-side — it can't be compacted away, forgotten, or bypassed. The agent calls tools, the server tells it where it is and what's valid.

## Quick start

```bash
npm install
npm run build
```

Create a graph definition (e.g. `graphs/my-workflow.graph.yaml`):

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

Validate your graph:

```bash
node dist/index.js --graphs ./graphs/ --validate
```

## MCP tools

| Tool | Description |
|------|-------------|
| `graph_list` | Discover available workflow graphs |
| `graph_start` | Begin traversing a graph |
| `graph_advance` | Move to the next node via a labeled edge |
| `graph_context_set` | Update session context without advancing |
| `graph_inspect` | Read-only introspection (position, history, or full graph) |
| `graph_reset` | Clear traversal and start over |

## MCP server configuration

### Claude Code

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "graph-engine": {
      "command": "node",
      "args": ["/path/to/graph-engine/dist/index.js", "--graphs", "/path/to/graphs/"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "graph-engine": {
      "command": "node",
      "args": ["/path/to/graph-engine/dist/index.js", "--graphs", "/path/to/graphs/"]
    }
  }
}
```

### Generic MCP client

Any MCP-compatible client that supports stdio transport:

```json
{
  "command": "node",
  "args": ["/path/to/graph-engine/dist/index.js", "--graphs", "/path/to/graphs/"]
}
```

## Documentation

See [docs/SPEC.md](docs/SPEC.md) for the full specification including graph schema, node types, expression language, and architecture.

## License

MIT
