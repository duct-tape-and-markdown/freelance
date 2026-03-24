/**
 * Markdown document parser.
 *
 * Uses remark/unified for AST parsing and gray-matter for front-matter.
 * Self-contained — no imports from freelance core.
 */

import fs from "node:fs";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import matter from "gray-matter";
import type { Root, Heading, Content } from "mdast";
import type { HeadingInfo, SectionRange, DocumentIndex, CorpusConfig, IdPattern } from "./types.js";

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

/**
 * Compile regex patterns for a corpus. Call once per corpus, not per file. [M-3]
 */
export function compilePatterns(corpus: CorpusConfig): IdPattern[] {
  return Object.entries(corpus.patterns).map(
    ([name, regex]) => ({ name, regex: new RegExp(regex, "g") })
  );
}

/**
 * Parse a single markdown file into a DocumentIndex.
 * Accepts optional pre-compiled patterns to avoid re-compilation per file. [M-3]
 */
export function parseDocument(
  absolutePath: string,
  relativePath: string,
  corpus: CorpusConfig,
  precompiledPatterns?: IdPattern[]
): DocumentIndex {
  const raw = fs.readFileSync(absolutePath, "utf-8");
  const lines = raw.split("\n");

  // Extract front-matter
  let frontMatter: Record<string, unknown> | null = null;
  if (corpus.frontMatter) {
    try {
      const parsed = matter(raw);
      if (parsed.data && Object.keys(parsed.data).length > 0) {
        frontMatter = parsed.data as Record<string, unknown>;
      }
    } catch {
      // Non-fatal: skip front-matter on parse failure
    }
  }

  // Parse AST
  const tree = processor.parse(raw) as Root;

  // Use pre-compiled patterns or compile fresh
  const idPatterns: IdPattern[] = precompiledPatterns ?? compilePatterns(corpus);

  // Extract headings with IDs
  const headings: HeadingInfo[] = [];
  for (const node of tree.children) {
    if (node.type === "heading") {
      const heading = node as Heading;
      const text = extractHeadingText(heading);
      const line = heading.position?.start.line ?? 0;
      const ids = extractIds(text, idPatterns);
      headings.push({ level: heading.depth, text, line, ids });
    }
  }

  // Build section ranges
  const sections = buildSectionRanges(headings, lines.length);

  // Collect all IDs (from headings + front-matter + body)
  const allIds = new Set<string>();
  for (const h of headings) {
    for (const id of h.ids) allIds.add(id);
  }

  // Scan full document text for IDs not already found in headings
  for (const pattern of idPatterns) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(raw)) !== null) {
      allIds.add(match[0]);
    }
  }

  return {
    path: relativePath,
    absolutePath,
    corpus: corpus.name,
    headings,
    sections,
    frontMatter,
    ids: [...allIds],
  };
}

/**
 * Extract plain text from a heading node.
 */
function extractHeadingText(heading: Heading): string {
  const parts: string[] = [];
  for (const child of heading.children) {
    parts.push(extractNodeText(child));
  }
  return parts.join("");
}

function extractNodeText(node: Content): string {
  if ("value" in node) return node.value;
  if ("children" in node) {
    return (node.children as Content[]).map(extractNodeText).join("");
  }
  return "";
}

/**
 * Extract domain-specific IDs from text using configured patterns.
 */
function extractIds(text: string, patterns: IdPattern[]): string[] {
  const ids: string[] = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      ids.push(match[0]);
    }
  }
  return ids;
}

/**
 * Build section ranges from headings.
 * Each section spans from its heading line to just before the next
 * heading of equal or higher level (or end of file).
 */
function buildSectionRanges(headings: HeadingInfo[], totalLines: number): SectionRange[] {
  const sections: SectionRange[] = [];

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    let endLine = totalLines;

    // Find end: next heading of same or higher level
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= current.level) {
        endLine = headings[j].line - 1;
        break;
      }
    }

    sections.push({
      heading: current,
      startLine: current.line,
      endLine,
    });
  }

  return sections;
}

/**
 * Match a section by sectionId with strict precedence:
 * 1. Exact ID match (heading.ids includes sectionId)
 * 2. Exact heading text match
 * 3. Heading text starts with "sectionId:" (e.g. "FE-1.1: Title")
 *
 * No substring matching — avoids "FE-1" matching "FE-1.1".
 */
function findSection(sections: SectionRange[], sectionId: string): SectionRange | null {
  // Priority 1: exact ID match
  const byId = sections.find((s) => s.heading.ids.includes(sectionId));
  if (byId) return byId;

  // Priority 2: exact heading text match
  const byText = sections.find((s) => s.heading.text === sectionId);
  if (byText) return byText;

  // Priority 3: heading starts with "sectionId:" (common pattern: "FE-1.1: Title")
  const byPrefix = sections.find(
    (s) => s.heading.text.startsWith(sectionId + ":") ||
           s.heading.text.startsWith(sectionId + " ")
  );
  if (byPrefix) return byPrefix;

  return null;
}

/**
 * Extract the content of a specific section by heading text match.
 * Re-parses the file from disk so section boundaries reflect current file state,
 * not potentially stale index data.
 * Returns null if the section is not found.
 */
export function extractSectionContent(
  absolutePath: string,
  sectionId: string,
  doc: DocumentIndex
): { content: string; lineRange: [number, number]; subsections: string[] } | null {
  // Re-read the file and recompute section boundaries from current disk state
  // to avoid stale index data producing wrong content.
  const raw = fs.readFileSync(absolutePath, "utf-8");
  const lines = raw.split("\n");
  const tree = processor.parse(raw) as Root;

  const corpus: CorpusConfig = {
    name: doc.corpus,
    root: "",
    patterns: {},
    frontMatter: false,
  };

  // Re-extract headings from current file
  const idPatterns: IdPattern[] = [];
  // If the doc had patterns, we need them for ID extraction from headings.
  // Use the IDs from the doc index as a heuristic — patterns were already applied at index time.

  const headings: HeadingInfo[] = [];
  for (const node of tree.children) {
    if (node.type === "heading") {
      const heading = node as Heading;
      const text = extractHeadingText(heading);
      const line = heading.position?.start.line ?? 0;
      // Re-use indexed heading IDs where the text matches, otherwise empty
      const indexedHeading = doc.headings.find((h) => h.text === text && h.line === line);
      const ids = indexedHeading?.ids ?? [];
      headings.push({ level: heading.depth, text, line, ids });
    }
  }

  const freshSections = buildSectionRanges(headings, lines.length);

  const section = findSection(freshSections, sectionId);
  if (!section) return null;

  const content = lines.slice(section.startLine - 1, section.endLine).join("\n");

  // Find subsection headings (one level deeper)
  const subsections: string[] = [];
  for (const s of freshSections) {
    if (
      s.heading.level === section.heading.level + 1 &&
      s.startLine > section.startLine &&
      s.endLine <= section.endLine
    ) {
      subsections.push(s.heading.text);
    }
  }

  return {
    content,
    lineRange: [section.startLine, section.endLine],
    subsections,
  };
}
