import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphDefinition } from "../src/schema/graph-schema.js";
import {
  checkSourcesDetailed,
  hashContent,
  hashPropContent,
  hashSource,
  hashSources,
  validateGraphSources,
} from "../src/sources.js";

let tmpDir: string;
let fileA: string;
let fileB: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sources-test-"));
  fileA = path.join(tmpDir, "doc-a.md");
  fileB = path.join(tmpDir, "doc-b.md");
  fs.writeFileSync(fileA, "# Section A\n\nContent of section A.\n");
  fs.writeFileSync(fileB, "# Section B\n\nContent of section B.\n");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("hashContent vs hashPropContent", () => {
  // Two hashers for two purposes: hashContent is for source files
  // (minimal normalization, so real content drift is detected);
  // hashPropContent is for proposition dedup (stricter normalization,
  // so superficial variance doesn't create duplicate propositions).

  it("hashContent only normalizes CRLF→LF and trims trailing whitespace", () => {
    expect(hashContent("X validates Y")).toBe(hashContent("X validates Y\n"));
    expect(hashContent("X validates Y")).toBe(hashContent("X validates Y\r\n"));
    // Case matters for source hashing — it's real drift.
    expect(hashContent("X validates Y")).not.toBe(hashContent("x validates y"));
    // Trailing punctuation matters for source hashing — a file that
    // added a period really did change.
    expect(hashContent("X validates Y")).not.toBe(hashContent("X validates Y."));
  });

  it("hashPropContent collides on case variance", () => {
    expect(hashPropContent("X validates Y")).toBe(hashPropContent("x validates y"));
    expect(hashPropContent("VO2max trains via intervals")).toBe(
      hashPropContent("vo2max trains via intervals"),
    );
  });

  it("hashPropContent collides on whitespace variance", () => {
    expect(hashPropContent("X  validates  Y")).toBe(hashPropContent("X validates Y"));
    expect(hashPropContent("X\tvalidates\tY")).toBe(hashPropContent("X validates Y"));
    expect(hashPropContent("  X validates Y  ")).toBe(hashPropContent("X validates Y"));
  });

  it("hashPropContent collides on trailing sentence punctuation", () => {
    expect(hashPropContent("X validates Y")).toBe(hashPropContent("X validates Y."));
    expect(hashPropContent("X validates Y")).toBe(hashPropContent("X validates Y!"));
    expect(hashPropContent("X validates Y")).toBe(hashPropContent("X validates Y?"));
    expect(hashPropContent("X validates Y")).toBe(hashPropContent("X validates Y..."));
    expect(hashPropContent("X validates Y")).toBe(hashPropContent("X validates Y …"));
  });

  it("hashPropContent preserves internal punctuation", () => {
    // Internal commas/colons can carry meaning — don't collide distinct claims.
    expect(hashPropContent("A, B, and C are the pillars")).not.toBe(
      hashPropContent("A B C are the pillars"),
    );
    expect(hashPropContent("X: Y")).not.toBe(hashPropContent("X Y"));
  });

  it("hashPropContent still distinguishes genuinely different claims", () => {
    expect(hashPropContent("X validates Y")).not.toBe(hashPropContent("X does Y"));
    expect(hashPropContent("A depends on B")).not.toBe(hashPropContent("A replaces B"));
  });

  it("hashPropContent produces the same 16-char hex format as hashContent", () => {
    const hash = hashPropContent("some claim");
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("hashPropContent and hashContent produce different hashes for the same input", () => {
    // Migration note: propositions emitted before the switch to
    // hashPropContent were stored with hashContent digests. Re-emitting
    // the same content after the switch hits a different hash and
    // creates a new row rather than deduping. Both are valid; the
    // workaround is `freelance memory reset --confirm` + re-compile
    // to rebuild under the new hash regime. This test documents the
    // behavior so it isn't surprising later.
    expect(hashContent("X validates Y.")).not.toBe(hashPropContent("X validates Y."));
    expect(hashContent("X validates Y")).not.toBe(hashPropContent("X validates Y"));
  });
});

describe("hashSource", () => {
  it("hashes a whole file", () => {
    const result = hashSource({ path: fileA });
    expect(result.hash).toBeTruthy();
    expect(result.hash).toHaveLength(16);
    expect(result.path).toBe(fileA);
  });

  it("produces consistent hashes", () => {
    const h1 = hashSource({ path: fileA });
    const h2 = hashSource({ path: fileA });
    expect(h1.hash).toBe(h2.hash);
  });

  it("different files produce different hashes", () => {
    const hA = hashSource({ path: fileA });
    const hB = hashSource({ path: fileB });
    expect(hA.hash).not.toBe(hB.hash);
  });

  it("throws for missing file", () => {
    expect(() => hashSource({ path: "/nonexistent" })).toThrow("Source file not found");
  });

  it("uses section resolver when section is provided", () => {
    const resolver = (_filePath: string, section: string) => {
      if (section === "A") return "Content of section A.";
      return null;
    };
    const withSection = hashSource({ path: fileA, section: "A" }, resolver);
    const withoutSection = hashSource({ path: fileA });
    // Section content is different from full file
    expect(withSection.hash).not.toBe(withoutSection.hash);
  });

  it("falls back to whole file when section not found", () => {
    const resolver = () => null;
    const withResolver = hashSource({ path: fileA, section: "missing" }, resolver);
    const withoutResolver = hashSource({ path: fileA });
    expect(withResolver.hash).toBe(withoutResolver.hash);
  });
});

describe("hashSources", () => {
  it("hashes multiple sources with combined hash", () => {
    const result = hashSources([{ path: fileA }, { path: fileB }]);
    expect(result.hash).toHaveLength(16);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].path).toBe(fileA);
    expect(result.sources[1].path).toBe(fileB);
  });

  it("combined hash differs from individual hashes", () => {
    const result = hashSources([{ path: fileA }, { path: fileB }]);
    expect(result.hash).not.toBe(result.sources[0].hash);
    expect(result.hash).not.toBe(result.sources[1].hash);
  });

  it("combined hash is order-independent", () => {
    const ab = hashSources([{ path: fileA }, { path: fileB }]);
    const ba = hashSources([{ path: fileB }, { path: fileA }]);
    expect(ab.hash).toBe(ba.hash);
  });

  it("produces stable hashes across CRLF and LF", () => {
    const crlfFile = path.join(tmpDir, "crlf.md");
    const lfFile = path.join(tmpDir, "lf.md");
    fs.writeFileSync(crlfFile, "Line 1\r\nLine 2\r\n");
    fs.writeFileSync(lfFile, "Line 1\nLine 2\n");

    const crlfHash = hashSource({ path: crlfFile });
    const lfHash = hashSource({ path: lfFile });
    expect(crlfHash.hash).toBe(lfHash.hash);

    fs.unlinkSync(crlfFile);
    fs.unlinkSync(lfFile);
  });

  it("ignores trailing whitespace differences", () => {
    const trailingFile = path.join(tmpDir, "trailing.md");
    const noTrailingFile = path.join(tmpDir, "no-trailing.md");
    fs.writeFileSync(trailingFile, "Content here\n\n\n");
    fs.writeFileSync(noTrailingFile, "Content here");

    const h1 = hashSource({ path: trailingFile });
    const h2 = hashSource({ path: noTrailingFile });
    expect(h1.hash).toBe(h2.hash);

    fs.unlinkSync(trailingFile);
    fs.unlinkSync(noTrailingFile);
  });
});

