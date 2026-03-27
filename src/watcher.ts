import fs from "node:fs";
import { loadGraphs, loadGraphsLayered } from "./loader.js";
import type { ValidatedGraph } from "./types.js";

export interface WatcherOptions {
  /** Directory or directories containing *.workflow.yaml files */
  graphsDir: string | string[];
  /** Called with new validated graphs on successful reload */
  onUpdate: (graphs: Map<string, ValidatedGraph>) => void;
  /** Called when reload fails (validation error, etc.) */
  onError: (error: Error) => void;
  /** Debounce interval in ms (default: 200) */
  debounceMs?: number;
}

/**
 * Watch directory(ies) for graph file changes and reload on modification.
 *
 * Uses fs.watch with debounce. On any change to *.workflow.yaml files,
 * re-reads all directories, validates, and calls onUpdate.
 *
 * Note: fs.watch behavior varies by platform. On Linux (inotify) it is
 * reliable. On macOS (FSEvents) it may fire duplicate or miss events.
 * The debounce mitigates duplicate fires.
 *
 * Returns a cleanup function that stops watching.
 */
export function watchGraphs(options: WatcherOptions): () => void {
  const { graphsDir, onUpdate, onError, debounceMs = 200 } = options;
  const dirs = Array.isArray(graphsDir) ? graphsDir : [graphsDir];

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function reload() {
    try {
      const graphs = dirs.length === 1
        ? loadGraphs(dirs[0])
        : loadGraphsLayered(dirs);
      onUpdate(graphs);
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  const watchers = dirs.map((dir) =>
    fs.watch(dir, (_eventType, filename) => {
      if (!filename?.endsWith(".workflow.yaml")) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(reload, debounceMs);
    })
  );

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) w.close();
  };
}
