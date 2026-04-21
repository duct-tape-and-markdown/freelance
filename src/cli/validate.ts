import fs from "node:fs";
import path from "node:path";
import { validateHookImports } from "../hook-resolution.js";
import { findGraphFiles, loadSingleGraph, validateCrossGraphRefs } from "../loader.js";
import { SEALED_GRAPH_IDS } from "../memory/sealed.js";
import { extractSection } from "../section-resolver.js";
import type { SourceOptions } from "../sources.js";
import { getDetailedDrift, validateGraphSources } from "../sources.js";
import type { ValidatedGraph } from "../types.js";
import { EXIT, outputJson } from "./output.js";

interface GraphResult {
  id: string;
  name: string;
  version: string;
  nodeCount: number;
}

interface SourceDriftResult {
  graphId: string;
  node: string;
  drifted: Array<{ path: string; section?: string; expected: string; actual: string }>;
}

interface ValidateResult {
  valid: boolean;
  graphs: GraphResult[];
  errors: { file: string; message: string }[];
  sourceDrift?: SourceDriftResult[];
  fixed?: number;
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
    const sourceDrift: SourceDriftResult[] = [];
    // Track files that need hash updates: filePath → Array<{section, oldHash, newHash}>
    const fixMap = new Map<string, Array<{ section?: string; oldHash: string; newHash: string }>>();

    const resolvedBasePath = options.basePath
      ? path.resolve(options.basePath)
      : path.dirname(resolvedDir);

    for (const [graphId, { definition }] of parsed) {
      const sourceOpts: SourceOptions = { resolver: extractSection, basePath: resolvedBasePath };
      const sourceResult = validateGraphSources(definition, sourceOpts);

      for (const warning of sourceResult.warnings) {
        const detailedDrift = getDetailedDrift(definition, warning.node, sourceOpts);
        sourceDrift.push({
          graphId,
          node: warning.node,
          drifted: detailedDrift,
        });

        // Collect hash replacements for --fix
        if (options.fix) {
          const gFile = graphFilePaths.get(graphId)!;
          if (!fixMap.has(gFile)) {
            fixMap.set(gFile, []);
          }
          const fileFixList = fixMap.get(gFile)!;
          for (const d of detailedDrift) {
            if (d.actual !== "FILE_NOT_FOUND") {
              fileFixList.push({ section: d.section, oldHash: d.expected, newHash: d.actual });
            }
          }
        }
      }
    }

    if (sourceDrift.length > 0) {
      result.sourceDrift = sourceDrift;
      result.valid = false;
    }

    // Phase 4: if --fix, rewrite YAML files with updated hashes
    if (options.fix && fixMap.size > 0) {
      let totalFixed = 0;

      for (const [filePath, fixes] of fixMap) {
        let content = fs.readFileSync(filePath, "utf-8");
        let fileFixed = 0;

        for (const { section, oldHash, newHash } of fixes) {
          let replaced: string;

          if (section) {
            const pattern = new RegExp(
              `(section:\\s*"${escapeRegex(section)}"\\s*\\n\\s*hash:\\s*")${escapeRegex(oldHash)}"`,
            );
            replaced = content.replace(pattern, `$1${newHash}"`);
          } else {
            const pattern = new RegExp(`(hash:\\s*")${escapeRegex(oldHash)}"`);
            replaced = content.replace(pattern, `$1${newHash}"`);
          }

          if (replaced !== content) {
            content = replaced;
            fileFixed++;
          }
        }

        if (fileFixed > 0) {
          fs.writeFileSync(filePath, content, "utf-8");
          totalFixed += fileFixed;
        }
      }

      result.fixed = totalFixed;
      if (totalFixed > 0) {
        result.valid = true; // Drift was fixed
      }
    }
  }

  outputJson(result);
  process.exit(result.valid ? EXIT.SUCCESS : EXIT.VALIDATION);
}

// --- Helpers ---

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
