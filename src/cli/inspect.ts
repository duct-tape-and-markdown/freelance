import fs from "node:fs";
import path from "node:path";
import { cli, info, outputJson } from "./output.js";
import { TRAVERSALS_DIR } from "../paths.js";
import type { SerializedTraversal } from "../types.js";

export interface InspectOptions {
  oneline: boolean;
}

interface PersistedTraversal {
  traversalId: string;
  graphId: string;
  currentNode: string;
  stackDepth: number;
  lastUpdated: string;
}

function readPersistedTraversals(): PersistedTraversal[] {
  const dir = path.resolve(TRAVERSALS_DIR);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const results: PersistedTraversal[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const data: SerializedTraversal = JSON.parse(raw);

      if (!data.traversalId || !data.stack || data.stack.length === 0) continue;

      const active = data.stack[data.stack.length - 1];
      results.push({
        traversalId: data.traversalId,
        graphId: active.graphId,
        currentNode: active.currentNode,
        stackDepth: data.stack.length,
        lastUpdated: data.lastUpdated,
      });
    } catch {
      // Skip corrupted files
    }
  }

  return results;
}

export function inspect(options: InspectOptions): void {
  const traversals = readPersistedTraversals();

  // Silent exit when nothing to show
  if (traversals.length === 0) return;

  if (cli.json) {
    outputJson({ traversals });
    return;
  }

  if (options.oneline) {
    for (const t of traversals) {
      info(`[Freelance] Active traversal: ${t.traversalId} — ${t.graphId} @ ${t.currentNode}`);
    }
    return;
  }

  // Default: verbose output
  info(`Active traversals (${traversals.length}):\n`);
  for (const t of traversals) {
    info(`  ${t.traversalId}  ${t.graphId} @ ${t.currentNode}  (depth: ${t.stackDepth}, updated: ${t.lastUpdated})`);
  }
}
