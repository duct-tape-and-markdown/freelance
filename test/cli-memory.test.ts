/**
 * CLI-boundary tests for `memoryEmit` — the JSON shape validation that
 * rejects malformed payloads before they reach `store.emit`. Runs the
 * real handler + a real MemoryStore against a tmp file; stdout is
 * captured and parsed back into the structured error envelope.
 *
 * Syntax-tier failures (non-JSON) surface as `INVALID_EMIT_JSON`; this
 * file focuses on shape-tier failures (`INVALID_EMIT_SHAPE`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryEmit, runMemoryHandler } from "../src/cli/memory.js";
import { openDatabase } from "../src/memory/db.js";
import { MemoryStore } from "../src/memory/store.js";

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-memory-emit-"));
  store = new MemoryStore(openDatabase(path.join(tmpDir, "memory.db")), tmpDir);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeEmitFile(content: string): string {
  const file = path.join(tmpDir, "emit.json");
  fs.writeFileSync(file, content);
  return file;
}

function stdoutJson(): { isError?: boolean; error?: { code: string; message: string } } {
  const output = stdoutSpy.mock.calls.map((c: [string]) => c[0]).join("");
  return JSON.parse(output);
}

describe("memoryEmit shape validation", () => {
  it("rejects non-array top-level with INVALID_EMIT_SHAPE", () => {
    const file = writeEmitFile(JSON.stringify({ content: "x" }));
    expect(() => runMemoryHandler(store, () => memoryEmit(store, file))).toThrow("process.exit");

    const out = stdoutJson();
    expect(out.isError).toBe(true);
    expect(out.error?.code).toBe("INVALID_EMIT_SHAPE");
  });

  it("rejects null sources with INVALID_EMIT_SHAPE (not a runtime TypeError)", () => {
    const file = writeEmitFile(JSON.stringify([{ content: "x", entities: ["E"], sources: null }]));
    expect(() => runMemoryHandler(store, () => memoryEmit(store, file))).toThrow("process.exit");

    const out = stdoutJson();
    expect(out.error?.code).toBe("INVALID_EMIT_SHAPE");
    // Field path surfaces the failing key so the caller knows what to fix.
    expect(out.error?.message).toContain("sources");
  });

  it("rejects string-as-entities with INVALID_EMIT_SHAPE", () => {
    const file = writeEmitFile(
      JSON.stringify([{ content: "x", entities: "Foo", sources: ["a.ts"] }]),
    );
    expect(() => runMemoryHandler(store, () => memoryEmit(store, file))).toThrow("process.exit");
    expect(stdoutJson().error?.code).toBe("INVALID_EMIT_SHAPE");
  });

  it("rejects missing content with INVALID_EMIT_SHAPE", () => {
    const file = writeEmitFile(JSON.stringify([{ entities: ["Foo"], sources: ["a.ts"] }]));
    expect(() => runMemoryHandler(store, () => memoryEmit(store, file))).toThrow("process.exit");

    const out = stdoutJson();
    expect(out.error?.code).toBe("INVALID_EMIT_SHAPE");
    expect(out.error?.message).toContain("content");
  });

  it("rejects empty sources array (sources: min 1 invariant)", () => {
    const file = writeEmitFile(JSON.stringify([{ content: "x", entities: ["Foo"], sources: [] }]));
    expect(() => runMemoryHandler(store, () => memoryEmit(store, file))).toThrow("process.exit");
    expect(stdoutJson().error?.code).toBe("INVALID_EMIT_SHAPE");
  });

  it("rejects empty entities array (entities: 1..4 invariant)", () => {
    const file = writeEmitFile(JSON.stringify([{ content: "x", entities: [], sources: ["a.ts"] }]));
    expect(() => runMemoryHandler(store, () => memoryEmit(store, file))).toThrow("process.exit");
    expect(stdoutJson().error?.code).toBe("INVALID_EMIT_SHAPE");
  });

  it("rejects >4 entities (entities: 1..4 invariant)", () => {
    const file = writeEmitFile(
      JSON.stringify([{ content: "x", entities: ["A", "B", "C", "D", "E"], sources: ["a.ts"] }]),
    );
    expect(() => runMemoryHandler(store, () => memoryEmit(store, file))).toThrow("process.exit");
    expect(stdoutJson().error?.code).toBe("INVALID_EMIT_SHAPE");
  });

  it("still rejects non-JSON with INVALID_EMIT_JSON (syntax tier unchanged)", () => {
    const file = writeEmitFile("{ not json");
    expect(() => runMemoryHandler(store, () => memoryEmit(store, file))).toThrow("process.exit");
    expect(stdoutJson().error?.code).toBe("INVALID_EMIT_JSON");
  });
});

describe("runMemoryHandler", () => {
  // The whole point of this wrapper (#153): `process.exit` inside
  // `handleError` doesn't unwind `finally`, so any outer
  // `try { ... } finally { store.close() }` wouldn't run on error paths.
  // These tests lock in that the wrapper closes the store *before*
  // handleError fires, on both error and success paths.
  it("closes the store before process.exit on the error path", () => {
    const closeSpy = vi.spyOn(store, "close");
    const exitSpy = vi.spyOn(process, "exit");

    expect(() =>
      runMemoryHandler(store, () => {
        throw new Error("boom");
      }),
    ).toThrow("process.exit");

    expect(closeSpy).toHaveBeenCalled();
    // Close must happen in the catch *before* handleError → process.exit.
    const firstCloseOrder = closeSpy.mock.invocationCallOrder[0];
    const firstExitOrder = exitSpy.mock.invocationCallOrder[0];
    expect(firstCloseOrder).toBeLessThan(firstExitOrder);
  });

  it("closes the store on the success path too", () => {
    const closeSpy = vi.spyOn(store, "close");
    runMemoryHandler(store, () => {
      /* no-op success */
    });
    expect(closeSpy).toHaveBeenCalled();
  });
});
