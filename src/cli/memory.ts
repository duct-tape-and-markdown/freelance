/** CLI handlers for memory subcommands. Operates directly on MemoryStore. */

import fs from "node:fs";
import type { MemoryStore } from "../memory/index.js";
import { cli, info, outputJson } from "./output.js";

function handleError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  if (cli.json) {
    outputJson({ error: message });
  } else {
    info(`Error: ${message}`);
  }
  process.exit(1);
}

export function memoryStatus(store: MemoryStore, collection?: string): void {
  try {
    const result = store.status(collection);
    if (cli.json) {
      outputJson(result);
    } else {
      info(
        `Propositions: ${result.total_propositions} total, ${result.valid_propositions} valid, ${result.stale_propositions} stale`,
      );
      info(`Entities: ${result.total_entities}`);
      if (collection) info(`Collection: ${collection}`);
    }
  } catch (e) {
    handleError(e);
  }
}

export function memoryBrowse(
  store: MemoryStore,
  opts?: { name?: string; kind?: string; collection?: string; limit?: string; offset?: string },
): void {
  try {
    const result = store.browse({
      name: opts?.name,
      kind: opts?.kind,
      collection: opts?.collection,
      limit: opts?.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts?.offset ? parseInt(opts.offset, 10) : undefined,
    });
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.entities.length === 0) {
        info("No entities found.");
        return;
      }
      for (const e of result.entities) {
        info(
          `  ${e.name}${e.kind ? ` (${e.kind})` : ""}  ${e.valid_proposition_count} propositions`,
        );
      }
      info(`\n${result.entities.length} entities (total: ${result.total})`);
    }
  } catch (e) {
    handleError(e);
  }
}

export function memoryInspect(store: MemoryStore, entity: string, collection?: string): void {
  try {
    const result = store.inspect(entity, collection);
    if (cli.json) {
      outputJson(result);
    } else {
      info(`Entity: ${result.entity.name}${result.entity.kind ? ` (${result.entity.kind})` : ""}`);
      if (result.propositions.length > 0) {
        info("\nPropositions:");
        for (const p of result.propositions) {
          const status = p.valid ? "" : " [stale]";
          info(`  - ${p.content}${status}`);
        }
      }
      if (result.neighbors && result.neighbors.length > 0) {
        info("\nNeighbors:");
        for (const n of result.neighbors) {
          info(`  ${n.name}${n.kind ? ` (${n.kind})` : ""}`);
        }
      }
    }
  } catch (e) {
    handleError(e);
  }
}

export function memorySearch(
  store: MemoryStore,
  query: string,
  opts?: { collection?: string; limit?: string },
): void {
  try {
    const result = store.search(query, {
      collection: opts?.collection,
      limit: opts?.limit ? parseInt(opts.limit, 10) : undefined,
    });
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.propositions.length === 0) {
        info("No results found.");
        return;
      }
      for (const r of result.propositions) {
        const entities = r.entities.map((e: { name: string }) => e.name).join(", ");
        const status = r.valid ? "" : " [stale]";
        info(`  [${entities}] ${r.content}${status}`);
      }
      info(`\n${result.propositions.length} results`);
    }
  } catch (e) {
    handleError(e);
  }
}

export function memoryRelated(store: MemoryStore, entity: string, collection?: string): void {
  try {
    const result = store.related(entity, collection);
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.neighbors.length === 0) {
        info("No related entities found.");
        return;
      }
      for (const r of result.neighbors) {
        info(`  ${r.name}${r.kind ? ` (${r.kind})` : ""}  shared: ${r.shared_propositions}`);
        if ("sample" in r) info(`    "${(r as { sample: string }).sample}"`);
      }
    }
  } catch (e) {
    handleError(e);
  }
}

export function memoryBySource(store: MemoryStore, filePath: string, collection?: string): void {
  try {
    const result = store.bySource(filePath, collection);
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.propositions.length === 0) {
        info(`No propositions found for ${filePath}.`);
        return;
      }
      for (const p of result.propositions) {
        const status = p.valid ? "" : " [stale]";
        info(`  ${p.content}${status}`);
      }
      info(`\n${result.propositions.length} propositions`);
    }
  } catch (e) {
    handleError(e);
  }
}

export function memoryEmit(store: MemoryStore, file: string, collection: string): void {
  try {
    // Read JSON from file or stdin
    let raw: string;
    if (file === "-") {
      raw = fs.readFileSync(0, "utf-8"); // stdin
    } else {
      raw = fs.readFileSync(file, "utf-8");
    }

    const propositions = JSON.parse(raw) as Array<{
      content: string;
      entities: string[];
      sources: string[];
      entityKinds?: Record<string, string>;
    }>;

    const result = store.emit(propositions, collection);
    if (cli.json) {
      outputJson(result);
    } else {
      info(`Emitted ${result.created} propositions (${result.deduplicated} deduplicated)`);
    }
  } catch (e) {
    handleError(e);
  }
}
