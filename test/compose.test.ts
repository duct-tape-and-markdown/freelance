import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphBuilder } from "../src/builder.js";
import { buildMemoryStore, composeRuntime, migrateLegacyLayout } from "../src/compose.js";
import type { ValidatedGraph } from "../src/types.js";

function makeTmpGraphsDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFake(filePath: string, content = "x"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function emptyGraphs(): Map<string, ValidatedGraph> {
  // Builder produces a single trivial graph so composeRuntime has something
  // to pass into TraversalStore. The engine never runs in these tests.
  const vg = new GraphBuilder("test-compose")
    .setDescription("compose test fixture")
    .node("start", { type: "terminal", description: "done" })
    .build();
  return new Map([[vg.definition.id, vg]]);
}

describe("migrateLegacyLayout", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    tmpDir = makeTmpGraphsDir("migrate-");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("no-op when .state/ doesn't exist", () => {
    migrateLegacyLayout(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, "memory"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "traversals"))).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("moves memory.db + sidecars from .state/ to memory/", () => {
    writeFake(path.join(tmpDir, ".state", "memory.db"), "db");
    writeFake(path.join(tmpDir, ".state", "memory.db-shm"), "shm");
    writeFake(path.join(tmpDir, ".state", "memory.db-wal"), "wal");

    migrateLegacyLayout(tmpDir);

    expect(fs.readFileSync(path.join(tmpDir, "memory", "memory.db"), "utf-8")).toBe("db");
    expect(fs.readFileSync(path.join(tmpDir, "memory", "memory.db-shm"), "utf-8")).toBe("shm");
    expect(fs.readFileSync(path.join(tmpDir, "memory", "memory.db-wal"), "utf-8")).toBe("wal");
    expect(fs.existsSync(path.join(tmpDir, ".state"))).toBe(false);
  });

  it("moves .state/traversals/ up to traversals/", () => {
    writeFake(path.join(tmpDir, ".state", "traversals", "tr_abc.json"), '{"id":"tr_abc"}');

    migrateLegacyLayout(tmpDir);

    expect(fs.readFileSync(path.join(tmpDir, "traversals", "tr_abc.json"), "utf-8")).toBe(
      '{"id":"tr_abc"}',
    );
    expect(fs.existsSync(path.join(tmpDir, ".state"))).toBe(false);
  });

  it("merges traversals into existing target dir rather than clobbering", () => {
    // Pre-existing traversals/ with a file — a partial migration could
    // have left this state.
    writeFake(path.join(tmpDir, "traversals", "tr_new.json"), '{"id":"tr_new"}');
    // Legacy .state/traversals/ has a different file.
    writeFake(path.join(tmpDir, ".state", "traversals", "tr_old.json"), '{"id":"tr_old"}');

    migrateLegacyLayout(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "traversals", "tr_new.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "traversals", "tr_old.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".state"))).toBe(false);
  });

  it("deletes vestigial state.db* files", () => {
    writeFake(path.join(tmpDir, ".state", "state.db"), "legacy");
    writeFake(path.join(tmpDir, ".state", "state.db-shm"), "legacy");
    writeFake(path.join(tmpDir, ".state", "state.db-wal"), "legacy");

    migrateLegacyLayout(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, ".state"))).toBe(false);
    // state.db is not recreated under memory/ or anywhere else
    expect(fs.existsSync(path.join(tmpDir, "state.db"))).toBe(false);
  });

  it("logs a success line to stderr after migration", () => {
    writeFake(path.join(tmpDir, ".state", "memory.db"), "db");

    migrateLegacyLayout(tmpDir);

    const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(calls).toContain("migrated legacy .state/ layout");
  });

  it("leaves .state/ in place with a warning when unknown files remain", () => {
    writeFake(path.join(tmpDir, ".state", "memory.db"), "db");
    writeFake(path.join(tmpDir, ".state", "unknown.bin"), "weird");

    migrateLegacyLayout(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, ".state"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".state", "unknown.bin"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "memory", "memory.db"))).toBe(true);

    const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(calls).toContain("unrecognized");
    expect(calls).toContain("unknown.bin");
  });

  it("logs a failure message when an fs operation throws", () => {
    writeFake(path.join(tmpDir, ".state", "memory.db"), "db");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated rename failure");
    });

    migrateLegacyLayout(tmpDir);

    const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(calls).toContain("migration failed");
    expect(calls).toContain("simulated rename failure");
    renameSpy.mockRestore();
  });
});

describe("composeRuntime", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpGraphsDir("compose-");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a Runtime with store and sourceOpts when memory is off", () => {
    const runtime = composeRuntime({
      graphs: emptyGraphs(),
      stateDir: ":memory:",
      sourceRoot: tmpDir,
    });

    expect(runtime.store).toBeDefined();
    expect(runtime.sourceOpts).toBeDefined();
    expect(runtime.sourceOpts.basePath).toBe(tmpDir);
    expect(runtime.memoryStore).toBeUndefined();
    runtime.close();
  });

  it("builds a MemoryStore when memory is enabled", () => {
    // openDatabase can create the .db file but not its parent dir —
    // that's resolveMemoryConfig's job in the CLI path. Test mkdirs
    // the parent directly to isolate composeRuntime.
    fs.mkdirSync(path.join(tmpDir, "memory"), { recursive: true });
    const runtime = composeRuntime({
      graphs: emptyGraphs(),
      stateDir: ":memory:",
      sourceRoot: tmpDir,
      memory: {
        enabled: true,
        db: path.join(tmpDir, "memory", "memory.db"),
      },
    });

    expect(runtime.memoryStore).toBeDefined();
    runtime.close();
  });

  it("throws when memory is enabled without sourceRoot", () => {
    expect(() =>
      composeRuntime({
        graphs: emptyGraphs(),
        stateDir: ":memory:",
        memory: {
          enabled: true,
          db: path.join(tmpDir, "memory", "memory.db"),
        },
      }),
    ).toThrow(/sourceRoot is required when memory is enabled/);
  });

  it("close() is idempotent", () => {
    const runtime = composeRuntime({
      graphs: emptyGraphs(),
      stateDir: ":memory:",
      sourceRoot: tmpDir,
    });

    runtime.close();
    expect(() => runtime.close()).not.toThrow();
  });

  it("runs migrateLegacyLayout when graphsDir points at a legacy layout", () => {
    writeFake(path.join(tmpDir, ".state", "memory.db"), "db");

    const runtime = composeRuntime({
      graphs: emptyGraphs(),
      graphsDir: tmpDir,
      stateDir: ":memory:",
      sourceRoot: tmpDir,
    });

    expect(fs.existsSync(path.join(tmpDir, ".state"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "memory", "memory.db"))).toBe(true);
    runtime.close();
  });
});

describe("buildMemoryStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpGraphsDir("buildms-");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("constructs a MemoryStore from config + sourceRoot", () => {
    const store = buildMemoryStore({ enabled: true, db: path.join(tmpDir, "memory.db") }, tmpDir);

    expect(store).toBeDefined();
    // Status call hits the db + returns the expected shape
    const status = store.status();
    expect(status.total_propositions).toBe(0);
    expect(status.total_entities).toBe(0);
    store.close();
  });
});
