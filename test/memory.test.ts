import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
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

const C = "default";

describe("MemoryStore", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new MemoryStore(path.join(tmpDir, "memory.db"), tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("session lifecycle", () => {
    it("session created lazily on registerSource", () => {
      writeFile(tmpDir, "a.ts", "x");

      const status1 = store.status();
      expect(status1.active_session).toBeNull();

      store.registerSource("a.ts");

      const status2 = store.status();
      expect(status2.active_session).toBeTruthy();
    });

    it("end closes session and returns stats", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{ content: "Foo exists.", entities: ["Foo"], sources: ["a.ts"] }], C);

      const end = store.end();
      expect(end.session_id).toBeTruthy();
      expect(end.propositions_emitted).toBe(1);
      expect(end.files_registered).toBe(1);
      expect(end.entities_referenced).toBe(1);
      expect(end.duration_ms).toBeGreaterThanOrEqual(0);

      expect(store.status().active_session).toBeNull();
    });

    it("rejects end without active session", () => {
      expect(() => store.end()).toThrow("No active session");
    });

    it("rejects emit without registered source", () => {
      expect(() => store.emit([{ content: "test", entities: ["Foo"], sources: ["a.ts"] }], C))
        .toThrow("Register a source file first");
    });

    it("reuses existing session on subsequent registerSource calls", () => {
      writeFile(tmpDir, "a.ts", "x");
      writeFile(tmpDir, "b.ts", "y");

      store.registerSource("a.ts");
      const session1 = store.status().active_session;

      store.registerSource("b.ts");
      const session2 = store.status().active_session;

      expect(session1).toBe(session2);
    });

    it("new session after end + registerSource", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{ content: "Foo.", entities: ["Foo"], sources: ["a.ts"] }], C);
      const session1 = store.status().active_session;
      store.end();

      writeFile(tmpDir, "b.ts", "y");
      store.registerSource("b.ts");
      const session2 = store.status().active_session;

      expect(session1).not.toBe(session2);
    });
  });

  describe("source registration", () => {
    it("registers a source file", () => {
      writeFile(tmpDir, "test.ts", "const x = 1;");

      const result = store.registerSource("test.ts");
      expect(result.file_path).toBe("test.ts");
      expect(result.content_hash).toHaveLength(16);
      expect(result.status).toBe("registered");
    });

    it("updates hash on re-registration", () => {
      writeFile(tmpDir, "test.ts", "const x = 1;");

      const r1 = store.registerSource("test.ts");
      writeFile(tmpDir, "test.ts", "const x = 2;");
      const r2 = store.registerSource("test.ts");

      expect(r2.status).toBe("updated");
      expect(r2.content_hash).not.toBe(r1.content_hash);
    });

    it("rejects missing files", () => {
      expect(() => store.registerSource("nonexistent.ts")).toThrow("Cannot read file");
    });

    it("rejects paths outside source root", () => {
      expect(() => store.registerSource("/etc/passwd")).toThrow("outside the source root");
      expect(() => store.registerSource("../../etc/passwd")).toThrow("outside the source root");
    });

    it("accepts absolute paths within source root", () => {
      const filePath = writeFile(tmpDir, "inner.ts", "const x = 1;");
      const result = store.registerSource(filePath);
      expect(result.status).toBe("registered");
    });
  });

  describe("ignore filtering", () => {
    let ignoredStore: MemoryStore;

    beforeEach(() => {
      ignoredStore = new MemoryStore(
        path.join(tmpDir, "memory-ignored.db"),
        tmpDir,
        ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/*.lock"]
      );
    });

    afterEach(() => {
      ignoredStore.close();
    });

    it("skips files in ignored directories", () => {
      fs.mkdirSync(path.join(tmpDir, "node_modules", "lodash"), { recursive: true });
      writeFile(path.join(tmpDir, "node_modules", "lodash"), "index.js", "module.exports = {}");

      const result = ignoredStore.registerSource("node_modules/lodash/index.js");
      expect(result.status).toBe("skipped");
      expect(result.content_hash).toBe("");
    });

    it("skips files matching extension patterns", () => {
      writeFile(tmpDir, "package-lock.lock", "{}");
      const result = ignoredStore.registerSource("package-lock.lock");
      expect(result.status).toBe("skipped");
    });

    it("skips nested ignored directories", () => {
      fs.mkdirSync(path.join(tmpDir, "packages", "api", "dist"), { recursive: true });
      writeFile(path.join(tmpDir, "packages", "api", "dist"), "index.js", "compiled");

      const result = ignoredStore.registerSource("packages/api/dist/index.js");
      expect(result.status).toBe("skipped");
    });

    it("allows files not matching any pattern", () => {
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      writeFile(path.join(tmpDir, "src"), "auth.ts", "class Auth {}");

      const result = ignoredStore.registerSource("src/auth.ts");
      expect(result.status).toBe("registered");
    });

    it("skipped files don't create a session", () => {
      fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
      writeFile(path.join(tmpDir, "node_modules"), "index.js", "x");

      ignoredStore.registerSource("node_modules/index.js");
      expect(ignoredStore.status().active_session).toBeNull();
    });

    it("skipped files don't affect provenance", () => {
      // Register a real source and emit
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      ignoredStore.registerSource("auth.ts");
      ignoredStore.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      ignoredStore.end();

      // Register an ignored file — shouldn't affect anything
      fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
      writeFile(path.join(tmpDir, "node_modules"), "lodash.js", "x");
      ignoredStore.registerSource("node_modules/lodash.js");

      const status = ignoredStore.status();
      expect(status.total_sessions).toBe(1);
    });
  });

  describe("proposition emission", () => {
    it("requires at least one registered source", () => {
      expect(() => store.emit([{ content: "Foo exists.", entities: ["Foo"], sources: ["a.ts"] }], C))
        .toThrow("Register a source file first");
    });

    it("rejects emit with unregistered source path", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      expect(() => store.emit([{ content: "Foo.", entities: ["Foo"], sources: ["unknown.ts"] }], C))
        .toThrow('Source "unknown.ts" is not registered');
    });

    it("emits propositions with entities", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.registerSource("auth.ts");

      const result = store.emit([
        { content: "Auth validates JWT tokens.", entities: ["Auth"], sources: ["auth.ts"] },
        { content: "Auth returns 401 for expired tokens.", entities: ["Auth"], sources: ["auth.ts"] },
      ], C);

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
      store.registerSource("auth.ts");

      const r1 = store.emit([{ content: "Foo does bar.", entities: ["Foo"], sources: ["auth.ts"] }], C);
      const r2 = store.emit([{ content: "Foo does bar.", entities: ["Foo"], sources: ["auth.ts"] }], C);

      expect(r1.created).toBe(1);
      expect(r2.created).toBe(0);
      expect(r2.deduplicated).toBe(1);
    });

    it("creates multiple entities", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.registerSource("auth.ts");

      const result = store.emit([
        { content: "Auth depends on Database.", entities: ["Auth", "Database"], sources: ["auth.ts"] },
      ], C);

      expect(result.entities_created).toBe(2);
      expect(result.propositions[0].entities).toHaveLength(2);
    });
  });

  describe("entity resolution", () => {
    it("resolves by normalized name", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{ content: "Foo exists.", entities: ["AuthService"], sources: ["a.ts"] }], C);
      const r2 = store.emit([{ content: "Bar exists.", entities: ["authservice"], sources: ["a.ts"] }], C);

      expect(r2.propositions[0].entities[0].resolution).toBe("normalized");
      expect(r2.entities_resolved).toBe(1);
      expect(r2.entities_created).toBe(0);
    });
  });

  describe("browse", () => {
    it("lists entities with proposition counts", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([
        { content: "Auth validates.", entities: ["Auth"], sources: ["a.ts"] },
        { content: "DB stores.", entities: ["Database"], sources: ["a.ts"] },
      ], C);
      store.end();

      const result = store.browse();
      expect(result.total).toBe(2);
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map((e) => e.name).sort()).toEqual(["Auth", "Database"]);
    });

    it("filters by name", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([
        { content: "Auth validates.", entities: ["Auth"], sources: ["a.ts"] },
        { content: "DB stores.", entities: ["Database"], sources: ["a.ts"] },
      ], C);
      store.end();

      const result = store.browse({ name: "auth" });
      expect(result.total).toBe(1);
      expect(result.entities[0].name).toBe("Auth");
    });

    it("paginates", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      for (let i = 0; i < 5; i++) {
        store.emit([{ content: `Entity ${i} exists.`, entities: [`Entity${i}`], sources: ["a.ts"] }], C);
      }
      store.end();

      const page1 = store.browse({ limit: 2, offset: 0 });
      expect(page1.total).toBe(5);
      expect(page1.entities).toHaveLength(2);
    });
  });

  describe("inspect", () => {
    it("returns propositions and source sessions", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.registerSource("auth.ts");
      store.emit([
        { content: "Auth validates JWT tokens.", entities: ["Auth"], sources: ["auth.ts"] },
        { content: "Auth returns 401 for expired tokens.", entities: ["Auth"], sources: ["auth.ts"] },
      ], C);
      store.end();

      const result = store.inspect("Auth");

      expect(result.entity.name).toBe("Auth");
      expect(result.entity.proposition_count).toBe(2);
      expect(result.entity.valid_proposition_count).toBe(2);
      expect(result.propositions).toHaveLength(2);
      expect(result.propositions[0].valid).toBe(true);
      expect(result.source_sessions).toHaveLength(1);
      expect(result.source_sessions[0].files).toEqual(["auth.ts"]);
    });

    it("resolves by name", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{ content: "Foo exists.", entities: ["MyService"], sources: ["a.ts"] }], C);
      store.end();

      const result = store.inspect("MyService");
      expect(result.entity.name).toBe("MyService");
    });

    it("throws for unknown entity", () => {
      expect(() => store.inspect("nonexistent")).toThrow("Entity not found");
    });

    it("shows source sessions from multiple compilations", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      writeFile(tmpDir, "spec.md", "# Auth Spec");

      store.registerSource("auth.ts");
      store.emit([{ content: "Auth validates tokens.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      store.end();

      store.registerSource("spec.md");
      store.emit([{ content: "Auth should support refresh.", entities: ["Auth"], sources: ["spec.md"] }], C);
      store.end();

      const result = store.inspect("Auth");
      expect(result.propositions).toHaveLength(2);
      expect(result.source_sessions).toHaveLength(2);
      const allFiles = result.source_sessions.flatMap((s) => s.files).sort();
      expect(allFiles).toEqual(["auth.ts", "spec.md"]);
    });
  });

  describe("bySource", () => {
    it("finds propositions from sessions that included a file", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth validates.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      store.end();

      const result = store.bySource("auth.ts");
      expect(result.file_path).toBe("auth.ts");
      expect(result.propositions).toHaveLength(1);
      expect(result.propositions[0].content).toBe("Auth validates.");
    });
  });

  describe("search", () => {
    it("finds propositions immediately after emit (same connection)", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{ content: "Auth validates JWT tokens.", entities: ["Auth"], sources: ["a.ts"] }], C);
      store.end();

      const result = store.search("JWT");
      expect(result.propositions).toHaveLength(1);
      expect(result.propositions[0].content).toContain("JWT");
    });
  });

  describe("status", () => {
    it("returns overall counts", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([
        { content: "Foo exists.", entities: ["Foo"], sources: ["a.ts"] },
        { content: "Bar exists.", entities: ["Bar"], sources: ["a.ts"] },
      ], C);
      store.end();

      const result = store.status();
      expect(result.total_propositions).toBe(2);
      expect(result.valid_propositions).toBe(2);
      expect(result.stale_propositions).toBe(0);
      expect(result.total_entities).toBe(2);
      expect(result.total_sessions).toBe(1);
      expect(result.active_session).toBeNull();
    });
  });

  describe("provenance validation", () => {
    it("propositions valid when files unchanged", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      store.end();

      const result = store.inspect("Auth");
      expect(result.propositions[0].valid).toBe(true);
    });

    it("propositions stale when files changed", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      store.end();

      writeFile(tmpDir, "auth.ts", "class Auth { validate() {} }");

      const result = store.inspect("Auth");
      expect(result.propositions[0].valid).toBe(false);
      expect(result.propositions[0].source_files[0].current_match).toBe(false);
    });

    it("propositions stale when files deleted", () => {
      const filePath = writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      store.end();

      fs.unlinkSync(filePath);

      const result = store.inspect("Auth");
      expect(result.propositions[0].valid).toBe(false);
    });

    it("status reflects valid/stale counts", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      store.end();

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

      store.registerSource("auth.ts");
      store.emit([{ content: "Auth validates.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      store.end();

      store.registerSource("db.ts");
      store.emit([{ content: "DB stores.", entities: ["Database"], sources: ["db.ts"] }], C);
      store.end();

      writeFile(tmpDir, "auth.ts", "class Auth { changed }");

      const status = store.status();
      expect(status.valid_propositions).toBe(1);
      expect(status.stale_propositions).toBe(1);

      expect(store.inspect("Database").propositions[0].valid).toBe(true);
      expect(store.inspect("Auth").propositions[0].valid).toBe(false);
    });

    it("multiple sessions referencing same file — only matching hash is valid", () => {
      writeFile(tmpDir, "auth.ts", "version 1");
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth v1.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      store.end();

      writeFile(tmpDir, "auth.ts", "version 2");
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth v2.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      store.end();

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

      store.registerSource("a.ts");
      store.registerSource("b.ts");
      store.emit([{ content: "Uses both.", entities: ["Multi"], sources: ["a.ts", "b.ts"] }], C);
      store.end();

      expect(store.inspect("Multi").propositions[0].valid).toBe(true);

      writeFile(tmpDir, "b.ts", "b2");
      expect(store.inspect("Multi").propositions[0].valid).toBe(false);
    });
  });

  describe("cross-session knowledge", () => {
    it("accumulates knowledge across sessions", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      writeFile(tmpDir, "db.ts", "class DB {}");

      store.registerSource("auth.ts");
      store.emit([{ content: "Auth validates tokens.", entities: ["Auth"], sources: ["auth.ts"] }], C);
      store.end();

      store.registerSource("db.ts");
      store.emit([{ content: "DB stores users.", entities: ["Database"], sources: ["db.ts"] }], C);
      store.end();

      const status = store.status();
      expect(status.total_propositions).toBe(2);
      expect(status.total_entities).toBe(2);
      expect(status.total_sessions).toBe(2);
    });

    it("deduplication works across sessions", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{ content: "Auth validates tokens.", entities: ["Auth"], sources: ["a.ts"] }], C);
      store.end();

      writeFile(tmpDir, "b.ts", "y");
      store.registerSource("b.ts");
      const r = store.emit([{ content: "Auth validates tokens.", entities: ["Auth"], sources: ["b.ts"] }], C);
      expect(r.deduplicated).toBe(1);
      expect(r.created).toBe(0);
      store.end();

      expect(store.status().total_propositions).toBe(1);
    });
  });

  describe("stateless multi-process access", () => {
    it("second store instance sees active session from first", () => {
      const dbPath = path.join(tmpDir, "memory.db");
      const store2 = new MemoryStore(dbPath, tmpDir);

      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");

      // store2 sees the active session
      expect(store2.status().active_session).toBeTruthy();

      // store2 can register a source in the same session
      writeFile(tmpDir, "b.ts", "y");
      store2.registerSource("b.ts");

      // store can emit (both sources are registered)
      store.emit([{ content: "Uses both.", entities: ["Multi"], sources: ["a.ts", "b.ts"] }], C);
      store.end();

      // store2 sees the results
      const result = store2.browse({ name: "Multi" });
      expect(result.entities).toHaveLength(1);

      store2.close();
    });
  });

  describe("entityKinds", () => {
    it("sets kind on entity creation", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{
        content: "Auth validates tokens.",
        entities: ["Auth"],
        sources: ["a.ts"],
        entityKinds: { Auth: "class" },
      }], C);
      store.end();

      const result = store.browse({ name: "Auth" });
      expect(result.entities[0].kind).toBe("class");
    });

    it("kind is null when entityKinds not provided", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{ content: "Foo exists.", entities: ["Foo"], sources: ["a.ts"] }], C);
      store.end();

      const result = store.browse({ name: "Foo" });
      expect(result.entities[0].kind).toBeNull();
    });

    it("existing entity keeps its kind on re-resolution", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{
        content: "Auth validates.",
        entities: ["Auth"],
        sources: ["a.ts"],
        entityKinds: { Auth: "class" },
      }], C);
      // Re-resolve same entity without kind — should keep original
      store.emit([{
        content: "Auth also logs.",
        entities: ["Auth"],
        sources: ["a.ts"],
      }], C);
      store.end();

      const result = store.browse({ name: "Auth" });
      expect(result.entities[0].kind).toBe("class");
    });
  });

  describe("neighbors", () => {
    it("inspect returns co-occurring entities with valid counts", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([
        { content: "Auth depends on Database.", entities: ["Auth", "Database"], sources: ["a.ts"] },
        { content: "Auth uses Cache for tokens.", entities: ["Auth", "Cache"], sources: ["a.ts"] },
      ], C);
      store.end();

      const result = store.inspect("Auth");
      expect(result.neighbors).toHaveLength(2);
      const names = result.neighbors.map((n) => n.name).sort();
      expect(names).toEqual(["Cache", "Database"]);
      expect(result.neighbors[0].shared_propositions).toBe(1);
      expect(result.neighbors[0].valid_shared_propositions).toBe(1);
    });

    it("no neighbors for isolated entity", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{ content: "Standalone exists.", entities: ["Standalone"], sources: ["a.ts"] }], C);
      store.end();

      const result = store.inspect("Standalone");
      expect(result.neighbors).toHaveLength(0);
    });

    it("valid count drops when source goes stale", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([
        { content: "Auth depends on Database.", entities: ["Auth", "Database"], sources: ["a.ts"] },
      ], C);
      store.end();

      writeFile(tmpDir, "b.ts", "y");
      store.registerSource("b.ts");
      store.emit([
        { content: "Auth also uses Database for caching.", entities: ["Auth", "Database"], sources: ["b.ts"] },
      ], C);
      store.end();

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
      store.registerSource("a.ts");
      store.emit([
        { content: "Auth depends on Database for user lookups.", entities: ["Auth", "Database"], sources: ["a.ts"] },
        { content: "Auth uses Cache to store sessions.", entities: ["Auth", "Cache"], sources: ["a.ts"] },
        { content: "Auth also queries Database for roles.", entities: ["Auth", "Database"], sources: ["a.ts"] },
      ], C);
      store.end();

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
  });

  describe("collections", () => {
    it("rejects unknown collection on emit", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      expect(() => store.emit([{ content: "Foo.", entities: ["Foo"], sources: ["a.ts"] }], "unknown"))
        .toThrow('Unknown collection "unknown"');
    });

    it("same proposition in two collections creates two rows", () => {
      const colStore = new MemoryStore(
        path.join(tmpDir, "col.db"), tmpDir, [],
        [
          { name: "spec", description: "Specs", paths: [""] },
          { name: "domain", description: "Domain", paths: [""] },
        ]
      );

      writeFile(tmpDir, "a.ts", "x");
      colStore.registerSource("a.ts");
      colStore.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["a.ts"] }], "spec");
      colStore.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["a.ts"] }], "domain");
      colStore.end();

      const status = colStore.status();
      expect(status.total_propositions).toBe(2);
      colStore.close();
    });

    it("deduplicates within the same collection", () => {
      const colStore = new MemoryStore(
        path.join(tmpDir, "col2.db"), tmpDir, [],
        [{ name: "spec", description: "Specs", paths: [""] }]
      );

      writeFile(tmpDir, "a.ts", "x");
      colStore.registerSource("a.ts");
      const r1 = colStore.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["a.ts"] }], "spec");
      const r2 = colStore.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["a.ts"] }], "spec");
      expect(r1.created).toBe(1);
      expect(r2.deduplicated).toBe(1);
      colStore.end();
      colStore.close();
    });

    it("browse with collection filter scopes results", () => {
      const colStore = new MemoryStore(
        path.join(tmpDir, "col3.db"), tmpDir, [],
        [
          { name: "spec", description: "Specs", paths: [""] },
          { name: "domain", description: "Domain", paths: [""] },
        ]
      );

      writeFile(tmpDir, "a.ts", "x");
      colStore.registerSource("a.ts");
      colStore.emit([{ content: "Auth validates.", entities: ["Auth"], sources: ["a.ts"] }], "spec");
      colStore.emit([{ content: "DB stores.", entities: ["Database"], sources: ["a.ts"] }], "domain");
      colStore.end();

      const specResult = colStore.browse({ collection: "spec" });
      expect(specResult.entities).toHaveLength(1);
      expect(specResult.entities[0].name).toBe("Auth");

      const allResult = colStore.browse();
      expect(allResult.entities).toHaveLength(2);

      colStore.close();
    });

    it("inspect with collection filter shows only that collection's propositions", () => {
      const colStore = new MemoryStore(
        path.join(tmpDir, "col4.db"), tmpDir, [],
        [
          { name: "spec", description: "Specs", paths: [""] },
          { name: "domain", description: "Domain", paths: [""] },
        ]
      );

      writeFile(tmpDir, "a.ts", "x");
      colStore.registerSource("a.ts");
      colStore.emit([{ content: "Auth spec claim.", entities: ["Auth"], sources: ["a.ts"] }], "spec");
      colStore.emit([{ content: "Auth domain claim.", entities: ["Auth"], sources: ["a.ts"] }], "domain");
      colStore.end();

      const specResult = colStore.inspect("Auth", "spec");
      expect(specResult.propositions).toHaveLength(1);
      expect(specResult.propositions[0].content).toBe("Auth spec claim.");
      expect(specResult.propositions[0].collection).toBe("spec");

      const allResult = colStore.inspect("Auth");
      expect(allResult.propositions).toHaveLength(2);

      colStore.close();
    });

    it("search with collection filter scopes results", () => {
      const colStore = new MemoryStore(
        path.join(tmpDir, "col5.db"), tmpDir, [],
        [
          { name: "spec", description: "Specs", paths: [""] },
          { name: "domain", description: "Domain", paths: [""] },
        ]
      );

      writeFile(tmpDir, "a.ts", "x");
      colStore.registerSource("a.ts");
      colStore.emit([{ content: "Auth validates tokens.", entities: ["Auth"], sources: ["a.ts"] }], "spec");
      colStore.emit([{ content: "Auth handles requests.", entities: ["Auth"], sources: ["a.ts"] }], "domain");
      colStore.end();

      const specResult = colStore.search("Auth", { collection: "spec" });
      expect(specResult.propositions).toHaveLength(1);
      expect(specResult.propositions[0].collection).toBe("spec");

      const allResult = colStore.search("Auth");
      expect(allResult.propositions).toHaveLength(2);

      colStore.close();
    });

    it("status scoped to collection", () => {
      const colStore = new MemoryStore(
        path.join(tmpDir, "col6.db"), tmpDir, [],
        [
          { name: "spec", description: "Specs", paths: [""] },
          { name: "domain", description: "Domain", paths: [""] },
        ]
      );

      writeFile(tmpDir, "a.ts", "x");
      colStore.registerSource("a.ts");
      colStore.emit([{ content: "Spec prop.", entities: ["Spec"], sources: ["a.ts"] }], "spec");
      colStore.emit([{ content: "Domain prop 1.", entities: ["Dom"], sources: ["a.ts"] }], "domain");
      colStore.emit([{ content: "Domain prop 2.", entities: ["Dom"], sources: ["a.ts"] }], "domain");
      colStore.end();

      expect(colStore.status("spec").total_propositions).toBe(1);
      expect(colStore.status("domain").total_propositions).toBe(2);
      expect(colStore.status().total_propositions).toBe(3);

      colStore.close();
    });

    it("default collection synthesized when none configured", () => {
      const collections = store.getCollections();
      expect(collections).toHaveLength(1);
      expect(collections[0].name).toBe("default");
    });

    it("propositions include collection label in results", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.registerSource("a.ts");
      store.emit([{ content: "Auth exists.", entities: ["Auth"], sources: ["a.ts"] }], C);
      store.end();

      const result = store.inspect("Auth");
      expect(result.propositions[0].collection).toBe("default");
    });
  });
});
