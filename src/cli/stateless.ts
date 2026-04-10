/**
 * CLI handlers for stateless commands (graph files only, no store needed).
 *
 * guide, distill, sources — these operate on graph definitions and source files.
 */

import fs from "node:fs";
import { cli, info, outputJson } from "./output.js";
import { getGuide } from "../guide.js";
import { getDistillPrompt } from "../distill.js";
import { hashSources, checkSourcesDetailed, validateGraphSources, getDetailedDrift } from "../sources.js";
import { findGraphFiles, loadSingleGraph } from "../loader.js";
import type { SourceOptions } from "../sources.js";

function handleError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  if (cli.json) {
    outputJson({ error: message });
  } else {
    info(`Error: ${message}`);
  }
  process.exit(1);
}

export function guideShow(topic?: string): void {
  const result = getGuide(topic);
  if (cli.json) {
    outputJson(result);
  } else if ("error" in result) {
    info(result.error);
    process.exit(1);
  } else {
    info(result.content);
  }
}

export function distillRun(file: string, opts?: { mode?: string; graph?: string }): void {
  const mode = (opts?.mode === "refine" ? "refine" : "distill") as "distill" | "refine";
  const result = getDistillPrompt(mode);
  if (cli.json) {
    outputJson(result);
  } else {
    info(result.content);
  }
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
    const result = hashSources(sources, sourceOpts);
    if (cli.json) {
      outputJson(result);
    } else {
      for (const s of result.sources) {
        info(`${s.path}${s.section ? `:${s.section}` : ""}  ${s.hash}`);
      }
    }
  } catch (e) {
    handleError(e);
  }
}

export function sourcesCheck(sourceOpts: SourceOptions, paths: string[]): void {
  try {
    // Expect path:hash or path:section:hash format
    const sources = paths.map((p) => {
      const parts = p.split(":");
      if (parts.length === 3) {
        return { path: parts[0], section: parts[1], hash: parts[2] };
      }
      if (parts.length === 2) {
        return { path: parts[0], hash: parts[1] };
      }
      info(`Error: invalid format "${p}" — expected path:hash or path:section:hash`);
      process.exit(1);
    });
    const result = checkSourcesDetailed(sources, sourceOpts);
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.valid) {
        info("All sources valid.");
      } else {
        info("Drifted sources:");
        for (const d of result.drifted) {
          info(`  ${d.path}${d.section ? `:${d.section}` : ""}  expected=${d.expected} actual=${d.actual}`);
        }
      }
    }
  } catch (e) {
    handleError(e);
  }
}

export function sourcesValidate(graphsDirs: string[], sourceOpts: SourceOptions, graphId?: string): void {
  try {
    if (graphsDirs.length === 0) {
      info("Error: no graph directories found.");
      process.exit(1);
    }

    // Collect graph definitions from all directories
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

    const targets = graphId
      ? fileMap.has(graphId) ? [graphId] : []
      : [...fileMap.keys()];

    if (targets.length === 0) {
      info(graphId ? `Error: graph not found: ${graphId}` : "No graphs loaded.");
      process.exit(1);
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

    const result = { valid: drift.length === 0, graphsChecked: targets.length, drift };
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.valid) {
        info(`All sources valid across ${result.graphsChecked} graph(s).`);
      } else {
        for (const d of drift) {
          info(`${d.graphId} / ${d.node}:`);
          for (const s of d.drifted) {
            info(`  ${s.path}${s.section ? `:${s.section}` : ""}  expected=${s.expected} actual=${s.actual}`);
          }
        }
      }
    }
  } catch (e) {
    handleError(e);
  }
}
