import fs from "node:fs";
import path from "node:path";
import { resolveSourceRoot } from "../graph-resolution.js";
import { validateHookImports } from "../hook-resolution.js";
import { findGraphFiles, loadSingleGraph, validateCrossGraphRefs } from "../loader.js";
import { SEALED_GRAPH_IDS } from "../memory/sealed.js";
import type { GraphDefinition } from "../schema/graph-schema.js";
import { createCachingResolver } from "../section-resolver.js";
import type { GraphDrift, SourceOptions } from "../sources.js";
import { collectGraphDrift } from "../sources.js";
import type { ValidatedGraph } from "../types.js";
import { EXIT, outputJson } from "./output.js";

interface GraphResult {
  id: string;
  name: string;
  version: string;
  nodeCount: number;
}

/**
 * Why a drift row was NOT auto-fixed under `--fix`. Surfaced so the
 * operator sees the reason instead of a silent no-op:
 *   - `no-match` — the expected hash wasn't found in the yaml (already
 *     edited, or written in a form the regex doesn't cover).
 *   - `ambiguous` — one stored hash maps to conflicting current hashes,
 *     so a text replace can't pick a single target.
 *   - `file-not-found` — the bound source file is missing; there's no
 *     current content to rehash, so the drift is unfixable until the
 *     file is restored.
 */
interface FixWarning {
  graphId: string;
  node: string;
  section?: string;
  reason: "no-match" | "ambiguous" | "file-not-found";
}

interface ValidateResult {
  valid: boolean;
  graphs: GraphResult[];
  errors: { file: string; message: string }[];
  sourceDrift?: GraphDrift[];
  fixed?: number;
  fixWarnings?: FixWarning[];
}

interface ValidateOptions {
  checkSources?: boolean;
  fix?: boolean;
  /** Base path for resolving source references. Defaults to parent of graph directory. */
  basePath?: string;
}

