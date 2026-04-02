Read SPEC.md — specifically the "MCP tool surface" section (for behavior contracts), "Engine internals" (for session state shape), and the two example graphs (for how context, edges, validations, and node types interact).

This is Step 3 of 5 — session state management and the traversal engine. This builds the core logic that the MCP tools will wrap in Step 4. No MCP layer yet — everything is tested via direct function calls.

## What to build

### Engine class (`src/engine.ts`)

Create a `GraphEngine` class that holds loaded graphs and manages a single session.

```typescript
export class GraphEngine {
  constructor(graphs: Map<string, ValidatedGraph>)
  
  // Core operations — these map 1:1 to the MCP tools
  list(): GraphListResult
  start(graphId: string, initialContext?: Record<string, unknown>): StartResult
  advance(edge: string, contextUpdates?: Record<string, unknown>): AdvanceResult
  contextSet(updates: Record<string, unknown>): ContextSetResult
  inspect(detail: 'position' | 'full' | 'history'): InspectResult
  reset(): ResetResult
}
```

#### `list()`
Returns an array of `{ id, name, version, description }` for all loaded graphs. Always succeeds. Can be called whether or not a traversal is active.

#### `start(graphId, initialContext?)`
- Throws `EngineError` if graphId not found
- Throws `EngineError` if a traversal is already active (must reset first)
- Creates a new session state:
  - Sets `currentNode` to the graph's `startNode`
  - Initializes context from the graph's default context, with `initialContext` overrides merged on top
  - Initializes empty history and sets turnCount to 0
- Returns the current node info, instructions, suggested tools, valid transitions with `conditionMet` evaluated, and context

#### `advance(edge, contextUpdates?)`

This is the most complex operation. The order matters:

1. Throw `EngineError` if no traversal active
2. **Apply context updates first** (if provided). These persist regardless of whether the advance succeeds.
3. **Check validations on the current node.** If any validation fails, return an error result (NOT a throw — this is a structured failure the agent should see). Include: current node, failure reason, valid transitions with conditionMet, and current context.
4. **Find the edge** by label on the current node. If no edge matches, throw `EngineError`.
5. **Evaluate the edge's condition** (if it has one). If the condition is false, return a structured error: the edge exists but its condition isn't met. Include valid transitions with conditionMet so the agent can pick a different edge.
6. **If the edge has no condition, or the condition is true:** advance.
   - Record the transition in history (previous node, edge label, timestamp, context snapshot)
   - Set `currentNode` to the edge's target
   - Reset `turnCount` to 0
   - If the new node is terminal, set status to "complete" and include the traversal history
7. Return the new node info, instructions, suggested tools, valid transitions with conditionMet, and context

