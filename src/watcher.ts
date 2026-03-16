import fs from "node:fs";
import { loadGraphs, validateCrossGraphRefs } from "./loader.js";
import type { ValidatedGraph } from "./types.js";

export interface WatcherOptions {
  /** Directory containing *.graph.yaml files */
  graphsDir: string;
  /** Called with new validated graphs on successful reload */
  onUpdate: (graphs: Map<string, ValidatedGraph>) => void;
  /** Called when reload fails (validation error, etc.) */
  onError: (error: Error) => void;
  /** Debounce interval in ms (default: 200) */
  debounceMs?: number;
}

/**
 * Watch a directory for graph file changes and reload on modification.
 *
 * Uses fs.watch with debounce. On any change to *.graph.yaml files,
 * re-reads the entire directory, validates, and calls onUpdate.
 *
 * Note: fs.watch behavior varies by platform. On Linux (inotify) it is
 * reliable. On macOS (FSEvents) it may fire duplicate or miss events.
 * The debounce mitigates duplicate fires.
 *
 * Returns a cleanup function that stops watching.
 */
export function watchGraphs(options: WatcherOptions): () => void {
  const { graphsDir, onUpdate, onError, debounceMs = 200 } = options;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function reload() {
    try {
      const graphs = loadGraphs(graphsDir);
      validateCrossGraphRefs(graphs);
      onUpdate(graphs);
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  const watcher = fs.watch(graphsDir, (eventType, filename) => {
    // Only react to graph files
    if (!filename?.endsWith(".graph.yaml")) return;

    // Debounce: coalesce rapid changes into a single reload
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reload, debounceMs);
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };
}
