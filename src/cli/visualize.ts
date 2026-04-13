import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadSingleGraph } from "../loader.js";
import type { GraphDefinition } from "../types.js";
import { cli, EXIT, fatal, info, outputJson } from "./output.js";

type Format = "mermaid" | "dot";

export interface VisualizeOptions {
  format: Format;
  output?: string;
  open?: boolean;
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

  return lines.join("\n") + "\n";
}

function toDot(def: GraphDefinition): string {
  const lines: string[] = [
    `digraph "${def.id}" {`,
    `  rankdir=TD;`,
    `  node [fontname="Helvetica"];`,
    `  edge [fontname="Helvetica", fontsize=10];`,
    "",
  ];

  // Node definitions
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    lines.push(dotNodeDef(nodeId, node.type, nodeId));
  }

  lines.push("");

  // Edges
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (node.edges) {
      for (const edge of node.edges) {
        lines.push(`  "${nodeId}" -> "${edge.target}" [label="${edge.label}"];`);
      }
    }
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toHtml(mermaidCode: string, title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <style>
    body { font-family: sans-serif; display: flex; justify-content: center; padding: 2rem; }
    .mermaid { max-width: 100%; }
  </style>
</head>
<body>
  <div class="mermaid">
${mermaidCode}
  </div>
  <script>mermaid.initialize({ startOnLoad: true });</script>
</body>
</html>`;
}

function loadDefinition(filePath: string): GraphDefinition {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    fatal(`File not found: ${resolved}`, EXIT.GRAPH_ERROR);
  }

  if (!resolved.endsWith(".workflow.yaml")) {
    fatal(
      `File must have .workflow.yaml extension: ${path.basename(resolved)}`,
      EXIT.INVALID_USAGE,
    );
  }

  try {
    const { definition } = loadSingleGraph(resolved);
    return definition;
  } catch (err) {
    fatal(`Failed to load graph: ${err instanceof Error ? err.message : err}`, EXIT.GRAPH_ERROR);
  }
}

export function visualize(filePath: string, options: VisualizeOptions): void {
  const definition = loadDefinition(filePath);
  const format = options.format ?? "mermaid";

  let diagram: string;
  if (format === "dot") {
    diagram = toDot(definition);
  } else {
    diagram = toMermaid(definition);
  }

  if (cli.json) {
    const result: Record<string, string> = {
      graphId: definition.id,
    };
    result[format] = diagram;
    outputJson(result);
    return;
  }

  if (options.open) {
    const mermaidCode = format === "dot" ? toMermaid(definition) : diagram;
    const html = toHtml(mermaidCode, definition.name);
    const tmpFile = path.join(process.env.TMPDIR ?? "/tmp", `freelance-${definition.id}.html`);
    fs.writeFileSync(tmpFile, html);

    const platform = process.platform;
    const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
    try {
      execFileSync(cmd, [tmpFile]);
      info(`Opened in browser: ${tmpFile}`);
    } catch {
      info(`Generated: ${tmpFile}`);
      info("Could not open browser automatically.");
    }
    return;
  }

  if (options.output) {
    const outPath = path.resolve(options.output);
    fs.writeFileSync(outPath, diagram);
    info(`Written to: ${outPath}`);
  } else {
    process.stdout.write(diagram);
  }
}
