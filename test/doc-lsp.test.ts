import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DocumentIndexStore } from "../src/doc-lsp/index-builder.js";
import { DocLspTools } from "../src/doc-lsp/tools.js";
import { parseDocument } from "../src/doc-lsp/parser.js";
import type { DocLspConfig, CorpusConfig } from "../src/doc-lsp/types.js";

let tmpDir: string;
let corpusRoot: string;

const testCorpus: CorpusConfig = {
  name: "test-corpus",
  root: "", // set in beforeAll
  patterns: {
    concern_id: "[A-Z]+-\\d+\\.\\d+",
    asvs_ref: "V\\d+\\.\\d+\\.\\d+",
  },
  frontMatter: true,
};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-lsp-test-"));
  corpusRoot = path.join(tmpDir, "docs");
  fs.mkdirSync(corpusRoot, { recursive: true });
  fs.mkdirSync(path.join(corpusRoot, "protocols"), { recursive: true });
  fs.mkdirSync(path.join(corpusRoot, "implementations"), { recursive: true });

  // Create test documents
  fs.writeFileSync(
    path.join(corpusRoot, "protocols", "frontend-security.md"),
    `---
type: Protocol
depends_on:
  - path: backbone/asvs-v5.md
    relationship: implements
    ids: ["V5.2.3", "V5.2.6"]
---

# PROTO-FRONTEND-001: Frontend Security Protocol

## FE-1.1: Unsafe HTML Rendering

### Risk

Cross-site scripting via unsafe HTML rendering.

### Detection Criteria

Look for innerHTML usage and dangerouslySetInnerHTML.

## FE-1.2: Client-Side URL Validation

### Risk

Open redirect vulnerabilities.

### Detection Criteria

Check URL parsing in client code.
`
  );

  fs.writeFileSync(
    path.join(corpusRoot, "implementations", "modern-frontend.md"),
    `---
type: Implementation
depends_on:
  - path: protocols/frontend-security.md
    relationship: implements
---

# Modern Frontend Security Implementation

## FE-1.1: Unsafe HTML Rendering

Implementation details for modern stack.

### Detection

Use ESLint rules to flag innerHTML.

### Remediation

Replace with textContent or sanitized HTML.

## FE-1.2: Client-Side URL Validation

Implementation for URL validation.
`
  );

  // Update testCorpus root
  (testCorpus as { root: string }).root = corpusRoot;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parser", () => {
  it("parses a markdown document with headings and front-matter", () => {
    const doc = parseDocument(
      path.join(corpusRoot, "protocols", "frontend-security.md"),
      "protocols/frontend-security.md",
      testCorpus
    );

    expect(doc.corpus).toBe("test-corpus");
    expect(doc.path).toBe("protocols/frontend-security.md");
    expect(doc.frontMatter).toBeTruthy();
    expect(doc.frontMatter?.type).toBe("Protocol");

    // Should find headings
    expect(doc.headings.length).toBeGreaterThan(0);
    const h1 = doc.headings.find((h) => h.level === 1);
    expect(h1?.text).toContain("Frontend Security Protocol");

    // Should extract concern IDs
    expect(doc.ids).toContain("FE-1.1");
    expect(doc.ids).toContain("FE-1.2");

    // Should extract ASVS refs from body text
    expect(doc.ids).toContain("V5.2.3");
    expect(doc.ids).toContain("V5.2.6");
  });

  it("builds section ranges", () => {
    const doc = parseDocument(
      path.join(corpusRoot, "protocols", "frontend-security.md"),
      "protocols/frontend-security.md",
      testCorpus
    );

    expect(doc.sections.length).toBeGreaterThan(0);
    const feSection = doc.sections.find((s) => s.heading.ids.includes("FE-1.1"));
    expect(feSection).toBeTruthy();
    expect(feSection!.startLine).toBeGreaterThan(0);
    expect(feSection!.endLine).toBeGreaterThan(feSection!.startLine);
  });
});

