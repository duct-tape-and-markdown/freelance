# Freelance

Graph-based workflow enforcement and persistent memory for AI coding agents.

Define structured workflows in YAML. Enforce them at tool boundaries via MCP. Build a persistent knowledge graph that grows with every query and knows when its sources have changed.

## Quick Start

### Claude Code (plugin — recommended)

```
/plugin marketplace add duct-tape-and-markdown/freelance
/plugin install freelance@freelance-plugins
```

This installs the MCP server, hooks, and skills automatically. Run `/freelance:freelance-init` to scaffold your first workflow.

### Other clients (Cursor, Windsurf, Cline)

```bash
npm install -g freelance-mcp
cd /path/to/your/project
freelance init
```

## Workflows

Workflows are directed graphs defined in YAML. The agent calls MCP tools to traverse them — `freelance_start` to begin, `freelance_advance` to move between nodes. Gate nodes block advancement until conditions are met. State lives server-side, so it survives context compaction.

```yaml
id: my-workflow
version: "1.0.0"
name: "My Workflow"
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

**Node types:** action (do work), decision (pick a route), gate (enforce conditions), wait (pause for external signals), terminal (end state).

**Subgraph composition** — Nodes can push into child workflows with scoped context. `contextMap` passes parent values in, `returnMap` passes child values back. The engine manages a stack, so subgraphs can nest.

**Expression evaluator** — Edge conditions and validations use a safe expression language (`context.x == 'value'`, `context.count > 0`, boolean operators, nested property access). Validated at load time, evaluated at runtime.

## Memory

Freelance includes a persistent knowledge graph backed by SQLite. The agent reads source files, reasons about them, and writes atomic propositions about 1-2 entities. Every proposition records which source files produced it and their content hashes at the time of compilation.

When you query memory, it checks whether the source files on disk still match. Match = valid knowledge. Mismatch = stale. The knowledge base grows with every query but never serves something that's silently out of date.

### How it works

**Compilation** — The agent reads source files, then emits propositions: self-contained claims in natural prose, each about 1-2 named entities. Propositions are deduplicated by content hash. Entity references are resolved by exact match, normalized match, or creation.

**Recollection** — When a new question comes in, the agent searches existing memory, reads the provenance sources, and identifies the delta — what the sources say about the question that existing propositions don't cover. Only that gap gets compiled. Each query makes the knowledge base denser from a different angle, without re-deriving what's already there.

**Source provenance** — Each proposition can be linked to the specific source files it was derived from. Validity is checked per-proposition when file-level attribution is present, falling back to session-level when it's not. Propositions from a prior session aren't hidden when stale — they're returned with a confidence signal so the agent can decide whether to re-verify.

**Git branching for free** — Switch branches, files change on disk, different propositions light up as valid or stale. Merge the branch, files converge, knowledge converges. No scope model, no branch tracking — just hash checks on read.

### Configuration

Memory is **enabled by default** with zero configuration. The database is stored at `.freelance/.state/memory.db`.

To customize, add memory settings to your `.freelance/config.yml` (see [Configuration](#configuration-1) below).

**Collections** partition propositions into named buckets. All read tools accept an optional `--collection` filter. Propositions are deduplicated within a collection — the same claim can exist in multiple collections.

Two sealed workflows are auto-injected: `memory:compile` (read sources, emit propositions, evaluate coverage) and `memory:recall` (recall, source, compare, fill delta, evaluate). These can be referenced as subgraphs in your own workflows.

### Memory tools

| Tool | Description |
|------|-------------|
| `memory_register_source` | Register a file as a provenance source (hashes content) |
| `memory_emit` | Write propositions with optional per-file source attribution |
| `memory_end` | Close the active compilation session |
| `memory_browse` | Find entities by name or kind |
| `memory_inspect` | Full entity details with propositions and validity |
| `memory_by_source` | All propositions linked to a source file |
| `memory_related` | Entity graph navigation — co-occurring entities with connection strength |
| `memory_search` | Full-text search across proposition content (FTS5) |
| `memory_status` | Knowledge graph health: total, valid, stale counts |

## Workflow Tools

| Tool | Description |
|------|-------------|
| `freelance_list` | Discover available workflow graphs and active traversals |
| `freelance_start` | Begin traversing a graph |
| `freelance_advance` | Move to the next node via a labeled edge |
| `freelance_context_set` | Update session context without advancing |
| `freelance_inspect` | Read-only introspection (position, history, or full graph) |
| `freelance_reset` | Clear traversal and start over |
| `freelance_guide` | Authoring guidance for writing graphs |
| `freelance_distill` | Distill a task into a new workflow |
| `freelance_validate` | Validate graph definitions |
| `freelance_sources_hash` | Compute hashes for source binding |
| `freelance_sources_check` | Verify source file availability |
| `freelance_sources_validate` | Validate source integrity against expectations |

## Configuration

Freelance uses two config files in `.freelance/`, both with the same schema:

| File | Purpose | Committed? |
|------|---------|-----------|
| `config.yml` | Team-shared settings | Yes |
| `config.local.yml` | Machine-specific overrides (plugin hooks) | No (gitignored) |

Precedence: **CLI flags > env vars > config.local.yml > config.yml > defaults**

```yaml
# .freelance/config.yml
workflows:                          # Additional workflow directories
  - ../shared-workflows/

