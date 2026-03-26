Read SPEC.md — specifically the "MCP tool surface" section for the six tool definitions, parameter schemas, and response formats.

This is Step 4 of 5 — wiring the MCP server. The engine core (Step 3) does all the work. This step is glue: translate MCP tool calls into engine operations and format the results as MCP tool responses.

## What to build

### MCP server (`src/server.ts`)

Create the MCP server using `@modelcontextprotocol/sdk`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
```

The server:
1. Accepts a `Map<string, ValidatedGraph>` (from the loader)
2. Creates a `GraphEngine` instance
3. Registers six tools with zod schemas for input validation
4. Connects via StdioServerTransport

Export a factory function:

```typescript
export function createServer(graphs: Map<string, ValidatedGraph>): McpServer
```

And a start function:

```typescript
export async function startServer(graphs: Map<string, ValidatedGraph>): Promise<void>
```

### Tool registrations

Register each tool using `server.tool(name, description, schema, handler)`. The description is important — it's what the agent sees in tool discovery.

#### `freelance_list`

- **Description:** "List all available workflow graphs. Call this to discover which graphs are loaded and can be started."
- **Input schema:** empty object (no parameters)
- **Handler:** Call `engine.list()`, return the result as a text content block (JSON stringified).

#### `freelance_start`

- **Description:** "Begin traversing a workflow graph. Must be called before advance, context_set, or inspect. Call freelance_list first to see available graphs."
- **Input schema:** `{ graphId: z.string(), initialContext: z.record(z.unknown()).optional() }`
- **Handler:** Call `engine.start()`. On success, return text content with the result JSON. On `EngineError`, return `isError: true` with the error message.

#### `freelance_advance`

- **Description:** "Move to the next node by taking a labeled edge. Optionally include context updates that are applied before edge evaluation. Context updates persist even if the advance fails."
- **Input schema:** `{ edge: z.string(), contextUpdates: z.record(z.unknown()).optional() }`
- **Handler:** Call `engine.advance()`. This has two failure modes:
  - `EngineError` (thrown) — programming error → return `isError: true` with error message
  - Result with `isError: true` — structured failure (validation/condition) → return `isError: true` with the full result JSON so the agent can see state and recover
  - Success → return text content with result JSON

#### `freelance_context_set`

- **Description:** "Update session context without advancing. Use this to record work results before choosing which edge to take. Returns updated valid transitions with conditionMet evaluated."
- **Input schema:** `{ updates: z.record(z.unknown()) }`
- **Handler:** Call `engine.contextSet()`. On success, return text content. On `EngineError`, return `isError: true`.

#### `freelance_inspect`

- **Description:** "Read-only introspection of current graph state. Use after context compaction to re-orient. Returns current position, valid transitions, and context."
- **Input schema:** `{ detail: z.enum(['position', 'full', 'history']).default('position') }`
- **Handler:** Call `engine.inspect()`. On success, return text content. On `EngineError`, return `isError: true`.

#### `freelance_reset`

- **Description:** "Clear the current traversal. Call this to start over or switch to a different graph. Requires confirm: true as a safety check."
- **Input schema:** `{ confirm: z.boolean() }`
- **Handler:** If `confirm` is not true, return `isError: true` with message "Must pass confirm: true to reset." Otherwise call `engine.reset()`, return text content.

### Response formatting

All successful responses should be returned as:
```typescript
{
  content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
}
```

All error responses:
```typescript
{
  content: [{ type: "text", text: JSON.stringify(errorInfo, null, 2) }],
  isError: true
}
```

For structured engine errors (advance validation/condition failures where `result.isError === true`), include the full result object in the error response — the agent needs the state information to recover.

### Update entry point (`src/index.ts`)

Replace the CLI validation harness with the actual MCP server:

1. Parse `--graphs` argument
2. Call `loadGraphs()` to load and validate graphs
3. If loading fails, print the error to stderr and exit with code 1
4. If loading succeeds, log to stderr: `"Graph Engine: loaded N graphs (id1, id2, ...)"` — log to stderr because stdout is the MCP transport
5. Create and start the MCP server with the loaded graphs

The server should handle graceful shutdown on SIGINT/SIGTERM.

### CLI validation mode

Add a `--validate` flag that runs the old behavior: load graphs, report results, exit. This is useful for CI and debugging without starting the MCP server.

```
freelance mcp --graphs ./graphs/                  # Start MCP server
freelance validate ./graphs/                      # Validate and exit
```

## Tests (`test/server.test.ts`)

Testing an MCP server over stdio is awkward. Instead, test the integration by:

1. Import `createServer` and the MCP SDK's `InMemoryTransport` (or `Client` from `@modelcontextprotocol/sdk/client/index.js`)
2. Create a client-server pair connected via in-memory transport
3. Call tools through the client and verify responses

If the SDK's test utilities don't support this cleanly, an alternative approach: test at the engine level (already done in Step 3) and write a minimal integration test that boots the server, sends a JSON-RPC message via stdin, and reads the response from stdout using child_process.

Write tests for:

### Happy path
- `freelance_list` returns the correct graphs
- `freelance_start` → `freelance_advance` (through a few nodes) → reach terminal
- Verify each response has the expected structure (status, currentNode, validTransitions, context)

### Error handling
- `freelance_start` with invalid graphId → isError response
- `freelance_advance` before starting → isError response
- `freelance_advance` with gate validation failure → isError response with full state
- `freelance_context_set` before starting → isError response
- `freelance_reset` without confirm: true → isError response
- `freelance_reset` with confirm: true → success, then `freelance_start` works again

### Response structure
- All success responses have `content` array with text type
- All error responses have `isError: true`
- JSON in text content is valid and parseable

## What NOT to build

- No changes to the engine, evaluator, or loader
- No graph composition (Phase 3)
- No CLI analytics or visualization

## Quality checks

1. `npm run build` — compiles cleanly
2. `npm test` — all 98 previous tests still pass, new server tests pass
3. `node dist/index.js --graphs test/fixtures/ --validate` — validates and exits
4. `node dist/index.js --graphs test/fixtures/` — starts MCP server (blocks waiting for stdio input, ctrl+c to exit) — verify it logs the loaded graph count to stderr