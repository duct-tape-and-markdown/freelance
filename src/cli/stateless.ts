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
import { checkSourcesDetailed, collectGraphDrift, hashSources } from "../sources.js";
import { fatal, outputJson } from "./output.js";

/**
 * Parse a colon-delimited source spec with explicit arity. One helper
 * for both `sources hash` (no hash component) and `sources check` (hash
 * required) so the two verbs share a validation + error contract instead
 * of diverging on `split` vs `lastIndexOf` strategies.
 */
function parseSourceSpec(
  spec: string,
  requireHash: boolean,
): { path: string; section?: string; hash?: string } {
  const parts = spec.split(":");
  if (requireHash) {
    if (parts.length === 3) return { path: parts[0], section: parts[1], hash: parts[2] };
    if (parts.length === 2) return { path: parts[0], hash: parts[1] };
    fatal(
      `invalid format "${spec}" — expected path:hash or path:section:hash`,
      EC.INVALID_SOURCE_FORMAT,
    );
  } else {
    if (parts.length === 2) return { path: parts[0], section: parts[1] };
    if (parts.length === 1) return { path: parts[0] };
    fatal(`invalid format "${spec}" — expected path or path:section`, EC.INVALID_SOURCE_FORMAT);
  }
}

export function guideShow(topic?: string): void {
  const result = getGuide(topic);
  outputJson(result);
}

export function distillRun(opts?: { mode?: string }): void {
  const mode = (opts?.mode === "refine" ? "refine" : "distill") as "distill" | "refine";
  outputJson(getDistillPrompt(mode));
}

// Source handlers throw (fatal/EngineError) on failure; `program.ts`
// wraps each call in `runCliHandler` so the throw routes through the
// shared `CliExit` / error-envelope plumbing instead of an in-handler
// try/catch (#230).
export function sourcesHash(sourceOpts: SourceOptions, paths: string[]): void {
  const sources = paths.map((p) => {
    const { path, section } = parseSourceSpec(p, false);
    return { path, section };
  });
  outputJson(hashSources(sources, sourceOpts));
}

export function sourcesCheck(sourceOpts: SourceOptions, paths: string[]): void {
  const sources = paths.map((p) => {
    const { path, section, hash } = parseSourceSpec(p, true);
    return { path, section, hash: hash! };
  });
  outputJson(checkSourcesDetailed(sources, sourceOpts));
}

export function sourcesValidate(
  graphsDirs: string[],
  sourceOpts: SourceOptions,
  graphId?: string,
): void {
  if (graphsDirs.length === 0) {
    fatal("no graph directories found.", EC.NO_GRAPHS_DIR);
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
      fatal(`graph not found: ${graphId}`, EC.GRAPH_NOT_FOUND);
    }
    fatal(
      "no loadable *.workflow.yaml files in the configured graphs directories",
      EC.NO_GRAPHS_LOADED,
    );
  }

  const drift = collectGraphDrift(
    targets.map((id) => [id, fileMap.get(id)!] as const),
    sourceOpts,
  );

  outputJson({ valid: drift.length === 0, graphsChecked: targets.length, drift });
}
