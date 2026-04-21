export const GUIDE_TOPICS = [
  "basics",
  "conventions",
  "gates",
  "cycles",
  "subgraphs",
  "wait-nodes",
  "onenter-hooks",
  "expressions",
  "multi-agent",
  "meta",
  "memory-workflows",
  "anti-patterns",
] as const;

type GuideTopic = (typeof GUIDE_TOPICS)[number];

const GUIDE_CONTENT: Record<GuideTopic, string> = {
  basics: `# Graph Basics

A Freelance graph is a directed graph defined in YAML. Each graph has:

- **id**: unique identifier used in \`freelance start\`
- **startNode**: where traversal begins
- **context**: initial key-value state available throughout the traversal
- **nodes**: the steps of the workflow

## Node types

- **action**: Work happens here. The agent reads instructions, does work, updates context.
- **decision**: A branching point. Edges have conditions evaluated against context.
- **gate**: A checkpoint. All validations must pass before the agent can advance.
- **wait**: Pauses until external conditions are met (human approval, CI, etc).
- **terminal**: End of the graph. No outgoing edges.

## Edges

Every non-terminal node has edges — labeled transitions to other nodes. An edge can have:
- **label**: the name you pass to \`freelance advance\`
- **target**: the destination node
- **condition**: an expression evaluated against context (optional)
- **default**: if true, this edge is taken when no other edge's condition matches

## Context

Context is a key-value store that persists throughout the traversal. Update it with \`freelance context set\` or via \`contextUpdates\` in \`freelance advance\`. Edge conditions and gate validations read from context.

Any node can also declare \`onEnter\` hooks — functions that run automatically on node arrival and pre-populate context from external state (memory, filesystem, APIs) so the agent arrives with what it needs instead of spending a turn fetching it. See the \`onenter-hooks\` topic.

## Typical flow

1. \`freelance status\` — discover available graphs
2. \`freelance start\` — begin a traversal, get first node's instructions
3. Do the work described in the node's instructions
4. \`freelance context set\` — record results
5. \`freelance advance\` — move to next node
6. Repeat until terminal node`,

  conventions: `# Authoring Conventions

Best practices for writing clear, maintainable workflow graphs.

## Instructions: Say What To Do, Not Where To Look

Node instructions describe the action. Source bindings say where to find information. Don't mix them.

**Wrong:** "Read this node's source sections before executing. Check the KB for movement rules."
**Right:** "Check cross-project movement rules." (with source bindings attached)

The agent reads sources automatically. Instructions that say "read the source" or "per KB §X" are redundant noise.

## Context: Gates Enforce, Instructions Don't

Don't put \`Set context.X = value\` in instructions. Context is enforced structurally:

- **Edge conditions** route based on context — the agent sees the conditions and knows what to set
- **Gate validations** block advancement until conditions are met — the agent sees validation messages at node arrival
- **ReturnMaps** define the output contract for subgraphs

If a value matters, enforce it with a gate. If it controls routing, put it in an edge condition. Don't rely on instruction text that the agent might ignore.

### When to add a gate

Add a gate when a context value:
- Controls whether a downstream subgraph or critical node executes
- Is returned to a parent graph via returnMap
- Represents a completion condition for a phase of work

Skip gates for informational context that nothing validates downstream.

## Context Enums

Routing-critical context fields can declare allowed values:

\`\`\`yaml
context:
  trainingPhase:
    type: string
    enum: [base, early-quality, race-specific, taper, recovery]
    default: null
\`\`\`

At load time, \`freelance validate\` checks that edge conditions only compare enum fields against declared values. A condition like \`context.trainingPhase == 'raceSpecific'\` (typo) will be caught statically.

Plain scalar context values (\`count: 0\`, \`done: false\`) continue to work unchanged. Only fields with \`enum\` declarations get static checking.

## Source Paths

Source paths are relative to the **source root**, which defaults to the parent of your \`.freelance/\` directory. If your layout is:

\`\`\`
project/
  .freelance/
    my.workflow.yaml
  docs/
    guide.md
\`\`\`

Then in your graph, reference it as \`path: "docs/guide.md"\` — relative to \`project/\`, not to \`.freelance/\`.

For sibling layouts (workflows separate from codebase), the same rule applies — paths resolve from the parent of the workflows directory. Override with \`--source-root\` if needed.

Use \`freelance sources hash\` to generate hashes. Paths you pass to it are also resolved from the source root.

## Ambient Sources: Graph-Level Knowledge

Use graph-level \`sources\` for foundational knowledge that applies throughout the workflow (quality standards, scope principles, release model). Use node-level sources for step-specific procedural content.

A section should not appear at both levels.

## Dependency Direction

Graphs reference skills as tool providers. Skills never reference graphs. This is a one-way dependency — graph renames don't break skills.

## Atomic Subgraphs: Small But Not Single-Node

Reusable subgraphs should decompose their procedure into distinct steps. One action node + one terminal means the procedure was compressed. If an instruction contains multiple sequential steps with decision points, those should be separate nodes.

## Cycle Requirements

Every cycle must include at least one decision, gate, or wait node. The engine rejects pure action-node cycles to prevent infinite loops.

## Namespace Organization

Organize graphs into subdirectories by domain. File convention: \`{name}.workflow.yaml\`.

## Provenance

Every source binding includes a content hash. Drift detection is built in at three levels:

- **CLI**: \`freelance validate <dir> --sources\` checks all graphs. Add \`--fix\` to restamp drifted hashes in-place.
- \`freelance sources validate\` checks a single graph or all loaded graphs by ID.
- \`freelance sources check\` checks an explicit list of source bindings.

When KB content changes, run validation to surface drift. Review drifted sections for instruction implications before restamping.`,

  gates: `# Gate Nodes

Gates are quality checkpoints. They block advancement until all validations pass.

## How they work

A gate node has a \`validations\` array. Each validation has:
- **expr**: an expression evaluated against context (e.g., \`context.testsPass == true\`)
- **message**: shown to the agent when the validation fails

When the agent calls \`freelance advance\` on a gate node, ALL validations must pass. If any fail, the advance is rejected with the failing messages. The agent must fix the issues and update context before retrying.

## When to use gates

- Before merging code (tests pass, review approved)
- Before deployment (staging verified, rollback plan documented)
- Before advancing past a critical milestone (acceptance criteria met)

## Tips

- Keep validation expressions simple — they read from context, not external systems
- The agent should use \`freelance context set\` to record results before hitting the gate
- Gates with multiple validations enforce ALL conditions simultaneously`,

  cycles: `# Cycles

Cycles let workflows loop — retry on failure, iterate on tasks, collect feedback.

## Rules

Every cycle MUST include at least one decision, gate, or wait node. This prevents infinite action loops where the agent just runs forever without a checkpoint.

## Common patterns

### Fix-and-retry
\`\`\`
build → test (gate) → deploy
         ↓ (fail)
        fix → build
\`\`\`
The gate ensures tests pass. If they fail, the agent loops back to fix.

### Task iteration
\`\`\`
build → build (self-loop via decision)
  ↓
verify
\`\`\`
The build node loops on itself while tasks remain, then advances to verify.

### Review cycle
\`\`\`
implement → review (decision) → implement (changes-requested)
                    ↓ (approved)
                   merge
\`\`\`

## Tips

- Use \`maxTurns\` on action nodes in cycles to prevent runaway loops
- Decision nodes in cycles should have clear, context-based conditions
- Always have an exit condition that the agent can reach`,

  subgraphs: `# Subgraphs

Subgraphs let you compose workflows. A node can push into a child graph, and when the child completes, control returns to the parent.

## How they work

A node with a \`subgraph\` field will push a new graph onto the traversal stack when entered. The child graph runs independently with its own context. When the child reaches a terminal node, it pops off the stack and control returns to the parent node.

## Context passing

- **contextMap**: maps parent context keys to child context keys on entry
- **returnMap**: maps child context keys back to parent context on completion
- **condition**: optional expression — if false, the subgraph is skipped

When field names are the same on both sides, use array shorthand:

\`\`\`yaml
# Shorthand — same name both sides
contextMap: [athlete, date]
returnMap: [approved]

# Object form — names differ
contextMap:
  taskDone: parentTaskDone
returnMap:
  approved: reviewPassed
\`\`\`

## When to use subgraphs

- Reusable workflows (e.g., a "code review" subgraph called from multiple parent graphs)
- Separation of concerns (keep each graph focused on one process)
- Conditional workflows (only enter the subgraph when a condition is met)

## Tips

- Subgraph nesting has a configurable depth limit (default: 5)
- Cross-graph references are validated at load time — no broken links at runtime
- Circular subgraph references are detected and rejected`,

  "wait-nodes": `# Wait Nodes

Wait nodes pause the traversal until external conditions are satisfied.

## How they work

A wait node has a \`waitOn\` array. Each entry specifies:
- **key**: a context key to check
- **type**: expected type (boolean, string, number, etc.)
- **description**: human-readable description of what's needed

The agent cannot advance past a wait node until all waitOn conditions are satisfied. This is useful for human-in-the-loop workflows.

## Timeouts

Wait nodes can have a \`timeout\` field (ISO 8601 duration, e.g., "PT1H" for 1 hour). If the timeout expires, the node transitions to a timed-out state and may allow advancement via a timeout edge.

## Common patterns

- **Human approval**: wait for \`context.approved == true\`
- **CI results**: wait for \`context.ciPassed == true\`
- **External data**: wait for a context key to be populated

## Tips

- Use \`freelance context set\` from outside the agent (or a separate process) to satisfy wait conditions
- Traversal state is persisted to disk, so wait nodes survive CLI invocations and client restarts — the traversal resumes when conditions are met`,

  "onenter-hooks": `# onEnter Hooks

onEnter hooks let a workflow run code automatically on node arrival — **before the agent sees the node**. Use them to populate context from external state (memory store, filesystem, APIs) so the agent arrives with everything it needs for the next step, instead of spending a turn fetching data.

## Schema

\`\`\`yaml
nodes:
  explore:
    type: action
    description: "Investigate the authentication module"
    onEnter:
      - call: memory_status
        args: {}
      - call: ./scripts/read-package.js
        args:
          path: context.targetFile
    instructions: "Use context.total_propositions and context.fileSize to..."
\`\`\`

Each entry in the \`onEnter\` array declares:
- **call**: either a built-in hook name (see the list below) or a relative path to a local script (\`./scripts/foo.js\` or \`../shared/bar.js\`). Absolute paths are rejected.
- **args**: an object of hook arguments. String values that match \`context.foo.bar\` are resolved against live context at invocation time; everything else passes through as a literal.

Hooks run sequentially in the order declared. Each hook's result is merged into context before the next hook fires, so later hooks can read earlier hooks' writes.

## Built-in hooks

Built-in hooks fire automatically on node arrival instead of requiring an agent round-trip. The memory hooks are read-only narrowings over the memory store; none of them mutate state. \`meta_set\` writes traversal meta tags.

- **memory_status**: proposition/entity counts. No args.
- **memory_browse**: page of entities. Args: \`name\`, \`kind\`, \`limit\`, \`offset\` (all optional).
- **memory_search**: FTS5 search over propositions. Args: \`query\` (required), \`limit\` (optional).
- **memory_related**: neighbor entities sharing propositions with one entity. Args: \`entity\` (required).
- **memory_inspect**: full detail (propositions, neighbors, source files) for one entity. Args: \`entity\` (required).
- **memory_by_source**: prior knowledge keyed by source path. Args: \`paths\` (required string array). The hook accepts an array so a single onEnter declaration can fan out over \`context.filesReadPaths\`. Caller-provided lists are capped at 50 paths per call (longer should be a script hook). Returns \`{ priorKnowledgeByPath, priorKnowledgePathsConsidered, priorKnowledgePathsTruncated }\`.
- **meta_set**: tags the traversal with caller-opaque meta key/value pairs. Every arg becomes a meta entry; values must resolve to strings (use \`context.foo\` to pull from live context). Merge semantics — new keys add, existing keys overwrite. See \`freelance guide meta\`.

## Local script hooks

A local script is an ES module with a default-export async function:

\`\`\`js
// .freelance/scripts/read-package.js
import fs from "node:fs";

export default async function ({ args, context, memory, graphId, nodeId }) {
  const content = fs.readFileSync(args.path, "utf-8");
  const pkg = JSON.parse(content);
  return {
    pkgName: pkg.name,
    pkgVersion: pkg.version,
  };
}
\`\`\`

The function receives a \`HookContext\` with:
- **args**: resolved arguments (context paths already dereferenced)
- **context**: live session context, read-only from the hook's perspective
- **memory**: narrow read interface over the memory store. Exposes \`status()\`, \`browse()\`, \`search()\`, \`related()\`, \`inspect()\`, \`bySource()\` — read methods only; \`emit()\` and other write paths stay unreachable. Present only when memory is enabled in the host config. Built-in memory hooks throw a clear error if you call them with memory off.
- **graphId, nodeId**: identifiers for the current position

The returned object is merged into session context via the same path as \`freelance context set\`, so strict-context enforcement applies. Scripts must return a plain object; returning \`undefined\`, \`null\`, an array, or a non-object errors loudly.

Script paths resolve relative to the **graph file's directory**. A hook in \`.freelance/my.workflow.yaml\` with \`call: ./scripts/foo.js\` looks for \`.freelance/scripts/foo.js\`. Missing files fail at graph load time, not at first invocation.

## Execution semantics

- **Timeout**: each hook has a 5000ms default timeout. Configure per-project via \`hooks.timeoutMs\` in \`config.yml\`. On timeout, the hook errors with a clear message and the node arrival fails.
- **Errors**: a throwing hook aborts the node arrival with an \`EngineError\` wrapping the underlying message, the node id, and the hook call. The traversal stays on the previous node.
- **Execution point**: hooks fire AFTER edge-condition evaluation and transitions — i.e., after the engine has decided the agent is arriving at this node, but before the response is built. The agent sees the node's \`validTransitions\` and \`context\` AFTER hooks have run.
- **Validation**: script hooks are imported eagerly by \`freelance validate\` — syntax errors, missing deps, and non-function default exports fail at authoring time, not mid-traversal. The validator never invokes the hook body; it only verifies the module loads and its default export is callable.

## When to use hooks (vs agent-driven context)

**Use a hook when:**
- The data is always needed at this node (not conditional on agent judgment)
- The data comes from deterministic sources (memory, filesystem, well-known APIs)
- Requiring an extra agent round-trip to fetch it would be pure latency with no decision value
- The operation should be invisible in the agent's tool-call history (routine lookups, not reasoning steps)

**Don't use a hook when:**
- The agent needs to REASON about whether/how to fetch the data
- The operation is user-visible or requires consent (writes, external API calls with side effects)
- The result determines routing (put that in an edge condition against context the agent sets)
- The fetch is slow or flaky (blocks node arrival; timeout kills the traversal)

## Trust model

Local script hooks execute with full Node.js privileges in the host process. A \`.workflow.yaml\` that references a local script is trusted code — treat it like a \`package.json\` scripts block. Don't load graphs from untrusted sources.

Operators in shared-graph-registry scenarios (untrusted contributors, multi-agent marketplaces) can set \`FREELANCE_HOOKS_ALLOW_SCRIPTS=0\` in the environment; graph load then rejects every \`onEnter\` entry that resolves to a local script, leaving built-ins as the only runnable hook surface. Default is allowed — the flag is opt-in to stricter handling, not default-deny.

## Tips

- Prefer **one hook per concern** over one hook that does everything. Later hooks read earlier hooks' context writes, so you can compose them.
- **Fail loud**: if a hook can't complete its job, throw. Don't return partial data.
- **Keep hooks short**: they block node arrival. Use them for fast lookups (<100ms typical), not heavy work.
- **Version scripts alongside graphs**: \`.freelance/scripts/\` lives next to the workflows that reference it.`,

  expressions: `# Expressions

Edge conditions (\`condition: "context.x == 'ready'"\`) and gate validations (\`expr: "context.count > 0"\`) use a small expression language. It's deliberately narrow — the grammar is closed and will stay that way.

## What's in the language

- **Literals:** strings (\`'single-quoted'\`), numbers (\`42\`, \`3.14\`), booleans (\`true\`, \`false\`), \`null\`
- **Property access:** \`context.foo\`, \`context.nested.value\` — must start with \`context.\`
- **Comparison:** \`==\`, \`!=\`, \`>\`, \`<\`, \`>=\`, \`<=\`. No type coercion — \`context.x == '5'\` is false when \`x\` is the number \`5\`
- **Logic:** \`&&\`, \`||\`, \`!\`, parentheses for grouping
- **Built-in:** \`len(x)\` — length of arrays and strings; \`0\` for anything else (including null/missing)

## What's not in the language (and won't be)

No arithmetic (\`a + b\`), no string operations (\`startsWith\`, \`contains\`, regex), no array membership (\`x in xs\`), no environment access (\`Date.now()\`, \`process.env\`), no multi-argument functions.

Three rules govern the stop-line (see \`docs/decisions.md\` § "Expression language stop-line"):

1. **Expressions are predicates, not computations.** The evaluator returns boolean. No value transformations.
2. **Built-in functions must be total and side-effect free.** \`len\` qualifies. A function that reads files, calls APIs, or throws on bad input doesn't.
3. **Context is the only data source.** No env vars, no clock, no filesystem. Replaying the same context must yield the same result.

## When you want something that isn't there

The pattern is **derive in a hook, compare in the expression**. If you need \`context.url.startsWith('https://')\`, add an \`onEnter\` hook that computes \`context.isHttps\` and write the edge condition as \`context.isHttps == true\`.

\`\`\`yaml
nodes:
  fetch:
    type: action
    onEnter:
      - call: ./scripts/classify-url.js
        args:
          url: context.url
      # script returns { isHttps: true/false }
    edges:
      - target: secure-path
        condition: "context.isHttps == true"
      - target: insecure-path
        default: true
\`\`\`

This keeps the expression language auditable (every comparison is statically enumerable via \`extractPropertyComparisons\`), keeps the hook surface the place where I/O and derivations live (with timeouts and a trust model — see \`onenter-hooks\`), and keeps edge conditions reproducible from context alone.

## Load-time checks

\`freelance validate\` tokenizes and parses every \`condition\` and \`validations[].expr\`. Syntax errors surface at validate time, not mid-traversal. If a node declares a \`context\` schema with an \`enum\`, comparisons against that field are statically checked against the declared values — a typo like \`context.phase == 'raceSpecific'\` against \`enum: [race-specific, ...]\` fails validation. See the \`conventions\` topic § "Context Enums".`,

  "multi-agent": `# Multi-Agent Workflows

Freelance can coordinate multiple agents working on the same traversal or related traversals. Traversal state lives on disk, so any agent invoking the CLI against the same state directory sees the same traversals.

## Shared traversals

Multiple agents invoking the CLI against the same workflows directory share traversal state through the filesystem. One agent advances the graph while another monitors or contributes context.

## Separate traversals

Each agent can run its own traversal of the same or different graphs.

## Patterns

### Lead + reviewer
One agent does implementation work, another runs a separate review graph that gates the first agent's progress.

### Pipeline handoff
Agent A completes a graph that produces artifacts. Agent B starts a downstream graph consuming those artifacts.

### Parallel tasks
Multiple agents each work on a task from the same plan, updating shared context.

## Tips

- Each agent should specify \`traversalId\` explicitly to avoid ambiguity when multiple traversals are active
- Wait nodes are natural handoff points between agents`,

  meta: `# Meta Tags

\`meta\` is a flat map of opaque string key/value tags attached to a traversal. Freelance never interprets them — meta exists purely so external systems can find a traversal by their own business key (ticket id, PR url, branch, doc path). Think of it as a query index, not workflow state.

## Setting meta

**At start (preferred for primary keys):**

\`\`\`json
{ "graphId": "delivery", "meta": { "externalKey": "DEV-1234" } }
\`\`\`

This is the right place for whatever uniquely identifies what the traversal is *about* — usually the upstream ticket id. Set it once, look it up forever.

**Mid-traversal (for keys that emerge):**

Some lookup keys aren't known at start — a PR url is created during the work, a branch may be picked partway through. Use \`freelance meta set\` to merge new tags in:

\`\`\`json
{ "traversalId": "tr_abc12345", "meta": { "prUrl": "https://github.com/o/r/pull/42" } }
\`\`\`

\`meta_set\` is a merge: new keys are added, existing keys are overwritten.

**Programmatic (workflow-driven via onEnter):**

A node can declare an onEnter hook that tags meta automatically when the agent arrives — no separate tool call needed. The built-in \`meta_set\` hook takes args verbatim as the meta payload, with \`context.foo.bar\` resolved against live context:

\`\`\`yaml
nodes:
  open-pr:
    type: action
    description: "Open the PR"
    onEnter:
      - call: meta_set
        args:
          prUrl: context.prUrl
          branch: context.branch
\`\`\`

Use this when the workflow itself knows when a key becomes available — it removes a turn from the agent's loop.

## Declaring required meta keys

A graph can declare \`requiredMeta\` at the top level to enforce that callers supply certain tags before start succeeds:

\`\`\`yaml
id: delivery
startNode: triage
requiredMeta: [externalKey]
nodes:
  triage: ...
\`\`\`

With that, \`freelance start\` rejects calls that don't pass \`meta.externalKey\` — unless the start node's onEnter hooks set it (meta_set fires before the requiredMeta check, so a hook can satisfy the requirement from context).

Use \`requiredMeta\` for workflows that are meaningless without a specific external binding: ticket-driven delivery workflows, PR-review workflows, document-author workflows. Don't use it for optional tagging — it turns the absence of a tag into a hard error.

## Reading meta back

Every traversal-state response includes meta when set:
- \`freelance status\` — each entry in \`activeTraversals\` carries its meta
- \`freelance inspect\` — meta at the top level of the response
- \`freelance advance\` — meta at the top level of the response

For ambient lookup ("which traversal is DEV-1234?"), call \`freelance status\` and read tags off the entries — Freelance does not provide a server-side filter because the discovery payload is already shaped for the agent to reason over.

## What meta is NOT

- **Not workflow state.** Edge conditions, gate validations, and instructions read from \`context\`, not \`meta\`. If a value drives behavior, put it in context.
- **Not typed.** All values are strings. Store richer values in context and tag a derived key (\`meta.prNumber: "42"\`, not \`meta.pr: { number: 42 }\`).
- **Not enforced by Freelance.** The schema doesn't reserve key names. By convention, use camelCase string keys and prefer stable external identifiers.

## Patterns

### Connect-dev workflows
Set \`externalKey = ticketId\` at start. Subsequent phases of the same ticket can be separate traversals tagged with the same \`externalKey\` — \`freelance status\` will show them all.

### PR-driven workflows
Start with \`externalKey\` only. After the PR is opened, call \`freelance meta set\` to add \`prUrl\` and \`branch\`. External systems can then locate the traversal by any of three keys.

### Multi-key cross-reference
\`meta: { externalKey: "DEV-1234", prUrl: "...", branch: "feat/x" }\` — three independent lookup paths to the same traversal.

## Tips

- **Set the primary key at start.** It signals intent and avoids "tagged later or never?" ambiguity in your data.
- **Treat meta as immutable in spirit.** \`meta_set\` allows overwrites for legitimate updates (renamed branch, replaced PR), but routine workflow logic shouldn't churn meta.
- **Don't duplicate context in meta.** Pick one home per value. Meta is for external lookup; context is for workflow execution.`,

  "memory-workflows": `# Memory Workflows

Freelance ships two sealed workflows that own writes to the knowledge graph. Direct calls to \`memory_emit\` and \`memory_prune\` are gated — they only succeed while a workflow traversal is active. Read tools (\`memory_browse\`, \`memory_inspect\`, \`memory_search\`, \`memory_related\`, \`memory_by_source\`, \`memory_status\`) are always available.

## memory:compile

Read source files, extract atomic claims, and write them to the graph.

**When to use:** building or expanding persistent knowledge about a codebase, design, or reference document. Give it a query that frames what you're compiling (e.g. "how authentication works", "run-sync.js pipeline") and let it read + emit.

**Shape:** three-node loop — \`exploring\` (read source files, delta-check against prior knowledge), \`compiling\` (extract atomic claims, plan entities, emit), \`evaluating\` (check coverage, loop or terminate). onEnter hooks pre-populate entity vocabulary and per-file prior knowledge, so the agent never burns a turn on setup.

**Warm start:** pass \`initialContext: { query, filesReadPaths: [...] }\` to \`freelance start\` so prior knowledge is available on first arrival.

## memory:recall

Query-driven knowledge recall. Searches existing memory, reads provenance sources, fills gaps between what's known and what the sources say.

**When to use:** you have a question that memory *might* answer but coverage is uncertain. Recall inspects existing entities, reads their source files, compares, and emits only gap propositions.

**Shape:** \`recalling\` → \`sourcing\` → \`comparing\` → \`filling\` → \`evaluating\`. Warm-exit edges short-circuit when existing knowledge already covers the query.

## Authoring guidance lives in the workflow nodes

The proposition rubric (atomicity, independence test, relationship exception) and entity guidance (search hubs, reuse existing names) are carried in the \`compiling\` / \`filling\` nodes' instruction prose — not in this guide and not in the tool descriptions. When you land on one of those nodes via \`freelance advance\`, the response's \`node.instructions\` field has the full rubric. Read that at emit time.

## User-authored graphs can also use memory tools

The \`memory_emit\` / \`memory_prune\` gate only checks that *some* traversal is active — not specifically one of the sealed workflows. If you author your own graph that writes to memory, carry your own authoring guidance in your node instructions (or reuse the sealed workflow's via a subgraph push).`,

  "anti-patterns": `# Anti-Patterns

Common mistakes when authoring Freelance graphs.

## Giant monolith graphs
**Problem**: One graph with 30+ nodes covering everything.
**Fix**: Break into focused subgraphs. Each graph should represent one coherent process.

## Missing exit conditions in cycles
**Problem**: A cycle where the agent can never satisfy the exit condition.
**Fix**: Ensure every cycle has a reachable exit. Test with realistic context values.

## Overly strict context
**Problem**: \`strictContext: true\` with too many required keys, forcing the agent to set irrelevant values.
**Fix**: Only use strict context when you need to prevent typos. Keep the required key set minimal.

## Vague node instructions
**Problem**: Instructions say "do the work" without specifics.
**Fix**: Be prescriptive. Name the files, describe the approach, list the acceptance criteria. The agent follows instructions literally.

## Gates that check external state
**Problem**: Gate validation like \`context.ciPassed == true\` but nothing tells the agent HOW to check CI.
**Fix**: Put the "how to check" in the node's instructions. The gate validates context; the instructions tell the agent how to populate it.

## Ignoring maxTurns
**Problem**: Action nodes in cycles without \`maxTurns\`, leading to runaway loops.
**Fix**: Set \`maxTurns\` on any action node that could loop. 50 is a reasonable default.

## Using context as a database
**Problem**: Storing large objects or arrays in context.
**Fix**: Context is for workflow state, not data storage. Store data in files, put references in context.`,
};

export function getGuideTopics(): string[] {
  return [...GUIDE_TOPICS];
}

export function getGuide(topic?: string): { content: string } | { error: string } {
  if (!topic) {
    const catalog = GUIDE_TOPICS.map((t) => `- ${t}`).join("\n");
    return {
      content: `# Freelance Graph Authoring Guide\n\nAvailable topics:\n${catalog}\n\nCall freelance guide with a topic to read it.`,
    };
  }

  if (!GUIDE_TOPICS.includes(topic as GuideTopic)) {
    return { error: `Unknown topic "${topic}". Available: ${GUIDE_TOPICS.join(", ")}` };
  }

  return { content: GUIDE_CONTENT[topic as GuideTopic] };
}
