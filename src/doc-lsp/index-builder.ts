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
import { parseDocument } from "./parser.js";
import type {
  DocLspConfig,
  CorpusConfig,
  DocumentIndex,
  IdLocation,
} from "./types.js";

export class DocumentIndexStore {
  /** corpus:relativePath → DocumentIndex */
  private documents = new Map<string, DocumentIndex>();

  /** id → locations */
  private idIndex = new Map<string, IdLocation[]>();

  /** absolutePath → document key (for file watcher updates) */
  private pathToKey = new Map<string, string>();

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

    const errors: string[] = [];

    for (const corpus of this.config.corpora) {
      if (!fs.existsSync(corpus.root)) {
        errors.push(`Corpus "${corpus.name}": root does not exist: ${corpus.root}`);
        continue;
      }
      this.indexCorpus(corpus, errors);
    }

    // Build inverted ID index
    this.rebuildIdIndex();

    return {
      documents: this.documents.size,
      ids: this.idIndex.size,
      errors,
    };
  }

  /**
   * Re-index a single file (for file watcher updates).
   */
  reindexFile(absolutePath: string): void {
    const corpus = this.findCorpusForPath(absolutePath);
    if (!corpus) return;

    const relativePath = path.relative(corpus.root, absolutePath);
    const key = `${corpus.name}:${relativePath}`;

    if (!fs.existsSync(absolutePath)) {
      // File deleted
      this.documents.delete(key);
      this.pathToKey.delete(absolutePath);
      this.rebuildIdIndex();
      return;
    }

    try {
      const doc = parseDocument(absolutePath, relativePath, corpus);
      this.documents.set(key, doc);
      this.pathToKey.set(absolutePath, key);
      this.rebuildIdIndex();
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
   */
  findDocument(relativePath: string): DocumentIndex | undefined {
    for (const [, doc] of this.documents) {
      if (doc.path === relativePath) return doc;
    }
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
    const ext = corpus.format === "json" ? ".json" : ".md";
    const files = walkDirectory(corpus.root, ext);

    for (const absolutePath of files) {
      const relativePath = path.relative(corpus.root, absolutePath);
      const key = `${corpus.name}:${relativePath}`;

      try {
        const doc = parseDocument(absolutePath, relativePath, corpus);
        this.documents.set(key, doc);
        this.pathToKey.set(absolutePath, key);
      } catch (e) {
        errors.push(
          `${corpus.name}/${relativePath}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  private rebuildIdIndex(): void {
    this.idIndex.clear();

    for (const doc of this.documents.values()) {
      for (const heading of doc.headings) {
        for (const id of heading.ids) {
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
    }
  }

  private findCorpusForPath(absolutePath: string): CorpusConfig | undefined {
    for (const corpus of this.config.corpora) {
      if (absolutePath.startsWith(corpus.root)) return corpus;
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
