/**
 * CLI handlers for memory subcommands — JSON-only machine surface.
 *
 * Runtime verbs under `freelance memory ...` are the primary execution
 * path for the Claude Agent Skill per `docs/decisions.md` § "CLI is the
 * primary execution surface". There is no human audience — every
 * handler writes structured JSON to stdout and exits with a semantic
 * code (see `EXIT` in output.ts).
 */

import fs from "node:fs";
import { EC, EngineError } from "../errors.js";
import { EmitBatchSchema } from "../memory/emit-schema.js";
import type { MemoryStore } from "../memory/index.js";
import type { PropositionShape } from "../memory/types.js";
import { CliExit, EXIT, errorEnvelope, outputJson } from "./output.js";

export const SHAPES = ["minimal", "full"] as const satisfies readonly PropositionShape[];

export function memoryStatus(store: MemoryStore): void {
  outputJson(store.status());
}

export function memoryBrowse(
  store: MemoryStore,
  opts?: {
    name?: string;
    kind?: string;
    limit?: number;
    offset?: number;
    includeOrphans?: boolean;
  },
): void {
  const result = store.browse({
    name: opts?.name,
    kind: opts?.kind,
    limit: opts?.limit,
    offset: opts?.offset,
    includeOrphans: opts?.includeOrphans,
  });
  outputJson(result);
}

export function memoryInspect(
  store: MemoryStore,
  entity: string,
  opts?: { limit?: number; offset?: number; shape?: PropositionShape },
): void {
  outputJson(
    store.inspect(entity, {
      limit: opts?.limit,
      offset: opts?.offset,
      shape: opts?.shape,
    }),
  );
}

export function memorySearch(
  store: MemoryStore,
  query: string,
  opts?: { limit?: number; shape?: PropositionShape; includeOrphans?: boolean },
): void {
  outputJson(
    store.search(query, {
      limit: opts?.limit,
      shape: opts?.shape,
      includeOrphans: opts?.includeOrphans,
    }),
  );
}

export function memoryRelated(
  store: MemoryStore,
  entity: string,
  opts?: { limit?: number; offset?: number },
): void {
  outputJson(
    store.related(entity, {
      limit: opts?.limit,
      offset: opts?.offset,
    }),
  );
}

export function memoryBySource(
  store: MemoryStore,
  filePath: string,
  opts?: { limit?: number; offset?: number; shape?: PropositionShape; includeOrphans?: boolean },
): void {
  outputJson(
    store.bySource(filePath, {
      limit: opts?.limit,
      offset: opts?.offset,
      shape: opts?.shape,
      includeOrphans: opts?.includeOrphans,
    }),
  );
}

export function memoryEmit(store: MemoryStore, file: string): void {
  const raw = file === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(file, "utf-8");
  const source = file === "-" ? "stdin" : file;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new EngineError(`${source} must contain valid JSON: ${msg}`, EC.INVALID_EMIT_JSON);
  }

  // Zod at the boundary — the engine trusts `EmitProposition[]`, so
  // shape validation has to live here or a malformed JSON payload
  // (null sources, string entities, missing content, top-level
  // non-array) becomes a generic TypeError mid-emit.
  const shapeResult = EmitBatchSchema.safeParse(parsed);
  if (!shapeResult.success) {
    const issues = shapeResult.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new EngineError(
      `${source} does not match the EmitProposition shape:\n${issues}`,
      EC.INVALID_EMIT_SHAPE,
    );
  }

  outputJson(store.emit(shapeResult.data));
}

export function memoryPrune(
  store: MemoryStore,
  opts: { keep?: string[]; dryRun?: boolean; confirm?: boolean },
): void {
  if (!opts.keep || opts.keep.length === 0) {
    throw new EngineError("memory prune requires --keep <ref> (repeatable).", EC.MISSING_KEEP);
  }

  // `--dry-run` is itself a no-op preview; otherwise require explicit
  // `--confirm`. Return the plan + an explicit refusal when neither
  // flag is set, so the skill sees the blast radius before committing.
  const confirmed = opts.dryRun || opts.confirm;
  const result = store.prune({ keep: opts.keep, dryRun: !confirmed });
  if (confirmed) {
    outputJson(result);
    return;
  }
  // Dual payload — the plan + the refusal envelope in one response.
  // `EngineError` can't carry the plan, so throw a `CliExit` that
  // `runCliHandler` unwraps into the combined stdout payload + exit.
  throw new CliExit(
    {
      ...result,
      ...errorEnvelope(EC.CONFIRM_REQUIRED, "Refusing to delete without --confirm or --dry-run."),
      commandName: "memory prune",
    },
    EXIT.INVALID_INPUT,
  );
}

/**
 * Delete memory.db + WAL/SHM sidecars. Safe because memory is
 * content-addressable: the next run rebuilds everything on demand.
 * Requires `--confirm` as a deliberate guard against accidents.
 *
 * Takes a `dbPath` rather than a `MemoryStore` on purpose — this is the
 * one memory verb that deliberately does NOT go through
 * `createMemoryStore`/`runMemoryVerb` (#266). It is the schema-incompat
 * recovery path: opening the store would run `checkSchemaCompatibility`
 * and reject the very file the operator is trying to delete (the
 * canonical "I upgraded Freelance and my old memory.db has the wrong
 * schema" case). The path is resolved open-coded at the wiring instead.
 */
export function memoryReset(dbPath: string, opts: { confirm?: boolean }): void {
  if (!opts.confirm) {
    throw new EngineError(
      "memory reset requires --confirm (destructive: deletes memory.db + sidecars).",
      EC.CONFIRM_REQUIRED,
      { envelopeSlots: { commandName: "memory reset" } },
    );
  }
  const targets = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
  const deleted: string[] = [];
  for (const f of targets) {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      deleted.push(f);
    }
  }
  outputJson({ status: "reset", deleted, dbPath });
}
