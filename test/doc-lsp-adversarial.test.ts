/**
 * Adversarial test data for Document LSP.
 * Tests edge cases from the review: empty files, duplicate headings,
 * concern-ID-like strings in code blocks, CRLF, BOM, no headings, etc.
 */
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
  name: "adversarial",
  root: "",
  patterns: {
    concern_id: "[A-Z]+-\\d+\\.\\d+",
  },
  frontMatter: true,
};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-lsp-adversarial-"));
  corpusRoot = tmpDir;
  (testCorpus as { root: string }).root = corpusRoot;

  // Empty file
  fs.writeFileSync(path.join(corpusRoot, "empty.md"), "");

  // File with no headings
  fs.writeFileSync(
    path.join(corpusRoot, "no-headings.md"),
    "Just a paragraph with no headings.\n\nAnother paragraph mentioning FE-1.1.\n"
  );

  // File with duplicate headings
  fs.writeFileSync(
    path.join(corpusRoot, "duplicates.md"),
    "# Title\n\n## FE-1.1: First\n\nContent A.\n\n## FE-1.1: Second\n\nContent B.\n"
  );

  // File with concern IDs inside code blocks
  fs.writeFileSync(
    path.join(corpusRoot, "code-blocks.md"),
    "# Real Section\n\nSome text.\n\n```\n## FE-2.1: This is a code block heading\n```\n\n## FE-3.1: Real Heading\n\nReal content.\n"
  );

  // File with CRLF line endings
  fs.writeFileSync(
    path.join(corpusRoot, "crlf.md"),
    "---\r\ntype: Test\r\n---\r\n\r\n# CRLF Doc\r\n\r\n## SEC-1.1: CRLF Section\r\n\r\nContent with CRLF.\r\n"
  );

  // File with UTF-8 BOM
  fs.writeFileSync(
    path.join(corpusRoot, "bom.md"),
    "\uFEFF# BOM Document\n\n## BOM-1.1: Section\n\nContent.\n"
  );

  // File with invalid front-matter
  fs.writeFileSync(
    path.join(corpusRoot, "bad-frontmatter.md"),
    "---\n: invalid yaml [[\n---\n\n# Bad Front-Matter\n\nContent.\n"
  );

  // File with only front-matter, no body
  fs.writeFileSync(
    path.join(corpusRoot, "frontmatter-only.md"),
    "---\ntype: Stub\n---\n"
  );

  // File with deeply nested headings
  fs.writeFileSync(
    path.join(corpusRoot, "deep-nesting.md"),
    "# L1\n\n## L2\n\n### L3\n\n#### L4\n\n##### L5\n\n###### L6\n\nDeep content.\n"
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildTools(): DocLspTools {
  const config: DocLspConfig = { corpora: [testCorpus] };
  const index = new DocumentIndexStore(config);
  index.build();
  return new DocLspTools(index);
}

describe("adversarial: empty file", () => {
  it("parses without crashing", () => {
    const doc = parseDocument(
      path.join(corpusRoot, "empty.md"),
      "empty.md",
      testCorpus
    );
    expect(doc.headings).toHaveLength(0);
    expect(doc.ids).toHaveLength(0);
    expect(doc.sections).toHaveLength(0);
  });

  it("doc_structure returns empty structure", () => {
    const tools = buildTools();
    const result = tools.structure("empty.md");
    expect(result).not.toBeNull();
    expect(result!.headings).toHaveLength(0);
    expect(result!.ids).toHaveLength(0);
  });
});

describe("adversarial: no headings", () => {
  it("finds inline IDs but no heading-level IDs", () => {
    const doc = parseDocument(
      path.join(corpusRoot, "no-headings.md"),
      "no-headings.md",
      testCorpus
    );
    expect(doc.headings).toHaveLength(0);
    // FE-1.1 appears in body text
    expect(doc.ids).toContain("FE-1.1");
  });

  it("doc_resolve finds inline IDs [O-5]", () => {
    const tools = buildTools();
    const result = tools.resolve("FE-1.1");
    // Should find it in no-headings.md as an inline reference
    const inNoHeadings = result.locations.some(
      (l) => l.path === "no-headings.md"
    );
    expect(inNoHeadings).toBe(true);
  });
});

describe("adversarial: duplicate headings", () => {
  it("indexes both instances of the same ID", () => {
    const tools = buildTools();
    const result = tools.resolve("FE-1.1");
    const inDuplicates = result.locations.filter(
      (l) => l.path === "duplicates.md"
    );
    expect(inDuplicates.length).toBe(2);
  });

  it("doc_section returns the first match", () => {
    const tools = buildTools();
    const result = tools.section("duplicates.md", "FE-1.1");
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Content A");
  });
});

describe("adversarial: code blocks", () => {
  it("remark AST ignores headings inside code blocks", () => {
    const doc = parseDocument(
      path.join(corpusRoot, "code-blocks.md"),
      "code-blocks.md",
      testCorpus
    );
    // Only real headings should be in the headings list
    const headingTexts = doc.headings.map((h) => h.text);
    expect(headingTexts).not.toContain("FE-2.1: This is a code block heading");
    expect(headingTexts).toContain("FE-3.1: Real Heading");
  });

  it("inline ID scan picks up IDs in code blocks (acceptable)", () => {
    const doc = parseDocument(
      path.join(corpusRoot, "code-blocks.md"),
      "code-blocks.md",
      testCorpus
    );
    // The raw text scan finds FE-2.1 in the code block — this is acceptable
    expect(doc.ids).toContain("FE-2.1");
    expect(doc.ids).toContain("FE-3.1");
  });
});

describe("adversarial: CRLF", () => {
  it("parses CRLF files correctly", () => {
    const doc = parseDocument(
      path.join(corpusRoot, "crlf.md"),
      "crlf.md",
      testCorpus
    );
    expect(doc.frontMatter).toBeTruthy();
    expect(doc.frontMatter?.type).toBe("Test");
    expect(doc.ids).toContain("SEC-1.1");
  });
});

describe("adversarial: BOM", () => {
  it("parses files with UTF-8 BOM", () => {
    const doc = parseDocument(
      path.join(corpusRoot, "bom.md"),
      "bom.md",
      testCorpus
    );
    expect(doc.headings.length).toBeGreaterThan(0);
    expect(doc.ids).toContain("BOM-1.1");
  });
});

describe("adversarial: invalid front-matter", () => {
  it("skips invalid front-matter without crashing", () => {
    const doc = parseDocument(
      path.join(corpusRoot, "bad-frontmatter.md"),
      "bad-frontmatter.md",
      testCorpus
    );
    expect(doc.frontMatter).toBeNull();
    expect(doc.headings.length).toBeGreaterThan(0);
  });
});

describe("adversarial: section matching [S-2]", () => {
  it("does not match FE-1 as a prefix of FE-1.1", () => {
    const tools = buildTools();
    // "FE-1" should NOT match "FE-1.1: First" via substring
    const result = tools.section("duplicates.md", "FE-1");
    expect(result).toBeNull();
  });

  it("matches FE-1.1 via exact ID", () => {
    const tools = buildTools();
    const result = tools.section("duplicates.md", "FE-1.1");
    expect(result).not.toBeNull();
  });
});

describe("adversarial: coverage scope [S-6]", () => {
  it("returns null for typo in corpus name", () => {
    const tools = buildTools();
    const result = tools.coverage("adversarail"); // typo
    expect(result).toBeNull();
  });

  it("returns results for correct corpus name", () => {
    const tools = buildTools();
    const result = tools.coverage("adversarial");
    expect(result).not.toBeNull();
    expect(result!.documents).toBeGreaterThan(0);
  });
});

describe("adversarial: path separator [M-4]", () => {
  it("does not match corpus root as prefix of different directory", () => {
    const config: DocLspConfig = {
      corpora: [{
        name: "short",
        root: "/tmp/docs",
        patterns: {},
        frontMatter: false,
      }],
    };
    const index = new DocumentIndexStore(config);
    // /tmp/docs-backup should NOT match corpus root /tmp/docs
    index.reindexFile("/tmp/docs-backup/file.md");
    // Should not crash and should not index the file
    expect(index.allDocuments()).toHaveLength(0);
  });
});

describe("adversarial: source basePath resolution [O-4]", () => {
  it("resolves relative paths against basePath", async () => {
    const { hashSource } = await import("../src/sources.js");

    // Create a file in a subdirectory
    const subDir = path.join(tmpDir, "subdir");
    fs.mkdirSync(subDir, { recursive: true });
    const file = path.join(subDir, "test.md");
    fs.writeFileSync(file, "# Test\n\nContent.\n");

    // Hash with basePath
    const result = hashSource(
      { path: "subdir/test.md" },
      { basePath: tmpDir }
    );
    expect(result.hash).toHaveLength(16);
    expect(result.path).toBe("subdir/test.md"); // preserves original path

    // Same file via absolute path
    const absolute = hashSource({ path: file });
    expect(absolute.hash).toBe(result.hash);

    fs.rmSync(subDir, { recursive: true });
  });
});
