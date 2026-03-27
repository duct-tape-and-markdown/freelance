# Graph Engine: A Domain-Agnostic Graph-Traversal MCP Server

**Spec version: 2.0**

## What this is

A standalone MCP server that enforces structured processes on AI coding agent sessions by representing workflows as directed graphs and exposing traversal as tool calls. The agent doesn't read documentation and try to remember rules — it calls tools, and the server tells it where it is, what to do, and blocks anything that violates the graph.

The engine is domain-agnostic. It loads YAML graph definitions at startup and exposes a universal tool surface. The graph definition carries all domain knowledge. The engine just walks it and enforces it.

The engine is also agent-agnostic. It uses the Model Context Protocol (MCP) over stdio, which is supported by Claude Code, Cursor, Windsurf, Cline, Continue, OpenAI's agent SDK, and any other MCP-compatible client. The spec is written with Claude Code as a reference client, but the engine has zero Claude-specific code.

## Why this exists

AI coding agents lose instruction compliance over long sessions. In Claude Code specifically, context compaction destroys behavioral directives — rules in CLAUDE.md are followed before compaction, violated after. The compaction summarizer preserves conversation content, not behavioral contracts. Other agents have analogous context window pressure.

An MCP server sidesteps this entirely: state lives server-side in the process, not in the agent's context window. The server can't forget. The server can't be compacted away. Every tool call returns the current position and valid actions, so even a fully compacted agent can re-orient immediately.

The pattern emerged from constraining an AI agent to a phase-based state machine during a knowledge compilation pipeline. The agent had to satisfy exit conditions before advancing between phases. This produced dramatically more reliable behavior than any amount of documentation or instruction-based prompting. This spec extracts that pattern into a reusable engine.

**Nothing like this exists in the ecosystem.** LangGraph and Stately Agent use state machines to orchestrate agents but own the agent loop — they replace your agent, not constrain it. Pimzino's spec-workflow-mcp enforces a development workflow via MCP tools but is hardcoded to one specific process. No existing tool provides a domain-agnostic, YAML-defined graph engine that constrains an external agent at tool boundaries.

## Architecture

```
┌─────────────────────────────────────────────┐
│              MCP Client (any agent)           │
│                                              │
│  Calls MCP tools:                            │
│  freelance_list, freelance_start, freelance_advance,     │
│  freelance_context_set, freelance_inspect,           │
│  freelance_reset                              │
└──────────────────┬──────────────────────────┘
                   │ stdio (JSON-RPC)
                   │
┌──────────────────▼──────────────────────────┐
│            Graph Engine MCP Server            │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Engine   │  │  Session  │  │  Graph    │  │
│  │  Core     │  │  State    │  │  Loader   │  │
│  │          │  │          │  │           │  │
│  │ validate  │  │ position  │  │ YAML parse│  │
│  │ advance   │  │ context   │  │ validate  │  │
│  │ evaluate  │  │ history   │  │ compose   │  │
│  └──────────┘  └──────────┘  └───────────┘  │
│                                              │
│  Loaded at startup:                          │
│  *.workflow.yaml from --workflows directory        │
└──────────────────────────────────────────────┘
```

### Key properties
- **Per-session state.** Process IS the session (stdio). No persistence. When the client exits, the server exits, state is gone.
- **Hard enforcement.** Invalid transitions return `isError: true` with a structured error explaining what's valid. The agent cannot bypass the graph.
- **Static tool registration.** All six tools registered at startup. No dynamic tool list changes — Claude Code's support for `notifications/tools/list_changed` is unreliable (known bug, issue #13646). Enforcement happens at call time, not at registration time.
- **Graph-as-config.** All domain knowledge lives in YAML. The engine has zero domain awareness. Adding a new workflow means adding a YAML file.
- **Agent-agnostic.** Pure MCP over stdio. No Claude Code imports, no framework dependencies. Works with any MCP client.

## Graph definition format

### Schema

