/**
 * End-to-end integration for memory:compile with the build-manifest
 * programmatic node running against a real MemoryStore.
 *
 * Seeds a collection via direct memory_emit calls, then starts the
 * memory:compile workflow and verifies that:
 *   1. The drain loop populates context.manifest with entities from
 *      the seeded collection before the agent sees the exploring node.
 *   2. History records the programmatic hop with operation metadata.
 *   3. Starting against an empty (unseeded) collection still lands at
 *      exploring with an empty manifest, no errors.
 *   4. Starting without any collection argument lets the browse op
 *      run with undefined collection (global scope) — defensive path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/index.js";
import { createServer } from "../src/server.js";
import type { ValidatedGraph } from "../src/types.js";

function seedMemory(dbPath: string, sourceRoot: string): MemoryStore {
  const collections = [
    { name: "test-collection", description: "integration fixture", paths: [""] },
  ];
  const store = new MemoryStore(dbPath, sourceRoot, collections);
  // Write a couple of propositions so the manifest is non-empty.
  store.emit(
    [
      {
        content: "The drainer runs ops between agent turns.",
        entities: ["drainer", "ops"],
        sources: ["docs/drainer.md"],
      },
      {
        content: "Memory store is constructed before the traversal store.",
        entities: ["memory store", "traversal store"],
        sources: ["docs/wiring.md"],
      },
    ],
    "test-collection",
  );
  store.close();
  return store;
}

describe("memory:compile + build-manifest integration", () => {
  let tmpRoot: string;
  let memDir: string;
  let dbPath: string;
  let sourceDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mem-compile-"));
    memDir = path.join(tmpRoot, "memory");
    sourceDir = path.join(tmpRoot, "source");
    fs.mkdirSync(memDir, { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "docs"), { recursive: true });
    dbPath = path.join(memDir, "test.db");
    // Create source files so emit's source hashing doesn't fail silently.
    fs.writeFileSync(path.join(sourceDir, "docs/drainer.md"), "# drainer\n");
    fs.writeFileSync(path.join(sourceDir, "docs/wiring.md"), "# wiring\n");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("drains build-manifest and lands the agent at exploring with a populated manifest", () => {
    // Seed the memory store directly, close it, then hand the file path
    // to createServer so the server's own MemoryStore instance opens
    // the already-populated DB.
    seedMemory(dbPath, sourceDir);

    const graphs = new Map<string, ValidatedGraph>();
    const { manager, memoryStore } = createServer(graphs, {
      memory: {
        enabled: true,
        db: dbPath,
        collections: [{ name: "test-collection", description: "integration fixture", paths: [""] }],
      },
      sourceRoot: sourceDir,
    });
    try {
      expect(memoryStore).toBeDefined();

      const result = manager.createTraversal("memory:compile", {
        collection: "test-collection",
        query: "how does the drain loop work",
      });
      expect(result.status).toBe("started");
      expect(result.currentNode).toBe("exploring");
      // Manifest populated from the seeded store
      const manifest = result.context.manifest as Array<{ name: string }>;
      expect(Array.isArray(manifest)).toBe(true);
      expect(manifest.length).toBeGreaterThanOrEqual(2);
      const manifestNames = manifest.map((e) => e.name).sort();
      expect(manifestNames).toContain("drainer");
      expect(manifestNames).toContain("memory store");
      expect(result.context.manifestTotal).toBeGreaterThanOrEqual(2);
    } finally {
      memoryStore?.close();
      manager.close();
    }
  });

  it("records the programmatic hop in traversal history with operation metadata", () => {
    seedMemory(dbPath, sourceDir);
    const graphs = new Map<string, ValidatedGraph>();
    const { manager, memoryStore } = createServer(graphs, {
      memory: {
        enabled: true,
        db: dbPath,
        collections: [{ name: "test-collection", description: "integration fixture", paths: [""] }],
      },
      sourceRoot: sourceDir,
    });
    try {
      const start = manager.createTraversal("memory:compile", {
        collection: "test-collection",
        query: "test",
      });
      const history = manager.inspect(start.traversalId, "history");
      if (!("traversalHistory" in history)) throw new Error("expected history result");
      expect(history.traversalHistory).toHaveLength(1);
      const entry = history.traversalHistory[0];
      expect(entry.node).toBe("build-manifest");
      expect(entry.edge).toBe("manifest-ready");
      expect(entry.operation).toBeDefined();
      expect(entry.operation?.name).toBe("memory_browse");
      expect(entry.operation?.appliedUpdates).toHaveProperty("manifest");
      expect(entry.operation?.appliedUpdates).toHaveProperty("manifestTotal");
    } finally {
      memoryStore?.close();
      manager.close();
    }
  });

  it("lands at exploring with an empty manifest when the collection has no entities", () => {
    const graphs = new Map<string, ValidatedGraph>();
    const { manager, memoryStore } = createServer(graphs, {
      memory: {
        enabled: true,
        db: dbPath,
        collections: [{ name: "empty", description: "empty fixture", paths: [""] }],
      },
      sourceRoot: sourceDir,
    });
    try {
      const result = manager.createTraversal("memory:compile", {
        collection: "empty",
        query: "test",
      });
      expect(result.currentNode).toBe("exploring");
      expect(result.context.manifest).toEqual([]);
      expect(result.context.manifestTotal).toBe(0);
    } finally {
      memoryStore?.close();
      manager.close();
    }
  });

  it("lands at exploring with an empty manifest when no collection is specified", () => {
    // Empty-string collection default normalizes to undefined in the op,
    // so browse returns results from all collections (which is empty on
    // a fresh store).
    const graphs = new Map<string, ValidatedGraph>();
    const { manager, memoryStore } = createServer(graphs, {
      memory: { enabled: true, db: dbPath },
      sourceRoot: sourceDir,
    });
    try {
      const result = manager.createTraversal("memory:compile");
      expect(result.currentNode).toBe("exploring");
      expect(result.context.manifest).toEqual([]);
      expect(result.context.manifestTotal).toBe(0);
    } finally {
      memoryStore?.close();
      manager.close();
    }
  });
});
