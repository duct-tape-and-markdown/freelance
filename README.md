# Freelance

Graph-based workflow enforcement and persistent memory for AI coding agents.

Define structured workflows in YAML. Agents drive them through the `freelance` CLI, via a Claude Agent Skill that teaches the invariant protocol. Build a persistent knowledge graph that grows with every query and knows when its sources have changed.

## Quick Start

### Claude Code (plugin — recommended)

```
/plugin marketplace add duct-tape-and-markdown/freelance
/plugin install freelance@freelance-plugins
```

This installs the CLI-driving skill and the session/compact hooks. Then scaffold the project with `freelance init` in a terminal.

### Other clients (Cursor, Windsurf, Cline)

```bash
npm install -g freelance-mcp
cd /path/to/your/project
freelance init
```

## Driving workflows via skill + CLI

Freelance ships a single [Claude Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) that teaches the agent how to drive any workflow through the `freelance` CLI. The skill activates from its description match — when the user mentions a workflow to run, describes a task matching a loaded workflow, or wants to continue an in-flight traversal.

`freelance init --client claude-code` installs `SKILL.md` at `.claude/skills/freelance/` (project scope) or `~/.claude/skills/freelance/` (user scope) alongside the workflows directory. The plugin install path ships the same skill.

The agent drives workflows through shell-out calls — `freelance status`, `freelance start <graphId>`, `freelance advance <edge>`, `freelance context set k=v`, `freelance inspect` — and branches on semantic exit codes (0 success, 1 internal, 2 blocked, 3 validation, 4 not found, 5 invalid input). Every runtime verb emits a structured JSON response on stdout; breadcrumbs go to stderr. See [`plugins/freelance/skills/freelance/SKILL.md`](plugins/freelance/skills/freelance/SKILL.md) for the driving protocol.

## Workflows

Workflows are directed graphs defined in YAML. The agent calls CLI verbs to traverse them — `freelance start` to begin, `freelance advance` to move between nodes. Gate nodes block advancement until conditions are met. State lives on disk under `.freelance/traversals/`, so it survives context compaction.

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

**onEnter hooks** — Any node can declare `onEnter: [{ call, args }]` hooks that run before the agent sees the node. `call` resolves to either a built-in hook (`memory_status`, `memory_browse`) or a local script path (`./scripts/fetch-context.js`). Hooks receive resolved args, live context, and the memory store, and return a plain object of context updates. Strict-context enforcement still applies. Per-hook timeout defaults to 5000ms, configurable via `hooks.timeoutMs` in `config.yml`.

> **Trust model for hook scripts.** Local script hooks execute with full Node privileges in the host process on graph load and node arrival — treat a workflow file that references a local script like a `package.json` scripts block: trust it at the same level you trust the rest of the repo. Do not load workflow graphs from untrusted sources.

## Memory

Freelance includes a persistent knowledge graph backed by SQLite. The agent reads source files, reasons about them, and writes atomic propositions about 1-2 entities. Every proposition records which source files produced it and their content hashes at the time of compilation.

When you query memory, it checks whether the source files on disk still match. Match = valid knowledge. Mismatch = stale. The knowledge base grows with every query but never serves something that's silently out of date.

### How it works

**Compilation** — The agent reads source files, then emits propositions: self-contained claims in natural prose, each about 1-2 named entities. Propositions are deduplicated by content hash. Entity references are resolved by exact match, normalized match, or creation.

**Recollection** — When a new question comes in, the agent searches existing memory, reads the provenance sources, and identifies the delta — what the sources say about the question that existing propositions don't cover. Only that gap gets compiled. Each query makes the knowledge base denser from a different angle, without re-deriving what's already there.

**Source provenance** — Every proposition records the specific source files it was derived from, their content hashes, and their mtime at emit time. Validity is checked per-proposition on read: if any of a prop's source files have drifted, the prop is marked stale. Stale propositions aren't hidden — they're returned with a confidence signal so the agent can decide whether to re-verify.

**Git branching for free** — Switch branches, files change on disk, different propositions light up as valid or stale. Merge the branch, files converge, knowledge converges. No scope model, no branch tracking — just hash checks on read.

### Configuration

Memory is **enabled by default** with zero configuration. The database is stored at `.freelance/memory/memory.db`.