**Critical distinction:** Validation failures and condition failures are structured error *results* (with `isError: true` in the result object), not thrown exceptions. The agent needs to see the full state to recover. Thrown `EngineError` exceptions are for programming errors (no traversal active, edge label doesn't exist).

#### `contextSet(updates)`
- Throw `EngineError` if no traversal active
- If the graph has `strictContext: true`, throw `EngineError` if any update key doesn't exist in the graph's declared context schema
- Merge updates into session context
- Increment `turnCount`
- If the current node has `maxTurns` and `turnCount >= maxTurns`, include a `turnWarning` in the result
- Return current node, updated context, valid transitions with conditionMet, turnCount, and turnWarning (or null)

#### `inspect(detail)`
- Throw `EngineError` if no traversal active
- `"position"` (default): current node info, instructions, suggested tools, valid transitions with conditionMet, context, turnCount, turnWarning
- `"history"`: traversal history array + context history (which keys were set at which nodes)
- `"full"`: the complete graph definition (all nodes, all edges, metadata) — for debugging/visualization

#### `reset()`
- Clears session state
- Returns the previous graph ID and node (for confirmation), or a message if no traversal was active
- Idempotent — calling reset with no active traversal is not an error

### Helper: conditionMet evaluation

Every response that includes `validTransitions` must evaluate each edge's condition against the current context and include `conditionMet: boolean`. Edges with no condition always have `conditionMet: true`. Edges with a `default: true` flag have `conditionMet: true` only when no other conditional edge on the same node has `conditionMet: true`.

Extract this into a helper function that takes a node's edges + context and returns the enriched transitions array. This will be called from start, advance, contextSet, and inspect.

### Error types (`src/errors.ts`)

```typescript
// Programming errors — thrown as exceptions
export class EngineError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'EngineError';
  }
}

// Codes: NO_TRAVERSAL, TRAVERSAL_ACTIVE, GRAPH_NOT_FOUND, 
//        EDGE_NOT_FOUND, STRICT_CONTEXT_VIOLATION
```

### Result types (`src/types.ts`)

Add result types to the existing types file. Each result type should have a `status` field and an `isError` boolean (false for success, true for validation/condition failures). Design these to be directly serializable as MCP tool responses — Step 4 should be thin glue.

## Tests (`test/engine.test.ts`)

Use the valid fixture graphs from Step 1 (valid-simple and valid-branching). Load them via `loadGraphs`, pass the map to `new GraphEngine(graphs)`.

### list()
- Returns both loaded graphs with correct id, name, version, description
- Works before and after starting a traversal

### start()
- Starting a valid graph returns the start node with correct info
- Context is initialized with graph defaults
- initialContext overrides merge correctly
- Starting with unknown graphId throws EngineError (GRAPH_NOT_FOUND)
- Starting while a traversal is active throws EngineError (TRAVERSAL_ACTIVE)

### advance() — happy path
- Advance through the simple graph from start to terminal
- Verify each advance returns the correct new node
- Verify history builds up correctly
- Terminal node sets status to "complete" and includes traversal history

### advance() — context updates persist on failure
- Set up a state where a gate validation will fail
- Call advance with contextUpdates AND an edge that will be blocked by the validation
- Verify the contextUpdates were applied (context changed) even though the advance failed
- Verify the result has isError: true with the validation message

### advance() — gate enforcement
- Arrive at a gate node
- Try to advance without setting the required context → isError with validation message
- Set the context to satisfy validations
- Advance succeeds

### advance() — conditional edges
- Arrive at a decision node with conditional edges
- Set context to match one condition
- Advance with that edge → succeeds
- Try to advance with an edge whose condition is false → isError

### advance() — default edges
- At a node with conditional edges + one default edge
- When no conditional edge has conditionMet → default edge is available (conditionMet: true)
- When a conditional edge matches → default edge has conditionMet: false

### contextSet()
- Updates context correctly
- Returns valid transitions with conditionMet updated based on new context
- Increments turnCount
- When turnCount reaches maxTurns, result includes turnWarning
- With strictContext: true, rejects unknown keys with EngineError

### inspect()
- "position" returns current node, context, transitions
- "history" returns traversal history with timestamps and context snapshots
- "full" returns the complete graph definition
- All throw EngineError when no traversal is active

### reset()
- Clears state, returns previous graph/node info
- After reset, start() works again
- Reset with no active traversal returns gracefully (no error)
- After reset, advance/contextSet/inspect throw NO_TRAVERSAL

### conditionMet evaluation
- Edges with no condition → conditionMet: true
- Edges with true condition → conditionMet: true
- Edges with false condition → conditionMet: false
- Default edge → conditionMet: true only when no sibling conditional edge is met

## What NOT to build

- No MCP server wiring (Step 4)
- No changes to the evaluator (Step 2)
- No changes to the loader (Step 1)
- The engine imports from loader, evaluator, and types — it's the integration layer

## Quality checks

1. `npm run build` — compiles cleanly
2. `npm test` — all previous tests still pass (loader: 8, evaluator: 57), all new engine tests pass
3. The engine has no MCP SDK imports — it's pure business logic