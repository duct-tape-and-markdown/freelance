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
 * Parse a single markdown file into a DocumentIndex.
 */
export function parseDocument(
  absolutePath: string,
  relativePath: string,
  corpus: CorpusConfig
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

  // Compile regex patterns for this corpus
  const idPatterns: IdPattern[] = Object.entries(corpus.patterns).map(
    ([name, regex]) => ({ name, regex: new RegExp(regex, "g") })
  );

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
 * Extract the content of a specific section by heading text match.
 * Returns null if the section is not found.
 */
export function extractSectionContent(
  absolutePath: string,
  sectionId: string,
  doc: DocumentIndex
): { content: string; lineRange: [number, number]; subsections: string[] } | null {
  // Find section by ID match or heading text match
  const section = doc.sections.find(
    (s) =>
      s.heading.ids.includes(sectionId) ||
      s.heading.text === sectionId ||
      s.heading.text.includes(sectionId)
  );

  if (!section) return null;

  const raw = fs.readFileSync(absolutePath, "utf-8");
  const lines = raw.split("\n");
  const content = lines.slice(section.startLine - 1, section.endLine).join("\n");

  // Find subsection headings (one level deeper)
  const subsections: string[] = [];
  for (const s of doc.sections) {
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