```yaml
# Required top-level fields
id: string                    # Unique graph identifier
version: string               # Semver for the graph definition
name: string                  # Human-readable name
description: string           # What this graph enforces
startNode: string             # Entry point node ID

# Optional
context:                      # Initial session context (key-value)
  key: defaultValue

strictContext: false           # If true, context_set rejects keys not in the schema
                               # If false (default), any key is allowed

nodes:
  <nodeId>:
    description: string       # What the agent should do at this node (imperative)
    type: action | decision | gate | terminal
    
    # What the agent sees when it arrives at this node
    instructions: string      # Detailed imperative instructions (the "op")
    
    # Optional: tools the agent should use at this node (advisory only)
    # Included in position response to guide the agent. Not enforced.
    suggestedTools: [string]
    
    # Optional: validations that must pass before ANY edge can be taken
    # Evaluated against session context
    # All node types support validations, but gate nodes REQUIRE them
    validations:
      - expr: string          # Boolean expression against context
        message: string       # Error message if validation fails
    
    # Optional: turn budget for action nodes
    # After this many freelance_context_set calls at this node,
    # the next response includes a warning to wrap up
    maxTurns: number
    
    # Edges define valid transitions out of this node
    edges:
      - target: string        # Target node ID
        label: string         # Human-readable edge name (used in freelance_advance)
        condition: string     # Optional: boolean expression against context
        description: string   # Optional: why you'd take this edge
      
      # Exactly one edge may be marked as default
      - target: string
        label: string
        default: true         # Taken when no other condition matches
```

### Changes from v1

**Dropped `tools.require` and `tools.block`.** The engine cannot observe external tool calls. Context updates + validations already cover enforcement — `context.testsPass === true` is strictly better than `require: [run_tests]` because the engine can verify it. `suggestedTools` replaces the old `tools.suggest` as pure advisory metadata.

**Added `strictContext` flag.** Defaults to `false` (open mode — any context key allowed). Set to `true` for graphs that need strict schema enforcement. Open mode is better for exploratory workflows where the agent needs ad-hoc context keys. Strict mode is better for well-defined pipelines with known state shapes.

**Added `maxTurns` on nodes.** Optional turn budget that counts `freelance_context_set` calls per node. After the limit, responses include a `turnWarning` field. Not hard enforcement — the agent can continue — but provides a checkpoint signal for long-running nodes like `implement` that could otherwise run unbounded until compaction. Hard enforcement of turn limits (blocking advance after maxTurns exceeded) can be added later if soft warnings prove insufficient.

### Node types

- **action** — The agent performs work. Has instructions, may have suggested tools, has edges out. The workhorse node type.
- **decision** — The agent evaluates conditions and chooses an edge. No work performed, just routing. Instructions describe what to evaluate. Should be quick — set context, pick an edge.
- **gate** — Like action, but REQUIRES validations. All validations must pass before ANY edge can be taken. Used for quality checkpoints. The primary enforcement mechanism.
- **terminal** — End state. No edges out. Graph traversal is complete. Instructions describe what to summarize.

### Example: Multi-phase pipeline with cycles

Demonstrates: strict context, gate nodes, cycle control, turn budgets, suggested tools.

```yaml
id: data-pipeline
version: "1.0.0"
name: "Data Processing Pipeline"
description: "Orchestrates a multi-phase data processing workflow with quality gates"
startNode: scan-sources
strictContext: true

context:
  sourceCount: 0
  processedCount: 0
  qualityScore: 0
  verificationPassed: false
  remainingItems: 0
  cycleCount: 0

nodes:
  scan-sources:
    type: action
    description: "Identify and catalog data sources"
    instructions: |
      Scan the target scope and catalog all data sources.
      Record source identifiers, types, and metadata.
      Set context.sourceCount to the total found.
    edges:
      - target: assess
        label: scan-complete
        description: "Sources cataloged, assess what needs processing"

  assess:
    type: action
    description: "Evaluate which sources need processing"
    instructions: |
      Compare cataloged sources against already-processed records.
      Identify gaps — sources with no output or stale output.
      Set context.remainingItems to the count needing work.
    edges:
      - target: plan
        label: gaps-found
        condition: "context.remainingItems > 0"
        description: "Unprocessed sources found"
      - target: verify
        label: all-current
        condition: "context.remainingItems == 0"
        description: "Everything is up to date, skip to verification"

  plan:
    type: action
    description: "Plan the processing batch"
    instructions: |
      Group remaining items by type/priority.
      Define a processing order and budget for this cycle.
    edges:
      - target: execute
        label: plan-ready

  execute:
    type: action
    maxTurns: 20
    description: "Process the planned batch"
    instructions: |
      Follow the plan. Process each item in order.
      Track progress in context as you go.
      Set context.processedCount when the batch is done.
    suggestedTools: [process_item, validate_output]
    edges:
      - target: verify
        label: batch-complete

  verify:
    type: gate
    description: "Verify processing quality"
    instructions: |
      Check all outputs for quality.
      Set context.qualityScore (0-100) and context.verificationPassed.
    validations:
      - expr: "context.verificationPassed == true"
        message: "Quality verification failed. Review outputs before proceeding."
      - expr: "context.qualityScore >= 80"
        message: "Quality score must be at least 80. Current score is below threshold."
    edges:
      - target: cycle-check
        label: verified

  cycle-check:
    type: decision
    description: "Decide whether another processing cycle is needed"
    instructions: |
      Evaluate: are there remaining unprocessed items? Is the cycle budget exhausted?
    edges:
      - target: assess
        label: more-cycles
        condition: "context.cycleCount < 3 && context.remainingItems > 0"
      - target: complete
        label: done
        default: true

  complete:
    type: terminal
    description: "Pipeline finished"
    instructions: |
      Summarize: total sources, items processed, quality score, remaining gaps.
```

