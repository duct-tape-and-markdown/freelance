/**
 * MCP tool registration for Freelance Memory.
 *
 * 7 tools: 1 write (emit), 6 read (browse, inspect, by_source, search, related, status).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, jsonResponse } from "../mcp-helpers.js";
import { prune } from "./prune.js";
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
        "Write propositions to the knowledge graph. Each proposition is one atomic claim with 1-4 entities and at least one source file. Deduped by normalized content hash. Requires an active workflow traversal. See `freelance_guide memory-tools` for authoring rules.",
      inputSchema: {
        propositions: z
          .array(
            z.object({
              content: z.string().min(1).describe("One atomic factual claim."),
              entities: z
                .array(z.string().min(1))
                .min(1)
                .max(4)
                .describe("Entities this claim is about (1-4). Reuse existing names verbatim."),
              sources: z
                .array(z.string().min(1))
                .min(1)
                .describe("Source file paths (relative to source root). Hashed at emit time."),
              entityKinds: z
                .record(z.string(), z.string())
                .optional()
                .describe("Map of entity name to kind (e.g. function, class, module)."),
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
        "Find entities by name (partial, case-insensitive) or kind. Returns proposition counts per entity. Orphans hidden by default. For proposition-level text search, use memory_search.",
      inputSchema: {
        name: z.string().optional().describe("Partial name match (case-insensitive)"),
        kind: z.string().optional().describe("Filter by entity kind"),
        limit: z.number().int().min(1).max(200).default(50).optional(),
        offset: z.number().int().min(0).default(0).optional(),
        includeOrphans: z
          .boolean()
          .optional()
          .describe("Include entities with no valid propositions. Default false."),
      },
    },
    ({ name, kind, limit, offset, includeOrphans }) => {
      try {
        return jsonResponse(store.browse({ name, kind, limit, offset, includeOrphans }));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.registerTool(
    "memory_inspect",
    {
      description:
        "Full details for one entity: valid propositions, neighbor entities, and source files. Resolve by id, exact name, or case-insensitive name.",
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
        "Return propositions sourced from a given file path. Shows both valid and stale entries. Use to audit what knowledge a file produced.",
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
        "Full-text search across propositions via FTS5, ranked by relevance. For entity-level lookup, use memory_browse. See `freelance_guide memory-tools` for query syntax.",
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
        "Show entities related to a given one via shared propositions. Returns neighbors ranked by shared proposition count with a sample proposition each.",
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
        "Knowledge graph health check: total/valid/stale proposition counts and entity count.",
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
    "memory_prune",
    {
      description:
        "Delete stale proposition_sources whose content_hash doesn't match any --keep ref tip or working tree. Uses git cat-file — no branch switching. Requires an active workflow traversal.",
      inputSchema: {
        keep: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Git refs to preserve (branches, tags, SHAs). Rows matching any ref tip are kept.",
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe("If true, return the plan without deleting anything."),
      },
    },
    ({ keep, dryRun }) => {
      try {
        const blocked = requireMemoryTraversal();
        if (blocked) return errorResponse(blocked);
        return jsonResponse(prune(store, { keep, dryRun }));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  server.registerTool(
    "memory_reset",
    {
      description:
        "Clear all propositions and entities from the knowledge graph. Requires confirm: true. Irreversible.",
      inputSchema: {
        confirm: z.boolean().describe("Must be true to proceed."),
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
