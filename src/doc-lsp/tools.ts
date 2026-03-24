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

import crypto from "node:crypto";
import { DocumentIndexStore } from "./index-builder.js";
import { extractSectionContent } from "./parser.js";
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

    // Find related IDs: other IDs that co-occur in the same documents
    const relatedIds: Record<string, string[]> = {};
    const seenDocs = new Set<string>();

    for (const loc of locations) {
      const key = `${loc.corpus}:${loc.path}`;
      if (seenDocs.has(key)) continue;
      seenDocs.add(key);

      const doc = this.index.getDocument(loc.corpus, loc.path);
      if (!doc) continue;

      // Look for IDs from front-matter references
      if (doc.frontMatter) {
        for (const [field, value] of Object.entries(doc.frontMatter)) {
          if (Array.isArray(value)) {
            const stringValues = value.filter((v): v is string => typeof v === "string");
            if (stringValues.length > 0) {
              relatedIds[field] = stringValues;
            }
          }
        }
      }
    }

    return { locations, relatedIds };
  }

  /**
   * doc_section: Retrieve the content of a specific section.
   */
  section(docPath: string, sectionId: string): DocSectionResult | null {
    const doc = this.findDoc(docPath);
    if (!doc) return null;

    const result = extractSectionContent(doc.absolutePath, sectionId, doc);
    if (!result) return null;

    const hash = crypto
      .createHash("sha256")
      .update(result.content)
      .digest("hex")
      .substring(0, 16);

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
   */
  dependencies(docPath: string): DocDependenciesResult | null {
    const doc = this.findDoc(docPath);
    if (!doc) return null;

    const dependsOn: DocDependenciesResult["dependsOn"] = [];
    const dependedOnBy: DocDependenciesResult["dependedOnBy"] = [];

    // Parse depends_on from front-matter
    if (doc.frontMatter?.depends_on) {
      const deps = Array.isArray(doc.frontMatter.depends_on)
        ? doc.frontMatter.depends_on
        : [doc.frontMatter.depends_on];

      for (const dep of deps) {
        if (typeof dep === "string") {
          dependsOn.push({ path: dep, relationship: "depends_on" });
        } else if (typeof dep === "object" && dep !== null) {
          const d = dep as Record<string, unknown>;
          dependsOn.push({
            path: (d.path as string) ?? String(dep),
            relationship: (d.relationship as string) ?? "depends_on",
            ids: Array.isArray(d.ids)
              ? d.ids.filter((v): v is string => typeof v === "string")
              : undefined,
          });
        }
      }
    }

    // Parse depended_on_by from front-matter
    if (doc.frontMatter?.depended_on_by) {
      const deps = Array.isArray(doc.frontMatter.depended_on_by)
        ? doc.frontMatter.depended_on_by
        : [doc.frontMatter.depended_on_by];

      for (const dep of deps) {
        if (typeof dep === "string") {
          dependedOnBy.push({ path: dep, relationship: "depended_on_by" });
        } else if (typeof dep === "object" && dep !== null) {
          const d = dep as Record<string, unknown>;
          dependedOnBy.push({
            path: (d.path as string) ?? String(dep),
            relationship: (d.relationship as string) ?? "depended_on_by",
            ids: Array.isArray(d.ids)
              ? d.ids.filter((v): v is string => typeof v === "string")
              : undefined,
          });
        }
      }
    }

    // Find reverse dependencies: scan all docs for depends_on references to this path
    for (const otherDoc of this.index.allDocuments()) {
      if (otherDoc.path === doc.path && otherDoc.corpus === doc.corpus) continue;
      if (!otherDoc.frontMatter?.depends_on) continue;

      const otherDeps = Array.isArray(otherDoc.frontMatter.depends_on)
        ? otherDoc.frontMatter.depends_on
        : [otherDoc.frontMatter.depends_on];

      for (const dep of otherDeps) {
        const depPath = typeof dep === "string" ? dep : (dep as Record<string, unknown>)?.path;
        if (depPath === doc.path) {
          // Check if already listed in dependedOnBy from front-matter
          const already = dependedOnBy.some((d) => d.path === otherDoc.path);
          if (!already) {
            const rel =
              typeof dep === "object" && dep !== null
                ? ((dep as Record<string, unknown>).relationship as string) ?? "depends_on"
                : "depends_on";
            dependedOnBy.push({ path: otherDoc.path, relationship: rel });
          }
        }
      }
    }

    return { dependsOn, dependedOnBy };
  }

  /**
   * doc_coverage: Report what exists and what's missing across a corpus.
   */
  coverage(scope: string): DocCoverageResult | null {
    const docs = this.index.getCorpusDocuments(scope);
    if (docs.length === 0) {
      // Try across all corpora if scope doesn't match a single corpus
      const allDocs = this.index.allDocuments();
      if (allDocs.length === 0) return null;
    }

    // Collect all IDs across the corpus
    const allIds = new Set<string>();
    const idsByDoc = new Map<string, Set<string>>();

    const corpusDocs = docs.length > 0 ? docs : this.index.allDocuments();

    for (const doc of corpusDocs) {
      const docIds = new Set<string>();
      for (const id of doc.ids) {
        allIds.add(id);
        docIds.add(id);
      }
      idsByDoc.set(`${doc.corpus}:${doc.path}`, docIds);
    }

    // Build coverage by document: which IDs appear in which documents
    const coverage: Record<string, { total: number; covered: number; missing: string[] }> = {};

    // Group documents by directory pattern for tier analysis
    const docGroups = new Map<string, DocumentIndex[]>();
    for (const doc of corpusDocs) {
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
      documents: corpusDocs.length,
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