### Example: Branching workflow with gates

Demonstrates: decision routing, open context, validations on action nodes, scope checks, quality gates.

```yaml
id: change-request
version: "1.0.0"
name: "Change Request Workflow"
description: "Enforces a structured process for making changes with quality gates"
startNode: classify
strictContext: false

context:
  changeType: null
  targetBranch: null
  testsPass: false
  lintPass: false
  outputUrl: null

nodes:
  classify:
    type: decision
    description: "Determine the type of change"
    instructions: |
      Based on the request, determine the change type.
      Set context.changeType to one of: standard, urgent, cosmetic.
    edges:
      - target: setup-standard
        label: standard
        condition: "context.changeType == 'standard'"
      - target: setup-urgent
        label: urgent
        condition: "context.changeType == 'urgent'"
      - target: setup-cosmetic
        label: cosmetic
        condition: "context.changeType == 'cosmetic'"

  setup-standard:
    type: action
    description: "Initialize standard change"
    instructions: |
      Set up the standard change path.
      Set context.targetBranch appropriately.
    validations:
      - expr: "context.targetBranch != null"
        message: "Target branch must be set before proceeding."
    edges:
      - target: implement
        label: ready

  setup-urgent:
    type: action
    description: "Initialize urgent change"
    instructions: |
      Set up the urgent change path with expedited targeting.
      Set context.targetBranch appropriately.
    validations:
      - expr: "context.targetBranch != null"
        message: "Target branch must be set before proceeding."
    edges:
      - target: implement
        label: ready

  setup-cosmetic:
    type: action
    description: "Initialize cosmetic change"
    instructions: |
      Set up the cosmetic change path.
      Set context.targetBranch appropriately.
    edges:
      - target: implement
        label: ready

  implement:
    type: action
    maxTurns: 30
    description: "Make the changes"
    instructions: |
      Implement the requested changes.
      Stay within the original scope.
    edges:
      - target: scope-check
        label: scope-question
        condition: "context.scopeQuestionRaised == true"
      - target: quality-gate
        label: done

  scope-check:
    type: decision
    description: "Evaluate scope boundaries"
    instructions: |
      Is the proposed work within the original request scope?
      Reset context.scopeQuestionRaised = false before advancing.
    edges:
      - target: implement
        label: in-scope
      - target: implement
        label: out-of-scope
        description: "Note as follow-up, return to original scope"

  quality-gate:
    type: gate
    description: "Verify quality standards"
    instructions: |
      Run all quality checks.
      Set context.testsPass and context.lintPass based on results.
    validations:
      - expr: "context.testsPass == true"
        message: "Tests must pass before finalizing."
      - expr: "context.lintPass == true"
        message: "Lint must pass before finalizing."
    edges:
      - target: finalize
        label: pass
      - target: implement
        label: fail
        condition: "context.testsPass == false || context.lintPass == false"

  finalize:
    type: action
    description: "Finalize and publish the change"
    instructions: |
      Create the output artifact (PR, deploy, publish — whatever fits).
      Set context.outputUrl when done.
    validations:
      - expr: "context.outputUrl != null"
        message: "Output must be created before completing."
    edges:
      - target: complete
        label: finalized

  complete:
    type: terminal
    description: "Change request complete"
    instructions: |
      Summarize what was done, the output location, and any follow-up items.
```

