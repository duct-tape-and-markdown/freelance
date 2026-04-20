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
        "Write propositions to the knowledge graph. Each proposition has content (one atomic claim), 1-4 entities, and at least one source file. Sources are hashed at emit time for per-proposition provenance. Dedup is by normalized content hash (case/whitespace/trailing-punctuation insensitive). Entities resolve exact-name first, then case-insensitive. Gated: requires an active workflow traversal — the workflow's node instructions carry the authoring rubric. See `freelance_guide memory-workflows`.",
      inputSchema: {
        propositions: z
          .array(
            z.object({
              content: z.string().min(1).describe("One atomic factual claim."),
              entities: z
                .array(z.string().min(1))
                .min(1)
                .max(4)
                .describe("Entities this claim is about (1-4 names)."),
              sources: z
                .array(z.string().min(1))
                .min(1)
                .describe("Source file paths (relative to source root)."),
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
        "Find entities by name (partial, case-insensitive), kind, or both. Returns each with total and valid (non-stale) proposition counts. Orphan entities (zero valid props) hidden by default. For proposition-level text search, use memory_search.",
      inputSchema: {
        name: z.string().optional().describe("Partial name match (case-insensitive)"),
        kind: z.string().optional().describe("Filter by entity kind"),
        limit: z.number().int().min(1).max(200).default(50).optional(),
        offset: z.number().int().min(0).default(0).optional(),
        includeOrphans: z
          .boolean()
          .optional()
          .describe("Include entities with zero valid propositions. Default false."),
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
        "Full details for one entity: valid propositions (by creation time), neighbor entities via shared propositions, and source files. Entity resolved by id, then exact name, then case-insensitive name.",
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
        "Return every proposition sourced from a given file path. Includes both valid and stale entries (each flagged). Use to audit what knowledge a file produced — e.g. after editing to see what's now stale, or before deleting to see what depends on it.",
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
        'Full-text search over proposition content via SQLite FTS5, ranked by relevance. Query syntax: plain words are OR\'d, "quoted phrases" match exactly, prefix* matches word prefixes. For entity-level lookup instead of content, use memory_browse.',
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
        "Show entities related to a given one via shared propositions. Two entities are 'related' if at least one proposition names both. Returns neighbors ranked by valid-shared-proposition count, each with a sample proposition showing the relationship in context.",
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
        "Knowledge graph health check: total proposition count, valid (non-stale) count, stale count, total entity count. A high stale count means sources have drifted.",
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
        "Delete proposition_sources rows whose content_hash doesn't match any --keep ref tip or the current working tree. Uses git cat-file to read ref blobs — no branch switching, rebase/squash/amend robust. Unresolvable refs hard-error before touching the db. Manual cleanup only — not wired into memory:compile or memory:recall. Requires an active workflow traversal.",
      inputSchema: {
        keep: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Git refs to preserve (branches, tags, remote refs, SHAs). Rows matching any ref tip are kept.",
          ),
        dryRun: z.boolean().optional().describe("Return the plan without deleting."),
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
        "Clear all propositions and entities from the knowledge graph. Requires confirm: true. Irreversible. Not gated by an active traversal — admin/maintenance operation.",
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
