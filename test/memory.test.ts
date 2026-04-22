import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError } from "../src/errors.js";
import { openDatabase, retryOnSqliteBusy } from "../src/memory/db.js";
import { MemoryStore } from "../src/memory/store.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
}

/**
 * Test helper: open a database at the given path and wrap it in a
 * MemoryStore. Mirrors the composition-root pattern where the host
 * opens the db once and hands the handle to MemoryStore.
 */
function makeMemoryStore(dbPath: string, sourceRoot: string): MemoryStore {
  return new MemoryStore(openDatabase(dbPath), sourceRoot);
}

let writeSeq = 0;
function writeFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  // Ensure each write produces a distinct mtime so stat()-based staleness
  // detection works even when writes happen within the same sub-millisecond.
  const epoch = Date.now() / 1000 + ++writeSeq;
  fs.utimesSync(filePath, epoch, epoch);
  return filePath;
}

describe("MemoryStore", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = makeMemoryStore(path.join(tmpDir, "memory.db"), tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("proposition emission", () => {
    it("rejects emit when a source file cannot be read", () => {
      expect(() =>
        store.emit([{ content: "Foo exists.", entities: ["Foo"], sources: ["nonexistent.ts"] }]),
      ).toThrow("Cannot read source file");
    });

    it("rejects emit with SOURCE_OUTSIDE_ROOT when source escapes the root", () => {
      try {
        store.emit([{ content: "Foo.", entities: ["Foo"], sources: ["../escape.ts"] }]);
        expect.fail("emit should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
        expect((e as EngineError).code).toBe("SOURCE_OUTSIDE_ROOT");
      }
    });

    it("emits propositions with entities", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");

      const result = store.emit([
        { content: "Auth validates JWT tokens.", entities: ["Auth"], sources: ["auth.ts"] },
        {
          content: "Auth returns 401 for expired tokens.",
          entities: ["Auth"],
          sources: ["auth.ts"],
        },
      ]);

      expect(result.created).toBe(2);
      expect(result.deduplicated).toBe(0);
      expect(result.entities_created).toBe(1);
      expect(result.entities_resolved).toBe(1);
      expect(result.propositions).toHaveLength(2);
      expect(result.propositions[0].status).toBe("created");
      expect(result.propositions[0].entities[0].name).toBe("Auth");
    });

    it("deduplicates by content hash", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");

      const r1 = store.emit([
        { content: "Foo does bar.", entities: ["Foo"], sources: ["auth.ts"] },
      ]);
      const r2 = store.emit([
        { content: "Foo does bar.", entities: ["Foo"], sources: ["auth.ts"] },
      ]);

      expect(r1.created).toBe(1);
      expect(r2.created).toBe(0);
      expect(r2.deduplicated).toBe(1);
    });

    it("dedupes across case, whitespace, and trailing punctuation variance", () => {
      // Proposition dedup normalizes superficial variance (case,
      // whitespace runs, trailing sentence punctuation) so "X does Y"
      // and "x  does y." collide. Internal punctuation and genuinely
      // different wording are preserved as distinct.
      writeFile(tmpDir, "auth.ts", "class Auth {}");

      store.emit([{ content: "Foo does bar.", entities: ["Foo"], sources: ["auth.ts"] }]);
      const dupCase = store.emit([
        { content: "foo does bar", entities: ["Foo"], sources: ["auth.ts"] },
      ]);
      expect(dupCase.deduplicated).toBe(1);

      const dupWhitespace = store.emit([
        { content: "Foo  does\tbar", entities: ["Foo"], sources: ["auth.ts"] },
      ]);
      expect(dupWhitespace.deduplicated).toBe(1);

      const dupPunct = store.emit([
        { content: "Foo does bar!", entities: ["Foo"], sources: ["auth.ts"] },
      ]);
      expect(dupPunct.deduplicated).toBe(1);

      // Internal punctuation carries meaning — different claim, not dedup.
      const distinct = store.emit([
        { content: "Foo, does bar", entities: ["Foo"], sources: ["auth.ts"] },
      ]);
      expect(distinct.created).toBe(1);
    });

    it("creates multiple entities", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");

      const result = store.emit([
        {
          content: "Auth depends on Database.",
          entities: ["Auth", "Database"],
          sources: ["auth.ts"],
        },
      ]);

      expect(result.entities_created).toBe(2);
      expect(result.propositions[0].entities).toHaveLength(2);
    });

    it("rolls back the whole batch when a later proposition references a missing source", () => {
      // Partial emit (some rows committed, others aborted) breaks the
      // "every prop in the batch has its full source set on success"
      // invariant. The BEGIN/COMMIT wrapper around the loop rolls back
      // EVERY row the batch wrote (propositions, proposition_sources,
      // entities, about) when any prop throws.
      writeFile(tmpDir, "a.ts", "class A {}");

      expect(() =>
        store.emit([
          { content: "A exists.", entities: ["A"], sources: ["a.ts"] },
          {
            content: "B exists.",
            entities: ["B"],
            sources: ["a.ts", "missing.ts"],
          },
        ]),
      ).toThrow(/Cannot read source file/);

      // Close the store so we can re-open a sibling connection on the
      // same db file and read out the raw row counts post-rollback.
      const dbPath = path.join(tmpDir, "memory.db");
      store.close();
      const db = new DatabaseSync(dbPath);
      try {
        const propCount = (
          db.prepare("SELECT COUNT(*) as c FROM propositions").get() as {
            c: number;
          }
        ).c;
        const sourceCount = (
          db.prepare("SELECT COUNT(*) as c FROM proposition_sources").get() as {
            c: number;
          }
        ).c;
        expect(propCount).toBe(0);
        expect(sourceCount).toBe(0);
      } finally {
        db.close();
      }

      // Replace the closed store so afterEach's close() is a no-op.
      store = makeMemoryStore(dbPath, tmpDir);
    });
  });

  describe("entity resolution", () => {
    it("resolves by normalized name", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([{ content: "Foo exists.", entities: ["AuthService"], sources: ["a.ts"] }]);
      const r2 = store.emit([
        { content: "Bar exists.", entities: ["authservice"], sources: ["a.ts"] },
      ]);

      expect(r2.propositions[0].entities[0].resolution).toBe("normalized");
      expect(r2.entities_resolved).toBe(1);
      expect(r2.entities_created).toBe(0);
    });
  });

  describe("browse", () => {
    it("lists entities with proposition counts", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        { content: "Auth validates.", entities: ["Auth"], sources: ["a.ts"] },
        { content: "DB stores.", entities: ["Database"], sources: ["a.ts"] },
      ]);

      const result = store.browse();
      expect(result.total).toBe(2);
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map((e) => e.name).sort()).toEqual(["Auth", "Database"]);
    });

    it("filters by name", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        { content: "Auth validates.", entities: ["Auth"], sources: ["a.ts"] },
        { content: "DB stores.", entities: ["Database"], sources: ["a.ts"] },
      ]);

      const result = store.browse({ name: "auth" });
      expect(result.total).toBe(1);
      expect(result.entities[0].name).toBe("Auth");
    });

    it("paginates", () => {
      writeFile(tmpDir, "a.ts", "x");
      for (let i = 0; i < 5; i++) {
        store.emit([
          { content: `Entity ${i} exists.`, entities: [`Entity${i}`], sources: ["a.ts"] },
        ]);
      }

      const page1 = store.browse({ limit: 2, offset: 0 });
      expect(page1.total).toBe(5);
      expect(page1.entities).toHaveLength(2);
    });

    it("hides orphan entities (every linked proposition is stale) by default", () => {
      writeFile(tmpDir, "active.ts", "x");
      writeFile(tmpDir, "dropped.ts", "y");

      store.emit([
        { content: "Live fact.", entities: ["Live"], sources: ["active.ts"] },
        { content: "Abandoned fact.", entities: ["Abandoned"], sources: ["dropped.ts"] },
      ]);

      // Drift only the file that supports the Abandoned entity. Live stays
      // valid; Abandoned's sole proposition becomes stale, and the entity
      // should drop out of browse.
      writeFile(tmpDir, "dropped.ts", "z-changed");

      const defaulted = store.browse();
      expect(defaulted.total).toBe(1);
      expect(defaulted.entities.map((e) => e.name)).toEqual(["Live"]);

      const all = store.browse({ includeOrphans: true });
      expect(all.total).toBe(2);
      expect(all.entities.map((e) => e.name).sort()).toEqual(["Abandoned", "Live"]);
      const abandoned = all.entities.find((e) => e.name === "Abandoned");
      expect(abandoned?.proposition_count).toBe(1);
      expect(abandoned?.valid_proposition_count).toBe(0);
    });

    it("pagination total matches the orphan-filtered set", () => {
      writeFile(tmpDir, "active.ts", "x");
      writeFile(tmpDir, "dropped.ts", "y");

      for (let i = 0; i < 3; i++) {
        store.emit([{ content: `Live ${i}.`, entities: [`Live${i}`], sources: ["active.ts"] }]);
      }
      for (let i = 0; i < 2; i++) {
        store.emit([{ content: `Gone ${i}.`, entities: [`Gone${i}`], sources: ["dropped.ts"] }]);
      }

      writeFile(tmpDir, "dropped.ts", "z-changed");

      const filtered = store.browse({ limit: 10 });
      expect(filtered.total).toBe(3);
      expect(filtered.entities).toHaveLength(3);

      const unfiltered = store.browse({ limit: 10, includeOrphans: true });
      expect(unfiltered.total).toBe(5);
    });
  });

  describe("inspect", () => {
    it("returns propositions and deduped source files", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.emit([
        { content: "Auth validates JWT tokens.", entities: ["Auth"], sources: ["auth.ts"] },
        {
          content: "Auth returns 401 for expired tokens.",
          entities: ["Auth"],
          sources: ["auth.ts"],
        },
      ]);

      const result = store.inspect("Auth");

      expect(result.entity.name).toBe("Auth");
      expect(result.entity.proposition_count).toBe(2);
      expect(result.entity.valid_proposition_count).toBe(2);
      expect(result.propositions).toHaveLength(2);
      expect(result.propositions[0].valid).toBe(true);
      expect(result.source_files).toEqual(["auth.ts"]);
    });

    it("resolves by name", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([{ content: "Foo exists.", entities: ["MyService"], sources: ["a.ts"] }]);

      const result = store.inspect("MyService");
      expect(result.entity.name).toBe("MyService");
    });

    it("throws for unknown entity", () => {
      expect(() => store.inspect("nonexistent")).toThrow("Entity not found");
    });

    it("source_files is deduped across multiple compilations for the same entity", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      writeFile(tmpDir, "spec.md", "# Auth Spec");

      store.emit([{ content: "Auth validates tokens.", entities: ["Auth"], sources: ["auth.ts"] }]);

      store.emit([
        { content: "Auth should support refresh.", entities: ["Auth"], sources: ["spec.md"] },
      ]);

      const result = store.inspect("Auth");
      expect(result.propositions).toHaveLength(2);
      expect(result.source_files).toEqual(["auth.ts", "spec.md"]);
    });

    it("paginates propositions and reports total", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      for (let i = 0; i < 5; i++) {
        store.emit([{ content: `Auth claim ${i}.`, entities: ["Auth"], sources: ["auth.ts"] }]);
      }

      const page1 = store.inspect("Auth", { limit: 2, offset: 0 });
      expect(page1.total).toBe(5);
      expect(page1.propositions).toHaveLength(2);

      const page2 = store.inspect("Auth", { limit: 2, offset: 2 });
      expect(page2.total).toBe(5);
      expect(page2.propositions).toHaveLength(2);

      const pageTail = store.inspect("Auth", { limit: 2, offset: 4 });
      expect(pageTail.propositions).toHaveLength(1);
    });

    it("returns minimal shape when requested", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.emit([{ content: "Auth validates.", entities: ["Auth"], sources: ["auth.ts"] }]);

      const full = store.inspect("Auth");
      const firstFull = full.propositions[0] as Record<string, unknown>;
      expect(firstFull).toHaveProperty("source_files");
      expect(firstFull).toHaveProperty("valid");
      expect(full.source_files).toBeDefined();

      const minimal = store.inspect("Auth", { shape: "minimal" });
      const firstMin = minimal.propositions[0] as Record<string, unknown>;
      expect(firstMin).toEqual({ id: firstFull.id, content: firstFull.content });
      // `source_files` is skipped under minimal to keep the projection cheap.
      expect(minimal.source_files).toBeUndefined();
    });

    it("clamps limit to [1, 200]", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.emit([{ content: "Auth claim.", entities: ["Auth"], sources: ["auth.ts"] }]);

      // Over the cap — silently clamped (don't throw on load-test-scale requests).
      const tooBig = store.inspect("Auth", { limit: 10000 });
      expect(tooBig.total).toBe(1);

      // Under 1 — coerced up to 1 rather than 0 (which SQLite treats
      // as "no rows"); empty pages hide real data from the caller.
      const tooSmall = store.inspect("Auth", { limit: 0 });
      expect(tooSmall.propositions.length).toBeGreaterThan(0);
    });
  });

  describe("bySource", () => {
    it("finds propositions derived from a source file", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.emit([{ content: "Auth validates.", entities: ["Auth"], sources: ["auth.ts"] }]);

      const result = store.bySource("auth.ts");
      expect(result.file_path).toBe("auth.ts");
      expect(result.propositions).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.propositions[0].content).toBe("Auth validates.");
    });

    it("paginates propositions and reports total", () => {
      writeFile(tmpDir, "heavy.md", "heavy contents");
      for (let i = 0; i < 4; i++) {
        store.emit([
          { content: `Heavy claim ${i}.`, entities: [`Heavy${i}`], sources: ["heavy.md"] },
        ]);
      }

      const page1 = store.bySource("heavy.md", { limit: 2, offset: 0 });
      expect(page1.total).toBe(4);
      expect(page1.propositions).toHaveLength(2);

      const page2 = store.bySource("heavy.md", { limit: 2, offset: 2 });
      expect(page2.total).toBe(4);
      expect(page2.propositions).toHaveLength(2);
    });

    it("returns minimal shape when requested", () => {
      writeFile(tmpDir, "auth.ts", "x");
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["auth.ts"] }]);

      const minimal = store.bySource("auth.ts", { shape: "minimal" });
      const first = minimal.propositions[0] as Record<string, unknown>;
      expect(Object.keys(first).sort()).toEqual(["content", "id"]);
    });

    it("hides orphans by default, surfaces them with includeOrphans", () => {
      // Emit against a file, then overwrite the file to break hash
      // equivalence (content-drift staleness). Default lens hides the
      // now-orphaned prop. `includeOrphans: true` surfaces it for
      // audit paths. Mirrors browse's orphan lens.
      writeFile(tmpDir, "drift.ts", "original");
      store.emit([{ content: "Drift claim.", entities: ["Drift"], sources: ["drift.ts"] }]);

      // Overwrite — disk hash no longer matches the proposition's
      // stored source hash. Prop becomes stale.
      writeFile(tmpDir, "drift.ts", "replaced");

      const hidden = store.bySource("drift.ts");
      expect(hidden.total).toBe(0);
      expect(hidden.propositions).toHaveLength(0);

      const surfaced = store.bySource("drift.ts", { includeOrphans: true });
      expect(surfaced.total).toBe(1);
      expect(surfaced.propositions).toHaveLength(1);
    });

    it("rejects bySource with SOURCE_OUTSIDE_ROOT when path escapes the root", () => {
      try {
        store.bySource("../../etc/passwd");
        expect.fail("bySource should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
        expect((e as EngineError).code).toBe("SOURCE_OUTSIDE_ROOT");
      }
    });
  });

  describe("search", () => {
    it("finds propositions immediately after emit (same connection)", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        { content: "Auth validates JWT tokens.", entities: ["Auth"], sources: ["a.ts"] },
      ]);

      const result = store.search("JWT");
      expect(result.propositions).toHaveLength(1);
      expect(result.propositions[0].content).toContain("JWT");
    });
  });

  describe("status", () => {
    it("returns overall counts", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        { content: "Foo exists.", entities: ["Foo"], sources: ["a.ts"] },
        { content: "Bar exists.", entities: ["Bar"], sources: ["a.ts"] },
      ]);

      const result = store.status();
      expect(result.total_propositions).toBe(2);
      expect(result.valid_propositions).toBe(2);
      expect(result.stale_propositions).toBe(0);
      expect(result.total_entities).toBe(2);
    });
  });

  describe("provenance validation", () => {
    it("propositions valid when files unchanged", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["auth.ts"] }]);

      const result = store.inspect("Auth");
      expect(result.propositions[0].valid).toBe(true);
    });

    it("propositions stale when files changed", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["auth.ts"] }]);

      writeFile(tmpDir, "auth.ts", "class Auth { validate() {} }");

      const result = store.inspect("Auth");
      expect(result.propositions[0].valid).toBe(false);
      expect(result.propositions[0].source_files[0].current_match).toBe(false);
    });

    it("propositions stale when files deleted", () => {
      const filePath = writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["auth.ts"] }]);

      fs.unlinkSync(filePath);

      const result = store.inspect("Auth");
      expect(result.propositions[0].valid).toBe(false);
    });

    it("status reflects valid/stale counts", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["auth.ts"] }]);

      let status = store.status();
      expect(status.valid_propositions).toBe(1);
      expect(status.stale_propositions).toBe(0);

      writeFile(tmpDir, "auth.ts", "class Auth { modified }");

      status = store.status();
      expect(status.valid_propositions).toBe(0);
      expect(status.stale_propositions).toBe(1);
    });

    it("propositions from unchanged sessions stay valid when other files change", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      writeFile(tmpDir, "db.ts", "class DB {}");

      store.emit([{ content: "Auth validates.", entities: ["Auth"], sources: ["auth.ts"] }]);

      store.emit([{ content: "DB stores.", entities: ["Database"], sources: ["db.ts"] }]);

      writeFile(tmpDir, "auth.ts", "class Auth { changed }");

      const status = store.status();
      expect(status.valid_propositions).toBe(1);
      expect(status.stale_propositions).toBe(1);

      expect(store.inspect("Database").propositions[0].valid).toBe(true);
      expect(store.inspect("Auth").propositions[0].valid).toBe(false);
    });

    it("multiple sessions referencing same file — only matching hash is valid", () => {
      writeFile(tmpDir, "auth.ts", "version 1");
      store.emit([{ content: "Auth v1.", entities: ["Auth"], sources: ["auth.ts"] }]);

      writeFile(tmpDir, "auth.ts", "version 2");
      store.emit([{ content: "Auth v2.", entities: ["Auth"], sources: ["auth.ts"] }]);

      const result = store.inspect("Auth");
      const v1 = result.propositions.find((p) => p.content === "Auth v1.");
      const v2 = result.propositions.find((p) => p.content === "Auth v2.");
      expect(v1!.valid).toBe(false);
      expect(v2!.valid).toBe(true);

      // Revert file — validity flips
      writeFile(tmpDir, "auth.ts", "version 1");
      const result2 = store.inspect("Auth");
      expect(result2.propositions.find((p) => p.content === "Auth v1.")!.valid).toBe(true);
      expect(result2.propositions.find((p) => p.content === "Auth v2.")!.valid).toBe(false);
    });

    it("session with multiple files — all must match for valid", () => {
      writeFile(tmpDir, "a.ts", "a1");
      writeFile(tmpDir, "b.ts", "b1");

      store.emit([{ content: "Uses both.", entities: ["Multi"], sources: ["a.ts", "b.ts"] }]);

      expect(store.inspect("Multi").propositions[0].valid).toBe(true);

      writeFile(tmpDir, "b.ts", "b2");
      expect(store.inspect("Multi").propositions[0].valid).toBe(false);
    });

    it("detects content drift even when mtime is preserved across edits", () => {
      // Regression guard for the no-mtime-fast-path invariant; see the
      // header comment in src/memory/staleness.ts for why mtime alone
      // isn't a trustworthy drift signal.
      const filePath = path.join(tmpDir, "spec.md");
      fs.writeFileSync(filePath, "version A content");
      const pinnedSec = 1700000000;
      fs.utimesSync(filePath, pinnedSec, pinnedSec);

      store.emit([{ content: "Claim one.", entities: ["X"], sources: ["spec.md"] }]);

      expect(store.inspect("X").propositions[0].valid).toBe(true);

      // Content edit, but mtime restored to the exact pre-edit value.
      fs.writeFileSync(filePath, "version B completely different content");
      fs.utimesSync(filePath, pinnedSec, pinnedSec);

      const result = store.inspect("X");
      expect(result.propositions[0].source_files[0].current_match).toBe(false);
      expect(result.propositions[0].valid).toBe(false);
    });
  });

  describe("resetAll", () => {
    it("wipes propositions and entities together", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        { content: "Auth validates.", entities: ["Auth"], sources: ["a.ts"] },
        { content: "DB stores.", entities: ["Database"], sources: ["a.ts"] },
      ]);

      const result = store.resetAll();
      expect(result.deleted_propositions).toBe(2);
      expect(result.deleted_entities).toBe(2);

      const status = store.status();
      expect(status.total_propositions).toBe(0);
      expect(status.total_entities).toBe(0);
    });

    it("rolls back on failure — no partial-delete window", () => {
      // Force the second DELETE to throw by stubbing exec; the first
      // DELETE (propositions) must be rolled back so the store isn't
      // left with stranded entity rows.
      writeFile(tmpDir, "a.ts", "x");
      store.emit([{ content: "Auth validates.", entities: ["Auth"], sources: ["a.ts"] }]);

      const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
      const origExec = db.exec.bind(db);
      let seen = 0;
      db.exec = (sql: string) => {
        // Let BEGIN + first DELETE succeed; fail the second DELETE to
        // exercise the rollback path. ROLLBACK itself must pass through.
        if (sql.includes("DELETE FROM entities")) {
          seen++;
          throw new Error("simulated failure on second delete");
        }
        return origExec(sql);
      };

      expect(() => store.resetAll()).toThrow("simulated failure");
      expect(seen).toBe(1);

      // Restore before asserting so status() can run.
      db.exec = origExec;

      const status = store.status();
      expect(status.total_propositions).toBe(1);
      expect(status.total_entities).toBe(1);
    });
  });

  describe("stale filter at scale", () => {
    // Regression guard: the old `NOT IN (?, …)` pattern bound one param
    // per stale id, which would hit SQLITE_MAX_VARIABLE_NUMBER on a
    // large-enough stale set. The temp-table materialization keeps the
    // param count bounded regardless.
    it("browse/inspect/related work when every proposition is stale", () => {
      writeFile(tmpDir, "heavy.ts", "v1");
      const N = 150;
      const batch = Array.from({ length: N }, (_, i) => ({
        content: `Heavy claim number ${i} about the system.`,
        entities: [`Hub${i}`, "Shared"],
        sources: ["heavy.ts"],
      }));
      store.emit(batch);
      writeFile(tmpDir, "heavy.ts", "v2-drifted");

      expect(() => store.browse({ includeOrphans: true })).not.toThrow();
      expect(() => store.inspect("Shared")).not.toThrow();
      expect(() => store.related("Shared")).not.toThrow();

      expect(store.status().stale_propositions).toBe(N);
    });
  });

  describe("cross-session knowledge", () => {
    it("accumulates knowledge across sessions", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      writeFile(tmpDir, "db.ts", "class DB {}");

      store.emit([{ content: "Auth validates tokens.", entities: ["Auth"], sources: ["auth.ts"] }]);

      store.emit([{ content: "DB stores users.", entities: ["Database"], sources: ["db.ts"] }]);

      const status = store.status();
      expect(status.total_propositions).toBe(2);
      expect(status.total_entities).toBe(2);
    });

    it("deduplication works across emit calls", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([{ content: "Auth validates tokens.", entities: ["Auth"], sources: ["a.ts"] }]);

      writeFile(tmpDir, "b.ts", "y");
      const r = store.emit([
        { content: "Auth validates tokens.", entities: ["Auth"], sources: ["b.ts"] },
      ]);
      expect(r.deduplicated).toBe(1);
      expect(r.created).toBe(0);

      expect(store.status().total_propositions).toBe(1);
    });
  });

  describe("stateless multi-process access", () => {
    it("second store instance sees propositions emitted by the first", () => {
      const dbPath = path.join(tmpDir, "memory.db");
      const store2 = makeMemoryStore(dbPath, tmpDir);

      writeFile(tmpDir, "a.ts", "x");
      writeFile(tmpDir, "b.ts", "y");
      store.emit([{ content: "Uses both.", entities: ["Multi"], sources: ["a.ts", "b.ts"] }]);

      const result = store2.browse({ name: "Multi" });
      expect(result.entities).toHaveLength(1);

      store2.close();
    });
  });

  describe("entityKinds", () => {
    it("sets kind on entity creation", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        {
          content: "Auth validates tokens.",
          entities: ["Auth"],
          sources: ["a.ts"],
          entityKinds: { Auth: "class" },
        },
      ]);

      const result = store.browse({ name: "Auth" });
      expect(result.entities[0].kind).toBe("class");
    });

    it("kind is null when entityKinds not provided", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([{ content: "Foo exists.", entities: ["Foo"], sources: ["a.ts"] }]);

      const result = store.browse({ name: "Foo" });
      expect(result.entities[0].kind).toBeNull();
    });

    it("existing entity keeps its kind on re-resolution", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        {
          content: "Auth validates.",
          entities: ["Auth"],
          sources: ["a.ts"],
          entityKinds: { Auth: "class" },
        },
      ]);
      // Re-resolve same entity without kind — should keep original
      store.emit([
        {
          content: "Auth also logs.",
          entities: ["Auth"],
          sources: ["a.ts"],
        },
      ]);

      const result = store.browse({ name: "Auth" });
      expect(result.entities[0].kind).toBe("class");
    });

    it("backfills kind on existing entity that had none", () => {
      writeFile(tmpDir, "a.ts", "x");
      // First emit without kind
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["a.ts"] }]);
      expect(store.browse({ name: "Auth" }).entities[0].kind).toBeNull();

      // Second emit with kind — should backfill
      store.emit([
        {
          content: "Auth validates tokens.",
          entities: ["Auth"],
          sources: ["a.ts"],
          entityKinds: { Auth: "class" },
        },
      ]);

      const result = store.browse({ name: "Auth" });
      expect(result.entities[0].kind).toBe("class");
    });

    it("backfills kind via normalized name match", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        { content: "AuthService exists.", entities: ["AuthService"], sources: ["a.ts"] },
      ]);
      store.emit([
        {
          content: "authservice validates.",
          entities: ["authservice"],
          sources: ["a.ts"],
          entityKinds: { authservice: "class" },
        },
      ]);

      const result = store.browse({ name: "AuthService" });
      expect(result.entities[0].kind).toBe("class");
    });

    it("surfaces entity_kind_conflict warning when re-cited with different kind", () => {
      writeFile(tmpDir, "a.ts", "x");
      // First emit: Auth is a class
      store.emit([
        {
          content: "Auth validates tokens.",
          entities: ["Auth"],
          sources: ["a.ts"],
          entityKinds: { Auth: "class" },
        },
      ]);

      // Second emit: Auth is now cited as a function — conflict
      const r = store.emit([
        {
          content: "Auth also logs.",
          entities: ["Auth"],
          sources: ["a.ts"],
          entityKinds: { Auth: "function" },
        },
      ]);

      expect(r.warnings).toBeDefined();
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings![0]).toEqual({
        type: "entity_kind_conflict",
        entity: "Auth",
        existingKind: "class",
        providedKind: "function",
      });

      // Existing kind still wins (first-wins, not reconciled)
      expect(store.browse({ name: "Auth" }).entities[0].kind).toBe("class");
    });

    it("no warning when kind matches existing", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        {
          content: "Auth validates.",
          entities: ["Auth"],
          sources: ["a.ts"],
          entityKinds: { Auth: "class" },
        },
      ]);
      const r = store.emit([
        {
          content: "Auth also logs.",
          entities: ["Auth"],
          sources: ["a.ts"],
          entityKinds: { Auth: "class" },
        },
      ]);
      expect(r.warnings).toBeUndefined();
    });

    it("no warning when new emit omits kind (existing kind stays)", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        {
          content: "Auth validates.",
          entities: ["Auth"],
          sources: ["a.ts"],
          entityKinds: { Auth: "class" },
        },
      ]);
      const r = store.emit([{ content: "Auth also logs.", entities: ["Auth"], sources: ["a.ts"] }]);
      expect(r.warnings).toBeUndefined();
    });

    it("conflict warning fires on normalized-name match too", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        {
          content: "AuthService exists.",
          entities: ["AuthService"],
          sources: ["a.ts"],
          entityKinds: { AuthService: "class" },
        },
      ]);
      const r = store.emit([
        {
          content: "authservice also logs.",
          entities: ["authservice"],
          sources: ["a.ts"],
          entityKinds: { authservice: "interface" },
        },
      ]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings![0]).toEqual({
        type: "entity_kind_conflict",
        entity: "AuthService",
        existingKind: "class",
        providedKind: "interface",
      });
    });
  });

  describe("neighbors", () => {
    it("inspect returns co-occurring entities with valid counts", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        {
          content: "Auth depends on Database.",
          entities: ["Auth", "Database"],
          sources: ["a.ts"],
        },
        {
          content: "Auth uses Cache for tokens.",
          entities: ["Auth", "Cache"],
          sources: ["a.ts"],
        },
      ]);

      const result = store.inspect("Auth");
      expect(result.neighbors).toHaveLength(2);
      const names = result.neighbors.map((n) => n.name).sort();
      expect(names).toEqual(["Cache", "Database"]);
      expect(result.neighbors[0].shared_propositions).toBe(1);
      expect(result.neighbors[0].valid_shared_propositions).toBe(1);
    });

    it("no neighbors for isolated entity", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([{ content: "Standalone exists.", entities: ["Standalone"], sources: ["a.ts"] }]);

      const result = store.inspect("Standalone");
      expect(result.neighbors).toHaveLength(0);
    });

    it("valid count drops when source goes stale", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        {
          content: "Auth depends on Database.",
          entities: ["Auth", "Database"],
          sources: ["a.ts"],
        },
      ]);

      writeFile(tmpDir, "b.ts", "y");
      store.emit([
        {
          content: "Auth also uses Database for caching.",
          entities: ["Auth", "Database"],
          sources: ["b.ts"],
        },
      ]);

      let result = store.inspect("Auth");
      const db = result.neighbors.find((n) => n.name === "Database")!;
      expect(db.shared_propositions).toBe(2);
      expect(db.valid_shared_propositions).toBe(2);

      writeFile(tmpDir, "a.ts", "changed");
      result = store.inspect("Auth");
      const db2 = result.neighbors.find((n) => n.name === "Database")!;
      expect(db2.shared_propositions).toBe(2);
      expect(db2.valid_shared_propositions).toBe(1);
    });
  });

  describe("related", () => {
    it("returns neighbors with sample propositions", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.emit([
        {
          content: "Auth depends on Database for user lookups.",
          entities: ["Auth", "Database"],
          sources: ["a.ts"],
        },
        {
          content: "Auth uses Cache to store sessions.",
          entities: ["Auth", "Cache"],
          sources: ["a.ts"],
        },
        {
          content: "Auth also queries Database for roles.",
          entities: ["Auth", "Database"],
          sources: ["a.ts"],
        },
      ]);

      const result = store.related("Auth");
      expect(result.entity.name).toBe("Auth");
      expect(result.neighbors).toHaveLength(2);

      const db = result.neighbors.find((n) => n.name === "Database");
      expect(db!.shared_propositions).toBe(2);
      expect(db!.sample).toBeTruthy();

      const cache = result.neighbors.find((n) => n.name === "Cache");
      expect(cache!.shared_propositions).toBe(1);
    });

    it("throws for unknown entity", () => {
      expect(() => store.related("nonexistent")).toThrow("Entity not found");
    });

    it("paginates neighbors and reports total", () => {
      writeFile(tmpDir, "a.ts", "x");
      // Five neighbors sharing propositions with Hub.
      for (let i = 0; i < 5; i++) {
        store.emit([
          {
            content: `Hub connects to Node${i}.`,
            entities: ["Hub", `Node${i}`],
            sources: ["a.ts"],
          },
        ]);
      }

      const page1 = store.related("Hub", { limit: 2, offset: 0 });
      expect(page1.total).toBe(5);
      expect(page1.neighbors).toHaveLength(2);

      const page2 = store.related("Hub", { limit: 2, offset: 2 });
      expect(page2.total).toBe(5);
      expect(page2.neighbors).toHaveLength(2);

      const pageTail = store.related("Hub", { limit: 2, offset: 4 });
      expect(pageTail.neighbors).toHaveLength(1);
    });
  });
});

