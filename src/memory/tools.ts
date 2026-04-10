/**
 * MCP tool registration for Freelance Memory.
 *
 * 9 tools: 3 write (register_source, emit, end), 6 read (browse, inspect, by_source, search, related, status).
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
  const collections = store.getCollections();
  const collectionEnum = z.enum(
    collections.map((c) => c.name) as [string, ...string[]]
  );
  const collectionsNote = `Available collections: ${
    collections.map((c) => `"${c.name}" (${c.paths.join(", ")}) — ${c.description}`).join("; ")
  }.`;

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
    `Write propositions to memory. Each proposition is a self-contained claim about 1-2 entities, written in natural prose. Deduplicates by content hash within a collection. Requires an active session with at least one registered source file. ${collectionsNote}`,
    {
      collection: collectionEnum.describe("Target collection for these propositions"),
      propositions: z.array(z.object({
        content: z.string().min(1).describe("The proposition — a self-contained claim in natural prose"),
        entities: z.array(z.string().min(1)).min(1).max(2).describe("Entity names this proposition is about (1-2)"),
        sources: z.array(z.string().min(1)).min(1).describe("Source file paths this proposition was derived from (relative to source root). Each path must be registered in the active session."),
        entityKinds: z.record(z.string(), z.string()).optional().describe("Map of entity name to kind (e.g. function, class, type, interface, enum). Sets kind on entity creation."),
      })).min(1),
    },
    ({ collection, propositions }) => {
      try {
        return jsonResponse(store.emit(propositions, collection));
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
    `Find entities by name, kind, or partial match. Returns entities with valid proposition counts. Stale entities can be refreshed by re-registering their source files via memory_register_source. ${collectionsNote}`,
    {
      collection: collectionEnum.optional().describe("Collection to filter by (omit for all)"),
      name: z.string().optional().describe("Partial name match (case-insensitive)"),
      kind: z.string().optional().describe("Filter by entity kind"),
      limit: z.number().int().min(1).max(200).default(50).optional(),
      offset: z.number().int().min(0).default(0).optional(),
    },
    ({ collection, name, kind, limit, offset }) => {
      try {
        return jsonResponse(store.browse({ collection, name, kind, limit, offset }));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_inspect",
    `Full entity details — valid propositions, neighbors, and source sessions. Stale propositions can be refreshed by re-registering their source files via memory_register_source. ${collectionsNote}`,
    {
      collection: collectionEnum.optional().describe("Collection to filter by (omit for all)"),
      entity: z.string().min(1).describe("Entity ID or name"),
    },
    ({ collection, entity }) => {
      try {
        return jsonResponse(store.inspect(entity, collection));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_by_source",
    `All propositions from sessions that included a file. Shows valid and stale. ${collectionsNote}`,
    {
      collection: collectionEnum.optional().describe("Collection to filter by (omit for all)"),
      file_path: z.string().min(1).describe("File path (relative to source root or absolute)"),
    },
    ({ collection, file_path }) => {
      try {
        return jsonResponse(store.bySource(file_path, collection));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_search",
    `Full-text search across proposition content. Returns matching propositions with their entities and validity status. Use FTS5 query syntax: plain words for OR, double-quoted phrases for exact match, prefix* for prefix search. If your search returns no results but you later discover the answer through other means, consider starting the memory:compile workflow to capture what you learned — a search miss is a signal that memory has a gap worth filling. ${collectionsNote}`,
    {
      collection: collectionEnum.optional().describe("Collection to filter by (omit for all)"),
      query: z.string().min(1).describe("FTS5 search query (e.g. 'subgraph context', '\"return values\"', 'wait*')"),
      limit: z.number().int().min(1).max(100).default(20).optional(),
    },
    ({ collection, query, limit }) => {
      try {
        return jsonResponse(store.search(query, { limit, collection }));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_related",
    `Show entities related to a given entity via shared propositions. Returns co-occurring entities ranked by connection strength, each with a sample proposition showing the relationship. Use during recall to navigate the knowledge graph without inspecting entities one at a time. ${collectionsNote}`,
    {
      collection: collectionEnum.optional().describe("Collection to filter by (omit for all)"),
      entity: z.string().min(1).describe("Entity ID or name"),
    },
    ({ collection, entity }) => {
      try {
        return jsonResponse(store.related(entity, collection));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  server.tool(
    "memory_status",
    `Total propositions, valid count, stale count, entity count. Optionally scoped to a collection. ${collectionsNote}`,
    {
      collection: collectionEnum.optional().describe("Collection to get status for (omit for aggregate)"),
    },
    ({ collection }) => {
      try {
        return jsonResponse(store.status(collection));
      } catch (e) {
        return handleError(e);
      }
    }
  );
}