describe("checkSourcesDetailed", () => {
  it("returns valid for unchanged sources", () => {
    const hashed = hashSources([{ path: fileA }, { path: fileB }]);
    const result = checkSourcesDetailed(hashed.sources);
    expect(result.valid).toBe(true);
    expect(result.drifted).toHaveLength(0);
  });

  it("identifies specific drifted source", () => {
    const hashed = hashSources([{ path: fileA }, { path: fileB }]);
    const originalContent = fs.readFileSync(fileB, "utf-8");
    fs.writeFileSync(fileB, "# Changed B\n\nNew content.\n");

    const result = checkSourcesDetailed(hashed.sources);
    expect(result.valid).toBe(false);
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].path).toBe(fileB);
    expect(result.drifted[0].expected).toBe(hashed.sources[1].hash);
    expect(result.drifted[0].actual).not.toBe(hashed.sources[1].hash);

    fs.writeFileSync(fileB, originalContent);
  });

  it("handles deleted file gracefully", () => {
    const tempFile = path.join(tmpDir, "to-delete.md");
    fs.writeFileSync(tempFile, "# Temporary\n\nWill be deleted.\n");
    const hashed = hashSources([{ path: tempFile }]);

    fs.unlinkSync(tempFile);

    const result = checkSourcesDetailed(hashed.sources);
    expect(result.valid).toBe(false);
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].path).toBe(tempFile);
    expect(result.drifted[0].actual).toBe("FILE_NOT_FOUND");
    expect(result.drifted[0].expected).toBe(hashed.sources[0].hash);
  });
});

describe("validateGraphSources", () => {
  it("returns valid for graph with no sources", () => {
    const definition: GraphDefinition = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test graph",
      startNode: "start",
      strictContext: false,
      nodes: {
        start: {
          type: "action",
          description: "Start node",
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "End" },
      },
    };
    const result = validateGraphSources(definition);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("detects drift in source-bound nodes", () => {
    const definition = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test graph",
      startNode: "start",
      strictContext: false,
      nodes: {
        start: {
          type: "action" as const,
          description: "Start node",
          sources: [{ path: fileA, hash: "wrong-hash-value!" }],
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal" as const, description: "End" },
      },
    };

    const result = validateGraphSources(definition as unknown as GraphDefinition);
    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].node).toBe("start");
    expect(result.warnings[0].drifted[0].path).toBe(fileA);
  });

  it("passes for matching source hashes", () => {
    const hashed = hashSource({ path: fileA });

    const definition = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test graph",
      startNode: "start",
      strictContext: false,
      nodes: {
        start: {
          type: "action" as const,
          description: "Start node",
          sources: [{ path: fileA, hash: hashed.hash }],
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal" as const, description: "End" },
      },
    };

    const result = validateGraphSources(definition as unknown as GraphDefinition);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
