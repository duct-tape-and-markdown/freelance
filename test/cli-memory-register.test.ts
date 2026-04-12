/**
 * Tests for the memory-register CLI command's traversal gate.
 *
 * The CLI command opens the state store and checks for active memory
 * traversals via TraversalStore.hasActiveTraversalForGraph. These tests
 * verify the gate logic using the same state-store interface the command
 * consumes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateStore, type StateStore } from "../src/state/index.js";
import { COMPILE_KNOWLEDGE_ID } from "../src/memory/workflow.js";
import { RECOLLECTION_ID } from "../src/memory/recollection.js";

/**
 * Mirrors the gate check in `src/cli/program.ts` memory-register command.
 * Returns true if any active traversal belongs to the memory compilation
 * or recall workflows.
 */
function hasActiveMemoryTraversal(state: StateStore): boolean {
  const memoryIds = new Set([COMPILE_KNOWLEDGE_ID, RECOLLECTION_ID]);
  return state.list().some((r) => memoryIds.has(r.graphId));
}

function putTraversal(state: StateStore, id: string, graphId: string, currentNode: string): void {
  const now = new Date().toISOString();
  state.put({
    id,
    stack: [],
    graphId,
    currentNode,
    stackDepth: 1,
    createdAt: now,
    updatedAt: now,
  });
}

describe("memory-register traversal gate", () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-reg-gate-"));
    stateDir = path.join(tmpDir, "traversals");
    state = openStateStore(stateDir);
  });

  afterEach(() => {
    state.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when no traversals exist", () => {
    expect(hasActiveMemoryTraversal(state)).toBe(false);
  });

  it("returns true with active memory:compile traversal", () => {
    putTraversal(state, "tr_test0001", COMPILE_KNOWLEDGE_ID, "exploring");
    expect(hasActiveMemoryTraversal(state)).toBe(true);
  });

  it("returns true with active memory:recall traversal", () => {
    putTraversal(state, "tr_test0002", RECOLLECTION_ID, "recalling");
    expect(hasActiveMemoryTraversal(state)).toBe(true);
  });

  it("returns false with only non-memory traversals active", () => {
    putTraversal(state, "tr_test0003", "some-other-workflow", "step1");
    expect(hasActiveMemoryTraversal(state)).toBe(false);
  });

  it("uses correct constant values for graph IDs", () => {
    expect(COMPILE_KNOWLEDGE_ID).toBe("memory:compile");
    expect(RECOLLECTION_ID).toBe("memory:recall");
  });
});
