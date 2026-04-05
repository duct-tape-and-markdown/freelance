import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
}

function writeFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

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
    it("begin and end a session", () => {
      const begin = store.begin();
      expect(begin.session_id).toBeTruthy();
      expect(begin.entities).toBe(0);
      expect(begin.valid_propositions).toBe(0);
      expect(begin.stale).toBe(0);

      const end = store.end();
      expect(end.session_id).toBe(begin.session_id);
      expect(end.propositions_emitted).toBe(0);
      expect(end.files_registered).toBe(0);
      expect(end.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("rejects double begin", () => {
      store.begin();
      expect(() => store.begin()).toThrow("Session already active");
    });

    it("rejects end without begin", () => {
      expect(() => store.end()).toThrow("No active session");
    });

    it("rejects emit without begin", () => {
      expect(() => store.emit([{ content: "test", entities: ["Foo"] }])).toThrow("No active session");
    });

    it("rejects register without begin", () => {
      expect(() => store.registerSource("test.ts")).toThrow("No active session");
    });
  });

  describe("source registration", () => {
    it("registers a source file", () => {
      writeFile(tmpDir, "test.ts", "const x = 1;");
      store.begin();

      const result = store.registerSource("test.ts");
      expect(result.file_path).toBe("test.ts");
      expect(result.content_hash).toHaveLength(16);
      expect(result.status).toBe("registered");
    });

    it("updates hash on re-registration", () => {
      writeFile(tmpDir, "test.ts", "const x = 1;");
      store.begin();

      const r1 = store.registerSource("test.ts");
      writeFile(tmpDir, "test.ts", "const x = 2;");
      const r2 = store.registerSource("test.ts");

      expect(r2.status).toBe("updated");
      expect(r2.content_hash).not.toBe(r1.content_hash);
    });

    it("rejects missing files", () => {
      store.begin();
      expect(() => store.registerSource("nonexistent.ts")).toThrow("Cannot read file");
    });

    it("rejects paths outside source root", () => {
      store.begin();
      expect(() => store.registerSource("/etc/passwd")).toThrow("outside the source root");
      expect(() => store.registerSource("../../etc/passwd")).toThrow("outside the source root");
    });

    it("accepts absolute paths within source root", () => {
      const filePath = writeFile(tmpDir, "inner.ts", "const x = 1;");
      store.begin();
      const result = store.registerSource(filePath);
      expect(result.status).toBe("registered");
    });
  });

  describe("proposition emission", () => {
    it("requires at least one registered source", () => {
      store.begin();
      expect(() => store.emit([{ content: "Foo exists.", entities: ["Foo"] }]))
        .toThrow("No source files registered");
    });

    it("emits propositions with entities", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.begin();
      store.registerSource("auth.ts");

      const result = store.emit([
        { content: "Auth validates JWT tokens.", entities: ["Auth"] },
        { content: "Auth returns 401 for expired tokens.", entities: ["Auth"] },
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
      store.begin();
      store.registerSource("auth.ts");

      const r1 = store.emit([{ content: "Foo does bar.", entities: ["Foo"] }]);
      const r2 = store.emit([{ content: "Foo does bar.", entities: ["Foo"] }]);

      expect(r1.created).toBe(1);
      expect(r2.created).toBe(0);
      expect(r2.deduplicated).toBe(1);
      expect(r2.propositions[0].status).toBe("deduplicated");
    });

    it("creates multiple entities", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.begin();
      store.registerSource("auth.ts");

      const result = store.emit([
        { content: "Auth depends on Database.", entities: ["Auth", "Database"] },
      ]);

      expect(result.entities_created).toBe(2);
      expect(result.propositions[0].entities).toHaveLength(2);
    });
  });

  describe("entity resolution", () => {
    it("resolves by normalized name", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.begin();
      store.registerSource("a.ts");
      store.emit([{ content: "Foo exists.", entities: ["AuthService"] }]);
      const r2 = store.emit([{ content: "Bar exists.", entities: ["authservice"] }]);

      expect(r2.propositions[0].entities[0].resolution).toBe("normalized");
      expect(r2.entities_resolved).toBe(1);
      expect(r2.entities_created).toBe(0);
    });
  });

  describe("browse", () => {
    it("lists entities with proposition counts", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.begin();
      store.registerSource("a.ts");
      store.emit([
        { content: "Auth validates.", entities: ["Auth"] },
        { content: "DB stores.", entities: ["Database"] },
      ]);
      store.end();

      const result = store.browse();
      expect(result.total).toBe(2);
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map((e) => e.name).sort()).toEqual(["Auth", "Database"]);
      expect(result.entities.every((e) => e.proposition_count === 1)).toBe(true);
    });

    it("filters by name", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.begin();
      store.registerSource("a.ts");
      store.emit([
        { content: "Auth validates.", entities: ["Auth"] },
        { content: "DB stores.", entities: ["Database"] },
      ]);
      store.end();

      const result = store.browse({ name: "auth" });
      expect(result.total).toBe(1);
      expect(result.entities[0].name).toBe("Auth");
    });

    it("paginates", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.begin();
      store.registerSource("a.ts");
      for (let i = 0; i < 5; i++) {
        store.emit([{ content: `Entity ${i} exists.`, entities: [`Entity${i}`] }]);
      }
      store.end();

      const page1 = store.browse({ limit: 2, offset: 0 });
      expect(page1.total).toBe(5);
      expect(page1.entities).toHaveLength(2);

      const page2 = store.browse({ limit: 2, offset: 2 });
      expect(page2.entities).toHaveLength(2);
    });
  });

  describe("inspect", () => {
    it("returns propositions and source sessions", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.begin();
      store.registerSource("auth.ts");
      store.emit([
        { content: "Auth validates JWT tokens.", entities: ["Auth"] },
        { content: "Auth returns 401 for expired tokens.", entities: ["Auth"] },
      ]);
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
      store.begin();
      store.registerSource("a.ts");
      store.emit([{ content: "Foo exists.", entities: ["MyService"] }]);
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

      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth validates tokens.", entities: ["Auth"] }]);
      store.end();

      store.begin();
      store.registerSource("spec.md");
      store.emit([{ content: "Auth should support refresh.", entities: ["Auth"] }]);
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
      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth validates.", entities: ["Auth"] }]);
      store.end();

      const result = store.bySource("auth.ts");
      expect(result.file_path).toBe("auth.ts");
      expect(result.propositions).toHaveLength(1);
      expect(result.propositions[0].content).toBe("Auth validates.");
    });
  });

  describe("status", () => {
    it("returns overall counts", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.begin();
      store.registerSource("a.ts");
      store.emit([
        { content: "Foo exists.", entities: ["Foo"] },
        { content: "Bar exists.", entities: ["Bar"] },
      ]);
      store.end();

      const result = store.status();
      expect(result.total_propositions).toBe(2);
      expect(result.valid_propositions).toBe(2);
      expect(result.stale_propositions).toBe(0);
      expect(result.total_entities).toBe(2);
      expect(result.total_sessions).toBe(1);
      expect(result.active_session).toBeNull();
    });

    it("shows active session during compilation", () => {
      const begin = store.begin();
      const status = store.status();
      expect(status.active_session).toBe(begin.session_id);
    });
  });

  describe("provenance validation", () => {
    it("propositions valid when files unchanged", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth exists.", entities: ["Auth"] }]);
      store.end();

      const result = store.inspect("Auth");
      expect(result.propositions[0].valid).toBe(true);
    });

    it("propositions stale when files changed", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth exists.", entities: ["Auth"] }]);
      store.end();

      writeFile(tmpDir, "auth.ts", "class Auth { validate() {} }");

      const result = store.inspect("Auth");
      expect(result.propositions[0].valid).toBe(false);
      expect(result.propositions[0].source_files[0].current_match).toBe(false);
    });

    it("propositions stale when files deleted", () => {
      const filePath = writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth exists.", entities: ["Auth"] }]);
      store.end();

      fs.unlinkSync(filePath);

      const result = store.inspect("Auth");
      expect(result.propositions[0].valid).toBe(false);
    });

    it("status reflects valid/stale counts", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth exists.", entities: ["Auth"] }]);
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

      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth validates.", entities: ["Auth"] }]);
      store.end();

      store.begin();
      store.registerSource("db.ts");
      store.emit([{ content: "DB stores.", entities: ["Database"] }]);
      store.end();

      // Change auth.ts — only auth session goes stale
      writeFile(tmpDir, "auth.ts", "class Auth { changed }");

      const status = store.status();
      expect(status.valid_propositions).toBe(1);
      expect(status.stale_propositions).toBe(1);

      // DB propositions still valid
      const dbResult = store.inspect("Database");
      expect(dbResult.propositions[0].valid).toBe(true);

      // Auth propositions stale
      const authResult = store.inspect("Auth");
      expect(authResult.propositions[0].valid).toBe(false);
    });

    it("multiple sessions referencing same file — only matching hash is valid", () => {
      writeFile(tmpDir, "auth.ts", "version 1");
      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth v1.", entities: ["Auth"] }]);
      store.end();

      // Change file, compile again
      writeFile(tmpDir, "auth.ts", "version 2");
      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth v2.", entities: ["Auth"] }]);
      store.end();

      // File is at "version 2" — session 2 valid, session 1 stale
      const result = store.inspect("Auth");
      const v1 = result.propositions.find((p) => p.content === "Auth v1.");
      const v2 = result.propositions.find((p) => p.content === "Auth v2.");
      expect(v1!.valid).toBe(false);
      expect(v2!.valid).toBe(true);

      // Revert file — session 1 becomes valid, session 2 stale
      writeFile(tmpDir, "auth.ts", "version 1");
      const result2 = store.inspect("Auth");
      const v1b = result2.propositions.find((p) => p.content === "Auth v1.");
      const v2b = result2.propositions.find((p) => p.content === "Auth v2.");
      expect(v1b!.valid).toBe(true);
      expect(v2b!.valid).toBe(false);
    });

    it("session with multiple files — all must match for valid", () => {
      writeFile(tmpDir, "a.ts", "a1");
      writeFile(tmpDir, "b.ts", "b1");

      store.begin();
      store.registerSource("a.ts");
      store.registerSource("b.ts");
      store.emit([{ content: "Uses both.", entities: ["Multi"] }]);
      store.end();

      // Both unchanged — valid
      expect(store.inspect("Multi").propositions[0].valid).toBe(true);

      // Change one — stale
      writeFile(tmpDir, "b.ts", "b2");
      expect(store.inspect("Multi").propositions[0].valid).toBe(false);
    });
  });

  describe("cross-session knowledge", () => {
    it("accumulates knowledge across sessions", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      writeFile(tmpDir, "db.ts", "class DB {}");

      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth validates tokens.", entities: ["Auth"] }]);
      store.end();

      store.begin();
      store.registerSource("db.ts");
      store.emit([{ content: "DB stores users.", entities: ["Database"] }]);
      store.end();

      const status = store.status();
      expect(status.total_propositions).toBe(2);
      expect(status.total_entities).toBe(2);
      expect(status.total_sessions).toBe(2);
    });

    it("begin reflects accumulated state", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.begin();
      store.registerSource("a.ts");
      store.emit([{ content: "Auth validates.", entities: ["Auth"] }]);
      store.end();

      const begin2 = store.begin();
      expect(begin2.entities).toBe(1);
      expect(begin2.valid_propositions).toBe(1);
      store.end();
    });

    it("deduplication works across sessions", () => {
      writeFile(tmpDir, "a.ts", "x");
      store.begin();
      store.registerSource("a.ts");
      store.emit([{ content: "Auth validates tokens.", entities: ["Auth"] }]);
      store.end();

      writeFile(tmpDir, "b.ts", "y");
      store.begin();
      store.registerSource("b.ts");
      const r = store.emit([{ content: "Auth validates tokens.", entities: ["Auth"] }]);
      expect(r.deduplicated).toBe(1);
      expect(r.created).toBe(0);
      store.end();

      // Only one proposition exists
      expect(store.status().total_propositions).toBe(1);
    });
  });
});
