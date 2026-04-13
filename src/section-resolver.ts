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
import type { Heading, PhrasingContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * Extract a section from a markdown file by heading text.
 * Returns the raw content from the heading to the next heading at same or higher level.
 */
export function extractSection(filePath: string, sectionHeading: string): string | null {
  const content = fs.readFileSync(filePath, "utf-8");
  const tree = unified().use(remarkParse).parse(content);
  const lines = content.split("\n");

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

  const sectionLines = endLine ? lines.slice(startLine - 1, endLine) : lines.slice(startLine - 1);

  return sectionLines.join("\n");
}

function extractHeadingText(node: Heading): string {
  return (node.children as PhrasingContent[])
    .map((child) => ("value" in child ? child.value : ""))
    .join("")
    .trim();
}

function matchesSection(headingText: string, query: string): boolean {
  return headingText === query || headingText.startsWith(query + ":");
}
