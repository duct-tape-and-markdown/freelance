import { createRequire } from "node:module";

let version = "0.0.0";
try {
  const require = createRequire(import.meta.url);
  version = (require("../package.json") as { version: string }).version;
} catch {
  // Fallback when package.json is unreachable (e.g. bundled or relocated)
}

export const VERSION: string = version;
