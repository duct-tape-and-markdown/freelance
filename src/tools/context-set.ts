import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerContextSetTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.registerTool(
    "freelance_context_set",
    {
      description:
        "Update traversal context without advancing to a new node. Use this to record work results (e.g. `{ testsPass: true, coverage: 0.92 }`) so that the next freelance_advance can evaluate edge conditions against the updated state. Returns the refreshed list of valid transitions with conditionMet re-evaluated — so you can see which edges are now unlocked before taking one. Alternative: pass contextUpdates directly to freelance_advance in a single call; use context_set when you want to check which edges open up before committing.",
      inputSchema: {
        traversalId: z.string().optional(),
        updates: z.record(z.string(), z.unknown()),
      },
    },
    ({ traversalId, updates }) => {
      try {
        const id = manager.resolveTraversalId(traversalId);
        return jsonResponse(manager.contextSet(id, updates));
      } catch (e) {
        return handleError(e);
      }
    },
  );
}
