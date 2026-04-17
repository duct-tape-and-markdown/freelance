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

/**
 * Immediate-child subdirectories of each graphsDir that hold high-churn
 * runtime data (SQLite WAL frames, per-traversal JSON files). Excluded from
 * the watch tree: on Windows, recursive ReadDirectoryChangesW can pin a CPU
 * core when WAL writes flood the internal event buffer. Scoped to direct
 * children only — a nested `memory/` inside a user-authored domain folder
 * is unusual and not special-cased.
 */
const RUNTIME_SUBDIRS: ReadonlySet<string> = new Set(["memory", "traversals"]);

/**
 * Watch directory(ies) for graph file changes and reload on modification.
 *
 * Each graphsDir is watched non-recursively for top-level changes, and each
 * existing immediate subdirectory (except RUNTIME_SUBDIRS) is watched
 * recursively so nested `*.workflow.yaml` files still hot-reload. New
 * top-level subdirs created after startup are armed with a recursive
 * watcher when their creation event lands on the top-level watcher — files
 * created inside a brand-new subdir before that arm completes are not
 * guaranteed to trigger a reload; restart the server to pick them up.
 *
 * Per graph dir:
 *
 *   1. A non-recursive watcher on the dir itself — picks up top-level
 *      config.yml / config.local.yml changes, new *.workflow.yaml files
 *      at the root, and new subdirectory creation events.
 *   2. A recursive watcher per existing non-runtime subdirectory — picks
 *      up nested *.workflow.yaml changes without paying the recursive
 *      cost on the high-churn `memory/` and `traversals/` subtrees.
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

  function scheduleReload() {
    if (graphDebounce) clearTimeout(graphDebounce);
    graphDebounce = setTimeout(reload, debounceMs);
  }

  const watchers: fs.FSWatcher[] = [];
  const watchedSubdirs = new Set<string>();

  function armSubdirWatcher(subdirPath: string) {
    if (watchedSubdirs.has(subdirPath)) return;
    watchedSubdirs.add(subdirPath);
    watchers.push(
      fs.watch(subdirPath, { recursive: true }, (_eventType, filename) => {
        if (filename?.endsWith(".workflow.yaml")) scheduleReload();
      }),
    );
  }

  function handleTopLevel(dir: string, filename: string | null) {
    if (!filename) return;
    if ((filename === "config.yml" || filename === "config.local.yml") && onConfigChange) {
      if (configDebounce) clearTimeout(configDebounce);
      configDebounce = setTimeout(() => onConfigChange(dir), debounceMs);
      return;
    }
    if (filename.endsWith(".workflow.yaml")) {
      scheduleReload();
      return;
    }
    if (RUNTIME_SUBDIRS.has(filename)) return;
    const full = path.join(dir, filename);
    if (watchedSubdirs.has(full)) return;
    try {
      if (!fs.statSync(full).isDirectory()) return;
    } catch {
      return;
    }
    armSubdirWatcher(full);
  }

  for (const dir of dirs) {
    watchers.push(fs.watch(dir, (_eventType, filename) => handleTopLevel(dir, filename)));

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (RUNTIME_SUBDIRS.has(entry.name)) continue;
      armSubdirWatcher(path.join(dir, entry.name));
    }
  }

  return () => {
    if (graphDebounce) clearTimeout(graphDebounce);
    if (configDebounce) clearTimeout(configDebounce);
    for (const w of watchers) w.close();
  };
}
