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
    "Memory write tools require an active workflow traversal. Start a workflow (memory:compile, memory:recall, or any user-authored graph) first.";

  function requireMemoryTraversal(): string | undefined {
    if (hasActiveMemoryTraversal && !hasActiveMemoryTraversal()) {
      return TRAVERSAL_REQUIRED;
    }
  }

  // --- Write (gated by active memory traversal) ---

  server.registerTool(
    "memory_emit",
    {
      description:
        "Write propositions to the knowledge graph. Each proposition is one atomic factual claim. Apply the independence test: if either half of a candidate claim could be true while the other is false, it's two propositions, not one. Exception: relationship claims like 'A depends on B' — the edge IS the knowledge; atomizing them destroys graph connectivity. The entities array names every entity the claim is about (1-4): one for subject-verb claims, multiple for relationships. Sources are required, hashed at emit time, and attached per-proposition for drift detection. Dedup is by normalized content hash — same claim with varying case or trailing punctuation is a no-op. Entities resolve by exact then case-insensitive name. Gated: requires an active workflow traversal — start one first.",
      inputSchema: {
        propositions: z
          .array(
            z.object({
              content: z
                .string()
                .min(1)
                .describe(
                  "One atomic factual claim. If either half could be true while the other is false, emit two propositions instead. Exception: relationship claims ('A depends on B') — keep the edge intact.",
                ),
              entities: z
                .array(z.string().min(1))
                .min(1)
                .max(4)
                .describe(
                  "Every entity the claim is about (1-4). One for subject-verb claims; two or more for relationships. Multi-entity props drive graph density via shared edges — reuse existing entity names verbatim where they apply.",
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
    },
    ({ propositions }) => {
      try {
        const blocked = requireMemoryTraversal();
        if (blocked) return errorResponse(blocked);
        return jsonResponse(store.emit(propositions));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // --- Read ---

  server.registerTool(
    "memory_browse",
    {
      description:
        "Find entities by name (partial, case-insensitive), kind, or both. Returns each entity with its total proposition count and its valid (non-stale) count. Stale propositions happen when source files drift on disk — to refresh, re-run the memory:compile workflow against the changed sources. Use this for 'what entities exist matching X?'; use memory_search instead for 'what propositions mention X?'.",
      inputSchema: {
        name: z.string().optional().describe("Partial name match (case-insensitive)"),
        kind: z.string().optional().describe("Filter by entity kind"),
        limit: z.number().int().min(1).max(200).default(50).optional(),
        offset: z.number().int().min(0).default(0).optional(),
      },
    },
    ({ name, kind, limit, offset }) => {
      try {
        return jsonResponse(store.browse({ name, kind, limit, offset }));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.registerTool(
    "memory_inspect",
    {
      description:
        "Full details for a single entity: valid propositions about it (ordered by creation time), co-occurring neighbor entities via shared propositions, and the deduped list of source files that produced any of its propositions. Entity can be specified by id, exact name, or case-insensitive name (resolved in that priority). Use source_files to navigate to provenance, or neighbors to explore the knowledge graph sideways. Stale propositions are refreshed by re-running memory:compile against the changed sources.",
      inputSchema: {
        entity: z.string().min(1).describe("Entity ID or name"),
      },
    },
    ({ entity }) => {
      try {
        return jsonResponse(store.inspect(entity));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.registerTool(
    "memory_by_source",
    {
      description:
        "Return every proposition whose sources list includes the given file path. Use this to audit what claims a file produced — e.g. after editing a file, see which propositions are now stale and may need re-compilation; or before deleting a file, see what knowledge depends on it. Both valid and stale propositions are included (each has a valid flag). Path may be relative to the source root or absolute.",
      inputSchema: {
        filePath: z.string().min(1).describe("File path (relative to source root or absolute)"),
      },
    },
    ({ filePath }) => {
      try {
        return jsonResponse(store.bySource(filePath));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.registerTool(
    "memory_search",
    {
      description:
        "Full-text search across proposition content via SQLite FTS5, ranked by relevance. Returns matching propositions with their entities and validity status. Query syntax: plain words separated by spaces are OR'd; \"double-quoted phrases\" match exact sequences; prefix* matches word prefixes. Use this for 'what propositions mention X?'; use memory_browse instead for 'what entities exist matching X?'. If a search misses but you later discover the answer through other means, that's a signal memory has a gap — consider running memory:compile against the relevant sources to fill it.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("FTS5 search query (e.g. 'subgraph context', '\"return values\"', 'wait*')"),
        limit: z.number().int().min(1).max(100).default(20).optional(),
      },
    },
    ({ query, limit }) => {
      try {
        return jsonResponse(store.search(query, { limit }));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.registerTool(
    "memory_related",
    {
      description:
        "Show entities related to a given one via shared propositions — two entities are 'related' if at least one proposition names both. Returns neighbors ranked by count of valid shared propositions, each with a sample proposition showing the relationship in context. Use this to navigate the knowledge graph sideways during recall: start from a known entity, follow co-occurrences, jump to adjacent concepts without inspecting each entity individually.",
      inputSchema: {
        entity: z.string().min(1).describe("Entity ID or name"),
      },
    },
    ({ entity }) => {
      try {
        return jsonResponse(store.related(entity));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.registerTool(
    "memory_status",
    {
      description:
        "Health check for the knowledge graph: total propositions, valid (non-stale) count, stale count, and total entities. A high stale count means source files have drifted — consider running memory:compile to refresh. A low stale count means memory is current. Useful at session start (how much knowledge is here?), after file edits (what did my changes invalidate?), or before a recall workflow (is this worth querying?).",
      inputSchema: {},
    },
    () => {
      try {
        return jsonResponse(store.status());
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.registerTool(
    "memory_reset",
    {
      description:
        "Clear all propositions and entities from the knowledge graph. Operates on the live database handle — safe to call while the MCP is running (no split-brain from deleting files on disk). Requires confirm: true as a guard against accidental resets. Not gated by an active traversal — this is an admin/maintenance operation.",
      inputSchema: {
        confirm: z
          .boolean()
          .describe("Must be true to proceed — deliberate guard against accidents"),
      },
    },
    ({ confirm }) => {
      if (confirm !== true) {
        return errorResponse("Must pass confirm: true to reset.");
      }
      try {
        const result = store.resetAll();
        return jsonResponse({
          status: "reset",
          ...result,
        });
      } catch (e) {
        return handleError(e);
      }
    },
  );
}
