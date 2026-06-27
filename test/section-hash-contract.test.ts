/**
 * Section hash contract test.
 *
 * These hashes are the contract between Freelance and document-lsp.
 * Both projects must produce identical hashes for the same fixture.
 * If extraction or hashing logic changes in either project, these tests
 * break — that's the point.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCachingResolver, extractSection } from "../src/section-resolver.js";
import { hashContent } from "../src/sources.js";

const FIXTURE = path.resolve(__dirname, "fixtures/section-hash-contract.md");

// Contract hashes — must match document-lsp's test suite
const CONTRACT = {
  "Section A": "740fc766b7be4de4",
  "Section B": "0ba91bae73b29986",
  "Section C": "f2548c65438727d0",
};

describe("section hash contract", () => {
  it("extracts Section A (includes subsections, stops at same-level heading)", () => {
    const content = extractSection(FIXTURE, "Section A");
    expect(content).not.toBeNull();
    expect(content).toContain("## Section A");
    expect(content).toContain("### Subsection A.1");
    expect(content).not.toContain("## Section B");
    expect(hashContent(content!)).toBe(CONTRACT["Section A"]);
  });

  it("extracts Section B (matches via colon suffix)", () => {
    const content = extractSection(FIXTURE, "Section B");
    expect(content).not.toBeNull();
    expect(content).toContain("## Section B: With Colon Suffix");
    expect(content).not.toContain("## Section C");
    expect(hashContent(content!)).toBe(CONTRACT["Section B"]);
  });

  it("extracts Section C (runs to end of file)", () => {
    const content = extractSection(FIXTURE, "Section C");
    expect(content).not.toBeNull();
    expect(content).toContain("## Section C");
    expect(content).toContain("Final section.");
    expect(hashContent(content!)).toBe(CONTRACT["Section C"]);
  });

  it("returns null for nonexistent section", () => {
    expect(extractSection(FIXTURE, "Nonexistent")).toBeNull();
  });
});

describe("createCachingResolver (#331)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches extractSection output section-for-section", () => {
    const resolve = createCachingResolver();
    for (const section of ["Section A", "Section B", "Section C"] as const) {
      expect(resolve(FIXTURE, section)).toBe(extractSection(FIXTURE, section));
      expect(hashContent(resolve(FIXTURE, section)!)).toBe(CONTRACT[section]);
    }
    expect(resolve(FIXTURE, "Nonexistent")).toBeNull();
  });

  it("parses each file once across multiple section lookups", () => {
    const readSpy = vi.spyOn(fs, "readFileSync");
    const resolve = createCachingResolver();
    resolve(FIXTURE, "Section A");
    resolve(FIXTURE, "Section B");
    resolve(FIXTURE, "Section C");
    const readsOfFixture = readSpy.mock.calls.filter((c) => c[0] === FIXTURE).length;
    expect(readsOfFixture).toBe(1);
  });
});