## MCP tool surface

Six tools. Static registration. All enforcement at call time.

### `freelance_list`

Discover available graphs. Can be called at any time, including before starting a traversal.

**Parameters:** none

**Returns:**
```json
{
  "graphs": [
    { "id": "change-request", "name": "Change Request Workflow", "version": "1.0.0", "description": "Enforces a structured process for making changes with quality gates" },
    { "id": "data-pipeline", "name": "Data Processing Pipeline", "version": "1.0.0", "description": "Orchestrates a multi-phase data processing workflow with quality gates" }
  ]
}
```

### `freelance_start`

Begin graph traversal. Must be called before advance/context_set/inspect.

**Parameters:**
```typescript
{
  graphId: string,        // Which graph to traverse (matches YAML id field)
  initialContext?: object // Override default context values
}
```

**Returns:**
```json
{
  "status": "started",
  "graphId": "change-request",
  "currentNode": "classify",
  "node": {
    "type": "decision",
    "description": "Determine the type of change",
    "instructions": "Based on the request, determine the change type...",
    "suggestedTools": []
  },
  "validTransitions": [
    { "label": "standard", "target": "setup-standard", "condition": "context.changeType == 'standard'", "conditionMet": false },
    { "label": "urgent", "target": "setup-urgent", "condition": "context.changeType == 'urgent'", "conditionMet": false },
    { "label": "cosmetic", "target": "setup-cosmetic", "condition": "context.changeType == 'cosmetic'", "conditionMet": false }
  ],
  "context": { "changeType": null, "targetBranch": null }
}
```

Note: `conditionMet` is evaluated live on every response, always telling the agent which edges are currently available.

**Errors:**
- `isError: true` if graphId not found in loaded definitions
- `isError: true` if a traversal is already in progress (call `freelance_reset` first)

### `freelance_advance`

Move to the next node by taking a labeled edge. Can optionally include context updates that are applied before edge evaluation.

**Parameters:**
```typescript
{
  edge: string,           // The label of the edge to take
  contextUpdates?: object // Key-value pairs to set on context BEFORE evaluating
}
```

**Context update semantics:** `contextUpdates` are always persisted, even if the advance fails. This is intentional — if the agent sets `testsPass: true` but picks the wrong edge label, the context should still reflect that tests passed. Context updates and edge selection are logically separate operations bundled for convenience.

**Returns (success):**
```json
{
  "status": "advanced",
  "previousNode": "classify",
  "edgeTaken": "standard",
  "currentNode": "setup-standard",
  "node": {
    "type": "action",
    "description": "Initialize standard change",
    "instructions": "Set up the standard change path...",
    "suggestedTools": []
  },
  "validTransitions": [
    { "label": "ready", "target": "implement", "conditionMet": true }
  ],
  "context": { "changeType": "standard", "targetBranch": null }
}
```

**Returns (terminal node reached):**
```json
{
  "status": "complete",
  "previousNode": "finalize",
  "edgeTaken": "finalized",
  "currentNode": "complete",
  "node": {
    "type": "terminal",
    "description": "Change request complete",
    "instructions": "Summarize what was done..."
  },
  "validTransitions": [],
  "traversalHistory": ["classify", "setup-standard", "implement", "quality-gate", "finalize", "complete"],
  "context": { "...": "..." }
}
```

**Errors (context updates still persisted):**
- `isError: true` if no traversal active (must call `freelance_start` first)
- `isError: true` if edge label doesn't exist on current node
- `isError: true` if edge has a condition that evaluates to false against current context
- `isError: true` if current node has validations that fail (gate/action enforcement)

All error responses include full state for recovery:
```json
{
  "isError": true,
  "currentNode": "quality-gate",
  "reason": "Validation failed: Tests must pass before finalizing.",
  "validTransitions": [
    { "label": "pass", "target": "finalize", "conditionMet": false },
    { "label": "fail", "target": "implement", "conditionMet": true }
  ],
  "context": { "testsPass": false, "lintPass": true }
}
```

### `freelance_context_set`

Update session context without advancing. Used when the agent has done work at a node and needs to record results before choosing an edge.

**Parameters:**
```typescript
{
  updates: object  // Key-value pairs to merge into context
}
```

