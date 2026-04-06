/**
 * MCP tool registration for Freelance Memory.
 *
 * 7 tools: 3 write (register_source, emit, end), 4 read (browse, inspect, by_source, status).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResponse, errorResponse } from "../mcp-helpers.js";
import type { MemoryStore } from "./store.js";

function handleError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return errorResponse(message);
}

export function registerMemoryTools(server: McpServer, store: MemoryStore): void {
  // --- Write ---

  server.tool(
    "memory_register_source",
    "Register a file as a provenance source. Memory hashes the file and records it in the active session (creating one if needed). Must be called for every file read during compilation — memory_emit requires at least one registered source.",
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
    "Write propositions to memory. Each proposition is a self-contained claim about 1-2 entities, written in natural prose. Deduplicates by content hash. Requires an active session with at least one registered source file.",
    {
      propositions: z.array(z.object({
        content: z.string().min(1).describe("The proposition — a self-contained claim in natural prose"),
        entities: z.array(z.string().min(1)).min(1).max(2).describe("Entity names this proposition is about (1-2)"),
        sources: z.array(z.string().min(1)).min(1).describe("Source file paths this proposition was derived from (relative to source root). Each path must be registered in the active session."),
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

  // --- Read ---

  server.tool(
    "memory_browse",
    "Find entities by name, kind, or partial match. Returns entities with valid proposition counts.",
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
    "Full entity details — valid propositions and source sessions.",
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
    "memory_by_source",
    "All propositions from sessions that included a file. Shows valid and stale.",
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
    "memory_search",
    "Full-text search across proposition content. Returns matching propositions with their entities and validity status. Use FTS5 query syntax: plain words for OR, double-quoted phrases for exact match, prefix* for prefix search. If your search returns no results but you later discover the answer through other means, consider starting the memory:compile workflow to capture what you learned — a search miss is a signal that memory has a gap worth filling.",
    {
      query: z.string().min(1).describe("FTS5 search query (e.g. 'subgraph context', '\"return values\"', 'wait*')"),
      limit: z.number().int().min(1).max(100).default(20).optional(),
    },
    ({ query, limit }) => {
      try {
        return jsonResponse(store.search(query, { limit }));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_status",
    "Total propositions, valid count, stale count, entity count.",
    {},
    () => {
      try {
        return jsonResponse(store.status());
      } catch (e) {
        return handleError(e);
      }
    }
  );
}
