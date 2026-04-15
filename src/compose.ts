/**
 * Composition root for the freelance runtime.
 *
 * Both entry points — the MCP server (`src/server.ts`) and the CLI
 * (`src/cli/setup.ts`) — call `composeRuntime` to wire the same stack:
 * state backend → memory store (optional) → hook runner → traversal
 * store. Anything entry-point-specific (MCP tool registration, CLI
 * argv parsing, file watcher, signal handlers, output rendering) lives
 * in the caller, not here.
 *
 * The Runtime object returned is the sole public surface; callers use
 * it directly rather than reaching back into the individual pieces.
 */

import fs from "node:fs";
import path from "node:path";
import { HookRunner } from "./engine/hooks.js";
import { openDatabase } from "./memory/db.js";
import type { MemoryConfig } from "./memory/index.js";
import { MemoryStore } from "./memory/index.js";
import type { SectionResolver, SourceOptions } from "./sources.js";
import { openStateStore, TraversalStore } from "./state/index.js";
import type { ValidatedGraph } from "./types.js";

/**
 * Build a MemoryStore from a MemoryConfig. Shared by `composeRuntime`
 * and the CLI's `createMemoryStore` helper so the "open the db, build
 * the store" sequence has exactly one site — if we ever add migration
 * or schema-version checks, this is where they go.
 */
export function buildMemoryStore(memConfig: MemoryConfig, sourceRoot: string): MemoryStore {
  return new MemoryStore(openDatabase(memConfig.db), sourceRoot, memConfig.collections);
}

export interface ComposeConfig {
  /** Already-loaded graphs. Callers own loading + reload; compose doesn't touch the filesystem for graph yaml. */
  readonly graphs: Map<string, ValidatedGraph>;
  /**
   * The `.freelance/` directory this runtime is wiring up. Used by the
   * legacy-layout migration helper to detect and rehome a pre-flatten
   * `.state/` subdirectory. Optional — in-memory / ephemeral runtimes
   * and some test paths don't have one; when omitted, migration is
   * skipped.
   */
  readonly graphsDir?: string;
  /** Path to the persistent state dir, or `":memory:"` for an in-process store. */
  readonly stateDir: string;
  /** Resolved source root used for relative source bindings and the memory store. */
  readonly sourceRoot?: string;
  /** Section extraction callback for source bindings. */
  readonly sectionResolver?: SectionResolver;
  /**
   * Memory configuration. Pass `null` (or omit) to leave memory off —
   * user-script onEnter hooks still fire; built-in memory hooks throw
   * loudly at first invocation.
   */
  readonly memory?: MemoryConfig | null;
  readonly maxDepth?: number;
  readonly hookTimeoutMs?: number;
}

export interface Runtime {
  readonly store: TraversalStore;
  readonly memoryStore?: MemoryStore;
  readonly sourceOpts: SourceOptions;
  /**
   * Dispose resources in reverse construction order. Idempotent — safe
   * to call from multiple shutdown paths (signal handlers + finally
   * blocks in CLI commands).
   */
  close(): void;
}

/**
 * Detect a pre-flatten `.state/` subdirectory under `graphsDir` and
 * move its contents up to the new layout:
 *
 *   .state/memory.db{,-shm,-wal}  →  memory/memory.db{,-shm,-wal}
 *   .state/traversals/            →  traversals/
 *   .state/state.db{,-shm,-wal}   →  deleted (vestigial)
 *   .state/                       →  removed when empty
 *
 * Best-effort: if any move fails (permissions, cross-device, target
 * collision), the function logs the failure to stderr and leaves the
 * partial state for the user to handle. A loud migration failure is
 * always preferable to silently mixing layouts.
 */
export function migrateLegacyLayout(graphsDir: string): void {
  const legacyState = path.join(graphsDir, ".state");
  if (!fs.existsSync(legacyState)) return;

  const memoryDir = path.join(graphsDir, "memory");
  const traversalsDir = path.join(graphsDir, "traversals");

  try {
    // Move memory.db + sidecars into memory/
    const memoryFiles = ["memory.db", "memory.db-shm", "memory.db-wal"];
    const anyMemory = memoryFiles.some((f) => fs.existsSync(path.join(legacyState, f)));
    if (anyMemory) {
      fs.mkdirSync(memoryDir, { recursive: true });
      for (const f of memoryFiles) {
        const src = path.join(legacyState, f);
        if (fs.existsSync(src)) fs.renameSync(src, path.join(memoryDir, f));
      }
    }

    // Move traversals/ up one level. If the target already exists
    // (unusual, but possible if a partial migration ran before),
    // merge by moving individual *.json files rather than clobbering.
    const legacyTraversals = path.join(legacyState, "traversals");
    if (fs.existsSync(legacyTraversals)) {
      if (!fs.existsSync(traversalsDir)) {
        fs.renameSync(legacyTraversals, traversalsDir);
      } else {
        for (const entry of fs.readdirSync(legacyTraversals)) {
          fs.renameSync(path.join(legacyTraversals, entry), path.join(traversalsDir, entry));
        }
        fs.rmdirSync(legacyTraversals);
      }
    }

    // Vestigial state.db from the pre-stateless-store era — nothing
    // reads it anymore, safe to delete during migration.
    for (const f of ["state.db", "state.db-shm", "state.db-wal"]) {
      const p = path.join(legacyState, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    // Remove the now-empty .state/ directory.
    const remaining = fs.readdirSync(legacyState);
    if (remaining.length === 0) {
      fs.rmdirSync(legacyState);
    } else {
      process.stderr.write(
        `Freelance: legacy .state/ migration left ${remaining.length} unrecognized ` +
          `file(s) at ${legacyState}: [${remaining.join(", ")}]. Move or delete them manually.\n`,
      );
      return;
    }

    process.stderr.write(
      `Freelance: migrated legacy .state/ layout → ${graphsDir}/{memory,traversals}/\n`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `Freelance: legacy .state/ migration failed — ${msg}. ` +
        `Fix manually by moving .state/memory/ and .state/traversals/ up one level, ` +
        `then delete .state/.\n`,
    );
  }
}

export function composeRuntime(config: ComposeConfig): Runtime {
  if (config.graphsDir) {
    migrateLegacyLayout(config.graphsDir);
  }

  const backend = openStateStore(config.stateDir);

  let memoryStore: MemoryStore | undefined;
  if (config.memory && config.memory.enabled !== false && config.memory.db) {
    if (!config.sourceRoot) {
      throw new Error(
        "composeRuntime: sourceRoot is required when memory is enabled — " +
          "pass sourceRoot in the config so MemoryStore can resolve relative source paths.",
      );
    }
    memoryStore = buildMemoryStore(config.memory, config.sourceRoot);
  }

  const hookRunner = new HookRunner({
    memory: memoryStore,
    hookTimeoutMs: config.hookTimeoutMs,
  });

  const store = new TraversalStore(backend, config.graphs, {
    maxDepth: config.maxDepth,
    hookRunner,
  });

  const sourceOpts: SourceOptions = {
    resolver: config.sectionResolver,
    basePath: config.sourceRoot,
  };

  let closed = false;
  return {
    store,
    memoryStore,
    sourceOpts,
    close() {
      if (closed) return;
      closed = true;
      if (memoryStore) memoryStore.close();
      store.close();
    },
  };
}
