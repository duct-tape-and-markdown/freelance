import fs from "node:fs";
import path from "node:path";
import { loadGraphs, loadGraphsLayered } from "./loader.js";
import type { ValidatedGraph } from "./types.js";

export interface WatcherOptions {
  /** Directory or path-delimiter-separated directories containing *.graph.yaml files */
  graphsDir: string;
  /** Called with new validated graphs on successful reload */
  onUpdate: (graphs: Map<string, ValidatedGraph>) => void;
  /** Called when reload fails (validation error, etc.) */
  onError: (error: Error) => void;
  /** Debounce interval in ms (default: 200) */
  debounceMs?: number;
}

/**
 * Watch one or more directories for graph file changes and reload on modification.
 *
 * The graphsDir string may contain multiple directories separated by the
 * platform path delimiter (`:` on Unix, `;` on Windows).
 *
 * Uses fs.watch with debounce. On any change to *.graph.yaml files,
 * re-reads all directories, validates, and calls onUpdate.
 *
 * Returns a cleanup function that stops watching.
 */
export function watchGraphs(options: WatcherOptions): () => void {
  const { graphsDir, onUpdate, onError, debounceMs = 200 } = options;

  // Split on platform delimiter to support multiple directories
  const dirs = graphsDir.split(path.delimiter).filter((d) => d.length > 0);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function reload() {
    try {
      const graphs = dirs.length === 1 ? loadGraphs(dirs[0]) : loadGraphsLayered(dirs);
      onUpdate(graphs);
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // Watch each directory individually
  const watchers: fs.FSWatcher[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (!filename?.endsWith(".graph.yaml")) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(reload, debounceMs);
      });
      watchers.push(watcher);
    } catch {
      // Directory may not be watchable — skip silently
    }
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) w.close();
  };
}
