/**
 * In-memory index over documentation corpora.
 *
 * Built at startup by walking configured source directories and parsing
 * every markdown file. Refreshed via file watcher or manual reload.
 *
 * Self-contained — no imports from freelance core.
 */

import fs from "node:fs";
import path from "node:path";
import { parseDocument, compilePatterns } from "./parser.js";
import type { IdPattern } from "./types.js";
import type {
  DocLspConfig,
  CorpusConfig,
  DocumentIndex,
  IdLocation,
  DependencyRef,
} from "./types.js";

export class DocumentIndexStore {
  /** corpus:relativePath → DocumentIndex */
  private documents = new Map<string, DocumentIndex>();

  /** id → locations (heading-level and inline) */
  private idIndex = new Map<string, IdLocation[]>();

  /** absolutePath → document key (for file watcher updates) */
  private pathToKey = new Map<string, string>();

  /** relativePath → document key (first match, for fast lookup) [M-1] */
  private relPathIndex = new Map<string, string>();

  /** document key → set of IDs it contributes (for incremental updates) [S-1] */
  private docToIds = new Map<string, Set<string>>();

  /** path → set of paths that depend on it (pre-computed reverse deps) [S-3] */
  private reverseDeps = new Map<string, Set<string>>();

  /** path → forward dependency refs (pre-computed) [S-3] */
  private forwardDeps = new Map<string, DependencyRef[]>();

  private config: DocLspConfig;

  constructor(config: DocLspConfig) {
    this.config = config;
  }

  /**
   * Build the full index from all configured corpora.
   */
  build(): { documents: number; ids: number; errors: string[] } {
    this.documents.clear();
    this.idIndex.clear();
    this.pathToKey.clear();
    this.relPathIndex.clear();
    this.docToIds.clear();
    this.reverseDeps.clear();
    this.forwardDeps.clear();

    const errors: string[] = [];

    for (const corpus of this.config.corpora) {
      if (!fs.existsSync(corpus.root)) {
        errors.push(`Corpus "${corpus.name}": root does not exist: ${corpus.root}`);
        continue;
      }
      this.indexCorpus(corpus, errors);
    }

    // Build inverted ID index and dependency graph
    this.rebuildIdIndex();
    this.rebuildDependencyIndex();

    return {
      documents: this.documents.size,
      ids: this.idIndex.size,
      errors,
    };
  }

  /**
   * Re-index a single file (for file watcher updates).
   * Uses incremental ID index update instead of full rebuild. [S-1]
   */
  reindexFile(absolutePath: string): void {
    const corpus = this.findCorpusForPath(absolutePath);
    if (!corpus) return;

    const relativePath = path.relative(corpus.root, absolutePath);
    const key = `${corpus.name}:${relativePath}`;

    // Remove old entries for this document
    this.removeDocFromIdIndex(key);

    if (!fs.existsSync(absolutePath)) {
      // File deleted
      this.documents.delete(key);
      this.pathToKey.delete(absolutePath);
      this.relPathIndex.delete(relativePath);
      this.docToIds.delete(key);
      this.rebuildDependencyIndex();
      return;
    }

    try {
      const doc = parseDocument(absolutePath, relativePath, corpus);
      this.documents.set(key, doc);
      this.pathToKey.set(absolutePath, key);
      this.relPathIndex.set(relativePath, key);
      // Add new entries incrementally
      this.addDocToIdIndex(key, doc);
      this.rebuildDependencyIndex();
    } catch {
      // Parse failure on single file — leave index as-is
    }
  }

  /**
   * Resolve a domain-specific ID to all its locations.
   */
  resolveId(id: string): IdLocation[] {
    return this.idIndex.get(id) ?? [];
  }

  /**
   * Get all known IDs.
   */
  allIds(): string[] {
    return [...this.idIndex.keys()];
  }

  /**
   * Find a document by corpus and relative path.
   */
  getDocument(corpus: string, relativePath: string): DocumentIndex | undefined {
    return this.documents.get(`${corpus}:${relativePath}`);
  }

  /**
   * Find a document by relative path across all corpora.
   * Uses pre-built index for O(1) lookup. [M-1]
   */
  findDocument(relativePath: string): DocumentIndex | undefined {
    const key = this.relPathIndex.get(relativePath);
    if (key) return this.documents.get(key);
    return undefined;
  }

  /**
   * Find a document by absolute path.
   */
  findDocumentByAbsolutePath(absolutePath: string): DocumentIndex | undefined {
    const key = this.pathToKey.get(absolutePath);
    if (key) return this.documents.get(key);
    return undefined;
  }

  /**
   * Get all documents in a corpus.
   */
  getCorpusDocuments(corpus: string): DocumentIndex[] {
    const docs: DocumentIndex[] = [];
    for (const [key, doc] of this.documents) {
      if (key.startsWith(`${corpus}:`)) docs.push(doc);
    }
    return docs;
  }

  /**
   * Get all documents across all corpora.
   */
  allDocuments(): DocumentIndex[] {
    return [...this.documents.values()];
  }

  /**
   * Get pre-computed forward dependencies for a document path.
   */
  getForwardDeps(relativePath: string): DependencyRef[] {
    return this.forwardDeps.get(relativePath) ?? [];
  }

  /**
   * Get pre-computed reverse dependencies (who depends on this path).
   */
  getReverseDeps(relativePath: string): string[] {
    const deps = this.reverseDeps.get(relativePath);
    return deps ? [...deps] : [];
  }

  /**
   * Get corpus config by name.
   */
  getCorpusConfig(name: string): CorpusConfig | undefined {
    return this.config.corpora.find((c) => c.name === name);
  }

