/**
 * Document LSP configuration loading.
 *
 * Self-contained — no imports from freelance core.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { DocLspConfig, CorpusConfig } from "./types.js";

const CONFIG_FILENAMES = [
  "document-lsp.config.yml",
  "document-lsp.config.yaml",
];

export function loadConfig(configPath?: string): DocLspConfig {
  if (configPath) {
    return parseConfigFile(path.resolve(configPath));
  }

  // Auto-discover config file in cwd
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.resolve(filename);
    if (fs.existsSync(candidate)) {
      return parseConfigFile(candidate);
    }
  }

  throw new Error(
    `No document-lsp config found. Create ${CONFIG_FILENAMES[0]} or pass --config.`
  );
}

function parseConfigFile(filePath: string): DocLspConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const raw = yaml.load(content) as Record<string, unknown>;

  if (!raw || !Array.isArray(raw.corpora)) {
    throw new Error(`Invalid config: expected 'corpora' array in ${filePath}`);
  }

  const corpora: CorpusConfig[] = (raw.corpora as Record<string, unknown>[]).map(
    (c, i) => {
      if (!c.name || typeof c.name !== "string") {
        throw new Error(`Config corpus[${i}]: missing 'name'`);
      }
      if (!c.root || typeof c.root !== "string") {
        throw new Error(`Config corpus[${i}]: missing 'root'`);
      }

      const configDir = path.dirname(filePath);
      const resolvedRoot = path.resolve(configDir, c.root);

      const patterns: Record<string, string> = {};
      if (c.patterns && typeof c.patterns === "object") {
        for (const [k, v] of Object.entries(c.patterns as Record<string, unknown>)) {
          if (typeof v === "string") {
            // Validate regex
            try {
              new RegExp(v, "g");
            } catch (e) {
              throw new Error(
                `Config corpus "${c.name}": invalid pattern "${k}": ${e instanceof Error ? e.message : String(e)}`
              );
            }
            patterns[k] = v;
          }
        }
      }

      return {
        name: c.name as string,
        root: resolvedRoot,
        patterns,
        frontMatter: c.front_matter !== false,
      };
    }
  );

  return { corpora };
}
