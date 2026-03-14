import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function jsonResponse(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function errorResponse(message: string, detail?: unknown) {
  const payload = detail ?? { error: message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true as const,
  };
}

async function daemonRequest(
  host: string,
  port: number,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: host,
      port,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve({ status: res.statusCode ?? 500, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 500, data: { error: raw } });
        }
      });
    });

    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

export function createProxy(daemonHost: string, daemonPort: number): McpServer {
  const server = new McpServer(
    { name: "graph-engine-proxy", version: "0.1.0" },
  );

  async function callDaemon(method: string, path: string, body?: unknown) {
    try {
      const { data } = await daemonRequest(daemonHost, daemonPort, method, path, body);
      const result = data as Record<string, unknown>;
      if (result && result.isError) {
        return errorResponse(String(result.reason ?? result.error), result);
      }
      if (result && result.error) {
        return errorResponse(String(result.error));
      }
      return jsonResponse(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(`Daemon connection error: ${msg}`);
    }
  }

  // graph_list
  server.tool(
    "graph_list",
    "List all available workflow graphs and active traversals.",
    {},
    () => callDaemon("GET", "/graphs")
  );

  // graph_start
  server.tool(
    "graph_start",
    "Begin traversing a workflow graph. Returns a traversalId for subsequent operations.",
    {
      graphId: z.string().min(1),
      initialContext: z.record(z.string(), z.unknown()).optional(),
    },
    ({ graphId, initialContext }) =>
      callDaemon("POST", "/traversals", { graphId, initialContext })
  );

  // graph_advance
  server.tool(
    "graph_advance",
    "Move to the next node by taking a labeled edge. Context updates persist even if the advance fails.",
    {
      traversalId: z.string().optional(),
      edge: z.string().min(1),
      contextUpdates: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ traversalId, edge, contextUpdates }) => {
      const id = traversalId ?? await resolveId(daemonHost, daemonPort);
      if (!id) return errorResponse("No active traversals. Call graph_start first.");
      return callDaemon("POST", `/traversals/${id}/advance`, { edge, contextUpdates });
    }
  );

  // graph_context_set
  server.tool(
    "graph_context_set",
    "Update session context without advancing.",
    {
      traversalId: z.string().optional(),
      updates: z.record(z.string(), z.unknown()),
    },
    async ({ traversalId, updates }) => {
      const id = traversalId ?? await resolveId(daemonHost, daemonPort);
      if (!id) return errorResponse("No active traversals. Call graph_start first.");
      return callDaemon("POST", `/traversals/${id}/context`, { updates });
    }
  );

  // graph_inspect
  server.tool(
    "graph_inspect",
    "Read-only introspection of current graph state.",
    {
      traversalId: z.string().optional(),
      detail: z.enum(["position", "full", "history"]).default("position"),
    },
    async ({ traversalId, detail }) => {
      const id = traversalId ?? await resolveId(daemonHost, daemonPort);
      if (!id) return errorResponse("No active traversals. Call graph_start first.");
      return callDaemon("GET", `/traversals/${id}?detail=${detail}`);
    }
  );

  // graph_reset
  server.tool(
    "graph_reset",
    "Clear a traversal. Requires confirm: true.",
    {
      traversalId: z.string().optional(),
      confirm: z.boolean(),
    },
    async ({ traversalId, confirm }) => {
      if (confirm !== true) {
        return errorResponse("Must pass confirm: true to reset.");
      }
      const id = traversalId ?? await resolveId(daemonHost, daemonPort);
      if (!id) return errorResponse("No active traversals.");
      return callDaemon("POST", `/traversals/${id}/reset`);
    }
  );

  return server;
}

async function resolveId(host: string, port: number): Promise<string | null> {
  try {
    const { data } = await daemonRequest(host, port, "GET", "/traversals");
    const result = data as { traversals?: Array<{ traversalId: string }> };
    const traversals = result.traversals ?? [];
    if (traversals.length === 0) return null;
    if (traversals.length === 1) return traversals[0].traversalId;
    // Multiple — return error will be handled by caller
    return null;
  } catch {
    return null;
  }
}

export async function startProxy(
  daemonHost: string,
  daemonPort: number
): Promise<void> {
  const server = createProxy(daemonHost, daemonPort);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
