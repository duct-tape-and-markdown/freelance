import fs from "node:fs";
import path from "node:path";
import { loadGraphsCollecting } from "./loader.js";
import type { CollectingLoadResult } from "./loader.js";
import type { ValidatedGraph } from "./types.js";

export interface WatcherOptions {
  /** Directory or directories containing *.workflow.yaml files */
  graphsDir: string | string[];
  /** Called with new validated graphs on successful reload */
  onUpdate: (graphs: Map<string, ValidatedGraph>) => void;
  /** Called when reload fails (validation error, etc.) */
  onError: (error: Error) => void;
  /** Called with structured load errors when some graphs fail validation */
  onLoadErrors?: (errors: CollectingLoadResult["errors"]) => void;
  /** Called when config.yml changes in any watched directory */
  onConfigChange?: (configPath: string) => void;
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
  const { graphsDir, onUpdate, onError, onLoadErrors, onConfigChange, debounceMs = 200 } = options;
  const dirs = Array.isArray(graphsDir) ? graphsDir : [graphsDir];

  let graphDebounce: ReturnType<typeof setTimeout> | null = null;
  let configDebounce: ReturnType<typeof setTimeout> | null = null;

  function reload() {
    try {
      const { graphs, errors } = loadGraphsCollecting(dirs);
      onUpdate(graphs);
      if (onLoadErrors) {
        onLoadErrors(errors);
      }
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  const watchers = dirs.map((dir) =>
    fs.watch(dir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      if (filename === "config.yml" && onConfigChange) {
        if (configDebounce) clearTimeout(configDebounce);
        configDebounce = setTimeout(() => onConfigChange(path.join(dir, filename)), debounceMs);
      } else if (filename.endsWith(".workflow.yaml")) {
        if (graphDebounce) clearTimeout(graphDebounce);
        graphDebounce = setTimeout(reload, debounceMs);
      }
    })
  );

  return () => {
    if (graphDebounce) clearTimeout(graphDebounce);
    if (configDebounce) clearTimeout(configDebounce);
    for (const w of watchers) w.close();
  };
}
