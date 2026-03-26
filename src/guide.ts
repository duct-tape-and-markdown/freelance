export const GUIDE_TOPICS = [
  "basics",
  "gates",
  "cycles",
  "subgraphs",
  "wait-nodes",
  "multi-agent",
  "anti-patterns",
] as const;

export type GuideTopic = (typeof GUIDE_TOPICS)[number];

const GUIDE_CONTENT: Record<GuideTopic, string> = {
  basics: `# Graph Basics

A Freelance graph is a directed graph defined in YAML. Each graph has:

- **id**: unique identifier used in \`freelance_start\`
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
- **label**: the name you pass to \`freelance_advance\`
- **target**: the destination node
- **condition**: an expression evaluated against context (optional)
- **default**: if true, this edge is taken when no other edge's condition matches

## Context

Context is a key-value store that persists throughout the traversal. Update it with \`freelance_context_set\` or via \`contextUpdates\` in \`freelance_advance\`. Edge conditions and gate validations read from context.

## Typical flow

1. \`freelance_list\` — discover available graphs
2. \`freelance_start\` — begin a traversal, get first node's instructions
3. Do the work described in the node's instructions
4. \`freelance_context_set\` — record results
5. \`freelance_advance\` — move to next node
6. Repeat until terminal node`,

  gates: `# Gate Nodes

Gates are quality checkpoints. They block advancement until all validations pass.

## How they work

A gate node has a \`validations\` array. Each validation has:
- **expr**: an expression evaluated against context (e.g., \`context.testsPass == true\`)
- **message**: shown to the agent when the validation fails

When the agent calls \`freelance_advance\` on a gate node, ALL validations must pass. If any fail, the advance is rejected with the failing messages. The agent must fix the issues and update context before retrying.

## When to use gates

- Before merging code (tests pass, review approved)
- Before deployment (staging verified, rollback plan documented)
- Before advancing past a critical milestone (acceptance criteria met)

## Tips

- Keep validation expressions simple — they read from context, not external systems
- The agent should use \`freelance_context_set\` to record results before hitting the gate
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

- Use \`freelance_context_set\` from outside the agent (or a separate process) to satisfy wait conditions
- Wait nodes in daemon mode persist across sessions — the traversal resumes when conditions are met`,

  "multi-agent": `# Multi-Agent Workflows

Freelance can coordinate multiple agents working on the same traversal or related traversals.

## Shared traversals (daemon mode)

When running the daemon, multiple MCP clients can connect via proxy and share traversal state. One agent advances the graph while another monitors or contributes context.

## Separate traversals

Each agent can run its own traversal of the same or different graphs. Use the daemon's traversal management to track them all.

## Patterns

### Lead + reviewer
One agent does implementation work, another runs a separate review graph that gates the first agent's progress.

### Pipeline handoff
Agent A completes a graph that produces artifacts. Agent B starts a downstream graph consuming those artifacts.

### Parallel tasks
Multiple agents each work on a task from the same plan, updating shared context via the daemon.

## Tips

- Use the daemon for multi-agent setups — it provides persistence and shared state
- Each agent should specify \`traversalId\` explicitly to avoid ambiguity
- Wait nodes are natural handoff points between agents`,

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
    return { content: `# Freelance Graph Authoring Guide\n\nAvailable topics:\n${catalog}\n\nCall freelance_guide with a topic to read it.` };
  }

  if (!GUIDE_TOPICS.includes(topic as GuideTopic)) {
    return { error: `Unknown topic "${topic}". Available: ${GUIDE_TOPICS.join(", ")}` };
  }

  return { content: GUIDE_CONTENT[topic as GuideTopic] };
}