**Returns:**
```json
{
  "status": "updated",
  "currentNode": "quality-gate",
  "context": { "testsPass": true, "lintPass": true },
  "validTransitions": [
    { "label": "all-pass", "target": "create-pr", "conditionMet": true },
    { "label": "failures", "target": "implement", "conditionMet": false }
  ],
  "turnCount": 3,
  "turnWarning": null
}
```

When `maxTurns` is set and the count reaches the limit:
```json
{
  "status": "updated",
  "currentNode": "implement",
  "context": { "...": "..." },
  "validTransitions": [ "..." ],
  "turnCount": 30,
  "turnWarning": "Turn budget reached (30/30). Consider wrapping up and advancing to the next node."
}
```

**Errors:**
- `isError: true` if no traversal active
- `isError: true` if `strictContext: true` and update keys don't exist in the graph's context schema

### `freelance_inspect`

Read-only introspection. Returns graph state without modifying anything. Primary recovery mechanism after context compaction.

**Parameters:**
```typescript
{
  detail?: "position" | "full" | "history"  // Default: "position"
}
```

**Returns (position — default, lightweight):**
```json
{
  "graphId": "change-request",
  "graphName": "Change Request Workflow",
  "currentNode": "implement",
  "node": {
    "type": "action",
    "description": "Make the changes",
    "instructions": "Implement the requested changes...",
    "suggestedTools": []
  },
  "validTransitions": [ "..." ],
  "context": { "..." },
  "turnCount": 5,
  "turnWarning": null
}
```

**Returns (history — traversal audit trail):**
```json
{
  "graphId": "change-request",
  "currentNode": "implement",
  "traversalHistory": [
    { "node": "classify", "edge": "standard", "timestamp": "2026-03-13T10:00:00Z" },
    { "node": "setup-standard", "edge": "ready", "timestamp": "2026-03-13T10:01:00Z" }
  ],
  "contextHistory": [
    { "key": "changeType", "value": "standard", "setAt": "classify", "timestamp": "2026-03-13T10:00:00Z" },
    { "key": "targetBranch", "value": "develop", "setAt": "setup-standard", "timestamp": "2026-03-13T10:01:00Z" }
  ]
}
```

**Returns (full — complete graph definition, expensive):**
The complete graph definition including all nodes, edges, and metadata. Use sparingly — primarily for debugging or visualization.

### `freelance_reset`

Clear the current traversal and return to a clean state. Enables switching graphs mid-session or restarting a workflow.

**Parameters:**
```typescript
{
  confirm: boolean  // Must be true. Safety check against accidental resets.
}
```

**Returns:**
```json
{
  "status": "reset",
  "previousGraph": "change-request",
  "previousNode": "implement",
  "message": "Traversal cleared. Call freelance_start to begin a new workflow."
}
```

**Errors:**
- `isError: true` if `confirm` is not `true`
- Returns success even if no traversal was active (idempotent)

## When to use the graph engine (and when not to)

**The graph engine is for structured, multi-step tasks with defined workflows.** Feature development, hotfix deployment, compilation pipelines, release processes, code review workflows — anything with a defined sequence of steps and quality gates.

**The graph engine is NOT for:**
- Exploratory questions ("How does this function work?")
- One-off tasks ("Rename this variable across the codebase")
- Conversations ("What should we name this module?")
- Tasks that don't map to a defined graph

The CLAUDE.md (or equivalent agent instructions) must make this boundary explicit. The agent should only call `freelance_start` when the task matches a known workflow. For everything else, the agent works normally without graph constraints.

Recommended CLAUDE.md language:

```markdown
## Workflow execution

This project uses a graph engine to enforce structured workflows.
The graph engine is an MCP server — use its tools to navigate multi-step processes.

### When to use the graph engine

Call `freelance_list` to see available workflows.
Start a graph when the task matches a defined workflow.

### When NOT to use the graph engine

Do NOT start a graph for:
- Answering questions
- Exploratory reading
- One-off tasks
- Conversations about design

Just work normally. The graph engine is for multi-step workflows, not every interaction.

### During a graph traversal

1. Read the instructions at each node and execute them
2. Update context via `freelance_context_set` as you complete work
3. Advance via `freelance_advance` with the appropriate edge label
4. Continue until you reach a terminal node
5. If `freelance_advance` returns an error, read it — it tells you what's wrong

Never skip nodes. Never guess at transitions.
Call `freelance_inspect` if you lose track of where you are.
Call `freelance_reset` if you need to start over or switch workflows.
```

