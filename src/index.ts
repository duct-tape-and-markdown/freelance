import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGraphs } from "./loader.js";
import { startServer } from "./server.js";
import { startDaemon } from "./daemon.js";
import { startProxy } from "./proxy.js";

const FREELANCE_DIR = ".freelance";
const TRAVERSALS_DIR = path.join(FREELANCE_DIR, "traversals");

function usage(): never {
  console.error(`Usage:
  freelance --graphs <dir> [--validate] [--max-depth <n>]   Standalone MCP server
  freelance mcp --graphs <dir> [--max-depth <n>]            Standalone MCP server
  freelance mcp --connect <host:port>                       MCP proxy to daemon
  freelance daemon --graphs <dir> [--port <n>] [--max-depth <n>]  Start daemon
  freelance daemon stop                                     Stop daemon
  freelance daemon status                                   Daemon status
  freelance traversals list                                 List active traversals
  freelance traversals inspect <id>                         Inspect a traversal
  freelance traversals reset <id>                           Reset a traversal`);
  process.exit(1);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return undefined;
  return args[idx + 1];
}

function parseMaxDepth(args: string[]): number {
  const val = getArg(args, "--max-depth");
  if (!val) return 5;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed) || parsed < 1) {
    console.error("--max-depth must be a positive integer (minimum 1)");
    process.exit(1);
  }
  return parsed;
}

// --- Validate mode ---

function validateMode(graphsDir: string) {
  const resolvedDir = path.resolve(graphsDir);

  if (!fs.existsSync(resolvedDir)) {
    console.error(`Graph directory does not exist: ${resolvedDir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(resolvedDir)
    .filter((f) => f.endsWith(".graph.yaml"));

  if (files.length === 0) {
    console.error(`No *.graph.yaml files found in: ${resolvedDir}`);
    process.exit(1);
  }

  const tmpBase = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "ge-")
  );
  let loaded = 0;
  const errors: string[] = [];

  for (const file of files) {
    const tmpDir = path.join(tmpBase, file);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.copyFileSync(path.join(resolvedDir, file), path.join(tmpDir, file));

    try {
      const graphs = loadGraphs(tmpDir);
      for (const [id, { definition, graph }] of graphs) {
        console.log(
          `  OK  ${definition.name} (id: ${id}, v${definition.version}, ${graph.nodeCount()} nodes)`
        );
        loaded++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`  FAIL  ${file}: ${msg}`);
    }
  }

  console.log(`\nLoaded ${loaded} graph(s), ${errors.length} failed.\n`);

  if (errors.length > 0) {
    console.error("Errors:");
    for (const e of errors) {
      console.error(e);
    }
    process.exit(1);
  }
}

// --- Standalone MCP server ---

async function standaloneMode(graphsDir: string, maxDepth: number) {
  try {
    const graphs = loadGraphs(graphsDir);
    const ids = [...graphs.keys()];
    console.error(
      `Graph Engine: loaded ${graphs.size} graph(s) (${ids.join(", ")}), maxDepth=${maxDepth}`
    );
    await startServer(graphs, { maxDepth });
  } catch (err) {
    console.error(
      "Graph loading failed:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }
}

// --- Daemon commands ---

async function daemonStart(args: string[]) {
  const graphsDir = getArg(args, "--graphs");
  if (!graphsDir) {
    console.error("daemon requires --graphs <directory>");
    process.exit(1);
  }

  const portStr = getArg(args, "--port");
  const port = portStr ? parseInt(portStr, 10) : 7433;
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error("--port must be a valid port number");
    process.exit(1);
  }

  const maxDepth = parseMaxDepth(args);
  const persistDir = path.resolve(TRAVERSALS_DIR);

  try {
    const graphs = loadGraphs(graphsDir);
    const ids = [...graphs.keys()];
    console.error(
      `Freelance daemon: loaded ${graphs.size} graph(s) (${ids.join(", ")})`
    );
    await startDaemon(graphs, {
      port,
      host: "127.0.0.1",
      persistDir,
      maxDepth,
    });
  } catch (err) {
    console.error(
      "Daemon startup failed:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }
}

function daemonStop() {
  const pidFile = path.resolve(FREELANCE_DIR, "daemon.pid");
  if (!fs.existsSync(pidFile)) {
    console.error("No daemon PID file found. Is the daemon running?");
    process.exit(1);
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon (PID ${pid})`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      console.error(`Daemon process (PID ${pid}) not found. Cleaning up PID file.`);
      fs.unlinkSync(pidFile);
    } else {
      console.error(`Failed to stop daemon: ${err.message}`);
    }
    process.exit(1);
  }
}