memory:
  enabled: true                     # Default: true. Set false to disable.
  dir: /path/to/persistent/dir      # Override memory.db location
  ignore:                           # Glob patterns to exclude from indexing
    - "**/node_modules/**"
    - "**/dist/**"
  collections:                      # Partition propositions into named buckets
    - name: default
      description: General project knowledge
      paths: [""]
    - name: spec
      description: Feature specifications
      paths: ["docs/", "specs/"]
```

Merge rules: arrays (`workflows`, `ignore`, `collections`) concatenate across files. Scalars (`enabled`, `dir`) use highest-precedence value.

Use `freelance config show` to see the resolved configuration and which files contributed.

Use `freelance config set-local <key> <value>` to modify `config.local.yml` programmatically (used by plugin hooks).

### Workflow directories

Workflows load automatically from these directories (no flags needed):

1. `./.freelance/` — project-level workflows
2. `~/.freelance/` — user-level workflows (shared across projects)
3. Additional directories listed in `config.yml` or `config.local.yml` `workflows:`

Subdirectories are scanned recursively. Later directories shadow earlier ones by graph ID. You can also specify directories explicitly:

```bash
freelance mcp --workflows ./my-workflows/
```

**CLI flags:**
- `--memory-dir <path>` — override memory.db location (highest priority)
- `--no-memory` — disable memory entirely

**Environment variables:**
- `FREELANCE_WORKFLOWS_DIR` — colon-separated list of workflow directories (bypasses auto-scan)

### MCP setup

Run `freelance init` to auto-detect your client and generate the config. Supports Claude Code, Cursor, Windsurf, and Cline.

Manual configuration (e.g., `.mcp.json` for Claude Code):

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

## CLI

Every MCP tool has a CLI equivalent. Commands operate directly on the local state store — no daemon or MCP client required.

```
# Setup
freelance init                            # Interactive project setup
freelance validate <dir>                  # Validate graph definitions
freelance visualize <file>                # Render graph as Mermaid or DOT

# Traversals
freelance status                          # Show loaded graphs and active traversals
freelance start <graphId>                 # Begin a workflow traversal
freelance advance [edge]                  # Move to next node via edge label
freelance context set <key=value...>      # Update traversal context
freelance inspect [traversalId]           # Read-only introspection
freelance reset [traversalId] --confirm   # Clear a traversal

# Memory
freelance memory status                   # Proposition and entity counts
freelance memory browse                   # Find entities by name or kind
freelance memory inspect <entity>         # Full entity details
freelance memory search <query>           # Full-text search
freelance memory related <entity>         # Co-occurring entities
freelance memory by-source <file>         # Propositions from a source file
freelance memory register <file>          # Register a provenance source
freelance memory emit <file>              # Write propositions from JSON
freelance memory end                      # Close compilation session

# Graph tools
freelance guide [topic]                   # Authoring guidance
freelance distill                         # Get a distill prompt
freelance sources hash <paths...>         # Compute source hashes
freelance sources check <sources...>      # Validate source hashes
freelance sources validate                # Validate all source bindings

# Configuration
freelance config show                     # Display resolved config with sources
freelance config set-local <key> <value>  # Modify config.local.yml

# Server
freelance mcp                             # Start MCP server
freelance completion bash|zsh|fish        # Shell completion script
```

Run `freelance --help` for full details and flags.

## License

MIT