describe("MemoryStore schema migration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Transparent migration for the dead `collection` column. Simulates a
  // pre-migration DB by hand-installing the old schema + a seeded row,
  // then opens it with the real `openDatabase` (which runs the migration)
  // and confirms the column / old indexes are gone while the row survived.
  it("drops collection column and compound index from a pre-migration db", () => {
    const dbPath = path.join(tmpDir, "memory.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(`
      CREATE TABLE propositions (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        collection TEXT NOT NULL DEFAULT 'default',
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_prop_hash_coll ON propositions(content_hash, collection);
      CREATE INDEX idx_prop_collection ON propositions(collection);
    `);
    raw.exec(
      "INSERT INTO propositions (id, content, content_hash, collection, created_at) VALUES ('p1', 'foo', 'h1', 'default', '2024-01-01')",
    );
    raw.close();

    // openDatabase runs SCHEMA_SQL + migrateDropCollectionColumn.
    const db = openDatabase(dbPath);
    try {
      const cols = db.prepare("PRAGMA table_info(propositions)").all() as Array<{
        name: string;
      }>;
      expect(cols.map((c) => c.name)).not.toContain("collection");

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='propositions'")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).not.toContain("idx_prop_hash_coll");
      expect(names).not.toContain("idx_prop_collection");
      expect(names).toContain("idx_prop_hash");

      const row = db.prepare("SELECT id, content, content_hash FROM propositions").get() as {
        id: string;
        content: string;
        content_hash: string;
      };
      expect(row).toEqual({ id: "p1", content: "foo", content_hash: "h1" });
    } finally {
      db.close();
    }
  });

  it("no-op on a fresh db (idempotent)", () => {
    const dbPath = path.join(tmpDir, "memory.db");
    // Opening twice exercises the "column already gone" branch.
    const first = openDatabase(dbPath);
    first.close();
    const second = openDatabase(dbPath);
    try {
      const cols = second.prepare("PRAGMA table_info(propositions)").all() as Array<{
        name: string;
      }>;
      expect(cols.map((c) => c.name)).not.toContain("collection");
    } finally {
      second.close();
    }
  });

  it("drops mtime_ms column from a pre-migration proposition_sources", () => {
    const dbPath = path.join(tmpDir, "memory.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(`
      CREATE TABLE propositions (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE proposition_sources (
        proposition_id TEXT NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mtime_ms REAL,
        PRIMARY KEY (proposition_id, file_path)
      );
    `);
    raw.exec(
      "INSERT INTO propositions (id, content, content_hash, created_at) VALUES ('p1', 'foo', 'h1', '2024-01-01')",
    );
    raw.exec(
      "INSERT INTO proposition_sources (proposition_id, file_path, content_hash, mtime_ms) VALUES ('p1', 'a.ts', 'src-hash-1', 1234567890)",
    );
    raw.close();

    const db = openDatabase(dbPath);
    try {
      const cols = db.prepare("PRAGMA table_info(proposition_sources)").all() as Array<{
        name: string;
      }>;
      expect(cols.map((c) => c.name)).not.toContain("mtime_ms");

      // Row survived the column drop.
      const row = db
        .prepare(
          "SELECT proposition_id, file_path, content_hash FROM proposition_sources WHERE proposition_id = 'p1'",
        )
        .get() as { proposition_id: string; file_path: string; content_hash: string };
      expect(row).toEqual({
        proposition_id: "p1",
        file_path: "a.ts",
        content_hash: "src-hash-1",
      });
    } finally {
      db.close();
    }
  });
});

describe("MemoryStore lazy open (#138)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = createTempDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not invoke the db factory at construction", () => {
    let opened = 0;
    const store = new MemoryStore(() => {
      opened++;
      return openDatabase(path.join(tmpDir, "memory.db"));
    }, tmpDir);
    expect(opened).toBe(0);
    // Confirm a cleanup without any method call is a pure no-op — no
    // CLI verb that avoided touching memory should ever accidentally
    // force the open via close() in a finally block.
    store.close();
    expect(opened).toBe(0);
  });

  it("opens on first memory access and reuses the handle", () => {
    let opened = 0;
    const store = new MemoryStore(() => {
      opened++;
      return openDatabase(path.join(tmpDir, "memory.db"));
    }, tmpDir);
    store.status();
    expect(opened).toBe(1);
    store.status();
    expect(opened).toBe(1);
    store.close();
  });
});

describe("retryOnSqliteBusy (#138)", () => {
  function busyError(): Error {
    const e = new Error("database is locked");
    (e as { code?: string }).code = "ERR_SQLITE_ERROR";
    return e;
  }

  it("returns the first successful attempt", () => {
    let calls = 0;
    const result = retryOnSqliteBusy(() => {
      calls++;
      return "ok";
    }, "test");
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries through up to 3 busy errors then succeeds", () => {
    let calls = 0;
    const result = retryOnSqliteBusy(() => {
      calls++;
      if (calls <= 3) throw busyError();
      return "ok";
    }, "test");
    expect(result).toBe("ok");
    expect(calls).toBe(4);
  });

  it("throws EngineError DATABASE_BUSY after all retries exhaust", () => {
    let calls = 0;
    try {
      retryOnSqliteBusy(() => {
        calls++;
        throw busyError();
      }, "/tmp/x");
      expect.fail("expected DATABASE_BUSY to throw");
    } catch (e) {
      expect(calls).toBe(4);
      expect(e).toMatchObject({
        code: "DATABASE_BUSY",
        message: expect.stringContaining("/tmp/x"),
      });
    }
  });

  it("re-throws non-busy errors immediately without retry", () => {
    let calls = 0;
    const other = new Error("unrelated");
    try {
      retryOnSqliteBusy(() => {
        calls++;
        throw other;
      }, "test");
      expect.fail("expected throw");
    } catch (e) {
      expect(calls).toBe(1);
      expect(e).toBe(other);
    }
  });
});