describe("DocumentIndexStore", () => {
  let index: DocumentIndexStore;

  beforeAll(() => {
    const config: DocLspConfig = { corpora: [testCorpus] };
    index = new DocumentIndexStore(config);
    const result = index.build();
    expect(result.documents).toBeGreaterThan(0);
    expect(result.ids).toBeGreaterThan(0);
  });

  it("resolves IDs to locations", () => {
    const locations = index.resolveId("FE-1.1");
    expect(locations.length).toBeGreaterThanOrEqual(2);
    expect(locations.some((l) => l.path.includes("protocols"))).toBe(true);
    expect(locations.some((l) => l.path.includes("implementations"))).toBe(true);
  });

  it("returns empty for unknown ID", () => {
    const locations = index.resolveId("UNKNOWN-99.99");
    expect(locations).toHaveLength(0);
  });

  it("finds document by relative path", () => {
    const doc = index.findDocument("protocols/frontend-security.md");
    expect(doc).toBeTruthy();
    expect(doc!.corpus).toBe("test-corpus");
  });

  it("gets all documents in a corpus", () => {
    const docs = index.getCorpusDocuments("test-corpus");
    expect(docs).toHaveLength(2);
  });

  it("lists all IDs", () => {
    const ids = index.allIds();
    expect(ids).toContain("FE-1.1");
    expect(ids).toContain("FE-1.2");
  });

  it("reindexes a changed file", () => {
    const filePath = path.join(corpusRoot, "protocols", "frontend-security.md");
    const original = fs.readFileSync(filePath, "utf-8");

    // Add a new concern ID
    fs.writeFileSync(
      filePath,
      original + "\n## FE-1.3: New Concern\n\nNew content.\n"
    );

    index.reindexFile(filePath);
    const locations = index.resolveId("FE-1.3");
    expect(locations.length).toBeGreaterThan(0);

    // Restore
    fs.writeFileSync(filePath, original);
    index.reindexFile(filePath);
  });

  it("handles deleted file", () => {
    const newFile = path.join(corpusRoot, "protocols", "temp.md");
    fs.writeFileSync(newFile, "# TEMP-1.1: Temporary\n\nTemp content.\n");
    index.reindexFile(newFile);
    expect(index.resolveId("TEMP-1.1").length).toBeGreaterThan(0);

    fs.unlinkSync(newFile);
    index.reindexFile(newFile);
    expect(index.resolveId("TEMP-1.1")).toHaveLength(0);
  });
});

describe("DocLspTools", () => {
  let tools: DocLspTools;

  beforeAll(() => {
    const config: DocLspConfig = { corpora: [testCorpus] };
    const index = new DocumentIndexStore(config);
    index.build();
    tools = new DocLspTools(index);
  });

  describe("resolve", () => {
    it("resolves a concern ID to multiple locations", () => {
      const result = tools.resolve("FE-1.1");
      expect(result.locations.length).toBeGreaterThanOrEqual(2);
    });

    it("returns empty for unknown ID", () => {
      const result = tools.resolve("NONEXISTENT-99.99");
      expect(result.locations).toHaveLength(0);
    });
  });

  describe("section", () => {
    it("retrieves section content with hash", () => {
      const result = tools.section("protocols/frontend-security.md", "FE-1.1");
      expect(result).toBeTruthy();
      expect(result!.content).toContain("Unsafe HTML Rendering");
      expect(result!.hash).toHaveLength(16);
      expect(result!.lineRange[0]).toBeGreaterThan(0);
      expect(result!.subsections.length).toBeGreaterThan(0);
    });

    it("returns null for missing section", () => {
      const result = tools.section("protocols/frontend-security.md", "NONEXISTENT");
      expect(result).toBeNull();
    });

    it("returns null for missing document", () => {
      const result = tools.section("nonexistent.md", "FE-1.1");
      expect(result).toBeNull();
    });

    it("produces consistent hashes", () => {
      const r1 = tools.section("protocols/frontend-security.md", "FE-1.1");
      const r2 = tools.section("protocols/frontend-security.md", "FE-1.1");
      expect(r1!.hash).toBe(r2!.hash);
    });
  });

  describe("structure", () => {
    it("returns document structure", () => {
      const result = tools.structure("protocols/frontend-security.md");
      expect(result).toBeTruthy();
      expect(result!.headings.length).toBeGreaterThan(0);
      expect(result!.frontMatter).toBeTruthy();
      expect(result!.ids).toContain("FE-1.1");
    });

    it("returns null for missing document", () => {
      const result = tools.structure("nonexistent.md");
      expect(result).toBeNull();
    });
  });

  describe("dependencies", () => {
    it("returns dependencies from front-matter", () => {
      const result = tools.dependencies("protocols/frontend-security.md");
      expect(result).toBeTruthy();
      expect(result!.dependsOn.length).toBeGreaterThan(0);
      expect(result!.dependsOn[0].relationship).toBe("implements");
    });

    it("finds reverse dependencies", () => {
      const result = tools.dependencies("protocols/frontend-security.md");
      expect(result).toBeTruthy();
      expect(result!.dependedOnBy.length).toBeGreaterThan(0);
      expect(
        result!.dependedOnBy.some((d) => d.path.includes("implementations"))
      ).toBe(true);
    });

    it("returns null for missing document", () => {
      const result = tools.dependencies("nonexistent.md");
      expect(result).toBeNull();
    });
  });

  describe("coverage", () => {
    it("reports coverage for a corpus", () => {
      const result = tools.coverage("test-corpus");
      expect(result).toBeTruthy();
      expect(result!.documents).toBe(2);
      expect(result!.ids).toBeGreaterThan(0);
    });

    it("returns null for unknown corpus", () => {
      const result = tools.coverage("nonexistent-corpus");
      expect(result).toBeNull();
    });
  });
});
