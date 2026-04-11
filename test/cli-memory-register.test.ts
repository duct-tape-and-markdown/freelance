/**
 * Tests for the memory-register CLI command's traversal gate.
 *
 * The CLI command opens the state DB and checks for active memory traversals
 * using a raw SQL query. These tests verify that query logic works correctly
 * against real SQLite state — the same DB schema and constants used by the CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDatabase } from "../src/state/index.js";
import { COMPILE_KNOWLEDGE_ID } from "../src/memory/workflow.js";
import { RECOLLECTION_ID } from "../src/memory/recollection.js";

/**
 * Mirrors the query used in `src/index.ts` memory-register command.
 * Tests that the SQL + constants correctly detect active memory traversals.
 */
function hasActiveMemoryTraversal(stateDbPath: string): boolean {
  const stateDb = openStateDatabase(stateDbPath);
  const graphIds = [COMPILE_KNOWLEDGE_ID, RECOLLECTION_ID];
  const placeholders = graphIds.map(() => "?").join(", ");
  const row = stateDb.prepare(
    `SELECT 1 FROM traversals WHERE graph_id IN (${placeholders}) LIMIT 1`
  ).get(...graphIds);
  stateDb.close();
  return row !== undefined;
}

describe("memory-register traversal gate (SQL query)", () => {
  let tmpDir: string;
  let stateDbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-reg-gate-"));
    stateDbPath = path.join(tmpDir, "state.db");
    // Create the state DB with schema
    const db = openStateDatabase(stateDbPath);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when no traversals exist", () => {
    expect(hasActiveMemoryTraversal(stateDbPath)).toBe(false);
  });

  it("returns true with active memory:compile traversal", () => {
    const db = openStateDatabase(stateDbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO traversals (id, stack, graph_id, current_node, stack_depth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("tr_test0001", "[]", COMPILE_KNOWLEDGE_ID, "exploring", 1, now, now);
    db.close();

    expect(hasActiveMemoryTraversal(stateDbPath)).toBe(true);
  });

  it("returns true with active memory:recall traversal", () => {
    const db = openStateDatabase(stateDbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO traversals (id, stack, graph_id, current_node, stack_depth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("tr_test0002", "[]", RECOLLECTION_ID, "recalling", 1, now, now);
    db.close();

    expect(hasActiveMemoryTraversal(stateDbPath)).toBe(true);
  });

  it("returns false with only non-memory traversals active", () => {
    const db = openStateDatabase(stateDbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO traversals (id, stack, graph_id, current_node, stack_depth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("tr_test0003", "[]", "some-other-workflow", "step1", 1, now, now);
    db.close();

    expect(hasActiveMemoryTraversal(stateDbPath)).toBe(false);
  });

  it("uses correct constant values for graph IDs", () => {
    expect(COMPILE_KNOWLEDGE_ID).toBe("memory:compile");
    expect(RECOLLECTION_ID).toBe("memory:recall");
  });
});
