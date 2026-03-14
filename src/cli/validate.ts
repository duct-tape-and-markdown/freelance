import fs from "node:fs";
import path from "node:path";
import { loadSingleGraph, validateCrossGraphRefs } from "../loader.js";
import type { ValidatedGraph } from "../types.js";
import { cli, outputJson, info, error, fatal, EXIT } from "./output.js";

interface GraphResult {
  id: string;
  name: string;
  version: string;
  nodeCount: number;
}

interface ValidateResult {
  valid: boolean;
  graphs: GraphResult[];
  errors: { file: string; message: string }[];
}

export function validate(graphsDir: string): void {
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
}
