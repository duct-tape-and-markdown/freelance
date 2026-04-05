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
    const dbPath = path.join(tmpDir, "memory.db");
    store = new MemoryStore(dbPath, tmpDir);
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
      expect(begin.total_propositions).toBe(0);

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

    it("end counts deduplicated propositions", () => {
      // Session 1: create a proposition
      store.begin();
      store.emit([{ content: "Foo exists.", entities: ["Foo"] }]);
      store.end();

      // Session 2: emit same content (deduplicated) + a new one
      store.begin();
      store.emit([
        { content: "Foo exists.", entities: ["Foo"] },
        { content: "Bar exists.", entities: ["Bar"] },
      ]);
      const end = store.end();

      // Should count both: 1 deduped + 1 new = 2
      expect(end.propositions_emitted).toBe(2);
      expect(end.entities_referenced).toBe(2);
    });
  });

  describe("source registration", () => {
    it("registers a source file", () => {
      writeFile(tmpDir, "test.ts", "const x = 1;");
      store.begin();

      const result = store.registerSource("test.ts");
      expect(result.file_path).toBe("test.ts");
      expect(result.content_hash).toBeTruthy();
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
  });

  describe("proposition emission", () => {
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
      expect(result.entities_created).toBe(1); // Auth created once
      expect(result.entities_resolved).toBe(1); // Auth resolved second time
      expect(result.propositions).toHaveLength(2);
      expect(result.propositions[0].status).toBe("created");
      expect(result.propositions[0].entities).toHaveLength(1);
      expect(result.propositions[0].entities[0].name).toBe("Auth");
    });

    it("deduplicates by content hash", () => {
      store.begin();
      const r1 = store.emit([{ content: "Foo does bar.", entities: ["Foo"] }]);
      const r2 = store.emit([{ content: "Foo does bar.", entities: ["Foo"] }]);

      expect(r1.created).toBe(1);
      expect(r2.created).toBe(0);
      expect(r2.deduplicated).toBe(1);
      expect(r2.propositions[0].status).toBe("deduplicated");
    });

    it("creates multiple entities", () => {
      store.begin();
      const result = store.emit([
        { content: "Auth depends on Database.", entities: ["Auth", "Database"] },
      ]);

      expect(result.entities_created).toBe(2);
      expect(result.propositions[0].entities).toHaveLength(2);
    });
  });

  describe("entity resolution", () => {
    it("resolves by normalized name", () => {
      store.begin();
      store.emit([{ content: "Foo exists.", entities: ["AuthService"] }]);
      const r2 = store.emit([{ content: "Bar exists.", entities: ["authservice"] }]);

      expect(r2.propositions[0].entities[0].resolution).toBe("normalized");
      expect(r2.entities_resolved).toBe(1);
      expect(r2.entities_created).toBe(0);
    });
  });

  describe("browse", () => {
    it("lists entities", () => {
      store.begin();
      store.emit([
        { content: "Auth validates.", entities: ["Auth"] },
        { content: "DB stores.", entities: ["Database"] },
      ]);
      store.end();

      const result = store.browse();
      expect(result.total).toBe(2);
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map((e) => e.name).sort()).toEqual(["Auth", "Database"]);
    });

    it("filters by name", () => {
      store.begin();
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
      store.begin();
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
    it("returns entity details with propositions", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");
      store.begin();
      store.registerSource("auth.ts");
      store.emit([
        { content: "Auth validates JWT tokens.", entities: ["Auth"] },
        { content: "Auth returns 401 for expired tokens.", entities: ["Auth"] },
      ]);
      store.end();

      const browse = store.browse({ name: "Auth" });
      const result = store.inspect(browse.entities[0].id);

      expect(result.entity.name).toBe("Auth");
      expect(result.propositions).toHaveLength(2);
      expect(result.propositions[0].valid).toBe(true);
      expect(result.propositions[0].source_files).toHaveLength(1);
      expect(result.propositions[0].source_files[0].path).toBe("auth.ts");
    });

    it("resolves by name", () => {
      store.begin();
      store.emit([{ content: "Foo exists.", entities: ["MyService"] }]);
      store.end();

      const result = store.inspect("MyService");
      expect(result.entity.name).toBe("MyService");
    });

    it("throws for unknown entity", () => {
      expect(() => store.inspect("nonexistent")).toThrow("Entity not found");
    });
  });

  describe("relationships", () => {
    it("finds shared propositions", () => {
      store.begin();
      store.emit([
        { content: "Auth depends on Database.", entities: ["Auth", "Database"] },
        { content: "Auth validates tokens.", entities: ["Auth"] },
        { content: "Database stores users.", entities: ["Database"] },
      ]);
      store.end();

      const result = store.relationships("Auth", "Database");
      expect(result.shared_propositions).toHaveLength(1);
      expect(result.shared_propositions[0].content).toBe("Auth depends on Database.");
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
      store.begin();
      store.emit([
        { content: "Foo exists.", entities: ["Foo"] },
        { content: "Bar exists.", entities: ["Bar"] },
      ]);
      store.end();

      const result = store.status();
      expect(result.total_propositions).toBe(2);
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

      // Modify the file
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
  });

  describe("gaps", () => {
    it("identifies unimplemented intents", () => {
      store.begin();
      store.emit([
        { content: "Auth validates tokens.", entities: ["Auth"], kind: "intent" },
        { content: "Auth supports refresh.", entities: ["Auth"], kind: "intent" },
      ]);
      // Same content as first intent, but as observation = match
      store.emit([
        { content: "Auth validates tokens.", entities: ["Auth"], kind: "observation" },
      ]);
      store.end();

      const result = store.gaps();
      expect(result.matched).toHaveLength(1);
      expect(result.matched[0].content).toBe("Auth validates tokens.");
      expect(result.unimplemented).toHaveLength(1);
      expect(result.unimplemented[0].content).toBe("Auth supports refresh.");
    });

    it("identifies unplanned observations", () => {
      store.begin();
      store.emit([
        { content: "Auth logs failed attempts.", entities: ["Auth"], kind: "observation" },
      ]);
      store.end();

      const result = store.gaps();
      expect(result.unplanned).toHaveLength(1);
      expect(result.unplanned[0].content).toBe("Auth logs failed attempts.");
    });

    it("works with mixed-kind emissions in a single session", () => {
      // Both intent and observation in the same session — should still work
      store.begin();
      store.emit([
        { content: "Auth validates tokens.", entities: ["Auth"], kind: "intent" },
        { content: "Auth validates tokens.", entities: ["Auth"], kind: "observation" },
        { content: "Auth supports refresh.", entities: ["Auth"], kind: "intent" },
        { content: "Auth logs errors.", entities: ["Auth"], kind: "observation" },
      ]);
      store.end();

      const result = store.gaps();
      expect(result.matched).toHaveLength(1);
      expect(result.matched[0].content).toBe("Auth validates tokens.");
      expect(result.unimplemented).toHaveLength(1);
      expect(result.unimplemented[0].content).toBe("Auth supports refresh.");
      expect(result.unplanned).toHaveLength(1);
      expect(result.unplanned[0].content).toBe("Auth logs errors.");
    });

    it("defaults to observation when kind not specified", () => {
      store.begin();
      store.emit([
        { content: "Auth exists.", entities: ["Auth"] }, // no kind = observation
      ]);
      store.end();

      const result = store.gaps();
      expect(result.unplanned).toHaveLength(1);
      expect(result.unimplemented).toHaveLength(0);
    });

    it("same content deduplicates within same kind but not across kinds", () => {
      store.begin();
      store.emit([
        { content: "Auth validates tokens.", entities: ["Auth"], kind: "intent" },
      ]);
      // Emitting same content as intent again = deduplicated
      const r2 = store.emit([
        { content: "Auth validates tokens.", entities: ["Auth"], kind: "intent" },
      ]);
      expect(r2.deduplicated).toBe(1);

      // Same content as observation = new proposition
      const r3 = store.emit([
        { content: "Auth validates tokens.", entities: ["Auth"], kind: "observation" },
      ]);
      expect(r3.created).toBe(1);
      store.end();

      const result = store.gaps();
      expect(result.matched).toHaveLength(1);
    });
  });

  describe("cross-session knowledge", () => {
    it("accumulates knowledge across sessions", () => {
      writeFile(tmpDir, "auth.ts", "class Auth {}");

      // Session 1
      store.begin();
      store.registerSource("auth.ts");
      store.emit([{ content: "Auth validates tokens.", entities: ["Auth"] }]);
      store.end();

      // Session 2
      writeFile(tmpDir, "db.ts", "class DB {}");
      store.begin();
      store.registerSource("db.ts");
      store.emit([{ content: "DB stores users.", entities: ["Database"] }]);
      store.end();

      const status = store.status();
      expect(status.total_propositions).toBe(2);
      expect(status.total_entities).toBe(2);
      expect(status.total_sessions).toBe(2);
    });

    it("second session sees first session entities", () => {
      store.begin();
      store.emit([{ content: "Auth validates.", entities: ["Auth"] }]);
      store.end();

      const begin2 = store.begin();
      expect(begin2.entities).toBe(1);
      expect(begin2.total_propositions).toBe(1);
      store.end();
    });
  });
});
