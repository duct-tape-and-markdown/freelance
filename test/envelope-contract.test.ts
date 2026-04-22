/**
 * Wire-level contract for the CLI error envelope.
 *
 * Every CLI-surface failure reaches stdout as
 *   { isError: true, error: { code, message, kind, ...context } }
 * where `code` is an `EngineErrorCode` from `src/error-codes.ts`,
 * `kind` is derived via `errorKind`, and the exit code matches
 * `mapEngineErrorToExit(code)`. This test spawns the compiled CLI
 * against args guaranteed to fail, Zod-parses the envelope on
 * stdout, and asserts the contract holds for a diverse slice of
 * codes. One case per reproducible code — novel envelope-shape
 * regressions (missing `kind`, `error.code` drifting to a string,
 * exit code divorced from the catalog) surface here before they
 * reach the downstream skill.
 *
 * Scope clarifications baked into PR B:
 * - `validate` has its own success envelope ({valid, graphs,
 *   errors}) and does not surface GRAPH_STRUCTURE_INVALID through
 *   the isError envelope — that code is asserted by loader unit
 *   tests, not here.
 * - `error.hook` (populated by PR D when a hook throws) and
 *   `AMBIGUOUS_TRAVERSAL.candidates` / `CONFIRM_REQUIRED.commandName`
 *   (PR C) are left as `test.todo` so the contract checks land with
 *   PR B without blocking on peer work.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EXIT, mapEngineErrorToExit } from "../src/cli/output.js";
import {
  ALL_ENGINE_ERROR_CODES,
  ENGINE_ERROR_CODES,
  type EngineErrorCode,
} from "../src/error-codes.js";

const BIN = path.resolve(import.meta.dirname, "..", "dist", "bin.js");
const FIXTURES = path.resolve(import.meta.dirname, "fixtures");

const BLOCKED_CODES: ReadonlySet<EngineErrorCode> = new Set(ENGINE_ERROR_CODES.BLOCKED);

const envelopeSchema = z
  .object({
    isError: z.literal(true),
    error: z
      .object({
        code: z.enum(ALL_ENGINE_ERROR_CODES),
        message: z.string().min(1),
        kind: z.enum(["blocked", "structural"]),
        hook: z
          .object({
            name: z.string(),
            nodeId: z.string(),
            phase: z.literal("onEnter"),
            index: z.number(),
          })
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, stdin?: string): CliResult {
  const res = spawnSync("node", [BIN, ...args], {
    cwd,
    encoding: "utf-8",
    input: stdin,
    // The CLI resolves `.freelance/` from cwd; spawn each case in a
    // fresh tmp directory so unrelated on-disk state (active
    // traversals, memory.db) can't leak into assertions. HOME points
    // at the same tmp dir so `~/.freelance` doesn't back-door state
    // in either.
    env: { ...process.env, HOME: cwd },
  });
  return {
    exitCode: res.status ?? 0,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

function assertEnvelope(
  result: CliResult,
  expectedCode: EngineErrorCode,
): z.infer<typeof envelopeSchema> {
  expect(result.stdout, `stdout was empty; stderr: ${result.stderr}`).toBeTruthy();
  const parsed = envelopeSchema.safeParse(JSON.parse(result.stdout));
  expect(parsed.success, `envelope failed zod parse: ${JSON.stringify(parsed)}`).toBe(true);
  if (!parsed.success) throw new Error("unreachable");
  expect(parsed.data.error.code).toBe(expectedCode);
  expect(result.exitCode).toBe(mapEngineErrorToExit(expectedCode));
  const expectedKind = BLOCKED_CODES.has(expectedCode) ? "blocked" : "structural";
  expect(parsed.data.error.kind).toBe(expectedKind);
  return parsed.data;
}

describe("CLI error envelope — wire-level contract", () => {
  let tmpDir: string;

  // Build a project-shaped scaffold: `.freelance/` with a minimal
  // graph so `composeRuntime` resolves a source root. Without this,
  // every verb that instantiates the runtime fails with INTERNAL
  // (MEMORY_UNRESOLVED_SOURCE_ROOT on memory verbs) before it ever
  // reaches the code we're trying to probe.
  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "envelope-contract-")));
    const freelanceDir = path.join(tmpDir, ".freelance");
    fs.mkdirSync(freelanceDir, { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES, "valid-simple.workflow.yaml"),
      path.join(freelanceDir, "valid-simple.workflow.yaml"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("TOPIC_NOT_FOUND — freelance guide <bogus>", () => {
    const result = runCli(["guide", "bogus-topic"], tmpDir);
    assertEnvelope(result, "TOPIC_NOT_FOUND");
  });

  it("FILE_NOT_FOUND — freelance visualize <missing-file>", () => {
    const result = runCli(["visualize", path.join(tmpDir, "nope.yaml")], tmpDir);
    assertEnvelope(result, "FILE_NOT_FOUND");
  });

  it("NO_TRAVERSAL — freelance inspect with no active traversal", () => {
    const result = runCli(["inspect"], tmpDir);
    assertEnvelope(result, "NO_TRAVERSAL");
  });

  it("GRAPH_NOT_FOUND — freelance start <unknown-graph>", () => {
    const result = runCli(["start", "no-such-graph"], tmpDir);
    assertEnvelope(result, "GRAPH_NOT_FOUND");
  });

  it("INVALID_CONTEXT_JSON — freelance start --context <not-json>", () => {
    const result = runCli(["start", "--context", "not-json", "valid-simple"], tmpDir);
    assertEnvelope(result, "INVALID_CONTEXT_JSON");
  });

  it("INVALID_EMIT_JSON — freelance memory emit - with bad stdin", () => {
    const result = runCli(["memory", "emit", "-"], tmpDir, "not-json\n");
    assertEnvelope(result, "INVALID_EMIT_JSON");
  });

  it("INVALID_FLAG_VALUE — parseIntArg rejects non-numeric --limit", () => {
    const result = runCli(["memory", "browse", "--limit", "abc"], tmpDir);
    assertEnvelope(result, "INVALID_FLAG_VALUE");
  });

  // AMBIGUOUS_TRAVERSAL is reachable today (when multiple traversals
  // are active), but the task contract (#5) requires `candidates`
  // on the envelope — that field arrives with PR C's recovery
  // catalog work.
  it.todo("AMBIGUOUS_TRAVERSAL carries candidates: Array<{traversalId, meta}> (PR C)");

  // CONFIRM_REQUIRED isn't emitted anywhere today; PR C consolidates
  // the `--confirm` plumbing and adds `commandName: string` to the
  // envelope.
  it.todo("CONFIRM_REQUIRED carries commandName: string (PR C)");

  // HOOK_* throws only carry `error.hook` once PR D populates
  // `EngineError.context.hook` on the throw sites in the engine
  // hook runner. PR B defines the envelope shape and the
  // `HookErrorContext` type; PR D lights up the assertion.
  it.todo("error.hook present iff code ∈ INTERNAL_HOOK \\ {HOOK_RESOLUTION_MISMATCH} (PR D)");

  // SOURCE_FILE_UNREADABLE surfaces through MemoryStore.emit rather
  // than a CLI verb — covered by a unit test in PR D.
  it.todo("SOURCE_FILE_UNREADABLE covered by direct store.emit() unit test (PR D)");
});

describe("envelope-contract test harness", () => {
  it("mapEngineErrorToExit resolves every catalog code to a known EXIT value", () => {
    // Guard: if CATEGORY_EXIT gains an entry whose value isn't in
    // EXIT, `mapEngineErrorToExit` would return a code no consumer
    // knows how to branch on.
    const exits = new Set(Object.values(EXIT));
    for (const code of ALL_ENGINE_ERROR_CODES) {
      expect(exits.has(mapEngineErrorToExit(code))).toBe(true);
    }
  });
});
