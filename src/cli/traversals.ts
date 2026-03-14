import { cli, info, fatal, outputJson, EXIT } from "./output.js";
import { DEFAULT_PORT } from "../paths.js";

export function parseDaemonConnect(opts: { connect?: string }): {
  host: string;
  port: number;
} {
  if (!opts.connect) {
    return { host: "127.0.0.1", port: DEFAULT_PORT };
  }

  const lastColon = opts.connect.lastIndexOf(":");
  if (lastColon === -1) {
    // Host only, no port — use default
    return { host: opts.connect, port: DEFAULT_PORT };
  }

  const host = opts.connect.slice(0, lastColon) || "127.0.0.1";
  const portStr = opts.connect.slice(lastColon + 1);
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    fatal(`Invalid port in --connect: "${portStr}"`, EXIT.INVALID_USAGE);
  }
  return { host, port };
}

export async function daemonFetch(
  host: string,
  port: number,
  urlPath: string,
  method: string = "GET"
): Promise<unknown> {
  try {
    const res = await fetch(`http://${host}:${port}${urlPath}`, { method });
    if (!res.ok) {
      const body = await res.text();
      fatal(
        `Daemon returned HTTP ${res.status}: ${body}`,
        EXIT.DAEMON_ERROR
      );
    }
    return await res.json();
  } catch (e) {
    fatal(
      `Failed to connect to daemon at ${host}:${port}: ${(e as Error).message}\n\n  Is the daemon running? Start with: freelance daemon start --graphs <dir>`,
      EXIT.DAEMON_ERROR
    );
  }
}

export async function traversalsList(host: string, port: number): Promise<void> {
  const data = (await daemonFetch(host, port, "/traversals")) as {
    traversals: Array<Record<string, unknown>>;
  };

  if (cli.json) {
    outputJson(data);
    return;
  }

  if (data.traversals.length === 0) {
    info("No active traversals.");
    return;
  }
  for (const t of data.traversals) {
    info(
      `  ${t.traversalId}  ${t.graphId} @ ${t.currentNode}  (depth: ${t.stackDepth}, updated: ${t.lastUpdated})`
    );
  }
}

export async function traversalsInspect(host: string, port: number, id: string): Promise<void> {
  const data = await daemonFetch(host, port, `/traversals/${id}?detail=position`) as Record<string, unknown>;
  if (cli.json) {
    outputJson(data);
  } else {
    info(`Traversal: ${data.traversalId ?? id}`);
    info(`  Graph:   ${data.graphId}`);
    info(`  Node:    ${data.currentNode}`);
    info(`  Depth:   ${data.stackDepth}`);
  }
}

export async function traversalsReset(host: string, port: number, id: string): Promise<void> {
  const data = await daemonFetch(host, port, `/traversals/${id}/reset`, "POST") as Record<string, unknown>;
  if (cli.json) {
    outputJson(data);
  } else {
    info(`Reset traversal ${id}: ${data.status ?? "done"}`);
  }
}
