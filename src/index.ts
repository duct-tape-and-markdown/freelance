import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGraphs } from "./loader.js";
import { startServer } from "./server.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const graphsIdx = args.indexOf("--graphs");

  if (graphsIdx === -1 || !args[graphsIdx + 1]) {
    console.error("Usage: graph-engine --graphs <directory> [--validate] [--max-depth <number>]");
    process.exit(1);
  }

  let maxDepth = 5;
  const maxDepthIdx = args.indexOf("--max-depth");
  if (maxDepthIdx !== -1 && args[maxDepthIdx + 1]) {
    const parsed = parseInt(args[maxDepthIdx + 1], 10);
    if (isNaN(parsed) || parsed < 1) {
      console.error("--max-depth must be a positive integer (minimum 1)");
      process.exit(1);
    }
    maxDepth = parsed;
  }

  return {
    graphsDir: args[graphsIdx + 1],
    validate: args.includes("--validate"),
    maxDepth,
  };
}

function validateMode(graphsDir: string) {
  const resolvedDir = path.resolve(graphsDir);

  if (!fs.existsSync(resolvedDir)) {
    console.error(`Graph directory does not exist: ${resolvedDir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(resolvedDir)
    .filter((f) => f.endsWith(".graph.yaml"));

  if (files.length === 0) {
    console.error(`No *.graph.yaml files found in: ${resolvedDir}`);
    process.exit(1);
  }

  const tmpBase = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "ge-")
  );
  let loaded = 0;
  const errors: string[] = [];

  for (const file of files) {
    const tmpDir = path.join(tmpBase, file);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.copyFileSync(path.join(resolvedDir, file), path.join(tmpDir, file));

    try {
      const graphs = loadGraphs(tmpDir);
      for (const [id, { definition, graph }] of graphs) {
        console.log(
          `  OK  ${definition.name} (id: ${id}, v${definition.version}, ${graph.nodeCount()} nodes)`
        );
        loaded++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`  FAIL  ${file}: ${msg}`);
    }
  }

  console.log(`\nLoaded ${loaded} graph(s), ${errors.length} failed.\n`);

  if (errors.length > 0) {
    console.error("Errors:");
    for (const e of errors) {
      console.error(e);
    }
    process.exit(1);
  }
}

async function serverMode(graphsDir: string, maxDepth: number) {
  try {
    const graphs = loadGraphs(graphsDir);
    const ids = [...graphs.keys()];
    // Log to stderr — stdout is the MCP transport
    console.error(
      `Graph Engine: loaded ${graphs.size} graph(s) (${ids.join(", ")}), maxDepth=${maxDepth}`
    );
    await startServer(graphs, { maxDepth });
  } catch (err) {
    console.error(
      "Graph loading failed:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }
}

const { graphsDir, validate, maxDepth } = parseArgs();

if (validate) {
  validateMode(graphsDir);
} else {
  serverMode(graphsDir, maxDepth);
}