  /**
   * Get all corpus names.
   */
  corpusNames(): string[] {
    return this.config.corpora.map((c) => c.name);
  }

  /**
   * Get corpus root directories (for file watcher setup).
   */
  corpusRoots(): string[] {
    return this.config.corpora
      .filter((c) => fs.existsSync(c.root))
      .map((c) => c.root);
  }

  // --- Private ---

  private indexCorpus(corpus: CorpusConfig, errors: string[]): void {
    // O-3: only walk .md files — JSON format not supported by parser
    const files = walkDirectory(corpus.root, ".md");
    // M-3: compile patterns once per corpus, not per file
    const patterns = compilePatterns(corpus);

    for (const absolutePath of files) {
      const relativePath = path.relative(corpus.root, absolutePath);
      const key = `${corpus.name}:${relativePath}`;

      try {
        const doc = parseDocument(absolutePath, relativePath, corpus, patterns);
        this.documents.set(key, doc);
        this.pathToKey.set(absolutePath, key);
        this.relPathIndex.set(relativePath, key);
      } catch (e) {
        errors.push(
          `${corpus.name}/${relativePath}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  /**
   * Full rebuild of the inverted ID index.
   * Indexes both heading IDs and inline IDs. [O-5]
   */
  private rebuildIdIndex(): void {
    this.idIndex.clear();
    this.docToIds.clear();

    for (const [key, doc] of this.documents) {
      this.addDocToIdIndex(key, doc);
    }
  }

  /**
   * Incrementally add a document's IDs to the inverted index. [S-1]
   * Indexes heading IDs with section info, and inline-only IDs with
   * document-level location. [O-5]
   */
  private addDocToIdIndex(key: string, doc: DocumentIndex): void {
    const docIds = new Set<string>();
    const headingIds = new Set<string>();

    // Index IDs found in headings (with section-level location)
    for (const heading of doc.headings) {
      for (const id of heading.ids) {
        headingIds.add(id);
        docIds.add(id);
        let locations = this.idIndex.get(id);
        if (!locations) {
          locations = [];
          this.idIndex.set(id, locations);
        }
        locations.push({
          path: doc.path,
          corpus: doc.corpus,
          section: heading.text,
          line: heading.line,
        });
      }
    }

    // Index IDs found only in body text (not in headings) with doc-level location [O-5]
    for (const id of doc.ids) {
      if (!headingIds.has(id)) {
        docIds.add(id);
        let locations = this.idIndex.get(id);
        if (!locations) {
          locations = [];
          this.idIndex.set(id, locations);
        }
        locations.push({
          path: doc.path,
          corpus: doc.corpus,
          section: "(inline reference)",
          line: 0,
        });
      }
    }

    this.docToIds.set(key, docIds);
  }

  /**
   * Remove a document's IDs from the inverted index. [S-1]
   */
  private removeDocFromIdIndex(key: string): void {
    const oldIds = this.docToIds.get(key);
    if (!oldIds) return;

    const doc = this.documents.get(key);
    if (!doc) return;

    for (const id of oldIds) {
      const locations = this.idIndex.get(id);
      if (!locations) continue;
      // Remove locations belonging to this document
      const filtered = locations.filter(
        (loc) => !(loc.path === doc.path && loc.corpus === doc.corpus)
      );
      if (filtered.length === 0) {
        this.idIndex.delete(id);
      } else {
        this.idIndex.set(id, filtered);
      }
    }

    this.docToIds.delete(key);
  }

  /**
   * Build pre-computed dependency graph from front-matter. [S-3]
   */
  private rebuildDependencyIndex(): void {
    this.forwardDeps.clear();
    this.reverseDeps.clear();

    for (const doc of this.documents.values()) {
      if (!doc.frontMatter?.depends_on) continue;

      const deps = Array.isArray(doc.frontMatter.depends_on)
        ? doc.frontMatter.depends_on
        : [doc.frontMatter.depends_on];

      const forwardRefs: DependencyRef[] = [];

      for (const dep of deps) {
        let depPath: string;
        let relationship = "depends_on";
        let ids: string[] | undefined;

        if (typeof dep === "string") {
          depPath = dep;
        } else if (typeof dep === "object" && dep !== null) {
          const d = dep as Record<string, unknown>;
          depPath = (d.path as string) ?? String(dep);
          relationship = (d.relationship as string) ?? "depends_on";
          ids = Array.isArray(d.ids)
            ? d.ids.filter((v): v is string => typeof v === "string")
            : undefined;
        } else {
          continue;
        }

        forwardRefs.push({ path: depPath, relationship, ids });

        // Add reverse entry
        let rev = this.reverseDeps.get(depPath);
        if (!rev) {
          rev = new Set();
          this.reverseDeps.set(depPath, rev);
        }
        rev.add(doc.path);
      }

      if (forwardRefs.length > 0) {
        this.forwardDeps.set(doc.path, forwardRefs);
      }
    }
  }

  /**
   * Find which corpus a file belongs to. [M-4]
   * Uses path separator check to avoid false matches.
   */
  private findCorpusForPath(absolutePath: string): CorpusConfig | undefined {
    for (const corpus of this.config.corpora) {
      const rootWithSep = corpus.root.endsWith(path.sep)
        ? corpus.root
        : corpus.root + path.sep;
      if (absolutePath.startsWith(rootWithSep) || absolutePath === corpus.root) {
        return corpus;
      }
    }
    return undefined;
  }
}

/**
 * Recursively walk a directory and return all files with the given extension.
 */
function walkDirectory(dir: string, ext: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden dirs and node_modules
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          walk(fullPath);
        }
      } else if (entry.name.endsWith(ext)) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}
