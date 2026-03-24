/**
 * Document LSP types.
 *
 * This module is self-contained — no imports from freelance core.
 */

// --- Configuration ---

export interface IdPattern {
  readonly name: string;
  readonly regex: RegExp;
}

export interface CorpusConfig {
  readonly name: string;
  readonly root: string;
  readonly patterns: Record<string, string>; // name → regex string
  readonly frontMatter: boolean;
  readonly format?: "markdown" | "json";
}

export interface DocLspConfig {
  readonly corpora: CorpusConfig[];
}

// --- Index structures ---

export interface HeadingInfo {
  readonly level: number;
  readonly text: string;
  readonly line: number;
  readonly ids: string[]; // domain-specific IDs extracted from heading text
}

export interface SectionRange {
  readonly heading: HeadingInfo;
  /** 1-based start line (inclusive) */
  readonly startLine: number;
  /** 1-based end line (inclusive, last line of section content) */
  readonly endLine: number;
}

export interface DocumentIndex {
  readonly path: string; // relative to corpus root
  readonly absolutePath: string;
  readonly corpus: string;
  readonly headings: HeadingInfo[];
  readonly sections: SectionRange[];
  readonly frontMatter: Record<string, unknown> | null;
  /** All domain-specific IDs found in this document */
  readonly ids: string[];
}

export interface IdLocation {
  readonly path: string;
  readonly corpus: string;
  readonly section: string;
  readonly line: number;
}

// --- Tool result types ---

export interface DocResolveResult {
  readonly locations: Array<{
    readonly path: string;
    readonly corpus: string;
    readonly section: string;
    readonly line: number;
  }>;
  readonly relatedIds: Record<string, string[]>;
}

export interface DocSectionResult {
  readonly content: string;
  readonly lineRange: [number, number];
  readonly subsections: string[];
  readonly hash: string;
}

export interface DocStructureResult {
  readonly headings: Array<{
    readonly level: number;
    readonly text: string;
    readonly line: number;
    readonly ids: string[];
  }>;
  readonly frontMatter: Record<string, unknown> | null;
  readonly ids: string[];
}

export interface DependencyRef {
  readonly path: string;
  readonly relationship: string;
  readonly ids?: string[];
}

export interface DocDependenciesResult {
  readonly dependsOn: DependencyRef[];
  readonly dependedOnBy: DependencyRef[];
}

export interface CoverageEntry {
  readonly total: number;
  readonly covered: number;
  readonly missing: string[];
}

export interface DocCoverageResult {
  readonly corpus: string;
  readonly documents: number;
  readonly ids: number;
  readonly coverage: Record<string, CoverageEntry>;
}