function daemonStatus() {
  const pidFile = path.resolve(FREELANCE_DIR, "daemon.pid");
  if (!fs.existsSync(pidFile)) {
    console.log("Daemon: not running (no PID file)");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0); // Check if process exists
    console.log(`Daemon: running (PID ${pid})`);
  } catch {
    console.log(`Daemon: not running (stale PID file for ${pid})`);
  }
}

// --- Traversal commands ---

async function traversalsList(args: string[]) {
  const { host, port } = parseDaemonConnect(args);
  try {
    const res = await fetch(`http://${host}:${port}/traversals`);
    const data = await res.json() as { traversals: Array<Record<string, unknown>> };
    if (data.traversals.length === 0) {
      console.log("No active traversals.");
      return;
    }
    for (const t of data.traversals) {
      console.log(
        `  ${t.traversalId}  ${t.graphId} @ ${t.currentNode}  (depth: ${t.stackDepth}, updated: ${t.lastUpdated})`
      );
    }
  } catch (e) {
    console.error(`Failed to connect to daemon at ${host}:${port}: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function traversalsInspect(args: string[]) {
  const id = args.find((a) => a.startsWith("tr_"));
  if (!id) {
    console.error("Usage: freelance traversals inspect <traversalId>");
    process.exit(1);
  }
  const { host, port } = parseDaemonConnect(args);
  try {
    const res = await fetch(`http://${host}:${port}/traversals/${id}?detail=position`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Failed to connect to daemon at ${host}:${port}: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function traversalsReset(args: string[]) {
  const id = args.find((a) => a.startsWith("tr_"));
  if (!id) {
    console.error("Usage: freelance traversals reset <traversalId>");
    process.exit(1);
  }
  const { host, port } = parseDaemonConnect(args);
  try {
    const res = await fetch(`http://${host}:${port}/traversals/${id}/reset`, { method: "POST" });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Failed to connect to daemon at ${host}:${port}: ${(e as Error).message}`);
    process.exit(1);
  }
}

function parseDaemonConnect(args: string[]): { host: string; port: number } {
  const connect = getArg(args, "--connect");
  if (connect) {
    const [host, portStr] = connect.split(":");
    return { host: host || "127.0.0.1", port: parseInt(portStr, 10) || 7433 };
  }
  return { host: "127.0.0.1", port: 7433 };
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0];

if (command === "daemon") {
  const subcommand = args[1];
  if (subcommand === "stop") {
    daemonStop();
  } else if (subcommand === "status") {
    daemonStatus();
  } else {
    // "daemon --graphs ..." or "daemon start --graphs ..."
    const daemonArgs = subcommand === "start" ? args.slice(2) : args.slice(1);
    daemonStart(daemonArgs);
  }
} else if (command === "mcp") {
  const mcpArgs = args.slice(1);
  const connect = getArg(mcpArgs, "--connect");
  if (connect) {
    // Proxy mode
    const [host, portStr] = connect.split(":");
    const daemonHost = host || "127.0.0.1";
    const daemonPort = parseInt(portStr, 10) || 7433;
    console.error(`Graph Engine proxy: connecting to daemon at ${daemonHost}:${daemonPort}`);
    startProxy(daemonHost, daemonPort);
  } else {
    // Standalone mode
    const graphsDir = getArg(mcpArgs, "--graphs");
    if (!graphsDir) {
      console.error("mcp requires --graphs <directory> or --connect <host:port>");
      process.exit(1);
    }
    const maxDepth = parseMaxDepth(mcpArgs);
    standaloneMode(graphsDir, maxDepth);
  }
} else if (command === "traversals") {
  const subcommand = args[1];
  if (subcommand === "list") {
    traversalsList(args.slice(2));
  } else if (subcommand === "inspect") {
    traversalsInspect(args.slice(2));
  } else if (subcommand === "reset") {
    traversalsReset(args.slice(2));
  } else {
    console.error("Usage: freelance traversals <list|inspect|reset>");
    process.exit(1);
  }
} else if (args.includes("--graphs")) {
  // Backward compatible: --graphs flag without subcommand
  const graphsDir = getArg(args, "--graphs");
  if (!graphsDir) usage();
  const maxDepth = parseMaxDepth(args);

  if (args.includes("--validate")) {
    validateMode(graphsDir);
  } else {
    standaloneMode(graphsDir, maxDepth);
  }
} else {
  usage();
}
