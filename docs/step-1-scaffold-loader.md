Read SPEC.md first — it's the authoritative spec for this project.

You are building the Graph Engine: a domain-agnostic, YAML-defined, graph-traversal MCP server. This is Step 1 of 5 — project scaffold, graph loader, and structural validation. No MCP tools yet.

## Project setup

Initialize a TypeScript Node.js project:

- Package name: `graph-engine`
- TypeScript with strict mode, ES2022 target, NodeNext module resolution
- Output to `dist/`
- Dependencies: `@modelcontextprotocol/sdk`, `js-yaml`, `ajv`, `@dagrejs/graphlib`
- Dev dependencies: `typescript`, `@types/node`, `@types/js-yaml`, `vitest` (test runner)
- Add `type: "module"` to package.json
- Scripts: `build`, `dev` (ts-node or tsx), `test` (vitest)
- Entry point: `src/index.ts`
- Add a `.gitignore` (node_modules, dist)

## What to build

### 1. Graph YAML schema (`src/schema/`)

Create a JSON Schema (as a TypeScript object exported for ajv) that validates graph definition YAML files. The schema must enforce:

- Required top-level fields: `id` (string), `version` (string), `name` (string), `description` (string), `startNode` (string)
- Optional: `context` (object, any keys), `strictContext` (boolean, default false)
- `nodes` — object where keys are node IDs, each node has:
  - Required: `type` (enum: action, decision, gate, terminal), `description` (string)
  - Optional: `instructions` (string), `suggestedTools` (array of strings), `maxTurns` (integer, minimum 1)
  - Optional: `validations` — array of objects with `expr` (string) and `message` (string)
  - Required for non-terminal: `edges` — array of edge objects
  - Edge object: `target` (string, required), `label` (string, required), `condition` (string, optional), `description` (string, optional), `default` (boolean, optional)

Also create TypeScript types that mirror this schema: `GraphDefinition`, `NodeDefinition`, `EdgeDefinition`, `ValidationRule`. Put types in `src/types.ts`.

### 2. Graph loader (`src/loader.ts`)

Export a function: `loadGraphs(directory: string): Map<string, ValidatedGraph>`

It should:
1. Glob all `*.graph.yaml` files from the directory
2. Parse each with `js-yaml`
3. Validate each against the JSON Schema using `ajv`
4. For each valid graph, build a `@dagrejs/graphlib` Graph and run structural validation:
   a. All edge targets point to defined nodes
   b. `startNode` exists and is defined in nodes
   c. All non-terminal nodes have at least one outgoing edge
   d. Terminal nodes have zero outgoing edges
   e. No orphan nodes — all nodes reachable from startNode (use `alg.preorder` or equivalent)
   f. Gate nodes have at least one validation
   g. Cycles are allowed but must include at least one decision or gate node (no pure action→action loops)
5. Return a Map of graphId → validated graph data (the parsed definition + the graphlib graph)
6. On any validation failure: throw a descriptive error with the file path, node ID, and specific issue

`ValidatedGraph` is a type holding the parsed `GraphDefinition` plus the graphlib `Graph` instance.

### 3. Entry point (`src/index.ts`)

For now, just a CLI that:
1. Accepts a `--graphs` argument (directory path)
2. Calls `loadGraphs` on that directory
3. Logs the loaded graphs (id, name, node count) on success
4. Exits with error code 1 on validation failure, printing the error

This will become the MCP server entry point later. For now it's just a validation harness.

### 4. Test graphs (`test/fixtures/`)

Create these test fixture files:

**`valid-simple.graph.yaml`** — A minimal valid graph: 3 nodes (start → work → done), one action, one gate with a validation, one terminal. Include a context with one key.

**`valid-branching.graph.yaml`** — A graph with a decision node that branches into two paths that reconverge at a gate. Include conditional edges. Include a cycle (the gate can send back to an action node on failure).

**`invalid-orphan.graph.yaml`** — A graph with an unreachable node. Should fail validation.

**`invalid-missing-target.graph.yaml`** — A graph where an edge targets a node that doesn't exist. Should fail validation.

**`invalid-terminal-with-edges.graph.yaml`** — A terminal node that has outgoing edges. Should fail validation.

**`invalid-gate-no-validations.graph.yaml`** — A gate node with no validations array. Should fail validation.

**`invalid-action-loop.graph.yaml`** — A cycle of only action nodes (no decision/gate in the loop). Should fail validation.

### 5. Tests (`test/loader.test.ts`)

Write vitest tests:
- `loadGraphs` successfully loads the valid fixtures and returns the correct graph count
- Each invalid fixture produces a descriptive error (test the error message contains the relevant node ID or issue)
- The returned `ValidatedGraph` has the correct node count, edge count, and graph structure

## What NOT to build yet

- No MCP server setup (just the entry point CLI)
- No expression evaluator (that's Step 2)
- No session state management
- No tool implementations

## Quality checks

After building everything:
1. Run `npm run build` — must compile cleanly with zero errors
2. Run `npm test` — all tests must pass
3. Run `node dist/index.js --graphs test/fixtures/` — should load the 2 valid graphs and report them, ignoring the invalid ones (or: load all and report errors for invalids — your call on UX, but it should be clear what happened)