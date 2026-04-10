export { MemoryStore } from "./store.js";
export { registerMemoryTools } from "./tools.js";
export { openDatabase } from "./db.js";
export type { MemoryConfig, CollectionConfig } from "./types.js";

import type { CollectionConfig } from "./types.js";

/** Parse ignore and collections from a raw memory config object (from config.yml). */
export function parseMemoryOverlay(mem: Record<string, unknown>): { ignore?: string[]; collections?: CollectionConfig[] } {
  const ignore = Array.isArray(mem.ignore) ? mem.ignore as string[] : undefined;
  const collections = Array.isArray(mem.collections)
    ? (mem.collections as Array<Record<string, unknown>>)
        .map((c) => ({
          name: String(c.name ?? ""),
          description: String(c.description ?? ""),
          paths: Array.isArray(c.paths) ? (c.paths as string[]) : [],
        }))
        .filter((c): c is CollectionConfig => c.name.length > 0)
    : undefined;
  return { ignore, collections };
}
