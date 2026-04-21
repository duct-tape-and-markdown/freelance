/**
 * CLI handlers for stateless commands — JSON-only.
 *
 * guide, distill, sources — these operate on graph definitions and
 * source files without needing a TraversalStore. Per docs/decisions.md
 * § "CLI is the execution surface for agents", every handler emits
 * structured JSON to stdout.
 */

import { getDistillPrompt } from "../distill.js";
import { EC } from "../errors.js";
import { getGuide } from "../guide.js";
import { findGraphFiles, loadSingleGraph } from "../loader.js";
import type { SourceOptions } from "../sources.js";
import {
  checkSourcesDetailed,
  getDetailedDrift,
  hashSources,
  validateGraphSources,
} from "../sources.js";
import { EXIT, fatal, handleRuntimeError as handleError, outputJson } from "./output.js";

export function guideShow(topic?: string): void {
  const result = getGuide(topic);
  if ("error" in result) {
    fatal(result.error, EXIT.NOT_FOUND, "TOPIC_NOT_FOUND");
  }
  outputJson(result);
}

export function distillRun(opts?: { mode?: string }): void {
  const mode = (opts?.mode === "refine" ? "refine" : "distill") as "distill" | "refine";
  outputJson(getDistillPrompt(mode));
}

export function sourcesHash(sourceOpts: SourceOptions, paths: string[]): void {
  try {
    const sources = paths.map((p) => {
      // Support path:section syntax
      const colonIdx = p.lastIndexOf(":");
      if (colonIdx > 0) {
        return { path: p.slice(0, colonIdx), section: p.slice(colonIdx + 1) };
      }
      return { path: p };
    });
    outputJson(hashSources(sources, sourceOpts));
  } catch (e) {
    handleError(e);
  }
}

export function sourcesCheck(sourceOpts: SourceOptions, paths: string[]): void {
  try {
    const sources: Array<{ path: string; section?: string; hash: string }> = [];
    for (const p of paths) {
      const parts = p.split(":");
      if (parts.length === 3) {
        sources.push({ path: parts[0], section: parts[1], hash: parts[2] });
      } else if (parts.length === 2) {
        sources.push({ path: parts[0], hash: parts[1] });
      } else {
        fatal(
          `invalid format "${p}" — expected path:hash or path:section:hash`,
          EXIT.INVALID_INPUT,
          "INVALID_SOURCE_FORMAT",
        );
      }
    }
    outputJson(checkSourcesDetailed(sources, sourceOpts));
  } catch (e) {
    handleError(e);
  }
}

export function sourcesValidate(
  graphsDirs: string[],
  sourceOpts: SourceOptions,
  graphId?: string,
): void {
  try {
    if (graphsDirs.length === 0) {
      fatal("no graph directories found.", EXIT.NOT_FOUND, "NO_GRAPHS_DIR");
    }

    const fileMap = new Map<string, ReturnType<typeof loadSingleGraph>["definition"]>();
    for (const dir of graphsDirs) {
      for (const filePath of findGraphFiles(dir)) {
        try {
          const loaded = loadSingleGraph(filePath);
          fileMap.set(loaded.id, loaded.definition);
        } catch {
          // Skip files that fail to load
        }
      }
    }

    const targets = graphId ? (fileMap.has(graphId) ? [graphId] : []) : [...fileMap.keys()];

    if (targets.length === 0) {
      if (graphId) {
        fatal(`graph not found: ${graphId}`, EXIT.NOT_FOUND, EC.GRAPH_NOT_FOUND);
      }
      fatal(
        "no loadable *.workflow.yaml files in the configured graphs directories",
        EXIT.NOT_FOUND,
        "NO_GRAPHS_LOADED",
      );
    }

    const drift: Array<{
      graphId: string;
      node: string;
      drifted: Array<{ path: string; section?: string; expected: string; actual: string }>;
    }> = [];

    for (const id of targets) {
      const def = fileMap.get(id)!;
      const sourceResult = validateGraphSources(def, sourceOpts);
      for (const warning of sourceResult.warnings) {
        drift.push({
          graphId: id,
          node: warning.node,
          drifted: getDetailedDrift(def, warning.node, sourceOpts),
        });
      }
    }

    outputJson({ valid: drift.length === 0, graphsChecked: targets.length, drift });
  } catch (e) {
    handleError(e);
  }
}
