/**
 * Native section extraction for source binding hashes.
 *
 * Convention (shared with document-lsp):
 * - Section boundary: matched heading to next heading at same or higher level (or EOF)
 * - Content: raw text of those lines, including the heading itself
 * - Normalization: CRLF → LF before hashing
 * - Hash: SHA-256 truncated to 16 hex chars
 */

import fs from "node:fs";
import type { Heading, PhrasingContent, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { SectionResolver } from "./sources.js";

/** Parsed-once view of a markdown file, shared across section lookups. */
interface ParsedFile {
  tree: Root;
  lines: string[];
}

function parseFile(filePath: string): ParsedFile {
  const content = fs.readFileSync(filePath, "utf-8");
  const tree = unified().use(remarkParse).parse(content);
  return { tree, lines: content.split("\n") };
}

/**
 * Extract a section from a markdown file by heading text.
 * Returns the raw content from the heading to the next heading at same or higher level.
 */
export function extractSection(filePath: string, sectionHeading: string): string | null {
  return extractSectionFrom(parseFile(filePath), sectionHeading);
}

/**
 * Build a resolver that parses each file at most once per run. N nodes
 * binding M sections of one file parse it once, not N*M times — the
 * closure holds a Map keyed by absolute file path → parsed { tree, lines }.
 *
 * Wired into the author-time hot paths only: `freelance validate
 * --sources` (`src/cli/validate.ts`) and the stateless `sources`
 * verbs (via `loadGraphSetup`'s `sourceOpts`). Both build one per
 * invocation, so the cache lives exactly one run. NOT used by the
 * per-traversal runtime resolver (`composeRuntime`'s `sectionResolver`),
 * where a long-lived cache could serve stale section content if a source
 * file changes mid-run.
 */
export function createCachingResolver(): SectionResolver {
  const cache = new Map<string, ParsedFile>();
  return (filePath: string, section: string): string | null => {
    let parsed = cache.get(filePath);
    if (!parsed) {
      parsed = parseFile(filePath);
      cache.set(filePath, parsed);
    }
    return extractSectionFrom(parsed, section);
  };
}

function extractSectionFrom({ tree, lines }: ParsedFile, sectionHeading: string): string | null {
  let startLine: number | null = null;
  let startDepth: number | null = null;
  let endLine: number | null = null;

  for (const node of tree.children) {
    if (node.type === "heading") {
      const heading = node as Heading;

      if (startLine !== null && heading.depth <= startDepth!) {
        endLine = heading.position!.start.line - 1;
        break;
      }

      const headingText = extractHeadingText(heading);
      if (matchesSection(headingText, sectionHeading)) {
        startLine = heading.position!.start.line;
        startDepth = heading.depth;
      }
    }
  }

  if (startLine === null) {
    return null;
  }

  const sectionLines =
    endLine !== null ? lines.slice(startLine - 1, endLine) : lines.slice(startLine - 1);

  return sectionLines.join("\n");
}

function extractHeadingText(node: Heading): string {
  return (node.children as PhrasingContent[])
    .map((child) => ("value" in child ? child.value : ""))
    .join("")
    .trim();
}

function matchesSection(headingText: string, query: string): boolean {
  return headingText === query || headingText.startsWith(`${query}:`);
}