### Post-compaction recovery (Claude Code specific)

Add a compact-recovery hook:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "compact",
      "hooks": [{
        "type": "command",
        "command": "echo 'POST-COMPACTION: If you are mid-task, call freelance_inspect to re-orient. The graph engine tracks your position — ask it where you are.'"
      }]
    }]
  }
}
```

## Expression evaluator

Edge conditions and validations need a safe expression evaluator. This is a critical implementation decision — the wrong choice causes friction on day one.

### Requirements
- Must support `==`, `!=`, `>`, `<`, `>=`, `<=` (equality, comparison)
- Must support `&&`, `||`, `!` (logical)
- Must support string comparison (`context.taskType == 'feature'`)
- Must support null checks (`context.prUrl != null`)
- Must support property access (`context.testsPass`)
- Must NOT allow arbitrary code execution

### Recommendation: custom micro-evaluator

Neither `expr-eval` nor `safe-eval` fully fits. `expr-eval` uses `==` not `===`, doesn't support method calls, and has a non-JavaScript operator set. `safe-eval` and `new Function()` approaches open security surface area.

Build a ~100-line recursive descent evaluator that supports exactly the operators listed above. The input language is intentionally limited:

```
expression  := or_expr
or_expr     := and_expr ('||' and_expr)*
and_expr    := not_expr ('&&' not_expr)*
not_expr    := '!' not_expr | comparison
comparison  := value (('==' | '!=' | '>' | '<' | '>=' | '<=') value)?
value       := 'true' | 'false' | 'null' | NUMBER | STRING | property_access
property_access := 'context.' IDENTIFIER ('.' IDENTIFIER)*
STRING      := "'" [^']* "'"
```

This is tiny, auditable, and has zero dependencies. The expression language is documented in the graph schema — graph authors know exactly what they can write. If the need for more complex expressions arises (method calls, array operations), the evaluator can be extended deliberately rather than inheriting a third-party library's full surface.

**All expressions in the example graphs use this subset.** The v1 spec's use of `===` and `.startsWith()` was aspirational — this version constrains to what will actually be implemented.

## Engine internals

### Graph loader

```
Input: Directory path containing *.workflow.yaml files
Output: Map<graphId, ValidatedGraph>

1. Glob *.workflow.yaml from the directory
2. Parse each via js-yaml
3. Validate each against JSON Schema (ajv) — structural correctness
4. Build graph representation via @dagrejs/graphlib
5. Run graph validation per file:
   a. All edge targets point to defined nodes
   b. startNode exists and is reachable
   c. All non-terminal nodes have at least one outgoing edge
   d. Terminal nodes have zero outgoing edges
   e. No orphan nodes (alg.components check)
   f. Gate nodes have at least one validation
   g. Cycles must include at least one decision/gate node
      (prevents infinite action→action loops)
6. Register all valid graphs in the map
7. Fail fast with descriptive errors on any validation failure
   (include file path, node ID, and specific issue)
```

### Graph composition (Phase 3)

For cross-repo or team-specific customization. A local YAML can extend a shared base graph:

```yaml
extends: change-request  # Base graph ID to extend

overrides:
  quality-gate:               # Replace a node entirely
    type: gate
    description: "Stricter quality gate for this repo"
    instructions: |
      Run tests. Run linter. Run additional compatibility check.
    validations:
      - expr: "context.testsPass == true"
        message: "Tests must pass."
      - expr: "context.lintPass == true"
        message: "Lint must pass."
      - expr: "context.compatCheck == true"
        message: "Compatibility check must pass (repo-specific requirement)."
    edges:
      - target: finalize
        label: pass
      - target: implement
        label: fail
        condition: "context.testsPass == false || context.lintPass == false || context.compatCheck == false"

additions:
  extra-review:              # Add new nodes
    type: gate
    description: "Additional review step for sensitive areas"
    validations:
      - expr: "context.reviewApproved == true || context.touchesSensitiveArea == false"
        message: "Changes to sensitive areas require additional review."
    edges:
      - target: finalize
        label: approved

  rewire:                     # Redirect existing edges
    - from: quality-gate
      edge: pass
      newTarget: extra-review
      condition: "context.touchesSensitiveArea == true"
```

**Phase 3, not Phase 1.** For v1, repos that need different workflows should use separate complete graph files. Composition is elegant but complex — get the engine working first, then add merge semantics.

### Session state shape

```typescript
interface SessionState {
  graphId: string;
  currentNode: string;
  context: Record<string, unknown>;
  history: Array<{
    node: string;
    edge: string;
    timestamp: string;
    contextSnapshot: Record<string, unknown>;
  }>;
  turnCount: number;           // Resets on advance, counts context_set calls
  startedAt: string;
}
```

## Distribution

### As a Claude Code plugin

```
freelance/
├── plugin.json
├── src/
│   └── server.ts
├── graphs/                  # Ship with example graphs, or empty
│   └── ...
├── CLAUDE.md                # Agent instructions for graph usage
└── package.json
```

Plugin manifest:
```json
{
  "name": "freelance",
  "version": "1.0.0",
  "description": "Graph-based workflow enforcement for AI coding agents",
  "mcpServers": {
    "freelance": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js", "--workflows", "${CLAUDE_PLUGIN_ROOT}/graphs/"]
    }
  }
}
```

### As a standalone MCP server

For any MCP-compatible client:

```json
{
  "mcpServers": {
    "freelance": {
      "command": "node",
      "args": ["/path/to/freelance/dist/server.js", "--workflows", "/path/to/graphs/"]
    }
  }
}
```

Multiple graph directories can be passed for layered loading (Phase 3):
```json
{
  "args": ["dist/server.js", "--workflows", "/shared/graphs/", "--workflows", "./local/graphs/"]
}
```

### As an npm package (Phase 4)

```bash
npm install -g freelance-mcp
freelance mcp --workflows ./my-graphs/
```

### For other MCP clients

The engine is agent-agnostic. Cursor uses `.cursor/mcp.json`, Windsurf uses `~/.codeium/windsurf/mcp_config.json`, Cline uses its MCP settings. Same server binary, same configuration shape, different config file location. Agent instructions need adaptation per client, but the engine and graph definitions are identical.

## Tech stack

- **Runtime:** Node.js (TypeScript)
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.x (McpServer + StdioServerTransport)
- **Schema validation:** `zod` (for MCP tool input schemas, already a transitive dependency) + `ajv` (for YAML graph schema validation)
- **YAML parsing:** `js-yaml`
- **Graph operations:** `@dagrejs/graphlib` — cycle detection, reachability analysis, topological sort, component analysis
- **Expression evaluation:** Custom micro-evaluator (~100 lines, zero dependencies)
- **Transport:** stdio (standard MCP transport)

Total non-SDK dependencies: `js-yaml`, `ajv`, `@dagrejs/graphlib`. Zero infrastructure. No database. No network calls. The server is a pure function of its graph definitions and the session's tool call history.

## Implementation plan

### Phase 1: Core engine
Build the engine that loads YAML graphs, exposes the six tools, and enforces transitions.

1. Scaffold MCP server with `@modelcontextprotocol/sdk` (StdioServerTransport)
2. Implement YAML graph loader with ajv schema validation
3. Implement graph structural validation using `@dagrejs/graphlib`
4. Implement custom expression evaluator (recursive descent, ~100 lines)
5. Implement session state manager (position tracking, context, history, turn counting)
6. Implement six MCP tools: `freelance_list`, `freelance_start`, `freelance_advance`, `freelance_context_set`, `freelance_inspect`, `freelance_reset`
7. Test with a minimal 3-4 node graph definition
8. Test gate enforcement, conditional edges, cycle behavior, context updates on failed advance
9. Test compaction recovery (start traversal → simulate compaction → `freelance_inspect` → continue)

**Exit criteria:** The engine loads arbitrary YAML graph definitions, enforces transitions with `isError` responses, tracks session state, and recovers cleanly from re-orientation via `freelance_inspect`.

### Phase 2: Real-world validation
Author graph definitions for real workflows and validate the engine against actual agent sessions.

1. Author 2-3 graph definitions for real workflows the team uses
2. Configure the engine as an MCP server in target projects
3. Write agent instructions (CLAUDE.md or equivalent) with escape hatch guidance
4. Run end-to-end sessions — observe where the agent follows the graph, where it fights it
5. Iterate on graph definitions based on real behavior
6. Identify any missing engine features surfaced by real usage

**Exit criteria:** At least one graph definition is in daily use by the team with measurably better compliance than the previous documentation-based approach.

### Phase 3: Composition and tooling
Enable graph reuse, customization, and operational maturity.

1. Implement graph composition (extends/overrides/additions/rewire)
2. Add `--workflows` multi-directory support for layered graph loading
3. Add graph validation CLI (`freelance validate ./graphs/`) for CI integration
4. Add Mermaid diagram export (`freelance visualize ./graphs/my-workflow.workflow.yaml`)
5. Package as Claude Code plugin
6. Document configuration for other MCP clients (Cursor, Windsurf, Cline)

### Phase 4: Distribution and analytics (optional)
If the engine proves valuable beyond the team, consider broader distribution.

1. Publish as npm package
2. Add traversal event logging (structured JSON, opt-in)
3. Build analytics: node dwell time, edge frequency, gate failure rates, abandonment points
4. Write example graphs for common workflows (PR review, release management, incident response, onboarding)
5. Open-source with documentation and contributing guide

## Open questions

1. **Multiple concurrent graphs.** Should the engine support traversing two graphs simultaneously (e.g., a development workflow that triggers a deployment workflow mid-task)? Current spec says one graph at a time. The workaround is `freelance_reset` + `freelance_start` to switch, but this loses the first graph's state. Subgraph invocation (a node that starts another graph and resumes when it completes) would solve this cleanly but adds significant complexity. Defer until a concrete use case demands it.

2. **Backtracking.** The current spec doesn't support returning to a previous node without following a defined edge. If the agent or user says "actually, go back," the only path is through edges that happen to point back. For now, design graphs with explicit back-edges where backtracking is expected (the `implement` → `quality-gate` → `implement` loop in the example is already this pattern). A `graph_back` tool could be added later if explicit back-edges prove insufficient.

3. **Context size.** As the agent sets context values throughout a traversal, the context object grows. Every tool response includes the full context. For long workflows with many context keys, this could consume meaningful token budget. Monitor in practice — if it becomes an issue, add a `context.summary` mode that returns only keys that changed since the last call.

4. **Graph hot-reloading.** When a graph definition file changes on disk, in-progress sessions use the stale version (loaded at startup). Per-session state makes this acceptable at small scale. If sessions become very long or graphs change frequently, a `graph_reload` tool or file-watch mechanism could be added.

5. **Human-in-the-loop gates.** Some workflow steps may require human approval. The current spec handles this via context — the agent sets `context.approved = true` after getting human confirmation in the chat. A more robust pattern might involve the engine pausing traversal until an external signal arrives, but this requires an HTTP endpoint or file-watch mechanism, which contradicts the "pure stdio, zero infrastructure" principle. Context-based approval is sufficient for v1.

6. **Parallel branch execution (fork node).** A `fork` node type would allow a node to fan out into multiple concurrent branches that execute independently and rejoin at a gate. Each branch would be a subgraph invocation with isolated context via the existing `contextMap`/`returnMap` machinery. The fork blocks advance on its outgoing edges until all branches reach their terminal nodes, at which point all `returnMap` values merge back into the parent context.

   Proposed schema:
   ```yaml
   fan-out:
     type: fork
     description: "Run categorize and crossref in parallel"
     branches:
       - id: categorize
         subgraph: categorize-branch
         contextMap: { concepts: concepts }
         returnMap: { tags: tags }
       - id: crossref
         subgraph: crossref-branch
         contextMap: { concepts: concepts }
         returnMap: { crossRefsChecked: crossRefsChecked }
     edges:
       - target: store-gate
         label: branches-complete
   ```

   The MCP tool `freelance_advance` would take an optional `branch` parameter to target a specific branch. `freelance_inspect` would show all active branch positions. New statuses: `forked` (entered fork), `branch_advanced` (moved within a branch), `branch_complete` (one branch done, others pending), `fork_complete` (all branches done, fork's outgoing edges available).

   **Why this matters for multi-agent workflows:** When a client can spawn multiple agents per traversal, fork gives the engine the structure to route each agent to a different branch. Each branch has its own sub-stack (supporting nested subgraphs), and context isolation prevents cross-contamination. The join condition is implicit — all branches must reach terminal — so no new expression syntax is needed.

   **Why this is deferred:** With a single sequential agent, fork branches execute via interleaving, not true parallelism. The agent would almost certainly finish one branch before starting the next, which is equivalent to sequential subgraph nodes. The value becomes compelling only when multi-agent orchestration is a real use case. Implementation details are captured in the project's plan archive.
