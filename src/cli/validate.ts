import fs from "node:fs";
import path from "node:path";
import { loadSingleGraph, validateCrossGraphRefs } from "../loader.js";
import { validateGraphSources } from "../sources.js";
import type { ValidatedGraph } from "../types.js";
import { cli, outputJson, info, error, fatal, EXIT } from "./output.js";

interface GraphResult {
  id: string;
  name: string;
  version: string;
  nodeCount: number;
}

interface SourceDriftResult {
  graphId: string;
  node: string;
  drifted: Array<{ path: string; section?: string }>;
}

interface ValidateResult {
  valid: boolean;
  graphs: GraphResult[];
  errors: { file: string; message: string }[];
  sourceDrift?: SourceDriftResult[];
}

export interface ValidateOptions {
  checkSources?: boolean;
}

export function validate(graphsDir: string, options?: ValidateOptions): void {
  const resolvedDir = path.resolve(graphsDir);

  if (!fs.existsSync(resolvedDir)) {
    if (cli.json) {
      outputJson({ valid: false, graphs: [], errors: [{ file: resolvedDir, message: "Directory does not exist" }] });
      process.exit(EXIT.GRAPH_ERROR);
    }
    fatal(`Graph directory does not exist: ${resolvedDir}`, EXIT.GRAPH_ERROR);
  }

  const files = fs
    .readdirSync(resolvedDir)
    .filter((f) => f.endsWith(".graph.yaml"));

  if (files.length === 0) {
    if (cli.json) {
      outputJson({ valid: false, graphs: [], errors: [{ file: resolvedDir, message: "No *.graph.yaml files found" }] });
      process.exit(EXIT.GRAPH_ERROR);
    }
    fatal(`No *.graph.yaml files found in: ${resolvedDir}`, EXIT.GRAPH_ERROR);
  }

  const result: ValidateResult = { valid: true, graphs: [], errors: [] };
  const parsed = new Map<string, ValidatedGraph>();

  // Phase 1: validate each file independently so one broken file doesn't block the rest
  for (const file of files) {
    const filePath = path.join(resolvedDir, file);
    try {
      const { id, definition, graph } = loadSingleGraph(filePath);
      parsed.set(id, { definition, graph });
      result.graphs.push({
        id,
        name: definition.name,
        version: definition.version,
        nodeCount: graph.nodeCount(),
      });
      if (!cli.json) {
        info(`  OK  ${definition.name} (id: ${id}, v${definition.version}, ${graph.nodeCount()} nodes)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ file, message: msg });
      result.valid = false;
      if (!cli.json) {
        info(`  FAIL  ${file}: ${msg}`);
      }
    }
  }

  // Phase 2: if all individual files passed, run cross-graph validation (subgraph refs)
  if (result.errors.length === 0) {
    try {
      validateCrossGraphRefs(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: resolvedDir, message: msg });
      result.valid = false;
      if (!cli.json) {
        info(`  FAIL  ${msg}`);
      }
    }
  }

  // Phase 3: if --sources, check source bindings for drift
  if (options?.checkSources && result.errors.length === 0) {
    const sourceDrift: SourceDriftResult[] = [];

    for (const [graphId, { definition }] of parsed) {
      const sourceResult = validateGraphSources(definition);
      for (const warning of sourceResult.warnings) {
        sourceDrift.push({
          graphId,
          node: warning.node,
          drifted: warning.drifted,
        });
        if (!cli.json) {
          info(`  DRIFT  ${graphId} → ${warning.node}: ${warning.drifted.length} source(s) changed`);
        }
      }
    }

    if (sourceDrift.length > 0) {
      result.sourceDrift = sourceDrift;
      result.valid = false;
    }
  }

  if (cli.json) {
    outputJson(result);
    process.exit(result.valid ? EXIT.SUCCESS : EXIT.GRAPH_ERROR);
  }

  info(`\nValidated ${result.graphs.length} graph(s), ${result.errors.length} error(s).\n`);

  if (result.errors.length > 0) {
    error("Errors:");
    for (const e of result.errors) {
      error(`  ${e.file}: ${e.message}`);
    }
    process.exit(EXIT.GRAPH_ERROR);
  }

  if (result.sourceDrift && result.sourceDrift.length > 0) {
    error("Source drift detected:");
    for (const d of result.sourceDrift) {
      error(`  ${d.graphId} → ${d.node}:`);
      for (const s of d.drifted) {
        error(`    ${s.path}${s.section ? `#${s.section}` : ""}`);
      }
    }
    process.exit(EXIT.GRAPH_ERROR);
  }
}
