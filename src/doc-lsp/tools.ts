/**
 * Document LSP tool implementations.
 *
 * Five read-only structural navigation tools:
 * - doc_resolve: Resolve a domain-specific ID to locations
 * - doc_section: Retrieve section content with hash
 * - doc_structure: Return document structural outline
 * - doc_dependencies: Return document dependency graph
 * - doc_coverage: Report coverage across a corpus
 *
 * Self-contained — no imports from freelance core.
 */

import { DocumentIndexStore } from "./index-builder.js";
import { extractSectionContent } from "./parser.js";
import { hashContent } from "./hash.js";
import type {
  DocResolveResult,
  DocSectionResult,
  DocStructureResult,
  DocDependenciesResult,
  DocCoverageResult,
  DocumentIndex,
} from "./types.js";

export class DocLspTools {
  constructor(private index: DocumentIndexStore) {}

  /**
   * doc_resolve: Resolve a domain-specific identifier to its location(s).
   */
  resolve(id: string): DocResolveResult {
    const locations = this.index.resolveId(id);
    return { locations, relatedIds: {} };
  }

  /**
   * doc_section: Retrieve the content of a specific section.
   */
  section(docPath: string, sectionId: string): DocSectionResult | null {
    const doc = this.findDoc(docPath);
    if (!doc) return null;

    const result = extractSectionContent(doc.absolutePath, sectionId, doc);
    if (!result) return null;

    const hash = hashContent(result.content);

    return {
      content: result.content,
      lineRange: result.lineRange,
      subsections: result.subsections,
      hash,
    };
  }

  /**
   * doc_structure: Return the structural outline of a document.
   */
  structure(docPath: string): DocStructureResult | null {
    const doc = this.findDoc(docPath);
    if (!doc) return null;

    return {
      headings: doc.headings.map((h) => ({
        level: h.level,
        text: h.text,
        line: h.line,
        ids: h.ids,
      })),
      frontMatter: doc.frontMatter,
      ids: doc.ids,
    };
  }

  /**
   * doc_dependencies: Return what a document depends on and what depends on it.
   * Uses pre-computed dependency index for O(1) lookup. [S-3]
   */
  dependencies(docPath: string): DocDependenciesResult | null {
    const doc = this.findDoc(docPath);
    if (!doc) return null;

    // Forward deps from pre-computed index
    const dependsOn = this.index.getForwardDeps(doc.path);

    // Reverse deps from pre-computed index
    const reverseDepPaths = this.index.getReverseDeps(doc.path);

    // Also include explicit depended_on_by from front-matter
    const dependedOnBy: DocDependenciesResult["dependedOnBy"] = [];
    const seen = new Set<string>();

    if (doc.frontMatter?.depended_on_by) {
      const deps = Array.isArray(doc.frontMatter.depended_on_by)
        ? doc.frontMatter.depended_on_by
        : [doc.frontMatter.depended_on_by];

      for (const dep of deps) {
        if (typeof dep === "string") {
          dependedOnBy.push({ path: dep, relationship: "depended_on_by" });
          seen.add(dep);
        } else if (typeof dep === "object" && dep !== null) {
          const d = dep as Record<string, unknown>;
          const depPath = (d.path as string) ?? String(dep);
          dependedOnBy.push({
            path: depPath,
            relationship: (d.relationship as string) ?? "depended_on_by",
            ids: Array.isArray(d.ids)
              ? d.ids.filter((v): v is string => typeof v === "string")
              : undefined,
          });
          seen.add(depPath);
        }
      }
    }

    // Add computed reverse deps not already declared
    for (const depPath of reverseDepPaths) {
      if (!seen.has(depPath)) {
        dependedOnBy.push({ path: depPath, relationship: "depends_on" });
      }
    }

    return { dependsOn, dependedOnBy };
  }

  /**
   * doc_coverage: Report what exists and what's missing across a corpus.
   * Returns null if the scope doesn't match any corpus. [S-6]
   */
  coverage(scope: string): DocCoverageResult | null {
    const docs = this.index.getCorpusDocuments(scope);
    if (docs.length === 0) {
      // Scope must match a corpus name — don't silently fall back to all corpora
      return null;
    }

    // Collect all IDs across the corpus [M-2: removed unused idsByDoc]
    const allIds = new Set<string>();

    for (const doc of docs) {
      for (const id of doc.ids) {
        allIds.add(id);
      }
    }

    // Build coverage by document: which IDs appear in which documents
    const coverage: Record<string, { total: number; covered: number; missing: string[] }> = {};

    // Group documents by directory pattern for tier analysis
    const docGroups = new Map<string, DocumentIndex[]>();
    for (const doc of docs) {
      const dir = doc.path.split("/").slice(0, -1).join("/") || doc.corpus;
      let group = docGroups.get(dir);
      if (!group) {
        group = [];
        docGroups.set(dir, group);
      }
      group.push(doc);
    }

    for (const [groupName, groupDocs] of docGroups) {
      const coveredIds = new Set<string>();
      for (const doc of groupDocs) {
        for (const id of doc.ids) coveredIds.add(id);
      }
      const missing = [...allIds].filter((id) => !coveredIds.has(id));
      coverage[groupName] = {
        total: allIds.size,
        covered: coveredIds.size,
        missing,
      };
    }

    return {
      corpus: scope,
      documents: docs.length,
      ids: allIds.size,
      coverage,
    };
  }

  // --- Private ---

  private findDoc(docPath: string): DocumentIndex | undefined {
    // Try exact match first
    const doc = this.index.findDocument(docPath);
    if (doc) return doc;

    // Try with/without leading slash
    const normalized = docPath.startsWith("/") ? docPath.slice(1) : docPath;
    return this.index.findDocument(normalized);
  }
}
