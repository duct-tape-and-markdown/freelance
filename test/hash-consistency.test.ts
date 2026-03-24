import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DocumentIndexStore } from "../src/doc-lsp/index-builder.js";
import { DocLspTools } from "../src/doc-lsp/tools.js";
import { hashContent } from "../src/doc-lsp/hash.js";
import { hashSource } from "../src/sources.js";
import type { CorpusConfig, DocLspConfig } from "../src/doc-lsp/types.js";

let tmpDir: string;
let corpusRoot: string;
let docFile: string;

const testCorpus: CorpusConfig = {
  name: "hash-test",
  root: "",
  patterns: {},
  frontMatter: true,
};

function buildIndex(): { tools: DocLspTools; index: DocumentIndexStore } {
  const config: DocLspConfig = { corpora: [testCorpus] };
  const index = new DocumentIndexStore(config);
  index.build();
  const tools = new DocLspTools(index);
  return { tools, index };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hash-consistency-test-"));
  corpusRoot = path.join(tmpDir, "docs");
  fs.mkdirSync(corpusRoot, { recursive: true });

  docFile = path.join(corpusRoot, "example.md");
  fs.writeFileSync(
    docFile,
    "# Top\n\n## Section Alpha\n\nSome content here.\n\n## Section Beta\n\nOther content.\n"
  );

  (testCorpus as { root: string }).root = corpusRoot;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("hash consistency between doc-lsp and sources", () => {
  it("doc_section hash matches hashSource for the same section content", () => {
    const { tools } = buildIndex();
    const sectionResult = tools.section("example.md", "Section Alpha");
    expect(sectionResult).not.toBeNull();

    // Hash the same content through sources.ts using a resolver
    const resolver = () => sectionResult!.content;
    const sourceResult = hashSource({ path: docFile, section: "Section Alpha" }, resolver);

    expect(sourceResult.hash).toBe(sectionResult!.hash);
  });

  it("doc_section hash matches hashContent applied to the same raw content", () => {
    const { tools } = buildIndex();
    const sectionResult = tools.section("example.md", "Section Alpha");
    expect(sectionResult).not.toBeNull();

    const directHash = hashContent(sectionResult!.content);
    expect(directHash).toBe(sectionResult!.hash);
  });

  it("hashes match even with CRLF content", () => {
    const crlfFile = path.join(corpusRoot, "crlf-doc.md");
    fs.writeFileSync(
      crlfFile,
      "# Top\r\n\r\n## Section Alpha\r\n\r\nSome content here.\r\n\r\n## Section Beta\r\n\r\nOther content.\r\n"
    );

    const { tools } = buildIndex();
    const sectionResult = tools.section("crlf-doc.md", "Section Alpha");
    expect(sectionResult).not.toBeNull();

    // Hash through sources path with resolver
    const resolver = () => sectionResult!.content;
    const sourceResult = hashSource({ path: crlfFile, section: "Section Alpha" }, resolver);

    expect(sourceResult.hash).toBe(sectionResult!.hash);

    fs.unlinkSync(crlfFile);
  });

  it("whole-file hash from sources matches hashContent of file content", () => {
    const content = fs.readFileSync(docFile, "utf-8");
    const directHash = hashContent(content);
    const sourceResult = hashSource({ path: docFile });
    expect(sourceResult.hash).toBe(directHash);
  });
});