export async function validate(graphsDir: string, options?: ValidateOptions): Promise<void> {
  const resolvedDir = path.resolve(graphsDir);

  if (!fs.existsSync(resolvedDir)) {
    outputJson({
      valid: false,
      graphs: [],
      errors: [{ file: resolvedDir, message: "Directory does not exist" }],
    });
    process.exit(EXIT.VALIDATION);
  }

  const files = findGraphFiles(resolvedDir);

  if (files.length === 0) {
    outputJson({
      valid: false,
      graphs: [],
      errors: [{ file: resolvedDir, message: "No *.workflow.yaml files found" }],
    });
    process.exit(EXIT.VALIDATION);
  }

  const result: ValidateResult = { valid: true, graphs: [], errors: [] };
  const parsed = new Map<string, ValidatedGraph>();
  const graphFilePaths = new Map<string, string>();

  // Phase 1: validate each file independently so one broken file doesn't block the rest
  for (const filePath of files) {
    const relFile = path.relative(resolvedDir, filePath);
    try {
      const { id, definition, graph, hookResolutions } = loadSingleGraph(filePath);
      parsed.set(id, { definition, graph, hookResolutions });
      graphFilePaths.set(id, filePath);
      result.graphs.push({
        id,
        name: definition.name,
        version: definition.version,
        nodeCount: graph.nodeCount(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: relFile, message: msg });
      result.valid = false;
    }
  }

  // Phase 2: cross-graph validation. Sealed memory workflows exist at
  // runtime but not on disk — accept them as valid subgraph targets.
  if (result.errors.length === 0) {
    try {
      validateCrossGraphRefs(parsed, { extraAvailableIds: SEALED_GRAPH_IDS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: resolvedDir, message: msg });
      result.valid = false;
    }
  }

  // Phase 2.5: eager hook-script import check. Catches syntax errors,
  // missing relative deps, and non-function default exports at validate
  // time instead of deep into a traversal. Only runs if schema + cross-
  // graph checks passed — a graph that didn't parse has no resolutions
  // to import anyway.
  if (result.errors.length === 0) {
    for (const [graphId, { hookResolutions }] of parsed) {
      if (!hookResolutions) continue;
      const hookErrors = await validateHookImports(hookResolutions);
      if (hookErrors.length === 0) continue;
      const relFile = path.relative(resolvedDir, graphFilePaths.get(graphId)!);
      for (const hookErr of hookErrors) {
        result.errors.push({
          file: relFile,
          message: `Node "${hookErr.nodeId}", onEnter[${hookErr.index}] "${hookErr.call}": ${hookErr.message}`,
        });
        result.valid = false;
      }
    }
  }

  // Phase 3: if --sources, check source bindings for drift
  if (options?.checkSources && result.errors.length === 0) {
    const resolvedBasePath = resolveSourceRoot([resolvedDir], options.basePath);
    // A fresh resolver per run: parses each source file at most once even
    // when many nodes bind sections of the same file.
    const sourceOpts: SourceOptions = {
      resolver: createCachingResolver(),
      basePath: resolvedBasePath,
    };

    const definitions: Array<[string, GraphDefinition]> = [...parsed].map(
      ([graphId, { definition }]) => [graphId, definition],
    );
    const rows: GraphDrift[] = collectGraphDrift(definitions, sourceOpts);

    // Track files that need hash updates, carrying graphId/node/section
    // so an un-targetable replacement can be reported as a fixWarning.
    const fixMap = new Map<
      string,
      Array<{
        graphId: string;
        node: string;
        section?: string;
        oldHash: string;
        newHash: string;
      }>
    >();
    const fixWarnings: FixWarning[] = [];
    if (options.fix) {
      for (const row of rows) {
        const gFile = graphFilePaths.get(row.graphId)!;
        if (!fixMap.has(gFile)) fixMap.set(gFile, []);
        const fileFixList = fixMap.get(gFile)!;
        for (const d of row.drifted) {
          if (d.actual === "FILE_NOT_FOUND") {
            // No current content to rehash — record the unfixable drift
            // so the valid-flip guard below keeps valid=false instead of
            // silently dropping it (a missing file alongside a fixable
            // drift would otherwise flip valid=true).
            fixWarnings.push({
              graphId: row.graphId,
              node: row.node,
              section: d.section,
              reason: "file-not-found",
            });
            continue;
          }
          fileFixList.push({
            graphId: row.graphId,
            node: row.node,
            section: d.section,
            oldHash: d.expected,
            newHash: d.actual,
          });
        }
      }
    }

    if (rows.length > 0) {
      result.sourceDrift = rows;
      result.valid = false;
    }

    // Phase 4: if --fix, rewrite YAML files with updated hashes
    if (options.fix && fixMap.size > 0) {
      let totalFixed = 0;

      for (const [filePath, fixes] of fixMap) {
        let content = fs.readFileSync(filePath, "utf-8");
        let fileFixed = 0;

        // Group by oldHash: identical oldHash => identical stored source
        // content => when drifted, identical CURRENT content => identical
        // newHash. So every occurrence of a given oldHash rewrites to the
        // same target, and replacing them all is correct. The only
        // un-targetable case is one oldHash mapped to conflicting
        // newHashes — impossible by the above reasoning unless the bound
        // content genuinely differs, in which case text alone can't pick
        // a target. This sidesteps the section/hash key-order coupling a
        // section-anchored regex would impose.
        const byOldHash = new Map<string, typeof fixes>();
        for (const fix of fixes) {
          const group = byOldHash.get(fix.oldHash);
          if (group) group.push(fix);
          else byOldHash.set(fix.oldHash, [fix]);
        }

        for (const [oldHash, group] of byOldHash) {
          // Quote-tolerant: `\2` backref forces the closing quote to
          // match the opening one (empty for unquoted yaml). The trailing
          // lookahead pins an end boundary so a hash prefix can't
          // partial-match a longer unquoted literal.
          const bareSource = `(hash:\\s*)(["']?)${escapeRegex(oldHash)}\\2(?=$|[\\s"'])`;
          const occurrences = countMatches(content, bareSource);
          const newHashes = new Set(group.map((r) => r.newHash));

          if (occurrences === 0) {
            for (const { graphId, node, section } of group) {
              fixWarnings.push({ graphId, node, section, reason: "no-match" });
            }
            continue;
          }

          if (newHashes.size > 1) {
            for (const { graphId, node, section } of group) {
              fixWarnings.push({ graphId, node, section, reason: "ambiguous" });
            }
            continue;
          }

          const [newHash] = newHashes;
          content = content.replace(new RegExp(bareSource, "g"), `$1$2${newHash}$2`);
          fileFixed += occurrences;
        }

        if (fileFixed > 0) {
          fs.writeFileSync(filePath, content, "utf-8");
          totalFixed += fileFixed;
        }
      }

      result.fixed = totalFixed;
    }

    if (fixWarnings.length > 0) {
      result.fixWarnings = fixWarnings;
    }
    // Only flip valid back to true if every drift row was actually
    // fixed — a leftover skip (no-match, ambiguous, or file-not-found)
    // means residual drift the operator must see.
    if (options.fix && result.fixed && result.fixed > 0 && fixWarnings.length === 0) {
      result.valid = true; // All drift was fixed
    }
  }

  outputJson(result);
  process.exit(result.valid ? EXIT.SUCCESS : EXIT.VALIDATION);
}

// --- Helpers ---

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count global matches of a regex source against content. */
function countMatches(content: string, source: string): number {
  return (content.match(new RegExp(source, "g")) ?? []).length;
}
