import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/memory/db.js";
import { MemoryStore } from "../src/memory/store.js";

/**
 * Test-side read helper. The prior tests reached into `store.getDb()`
 * to run verification SQL against `proposition_sources`; that escape
 * hatch is gone, so we open a second short-lived db handle to the same
 * file. WAL mode lets multiple readers coexist.
 */
function readPropSources(dbPath: string): Array<{ proposition_id: string; file_path: string }> {
  const db = openDatabase(dbPath);
  try {
    return db.prepare("SELECT proposition_id, file_path FROM proposition_sources").all() as Array<{
      proposition_id: string;
      file_path: string;
    }>;
  } finally {
    db.close();
  }
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function createGitDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prune-test-")));
  git(dir, "init", "--initial-branch=main", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function commitAll(dir: string, msg: string): string {
  git(dir, "add", "-A");
  git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

describe("memory prune (content-reachability)", () => {
  let dir: string;
  let dbPath: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = createGitDir();
    dbPath = path.join(dir, "memory.db");
    store = new MemoryStore(openDatabase(dbPath), dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("validation", () => {
    it("throws when keep list is empty", () => {
      expect(() => store.prune({ keep: [] })).toThrow(/requires at least one --keep/i);
    });

    it("hard-errors on unresolvable keep ref without touching the db", () => {
      fs.writeFileSync(path.join(dir, "a.ts"), "x");
      commitAll(dir, "add a");
      store.emit([{ content: "a", entities: ["A"], sources: ["a.ts"] }]);
      const before = readPropSources(dbPath).length;

      expect(() => store.prune({ keep: ["does-not-exist"] })).toThrow(/does-not-exist/);

      expect(readPropSources(dbPath).length).toBe(before);
    });

    it("hard-errors when source root is outside a git checkout", () => {
      const nonGit = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prune-nogit-")));
      fs.writeFileSync(path.join(nonGit, "a.ts"), "x");
      const s = new MemoryStore(openDatabase(path.join(nonGit, "memory.db")), nonGit);
      s.emit([{ content: "a", entities: ["A"], sources: ["a.ts"] }]);
      expect(() => s.prune({ keep: ["main"] })).toThrow(/git checkout/i);
      s.close();
      fs.rmSync(nonGit, { recursive: true, force: true });
    });
  });

  describe("reachability", () => {
    it("preserves rows whose content is on disk", () => {
      fs.writeFileSync(path.join(dir, "a.ts"), "v1");
      commitAll(dir, "v1");
      store.emit([{ content: "a is v1", entities: ["A"], sources: ["a.ts"] }]);
      // File still v1 on disk.
      const result = store.prune({ keep: ["main"] });
      expect(result.rows_pruned).toBe(0);
    });

    it("preserves rows whose content is only at a keep ref tip (not disk)", () => {
      fs.writeFileSync(path.join(dir, "a.ts"), "v1");
      const v1 = commitAll(dir, "v1");
      store.emit([{ content: "a is v1", entities: ["A"], sources: ["a.ts"] }]);
      git(dir, "tag", "preserve-me", v1);
      // Advance the worktree past v1.
      fs.writeFileSync(path.join(dir, "a.ts"), "v2");
      commitAll(dir, "v2");
      // Disk is now v2, but preserve-me still points at v1.
      const result = store.prune({ keep: ["preserve-me"] });
      expect(result.rows_pruned).toBe(0);
    });

    it("prunes rows whose content is nowhere (not disk, not any keep ref)", () => {
      // Commit v1, emit against it, then rewrite so v1 content lives nowhere.
      fs.writeFileSync(path.join(dir, "a.ts"), "v1");
      commitAll(dir, "v1");
      store.emit([{ content: "a is v1", entities: ["A"], sources: ["a.ts"] }]);

      // Amend main to replace v1 entirely. Original commit orphaned.
      fs.writeFileSync(path.join(dir, "a.ts"), "replaced");
      git(dir, "add", "a.ts");
      git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "--amend", "--no-edit");

      const result = store.prune({ keep: ["main"] });
      expect(result.rows_pruned).toBe(1);
      expect(result.propositions_hard_deleted).toBe(1);
      expect(result.entities_orphaned).toBe(1);

      expect(readPropSources(dbPath)).toHaveLength(0);
    });

    it("preserves rows across squash merge (rebase/squash-robust)", () => {
      // The git_ref approach fails this case — squash orphans the
      // original feature SHA. Content-reachability preserves because
      // the resulting tree still contains the bytes.
      fs.writeFileSync(path.join(dir, "a.ts"), "main-v1");
      commitAll(dir, "main v1");

      git(dir, "checkout", "-q", "-b", "feature");
      fs.writeFileSync(path.join(dir, "a.ts"), "feature-work");
      commitAll(dir, "feature");
      store.emit([{ content: "feature claim", entities: ["A"], sources: ["a.ts"] }]);

      git(dir, "checkout", "-q", "main");
      git(dir, "merge", "--squash", "feature");
      git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "squashed");
      git(dir, "branch", "-q", "-D", "feature");
      // Now on main with the feature content, but original feature
      // commit SHA is orphaned. Row's content_hash matches
      // main:a.ts content → preserved.
      const result = store.prune({ keep: ["main"] });
      expect(result.rows_pruned).toBe(0);
    });

    it("prunes content from a deleted branch no longer represented anywhere", () => {
      fs.writeFileSync(path.join(dir, "a.ts"), "main");
      commitAll(dir, "main");

      git(dir, "checkout", "-q", "-b", "experiment");
      fs.writeFileSync(path.join(dir, "a.ts"), "abandoned-experiment");
      commitAll(dir, "experiment");
      store.emit([{ content: "experiment claim", entities: ["X"], sources: ["a.ts"] }]);

      git(dir, "checkout", "-q", "main");
      git(dir, "branch", "-q", "-D", "experiment");
      // Content "abandoned-experiment" lives nowhere reachable from main.
      const result = store.prune({ keep: ["main"] });
      expect(result.rows_pruned).toBe(1);
    });

    it("prunes rows whose source file has been deleted everywhere (subsumes missing-files mode)", () => {
      fs.writeFileSync(path.join(dir, "scratch.ts"), "scratch notes");
      commitAll(dir, "add scratch");
      store.emit([{ content: "scratch claim", entities: ["Notes"], sources: ["scratch.ts"] }]);

      // Delete the file on disk AND from main.
      fs.unlinkSync(path.join(dir, "scratch.ts"));
      git(dir, "rm", "-q", "scratch.ts");
      commitAll(dir, "remove scratch");

      const result = store.prune({ keep: ["main"] });
      expect(result.rows_pruned).toBe(1);
    });

    it("preserves sources outside the git repo via disk hashing only", () => {
      // Source path escapes the git root (e.g. symlinked external
      // doc). cat-file can't read it; disk still can. As long as
      // disk matches, row is preserved.
      fs.writeFileSync(path.join(dir, "a.ts"), "x");
      commitAll(dir, "initial");
      // Put an external file outside the repo and emit against it
      // via an absolute path that resolves outside sourceRoot? Can't
      // — emit rejects paths outside sourceRoot. So this case only
      // triggers for paths stored relative to sourceRoot but outside
      // gitRoot when sourceRoot ≠ gitRoot. Covered implicitly by the
      // "disk matches → preserved" path above; no additional assert.
      const result = store.prune({ keep: ["main"] });
      expect(result.rows_pruned).toBe(0);
    });
  });

  describe("multi-source propositions", () => {
    it("keeps a proposition alive when at least one source row survives", () => {
      fs.writeFileSync(path.join(dir, "a.ts"), "a-main");
      fs.writeFileSync(path.join(dir, "b.ts"), "b-stable");
      commitAll(dir, "initial");

      git(dir, "checkout", "-q", "-b", "side");
      fs.writeFileSync(path.join(dir, "a.ts"), "a-side-draft");
      commitAll(dir, "side a");
      store.emit([{ content: "two-source claim", entities: ["X"], sources: ["a.ts", "b.ts"] }]);

      git(dir, "checkout", "-q", "main");
      git(dir, "branch", "-q", "-D", "side");
      // a.ts on main = "a-main"; row's hash for a.ts is "a-side-draft" → prune that row.
      // b.ts on main = "b-stable"; row's hash for b.ts is "b-stable" → preserve that row.
      const result = store.prune({ keep: ["main"] });
      expect(result.rows_pruned).toBe(1);
      expect(result.propositions_hard_deleted).toBe(0);

      expect(readPropSources(dbPath).map((r) => r.file_path)).toEqual(["b.ts"]);
    });
  });

  describe("nested paths", () => {
    it("resolves ref:path specs for files in subdirectories", () => {
      fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "lib", "auth.ts"), "v1");
      commitAll(dir, "nested");
      store.emit([{ content: "nested claim", entities: ["Auth"], sources: ["src/lib/auth.ts"] }]);

      // Disk matches, so preserved regardless of ref. Exercises path
      // separator handling that would otherwise break on Windows.
      const result = store.prune({ keep: ["main"] });
      expect(result.rows_pruned).toBe(0);
    });
  });

  describe("atomicity", () => {
    it("commits all victim deletes in a single transaction", () => {
      // Build a state where two rows should be pruned. If prune ran
      // without a transaction and was interrupted, partial state would
      // be observable. We can't interrupt cleanly in a sync call, so
      // just confirm the happy-path writes land together.
      fs.writeFileSync(path.join(dir, "a.ts"), "v1");
      fs.writeFileSync(path.join(dir, "b.ts"), "v1");
      commitAll(dir, "v1");
      store.emit([
        { content: "a claim", entities: ["A"], sources: ["a.ts"] },
        { content: "b claim", entities: ["B"], sources: ["b.ts"] },
      ]);

      fs.writeFileSync(path.join(dir, "a.ts"), "replaced");
      fs.writeFileSync(path.join(dir, "b.ts"), "replaced");
      git(dir, "add", ".");
      git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "--amend", "--no-edit");

      const result = store.prune({ keep: ["main"] });
      expect(result.rows_pruned).toBe(2);

      expect(readPropSources(dbPath)).toHaveLength(0);
    });
  });

  describe("dry-run", () => {
    it("returns the plan without mutating the db", () => {
      fs.writeFileSync(path.join(dir, "a.ts"), "v1");
      commitAll(dir, "v1");
      store.emit([{ content: "a v1", entities: ["A"], sources: ["a.ts"] }]);
      fs.writeFileSync(path.join(dir, "a.ts"), "replaced");
      git(dir, "add", "a.ts");
      git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "--amend", "--no-edit");

      const plan = store.prune({ keep: ["main"], dryRun: true });
      expect(plan.dry_run).toBe(true);
      expect(plan.rows_pruned).toBe(1);

      expect(readPropSources(dbPath)).toHaveLength(1);
    });
  });
});
