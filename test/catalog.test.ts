/**
 * Round-trip test for `freelance catalog --json`.
 *
 * Spawns the compiled CLI and asserts the emitted catalog is
 * bijective with the in-source `ENGINE_ERROR_CODES` table: every
 * `EngineErrorCode` appears exactly once, every entry carries the
 * fields the wire contract requires (`kind`, `exit`, `recoveryVerb`,
 * `recoveryKind`), and the values match what `errorKind`,
 * `mapEngineErrorToExit`, and `RECOVERY` return for the same code.
 *
 * Guards two drift failures at once:
 *   - `catalog()` forgetting a code the catalog type covers
 *   - A new code slipping into `ENGINE_ERROR_CODES` / `RECOVERY`
 *     without `catalog()` being rebuilt against it
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mapEngineErrorToExit } from "../src/cli/output.js";
import {
  ALL_ENGINE_ERROR_CODES,
  type EngineErrorCode,
  errorKind,
  RECOVERY,
} from "../src/error-codes.js";

const BIN = path.resolve(import.meta.dirname, "..", "dist", "bin.js");

const catalogEntrySchema = z.object({
  code: z.enum(ALL_ENGINE_ERROR_CODES),
  kind: z.enum(["blocked", "structural"]),
  exit: z.number().int().min(0),
  recoveryVerb: z.string().nullable(),
  recoveryKind: z.enum(["retry", "fix-context", "report", "clear"]),
});

const catalogSchema = z.object({
  codes: z.array(catalogEntrySchema).min(1),
});

describe("freelance catalog --json — round-trip against ENGINE_ERROR_CODES", () => {
  it("emits every EngineErrorCode exactly once with matching fields", () => {
    const res = spawnSync("node", [BIN, "catalog"], { encoding: "utf-8" });
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);

    const parsed = catalogSchema.safeParse(JSON.parse(res.stdout));
    expect(parsed.success, `zod parse: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.success) throw new Error("unreachable");

    const emitted = new Map<EngineErrorCode, (typeof parsed.data.codes)[number]>();
    for (const entry of parsed.data.codes) {
      expect(emitted.has(entry.code), `duplicate code in catalog: ${entry.code}`).toBe(false);
      emitted.set(entry.code, entry);
    }

    for (const code of ALL_ENGINE_ERROR_CODES) {
      const entry = emitted.get(code);
      expect(entry, `catalog missing code: ${code}`).toBeDefined();
      if (!entry) continue;
      expect(entry.kind).toBe(errorKind(code));
      expect(entry.exit).toBe(mapEngineErrorToExit(code));
      expect(entry.recoveryVerb).toBe(RECOVERY[code].verb);
      expect(entry.recoveryKind).toBe(RECOVERY[code].kind);
    }

    expect(emitted.size).toBe(ALL_ENGINE_ERROR_CODES.length);
  });
});

describe("catalog actionability coherence", () => {
  // The catalog carries three independent actionability signals —
  // `errorKind` (blocked|structural), `exit`, and `recoveryKind` — that
  // a driving skill reads together. Nothing in the `satisfies` checks
  // stops them from contradicting each other; #337 shipped a code
  // (STACK_DEPTH_EXCEEDED) classified `blocked` (= "traversal fine,
  // re-advance") whose recovery said `report` (= "stop"). This test is
  // the enforcement that closes that gap. See docs/decisions.md §
  // "Catalog actionability signals must be coherent".
  it("blocked codes are retryable — never recoveryKind 'report' or 'clear'", () => {
    for (const code of ALL_ENGINE_ERROR_CODES) {
      if (errorKind(code) !== "blocked") continue;
      // `blocked` tells the skill the traversal state is fine and the
      // same operation can proceed once context is fixed (or after a
      // transient retry). `report` (stop) and `clear` (drop a stale
      // pointer) both contradict that — they belong to structural codes.
      expect(
        ["fix-context", "retry"],
        `${code} is errorKind "blocked" but recoveryKind "${RECOVERY[code].kind}" — signals disagree`,
      ).toContain(RECOVERY[code].kind);
    }
  });
});
