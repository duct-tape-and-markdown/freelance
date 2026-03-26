/**
 * Section hash contract test.
 *
 * These hashes are the contract between Freelance and document-lsp.
 * Both projects must produce identical hashes for the same fixture.
 * If extraction or hashing logic changes in either project, these tests
 * break — that's the point.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractSection } from "../src/section-resolver.js";
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
