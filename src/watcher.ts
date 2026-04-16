import fs from "node:fs";
import path from "node:path";
import type { CollectingLoadResult } from "./loader.js";
import { loadGraphsCollecting } from "./loader.js";
import type { ValidatedGraph } from "./types.js";

interface WatcherOptions {
  /** Directory or directories containing *.workflow.yaml files */
  graphsDir: string | string[];
  /** Called with new validated graphs on successful reload */
  onUpdate: (graphs: Map<string, ValidatedGraph>) => void;
  /** Called when reload fails (validation error, etc.) */
  onError: (error: Error) => void;
  /** Called with structured load errors when some graphs fail validation */
  onLoadErrors?: (errors: CollectingLoadResult["errors"]) => void;
  /** Called with the directory path when config.yml or config.local.yml changes */
  onConfigChange?: (dir: string) => void;
  /** Debounce interval in ms (default: 200) */
  debounceMs?: number;
}

const CONFIG_FILES = ["config.yml", "config.local.yml"] as const;

/**
 * Watch directory(ies) for graph file changes and reload on modification.
 *
 * Uses fs.watch with debounce. On any change to *.workflow.yaml files,
 * re-reads all directories, validates, and calls onUpdate.
 *
 * Two watchers per graph dir:
 *
 *   1. A recursive directory watcher catches *.workflow.yaml changes
 *      anywhere inside the dir tree.
 *   2. Explicit per-file watchers on `config.yml` and `config.local.yml`
 *      guarantee config reload events regardless of editor save patterns
 *      (atomic rename, temp-file swap) that sometimes drop events on the
 *      recursive parent watch. This is the reliable path for config
 *      changes — the recursive watcher's config branch stays as a
 *      belt-and-suspenders backup.
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

  function scheduleConfigReload(dir: string): void {
    if (!onConfigChange) return;
    if (configDebounce) clearTimeout(configDebounce);
    configDebounce = setTimeout(() => onConfigChange(dir), debounceMs);
  }

  const closers: Array<() => void> = [];

  for (const dir of dirs) {
    // Recursive directory watch — picks up workflow file changes anywhere
    // under the tree, and acts as a backup for config file changes.
    const dirWatcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const base = path.basename(filename);
      if ((base === "config.yml" || base === "config.local.yml") && onConfigChange) {
        scheduleConfigReload(dir);
      } else if (filename.endsWith(".workflow.yaml")) {
        if (graphDebounce) clearTimeout(graphDebounce);
        graphDebounce = setTimeout(reload, debounceMs);
      }
    });
    closers.push(() => dirWatcher.close());

    // Explicit per-file watches on config.yml / config.local.yml. These
    // are the reliable path for config changes — some editor save
    // patterns (atomic rename via temp file, write-then-move) can drop
    // events on the parent directory watch but consistently fire on a
    // direct file watch. If the file doesn't exist yet, skip silently.
    if (onConfigChange) {
      for (const cfgFile of CONFIG_FILES) {
        const cfgPath = path.join(dir, cfgFile);
        try {
          if (!fs.existsSync(cfgPath)) continue;
          const fileWatcher = fs.watch(cfgPath, () => scheduleConfigReload(dir));
          closers.push(() => fileWatcher.close());
        } catch {
          // Non-fatal: if we can't watch a specific config file, the
          // recursive dir watcher still catches most events.
        }
      }
    }
  }

  return () => {
    if (graphDebounce) clearTimeout(graphDebounce);
    if (configDebounce) clearTimeout(configDebounce);
    for (const close of closers) close();
  };
}
