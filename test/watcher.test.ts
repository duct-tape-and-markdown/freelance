import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchGraphs } from "../src/watcher.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function tmpGraphDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
  // Copy a valid graph to start with
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
    path.join(dir, "valid-simple.workflow.yaml")
  );
  return dir;
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("Graph watcher", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  it("calls onUpdate when a graph file is modified", async () => {
    const dir = tmpGraphDir();
    let updateCount = 0;

    const stop = watchGraphs({
      graphsDir: dir,
      onUpdate: () => { updateCount++; },
      onError: () => {},
      debounceMs: 50,
    });
    cleanups.push(stop);

    // Modify the file
    const graphFile = path.join(dir, "valid-simple.workflow.yaml");
    const content = fs.readFileSync(graphFile, "utf-8");
    fs.writeFileSync(graphFile, content); // touch

    await waitFor(() => updateCount > 0);
    expect(updateCount).toBeGreaterThan(0);
  });

  it("calls onError when validation fails", async () => {
    const dir = tmpGraphDir();
    let errorCount = 0;
    let lastError: Error | null = null;

    const stop = watchGraphs({
      graphsDir: dir,
      onUpdate: () => {},
      onError: (err) => { errorCount++; lastError = err; },
      debounceMs: 50,
    });
    cleanups.push(stop);

    // Remove valid graph and write only an invalid one so all graphs fail
    fs.unlinkSync(path.join(dir, "valid-simple.workflow.yaml"));
    fs.writeFileSync(
      path.join(dir, "broken.workflow.yaml"),
      "id: broken\nnot_valid: true\n"
    );

    await waitFor(() => errorCount > 0);
    expect(errorCount).toBeGreaterThan(0);
    expect(lastError).not.toBeNull();
  });

  it("ignores non-graph files", async () => {
    const dir = tmpGraphDir();
    let updateCount = 0;

    const stop = watchGraphs({
      graphsDir: dir,
      onUpdate: () => { updateCount++; },
      onError: () => {},
      debounceMs: 50,
    });
    cleanups.push(stop);

    // Write a non-graph file
    fs.writeFileSync(path.join(dir, "readme.md"), "# Hello\n");

    // Wait a bit — should NOT trigger
    await new Promise((r) => setTimeout(r, 300));
    expect(updateCount).toBe(0);
  });

  it("debounces rapid changes", async () => {
    const dir = tmpGraphDir();
    let updateCount = 0;

    const stop = watchGraphs({
      graphsDir: dir,
      onUpdate: () => { updateCount++; },
      onError: () => {},
      debounceMs: 100,
    });
    cleanups.push(stop);

    // Rapid-fire modifications
    const graphFile = path.join(dir, "valid-simple.workflow.yaml");
    const content = fs.readFileSync(graphFile, "utf-8");
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(graphFile, content);
    }

    await waitFor(() => updateCount > 0);
    // Debounce should coalesce into 1 (or at most 2) reloads
    expect(updateCount).toBeLessThanOrEqual(2);
  });

  it("stop function prevents further callbacks", async () => {
    const dir = tmpGraphDir();
    let updateCount = 0;

    const stop = watchGraphs({
      graphsDir: dir,
      onUpdate: () => { updateCount++; },
      onError: () => {},
      debounceMs: 50,
    });

    // Stop immediately
    stop();

    // Modify file
    const graphFile = path.join(dir, "valid-simple.workflow.yaml");
    const content = fs.readFileSync(graphFile, "utf-8");
    fs.writeFileSync(graphFile, content);

    await new Promise((r) => setTimeout(r, 300));
    expect(updateCount).toBe(0);
  });
});
