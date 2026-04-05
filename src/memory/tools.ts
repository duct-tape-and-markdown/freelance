/**
 * MCP tool registration for Freelance Memory.
 *
 * Registers memory_* tools on the MCP server instance.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryStore } from "./store.js";

function jsonResponse(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true as const,
  };
}

function handleError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return errorResponse(message);
}

export function registerMemoryTools(server: McpServer, store: MemoryStore): void {
  // --- Write tools ---

  server.tool(
    "memory_begin",
    "Start a memory compilation session. Returns current entity count, valid/stale proposition counts. Must be called before memory_emit or memory_register_source.",
    {},
    () => {
      try {
        return jsonResponse(store.begin());
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_register_source",
    "Register a file as a provenance source for the active session. Freelance hashes the file and records it. Call this for every file read during compilation. Requires an active session (call memory_begin first).",
    {
      file_path: z.string().min(1).describe("Path to the source file (relative to source root or absolute)"),
    },
    ({ file_path }) => {
      try {
        return jsonResponse(store.registerSource(file_path));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_emit",
    "Write atomic propositions to memory. Each proposition is a single, self-contained claim with 1-2 entity references. Deduplicates by content hash. Requires an active session (call memory_begin first).",
    {
      propositions: z.array(z.object({
        content: z.string().min(1).describe("The atomic proposition — one self-contained claim"),
        entities: z.array(z.string().min(1)).min(1).max(2).describe("Entity names this proposition is about (1-2)"),
        relatesTo: z.array(z.string()).optional().describe("IDs of related propositions"),
      })).min(1),
    },
    ({ propositions }) => {
      try {
        return jsonResponse(store.emit(propositions));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_end",
    "Close the active compilation session. Returns stats about propositions emitted, entities referenced, and files registered.",
    {},
    () => {
      try {
        return jsonResponse(store.end());
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // --- Read tools ---

  server.tool(
    "memory_browse",
    "Find entities by name, kind, or partial match. Returns entities with valid proposition counts. Use this to discover what knowledge exists.",
    {
      name: z.string().optional().describe("Partial name match (case-insensitive)"),
      kind: z.string().optional().describe("Filter by entity kind"),
      limit: z.number().int().min(1).max(200).default(50).optional(),
      offset: z.number().int().min(0).default(0).optional(),
    },
    ({ name, kind, limit, offset }) => {
      try {
        return jsonResponse(store.browse({ name, kind, limit, offset }));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_inspect",
    "Full entity details — valid propositions, related entities, source files. Pass an entity ID or name.",
    {
      entity: z.string().min(1).describe("Entity ID or name"),
    },
    ({ entity }) => {
      try {
        return jsonResponse(store.inspect(entity));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_relationships",
    "Find propositions connecting two entities. Shows shared knowledge between two concepts.",
    {
      entity_a: z.string().min(1).describe("First entity (ID or name)"),
      entity_b: z.string().min(1).describe("Second entity (ID or name)"),
    },
    ({ entity_a, entity_b }) => {
      try {
        return jsonResponse(store.relationships(entity_a, entity_b));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_by_source",
    "All propositions from sessions that included a file. Shows both valid and stale propositions with provenance details.",
    {
      file_path: z.string().min(1).describe("File path (relative to source root or absolute)"),
    },
    ({ file_path }) => {
      try {
        return jsonResponse(store.bySource(file_path));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_status",
    "Overview of memory state — total propositions, valid/stale counts, entity count, active session.",
    {},
    () => {
      try {
        return jsonResponse(store.status());
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_gaps",
    "Find planned behavior without matching implementation. Compares propositions sourced from spec/plan files against those sourced from code files. Returns unimplemented plans, unplanned implementations, and matches.",
    {
      specPatterns: z.array(z.string()).optional().describe("File patterns for spec/plan files (SQL LIKE syntax, default: %.md, %.txt, etc.)"),
      implPatterns: z.array(z.string()).optional().describe("File patterns for implementation files (SQL LIKE syntax, default: %.ts, %.js, etc.)"),
    },
    ({ specPatterns, implPatterns }) => {
      try {
        return jsonResponse(store.gaps({ specPatterns, implPatterns }));
      } catch (e) {
        return handleError(e);
      }
    }
  );
}
