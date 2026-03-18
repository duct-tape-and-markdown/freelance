/**
 * HTTP client for communicating with the Freelance daemon.
 * Used by the dashboard TUI for polling and actions.
 */

export interface DaemonClientOptions {
  host: string;
  port: number;
}

export interface GraphInfo {
  id: string;
  name: string;
  version: string;
  description: string;
}

export interface TraversalSummary {
  id: string;
  graphId: string;
  graphName: string;
  graphVersion: string;
  status: string;
  currentNode: string;
  nodeType: string;
  startedAt: string;
  updatedAt: string;
  nodeCount: number;
  visitedNodes: number;
}

export interface TraversalDetail {
  traversalId: string;
  graphId: string;
  currentNode: string;
  node: {
    type: string;
    description: string;
    instructions?: string;
  };
  validTransitions: Array<{
    label: string;
    target: string;
    condition?: string;
    description?: string;
    conditionMet: boolean;
  }>;
  context: Record<string, unknown>;
  history?: Array<{
    from: string;
    edge: string;
    to: string;
    timestamp: string;
  }>;
  graph?: {
    id: string;
    name: string;
    version: string;
    description: string;
    nodes: Record<string, { type: string; description: string; edges?: Array<{ target: string; label: string }> }>;
  };
}

export interface HealthResponse {
  status: string;
  traversals: number;
}

export class DaemonConnectionError extends Error {
  constructor(host: string, port: number) {
    super(`Cannot connect to daemon at ${host}:${port}. Is it running?\n  Start with: freelance daemon start`);
    this.name = "DaemonConnectionError";
  }
}

export class DaemonClient {
  private baseUrl: string;

  constructor(private options: DaemonClientOptions) {
    this.baseUrl = `http://${options.host}:${options.port}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new DaemonConnectionError(this.options.host, this.options.port);
    }

    const data = await response.json() as T & { error?: string };
    if (!response.ok && data.error) {
      throw new Error(data.error);
    }
    return data;
  }

  async health(): Promise<HealthResponse> {
    return this.request("GET", "/health");
  }

  async listGraphs(): Promise<GraphInfo[]> {
    const data = await this.request<{ graphs: GraphInfo[] }>("GET", "/graphs");
    return data.graphs;
  }

  async listTraversals(): Promise<TraversalSummary[]> {
    const data = await this.request<{ traversals: TraversalSummary[] }>("GET", "/traversals");
    return data.traversals;
  }

  async inspectTraversal(id: string, detail: "position" | "full" | "history" = "full"): Promise<TraversalDetail> {
    return this.request("GET", `/traversals/${id}?detail=${detail}`);
  }

  async startTraversal(graphId: string, initialContext?: Record<string, unknown>): Promise<{ traversalId: string }> {
    return this.request("POST", "/traversals", { graphId, initialContext });
  }

  async resetTraversal(id: string): Promise<{ status: string }> {
    return this.request("POST", `/traversals/${id}/reset`);
  }

  async contextSet(id: string, updates: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/traversals/${id}/context`, { updates });
  }

  async advance(id: string, edge: string, contextUpdates?: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/traversals/${id}/advance`, { edge, contextUpdates });
  }
}
