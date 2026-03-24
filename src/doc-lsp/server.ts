/**
 * Document LSP MCP server.
 *
 * Standalone MCP server providing 5 read-only structural navigation tools.
 * Self-contained — no imports from freelance core.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DocumentIndexStore } from "./index-builder.js";
import { DocLspTools } from "./tools.js";
import { loadConfig } from "./config.js";
import { watchCorpora } from "./watcher.js";

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

export interface DocLspServerOptions {
  configPath?: string;
  watch?: boolean;
}

export function createDocLspServer(options?: DocLspServerOptions): {
  server: McpServer;
  index: DocumentIndexStore;
  tools: DocLspTools;
  stopWatcher?: () => void;
} {
  const config = loadConfig(options?.configPath);
  const index = new DocumentIndexStore(config);

  const buildResult = index.build();
  process.stderr.write(
    `Document LSP: indexed ${buildResult.documents} documents, ${buildResult.ids} unique IDs\n`
  );
  if (buildResult.errors.length > 0) {
    process.stderr.write(
      `Document LSP warnings:\n${buildResult.errors.map((e) => `  ${e}`).join("\n")}\n`
    );
  }

  const tools = new DocLspTools(index);

  let stopWatcher: (() => void) | undefined;
  if (options?.watch !== false) {
    const roots = index.corpusRoots();
    if (roots.length > 0) {
      stopWatcher = watchCorpora({
        roots,
        index,
        onUpdate: (path) => {
          process.stderr.write(`Document LSP: reindexed ${path}\n`);
        },
        onError: (err) => {
          process.stderr.write(`Document LSP watch error: ${err.message}\n`);
        },
      });
    }
  }

  const server = new McpServer({
    name: "document-lsp",
    version: "1.0.0",
  });

  // doc_resolve
  server.tool(
    "doc_resolve",
    "Resolve a domain-specific identifier (e.g. concern ID, ASVS reference) to its location(s) across the documentation corpus. Returns all files and sections where this ID appears.",
    {
      id: z.string().min(1).describe("The domain-specific identifier to resolve"),
    },
    ({ id }) => {
      try {
        const result = tools.resolve(id);
        if (result.locations.length === 0) {
          return jsonResponse({ ...result, message: `No locations found for ID "${id}"` });
        }
        return jsonResponse(result);
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // doc_section
  server.tool(
    "doc_section",
    "Retrieve the content of a specific section from a document without loading the full file. Returns content, line range, subsections, and a content hash for provenance tracking.",
    {
      path: z.string().min(1).describe("Relative path to the document"),
      section: z.string().min(1).describe("Section identifier or heading text to retrieve"),
    },
    ({ path, section }) => {
      try {
        const result = tools.section(path, section);
        if (!result) {
          return errorResponse(`Section "${section}" not found in "${path}"`);
        }
        return jsonResponse(result);
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // doc_structure
  server.tool(
    "doc_structure",
    "Return the structural outline of a document or corpus without loading content. Shows headings, front-matter, and domain-specific IDs.",
    {
      path: z.string().min(1).describe("Relative path to the document"),
    },
    ({ path }) => {
      try {
        const result = tools.structure(path);
        if (!result) {
          return errorResponse(`Document not found: "${path}"`);
        }
        return jsonResponse(result);
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // doc_dependencies
  server.tool(
    "doc_dependencies",
    "Return what a document depends on and what depends on it. Parsed from front-matter depends_on/depended_on_by fields and cross-referenced across the corpus.",
    {
      path: z.string().min(1).describe("Relative path to the document"),
    },
    ({ path }) => {
      try {
        const result = tools.dependencies(path);
        if (!result) {
          return errorResponse(`Document not found: "${path}"`);
        }
        return jsonResponse(result);
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : String(e));
      }
    }
  );

  // doc_coverage
  server.tool(
    "doc_coverage",
    "Report what exists and what's missing across a documentation corpus. Shows which domain-specific IDs are covered in which document groups and what's missing.",
    {
      scope: z.string().min(1).describe("Corpus name or scope identifier"),
    },
    ({ scope }) => {
      try {
        const result = tools.coverage(scope);
        if (!result) {
          return errorResponse(`No documents found for scope "${scope}"`);
        }
        return jsonResponse(result);
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : String(e));
      }
    }
  );

  return { server, index, tools, stopWatcher };
}

/**
 * Start the Document LSP as a standalone MCP server on stdio.
 */
export async function startDocLspServer(options?: DocLspServerOptions): Promise<void> {
  const { server, stopWatcher } = createDocLspServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    if (stopWatcher) stopWatcher();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