To customize, add memory settings to your `.freelance/config.yml` (see [Configuration](#configuration-1) below).

**Collections** partition propositions into named buckets. All read tools accept an optional `--collection` filter. Propositions are deduplicated within a collection — the same claim can exist in multiple collections.

Two sealed workflows are auto-injected: `memory:compile` (read sources, emit propositions, evaluate coverage) and `memory:recall` (recall, source, compare, fill delta, evaluate). These can be referenced as subgraphs in your own workflows.

### Memory CLI verbs

Write (gated by an active workflow traversal):

| Command | Description |
|---------|-------------|
| `freelance memory emit <file>` | Write propositions with required per-file source attribution (use `-` for stdin) |
| `freelance memory prune --keep <ref>` | Scope-bounded delete by content-reachability (see [Pruning memory](#pruning-memory)) |

Read (available anytime):

| Command | Description |
|---------|-------------|
| `freelance memory browse` | Find entities by name or kind |
| `freelance memory inspect <entity>` | Full entity details with propositions, neighbors, and deduped source files |
| `freelance memory by-source <file>` | All propositions derived from a specific source file |
| `freelance memory related <entity>` | Entity graph navigation — co-occurring entities with connection strength |
| `freelance memory search <query>` | Full-text search across proposition content (FTS5) |
| `freelance memory status` | Knowledge graph health: total, valid, stale counts |

## Workflow CLI verbs

| Command | Description |
|---------|-------------|
| `freelance status` | Discover available workflow graphs and active traversals (each with any `meta` tags) |
| `freelance start <graphId>` | Begin traversing a graph (optional opaque `--meta key=value` tags for later lookup) |
| `freelance advance <edge>` | Move to the next node via a labeled edge |
| `freelance context set <key=value>...` | Update session context without advancing |
| `freelance meta set <key=value>...` | Merge opaque `meta` tags onto a traversal (add or overwrite) |
| `freelance inspect [id]` | Read-only introspection (`--detail position` or `--detail history`); includes `meta` tags |
| `freelance reset --confirm` | Clear traversal and start over |
| `freelance guide [topic]` | Authoring guidance for writing graphs |
| `freelance distill --mode distill\|refine` | Distill a task into a new workflow, or refine an existing one |
| `freelance validate <dir>` | Validate graph definitions |
| `freelance sources hash <paths...>` | Compute hashes for source binding |
| `freelance sources check <sources...>` | Verify source file hashes |
| `freelance sources validate` | Validate source integrity across loaded graphs |

## Configuration

Freelance uses two config files in `.freelance/`, both with the same schema:

| File | Purpose | Committed? |
|------|---------|-----------|
| `config.yml` | Team-shared settings | Yes |
| `config.local.yml` | Machine-specific overrides (plugin hooks) | No (gitignored) |

General precedence: **CLI flags > env vars > config.local.yml > config.yml > defaults**. Per-field surface:

| Field | CLI flag | Env var | `config.yml` | Notes |
|---|---|---|---|---|
| `workflows` | `--workflows` (repeatable) | `FREELANCE_WORKFLOWS` | ✓ (array, concatenates across files) | User/project dirs cascade automatically |
| `memory.enabled` | `--memory` / `--no-memory` | — | ✓ | CLI flag always wins |
| `memory.dir` | `--memory-dir` | — | ✓ | Default: `.freelance/memory/` |
| `memory.collections` | — | — | ✓ (concatenates) | Must be declared before emit |
| `maxDepth` | `--max-depth` | — | ✓ | Default: `5` |
| `hooks.timeoutMs` | — | — | ✓ | Config-only. Default: `5000` |
| `context.maxValueBytes` | — | — | ✓ | Per-value cap on context writes. Default: `4096` (4 KB) |
| `context.maxTotalBytes` | — | — | ✓ | Total context cap per traversal. Default: `65536` (64 KB) |
| `sourceRoot` | `--source-root` | — | — | Computed from graphsDir if omitted |

```yaml
# .freelance/config.yml
workflows:                          # Additional workflow directories
  - ../shared-workflows/

memory:
  enabled: true                     # Default: true. Set false to disable.
  dir: /path/to/persistent/dir      # Override memory.db location (default: .freelance/memory/)
  collections:                      # Partition propositions into named buckets
    - name: default
      description: General project knowledge
      paths: [""]
    - name: spec
      description: Feature specifications
      paths: ["docs/", "specs/"]

maxDepth: 5                         # Max subgraph nesting depth. CLI --max-depth overrides.

hooks:
  timeoutMs: 5000                   # Per-hook timeout for onEnter hooks. Default 5000.

context:
  maxValueBytes: 4096               # Per-value byte cap on context writes. Default 4 KB.
  maxTotalBytes: 65536              # Total serialized-context cap per traversal. Default 64 KB.
```

Over-cap writes are rejected with `CONTEXT_VALUE_TOO_LARGE` or `CONTEXT_TOTAL_TOO_LARGE` errors at the `freelance context set`, `freelance advance --context …`, and onEnter-hook return boundaries, so a runaway hook or context write never persists.

Merge rules: arrays (`workflows`, `collections`) concatenate across files. Scalars use highest-precedence value.

Use `freelance config show` to see the resolved configuration and which files contributed.

Use `freelance config set-local <key> <value>` to modify `config.local.yml` programmatically (used by plugin hooks).

### Workflow directories

Workflows load automatically from these directories (no flags needed):

1. `./.freelance/` — project-level workflows
2. `~/.freelance/` — user-level workflows (shared across projects)
3. Additional directories listed in `config.yml` or `config.local.yml` `workflows:`

Subdirectories are scanned recursively. Later directories shadow earlier ones by graph ID. You can also specify directories explicitly:

```bash
freelance status --workflows ./my-workflows/
```

### `.freelance/` directory layout

```
.freelance/
├── config.yml           # team-shared config (committed)
├── config.local.yml     # machine-specific overrides (gitignored)
├── *.workflow.yaml      # source artifacts — your graph definitions
├── .gitignore           # auto-generated; covers runtime dirs below
├── memory/              # runtime (gitignored)
│   ├── memory.db        #   persistent knowledge graph
│   ├── memory.db-shm    #   SQLite shared-memory sidecar
│   └── memory.db-wal    #   SQLite write-ahead log
└── traversals/          # runtime (gitignored)
    └── tr_*.json        #   one file per active traversal
```

Source artifacts and runtime artifacts coexist as peers; the lifecycle distinction is maintained via `.gitignore`, not directory nesting. Freelance auto-generates `.freelance/.gitignore` on first write.

If you're upgrading from a pre-1.3 install that used a `.state/` subdirectory, the layout is migrated automatically on the next run — `memory.db` is moved into `memory/`, `traversals/` moves up one level, the vestigial `state.db` from the earlier architecture is removed, and the empty `.state/` is cleaned up. The migration logs one line to stderr and is best-effort; on failure you'll see an actionable message.

### Pruning memory

Over a long project lifetime, `proposition_sources` accumulates rows from abandoned branches and old file versions. Each row is a `(proposition, file_path, content_hash)` coordinate in corpus-version space — stale entries aren't wrong, they're frames of reference you no longer care about. `freelance memory prune` is the explicit, user-initiated cleanup path; emit-time GC would collapse the multi-frame store (see `docs/memory-intent.md`).

```bash
freelance memory prune --keep main --keep release --yes
freelance memory prune --keep main --dry-run
```

A row is deleted only when its `content_hash` doesn't match the file at **any** location you declared live: the current working tree, *or* the tip of any `--keep` ref. Ref blobs are read via `git cat-file --batch` directly from the object store, so prune never switches branches or touches your working tree.

The approach is robust to history-rewriting workflows (rebase, squash merge, amend) because it asks about tree content, not commit reachability — a squashed branch's bytes end up in the merge commit's tree and are still found. Unresolvable `--keep` refs hard-error before touching the database. Non-git source roots can't use prune at all.

Config default:

```yaml
memory:
  prune:
    keep: [main]                 # concatenates with --keep flags
```

### Resetting memory

Memory is content-addressable — everything in `memory.db` can be rebuilt on demand from source files. If you hit a schema incompatibility after a version bump, or just want a clean slate:

```bash
freelance memory reset --confirm
```

Deletes `memory.db` and its sidecars without opening the database, so it works even when the current binary refuses to load the old schema. Next run re-initializes a fresh store.

**CLI flags:**
- `--memory-dir <path>` — override memory.db location (highest priority)
- `--no-memory` — disable memory entirely

**Environment variables:**
- `FREELANCE_WORKFLOWS_DIR` — colon-separated list of workflow directories (bypasses auto-scan)

## CLI

Agents drive Freelance through the CLI. Commands operate directly on the local state store — no daemon or server required.

```
# Setup
freelance init                            # Interactive project setup
freelance validate <dir>                  # Validate graph definitions
freelance visualize <file>                # Render graph as Mermaid or DOT

# Traversals
freelance status [--filter key=value ...]           # Show loaded graphs and active traversals (with meta); --filter narrows by meta
freelance start <graphId> [--meta key=value ...]    # Begin a workflow traversal, optionally tagged
freelance advance [edge]                            # Move to next node via edge label
freelance context set <key=value...>                # Update traversal context
freelance meta set <key=value...>                   # Merge meta tags (add or overwrite)
freelance inspect [traversalId]                     # Read-only introspection (includes meta)
freelance reset [traversalId] --confirm             # Clear a traversal

# Memory
freelance memory status                   # Proposition and entity counts
freelance memory browse                   # Find entities by name or kind
freelance memory inspect <entity>         # Full entity details
freelance memory search <query>           # Full-text search
freelance memory related <entity>         # Co-occurring entities
freelance memory by-source <file>         # Propositions from a source file
freelance memory register <file>          # Hash a file (stateless echo)
freelance memory emit <file>              # Write propositions from JSON

# Graph tools
freelance guide [topic]                   # Authoring guidance
freelance distill                         # Get a distill prompt
freelance sources hash <paths...>         # Compute source hashes
freelance sources check <sources...>      # Validate source hashes
freelance sources validate                # Validate all source bindings

# Configuration
freelance config show                     # Display resolved config with sources
freelance config set-local <key> <value>  # Modify config.local.yml

freelance completion bash|zsh|fish        # Shell completion script
```

Run `freelance --help` for full details and flags.

## License

MIT
