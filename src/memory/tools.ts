/**
 * MCP tool registration for Freelance Memory.
 *
 * 7 tools: 1 write (emit), 6 read (browse, inspect, by_source, search, related, status).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, jsonResponse } from "../mcp-helpers.js";
import type { MemoryStore } from "./store.js";

function handleError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return errorResponse(message);
}

export function registerMemoryTools(
  server: McpServer,
  store: MemoryStore,
  hasActiveMemoryTraversal?: () => boolean,
): void {
  const TRAVERSAL_REQUIRED =
    "Memory write tools require an active memory workflow traversal. Start a memory:compile or memory:recall traversal first.";

  function requireMemoryTraversal(): string | undefined {
    if (hasActiveMemoryTraversal && !hasActiveMemoryTraversal()) {
      return TRAVERSAL_REQUIRED;
    }
  }

  // --- Write (gated by active memory traversal) ---

  server.tool(
    "memory_emit",
    "Write propositions to the knowledge graph. Each proposition is ONE atomic factual claim in natural prose — single sentence strongly preferred, two max. If you're tempted to use 'and' or 'also' or list multiple facts, split into separate propositions instead. The entities array names every entity the claim is genuinely about: one for 'X does Y' claims, two or more for relationships like 'A depends on B' or 'A was replaced by B via C'. Multi-entity propositions make the graph denser — prefer them for relationship claims, but never pack entities to justify a compound prop. Sources are hashed at emit time and attached per-proposition so staleness can be computed against current file state on every read. Deduplication is by content hash within a collection (emitting the same content twice is a no-op). Entities are resolved by exact name, then case-insensitive name, created if missing; pass entityKinds to tag new entities at creation. Gated: requires an active memory:compile or memory:recall traversal.",
    {
      collection: z.string().min(1).describe("Target collection for these propositions"),
      propositions: z
        .array(
          z.object({
            content: z
              .string()
              .min(1)
              .describe(
                "ONE atomic factual claim in natural prose. Single sentence strongly preferred. If you'd write 'and', 'also', or list multiple facts, emit two propositions instead.",
              ),
            entities: z
              .array(z.string().min(1))
              .min(1)
              .max(4)
              .describe(
                "Every entity the claim is genuinely about (1-4). Use 1 for subject-verb claims; 2+ for relationship claims ('A depends on B', 'A was replaced by B via C'). Multi-entity props make the graph denser via memory_related. Never pack extra entities to justify a compound prop — split the compound instead. >4 usually means the prop is a hub and should be split.",
              ),
            sources: z
              .array(z.string().min(1))
              .min(1)
              .describe(
                "Source file paths this proposition was derived from (relative to source root). Each file is hashed at emit time for per-proposition provenance.",
              ),
            entityKinds: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                "Map of entity name to kind (e.g. function, class, type, interface, enum). Sets kind on entity creation.",
              ),
          }),
        )
        .min(1),
    },
    ({ collection, propositions }) => {
      try {
        const blocked = requireMemoryTraversal();
        if (blocked) return errorResponse(blocked);
        return jsonResponse(store.emit(propositions, collection));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // --- Read ---

  server.tool(
    "memory_browse",
    "Find entities by name (partial, case-insensitive), kind, or both. Returns each entity with its total proposition count and its valid (non-stale) count. Stale propositions happen when source files drift on disk — to refresh, re-run the memory:compile workflow against the changed sources. Use this for 'what entities exist matching X?'; use memory_search instead for 'what propositions mention X?'. Optional collection filter scopes results to one named collection.",
    {
      collection: z.string().optional().describe("Collection to filter by (omit for all)"),
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
    },
  );

  server.tool(
    "memory_inspect",
    "Full details for a single entity: valid propositions about it (ordered by creation time), co-occurring neighbor entities via shared propositions, and the deduped list of source files that produced any of its propositions. Entity can be specified by id, exact name, or case-insensitive name (resolved in that priority). Use source_files to navigate to provenance, or neighbors to explore the knowledge graph sideways. Stale propositions are refreshed by re-running memory:compile against the changed sources. Optional collection filter.",
    {
      collection: z.string().optional().describe("Collection to filter by (omit for all)"),
      entity: z.string().min(1).describe("Entity ID or name"),
    },
    ({ collection, entity }) => {
      try {
        return jsonResponse(store.inspect(entity, collection));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.tool(
    "memory_by_source",
    "Return every proposition whose sources list includes the given file path. Use this to audit what claims a file produced — e.g. after editing a file, see which propositions are now stale and may need re-compilation; or before deleting a file, see what knowledge depends on it. Both valid and stale propositions are included (each has a valid flag). Path may be relative to the source root or absolute. Optional collection filter.",
    {
      collection: z.string().optional().describe("Collection to filter by (omit for all)"),
      filePath: z.string().min(1).describe("File path (relative to source root or absolute)"),
    },
    ({ collection, filePath }) => {
      try {
        return jsonResponse(store.bySource(filePath, collection));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.tool(
    "memory_search",
    "Full-text search across proposition content via SQLite FTS5, ranked by relevance. Returns matching propositions with their entities and validity status. Query syntax: plain words separated by spaces are OR'd; \"double-quoted phrases\" match exact sequences; prefix* matches word prefixes. Use this for 'what propositions mention X?'; use memory_browse instead for 'what entities exist matching X?'. If a search misses but you later discover the answer through other means, that's a signal memory has a gap — consider running memory:compile against the relevant sources to fill it. Optional collection filter.",
    {
      collection: z.string().optional().describe("Collection to filter by (omit for all)"),
      query: z
        .string()
        .min(1)
        .describe("FTS5 search query (e.g. 'subgraph context', '\"return values\"', 'wait*')"),
      limit: z.number().int().min(1).max(100).default(20).optional(),
    },
    ({ collection, query, limit }) => {
      try {
        return jsonResponse(store.search(query, { limit, collection }));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.tool(
    "memory_related",
    "Show entities related to a given one via shared propositions — two entities are 'related' if at least one proposition names both. Returns neighbors ranked by count of valid shared propositions, each with a sample proposition showing the relationship in context. Use this to navigate the knowledge graph sideways during recall: start from a known entity, follow co-occurrences, jump to adjacent concepts without inspecting each entity individually. Optional collection filter.",
    {
      collection: z.string().optional().describe("Collection to filter by (omit for all)"),
      entity: z.string().min(1).describe("Entity ID or name"),
    },
    ({ collection, entity }) => {
      try {
        return jsonResponse(store.related(entity, collection));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.tool(
    "memory_status",
    "Health check for the knowledge graph: total propositions, valid (non-stale) count, stale count, and total entities. Optional collection filter scopes all counts to one named collection (omit for aggregate across all collections). A high stale count means source files have drifted — consider running memory:compile to refresh. A low stale count means memory is current. Useful at session start (how much knowledge is here?), after file edits (what did my changes invalidate?), or before a recall workflow (is this worth querying?).",
    {
      collection: z
        .string()
        .optional()
        .describe("Collection to get status for (omit for aggregate)"),
    },
    ({ collection }) => {
      try {
        return jsonResponse(store.status(collection));
      } catch (e) {
        return handleError(e);
      }
    },
  );
}
