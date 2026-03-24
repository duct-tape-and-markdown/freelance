/**
 * File watcher for Document LSP index refresh.
 *
 * Self-contained — no imports from freelance core.
 */

import { watch } from "chokidar";
import type { DocumentIndexStore } from "./index-builder.js";

export interface WatcherOptions {
  roots: string[];
  index: DocumentIndexStore;
  onUpdate?: (path: string) => void;
  onError?: (err: Error) => void;
}

/**
 * Start watching corpus directories for changes.
 * Returns a stop function.
 */
export function watchCorpora(options: WatcherOptions): () => void {
  const { roots, index, onUpdate, onError } = options;

  const watcher = watch(roots, {
    ignoreInitial: true,
    persistent: true,
    // Watch markdown and json files
    ignored: [
      /(^|[/\\])\../, // dotfiles
      /node_modules/,
    ],
  });

  const handleChange = (filePath: string) => {
    if (!filePath.endsWith(".md") && !filePath.endsWith(".json")) return;
    try {
      index.reindexFile(filePath);
      onUpdate?.(filePath);
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  };

  watcher.on("add", handleChange);
  watcher.on("change", handleChange);
  watcher.on("unlink", handleChange);
  watcher.on("error", (err: unknown) => onError?.(err instanceof Error ? err : new Error(String(err))));

  return () => {
    watcher.close().catch(() => {});
  };
}
