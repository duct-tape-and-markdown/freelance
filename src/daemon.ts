import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { TraversalManager } from "./traversal-manager.js";
import { EngineError } from "./errors.js";
import { getPidFilePath } from "./paths.js";
import { info } from "./cli/output.js";
import { getGuide, getGuideTopics } from "./guide.js";
import { watchGraphs } from "./watcher.js";
import type { ValidatedGraph } from "./types.js";

interface DaemonOptions {
  port: number;
  host: string;
  persistDir: string;
  maxDepth?: number;
  graphsDirs?: string[];
  sourceRoot?: string;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function jsonOk(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

function jsonError(res: http.ServerResponse, message: string, status = 400): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

export function createDaemon(
  graphs: Map<string, ValidatedGraph>,
  options: DaemonOptions
): { server: http.Server; manager: TraversalManager; stopWatcher?: () => void } {
  const manager = new TraversalManager(graphs, {
    maxDepth: options.maxDepth,
    persistDir: options.persistDir,
  });

  // Start file watcher if graphsDirs provided
  let stopWatcher: (() => void) | undefined;
  if (options.graphsDirs?.length) {
    stopWatcher = watchGraphs({
      graphsDir: options.graphsDirs,
      onUpdate: (newGraphs) => {
        manager.updateGraphs(newGraphs);
        const ids = [...newGraphs.keys()];
        info(`Graph reload: ${newGraphs.size} graph(s) (${ids.join(", ")})`);
      },
      onError: (err) => {
        info(`Graph reload failed: ${err.message}`);
      },
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    try {
      // GET /graphs
      if (method === "GET" && pathname === "/graphs") {
        return jsonOk(res, manager.listGraphs());
      }

      // POST /traversals — create
      if (method === "POST" && pathname === "/traversals") {
        const body = JSON.parse(await readBody(req));
        const result = manager.createTraversal(body.graphId, body.initialContext);
        return jsonOk(res, result, 201);
      }

      // GET /traversals — list
      if (method === "GET" && pathname === "/traversals") {
        return jsonOk(res, { traversals: manager.listTraversals() });
      }

      // Match /traversals/:id routes
      const traversalMatch = pathname.match(/^\/traversals\/([^/]+)(\/(.+))?$/);
      if (traversalMatch) {
        const traversalId = traversalMatch[1];
        const action = traversalMatch[3]; // advance, context, reset, or undefined

        // GET /traversals/:id — inspect
        if (method === "GET" && !action) {
          const detail = (url.searchParams.get("detail") ?? "position") as "position" | "full" | "history";
          const result = manager.inspect(traversalId, detail);
          return jsonOk(res, result);
        }

        // POST /traversals/:id/advance
        if (method === "POST" && action === "advance") {
          const body = JSON.parse(await readBody(req));
          const result = manager.advance(traversalId, body.edge, body.contextUpdates);
          if (result.isError) {
            return jsonOk(res, result); // Still 200 — isError is app-level
          }
          return jsonOk(res, result);
        }

        // POST /traversals/:id/context
        if (method === "POST" && action === "context") {
          const body = JSON.parse(await readBody(req));
          const result = manager.contextSet(traversalId, body.updates);
          return jsonOk(res, result);
        }

        // POST /traversals/:id/reset
        if (method === "POST" && action === "reset") {
          const result = manager.resetTraversal(traversalId);
          return jsonOk(res, result);
        }
      }

      // POST /shutdown
      if (method === "POST" && pathname === "/shutdown") {
        jsonOk(res, { status: "shutting_down" });
        server.close(() => process.exit(0));
        return;
      }

      // GET /guide
      if (method === "GET" && pathname === "/guide") {
        const topic = url.searchParams.get("topic") ?? undefined;
        if (!topic) {
          return jsonOk(res, { topics: getGuideTopics() });
        }
        const result = getGuide(topic);
        if ("error" in result) {
          return jsonError(res, result.error);
        }
        return jsonOk(res, result);
      }

      // GET /health
      if (method === "GET" && pathname === "/health") {
        return jsonOk(res, { status: "ok", traversals: manager.listTraversals().length });
      }

      jsonError(res, "Not found", 404);
    } catch (e) {
      if (e instanceof EngineError) {
        return jsonError(res, e.message);
      }
      if (e instanceof SyntaxError) {
        return jsonError(res, `Invalid JSON: ${e.message}`);
      }
      const message = e instanceof Error ? e.message : String(e);
      jsonError(res, `Internal error: ${message}`, 500);
    }
  });

  return { server, manager, stopWatcher };
}

export function writePidFile(port: number, graphsDirs?: string[]): string {
  const pidFile = getPidFilePath();
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const pidData: Record<string, unknown> = { pid: process.pid, port };
  if (graphsDirs?.length) pidData.graphsDirs = graphsDirs;
  fs.writeFileSync(pidFile, JSON.stringify(pidData));
  return pidFile;
}

export function registerShutdownHandlers(
  server: http.Server,
  pidFile: string,
  stopWatcher?: () => void
): void {
  const shutdown = () => {
    info("\nShutting down daemon...");
    if (stopWatcher) stopWatcher();
    server.close(() => {
      try { fs.unlinkSync(pidFile); } catch {}
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function startDaemon(
  graphs: Map<string, ValidatedGraph>,
  options: DaemonOptions
): Promise<void> {
  const { server, stopWatcher } = createDaemon(graphs, options);
  const pidFile = writePidFile(options.port, options.graphsDirs);

  return new Promise<void>((_, reject) => {
    server.listen(options.port, options.host, () => {
      info(`Freelance daemon listening on ${options.host}:${options.port}`);
      info(`PID: ${process.pid}`);
      info(`Persistence: ${options.persistDir}`);
      if (options.graphsDirs?.length) {
        info(`Watching: ${options.graphsDirs.join(", ")}`);
      }
    });

    server.on("error", reject);
    registerShutdownHandlers(server, pidFile, stopWatcher);
  });
}
