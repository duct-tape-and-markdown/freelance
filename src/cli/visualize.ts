/**
 * CLI handler for `freelance visualize` — JSON-only.
 *
 * Per docs/decisions.md § "CLI is the execution surface for agents",
 * output is always structured JSON. The previous `--open` (browser
 * rendering) path is removed — agents don't open browsers. The
 * `--output <path>` flag still writes the raw diagram to a file for
 * callers that want to pipe to external tooling.
 */

import fs from "node:fs";
import path from "node:path";
import { loadSingleGraph } from "../loader.js";
import type { GraphDefinition } from "../types.js";
import { EXIT, fatal, outputJson } from "./output.js";

type Format = "mermaid" | "dot";

interface VisualizeOptions {
  format: Format;
  output?: string;
}

function dotNodeDef(nodeId: string, type: string, label: string): string {
  const shapes: Record<string, string> = {
    action: "box",
    decision: "diamond",
    gate: "diamond",
    terminal: "doublecircle",
    wait: "box",
  };
  const shape = shapes[type] ?? "box";
  const style = type === "gate" ? `, style="bold"` : type === "wait" ? `, style="dashed"` : "";
  return `  "${nodeId}" [label="${label}", shape=${shape}${style}];`;
}

function mermaidNode(nodeId: string, type: string): string {
  switch (type) {
    case "decision":
    case "gate":
      return `${nodeId}{${nodeId}}`;
    case "terminal":
      return `${nodeId}((${nodeId}))`;
    case "wait":
      return `${nodeId}([${nodeId}])`;
    default:
      return `${nodeId}[${nodeId}]`;
  }
}

function toMermaid(def: GraphDefinition): string {
  const lines: string[] = ["graph TD"];

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (node.edges) {
      for (const edge of node.edges) {
        const src = mermaidNode(nodeId, node.type);
        const tgt = mermaidNode(edge.target, def.nodes[edge.target].type);
        lines.push(`    ${src} -->|${edge.label}| ${tgt}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function toDot(def: GraphDefinition): string {
  const lines: string[] = [
    `digraph "${def.id}" {`,
    `  rankdir=TD;`,
    `  node [fontname="Helvetica"];`,
    `  edge [fontname="Helvetica", fontsize=10];`,
    "",
  ];

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    lines.push(dotNodeDef(nodeId, node.type, nodeId));
  }

  lines.push("");

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (node.edges) {
      for (const edge of node.edges) {
        lines.push(`  "${nodeId}" -> "${edge.target}" [label="${edge.label}"];`);
      }
    }
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function loadDefinition(filePath: string): GraphDefinition {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    fatal(`File not found: ${resolved}`, EXIT.NOT_FOUND, "FILE_NOT_FOUND");
  }

  if (!resolved.endsWith(".workflow.yaml")) {
    fatal(
      `File must have .workflow.yaml extension: ${path.basename(resolved)}`,
      EXIT.INVALID_INPUT,
      "INVALID_EXTENSION",
    );
  }

  try {
    const { definition } = loadSingleGraph(resolved);
    return definition;
  } catch (err) {
    fatal(
      `Failed to load graph: ${err instanceof Error ? err.message : err}`,
      EXIT.VALIDATION,
      "GRAPH_LOAD_FAILED",
    );
  }
}

export function visualize(filePath: string, options: VisualizeOptions): void {
  const definition = loadDefinition(filePath);
  const format = options.format ?? "mermaid";

  const diagram = format === "dot" ? toDot(definition) : toMermaid(definition);

  // `--output <path>` writes the raw diagram to a file so callers can
  // pipe directly to a renderer. On stdout we always emit JSON so the
  // agent driving this has a structured payload to reason about.
  if (options.output) {
    const outPath = path.resolve(options.output);
    fs.writeFileSync(outPath, diagram);
    outputJson({ graphId: definition.id, format, written: outPath });
    return;
  }

  outputJson({ graphId: definition.id, format, [format]: diagram });
}
