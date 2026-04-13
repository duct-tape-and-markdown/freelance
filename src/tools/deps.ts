/**
 * Dependency bundle for freelance_* MCP tool handlers.
 *
 * Lives in its own module so each per-tool file can import it without
 * creating a cycle with `./index.ts` (which imports every tool's register
 * function and would otherwise re-enter through the shared type import).
 *
 * Tools destructure only what they need. Mutable fields (loadErrors) are
 * exposed as getters so tools always see the current value without being
 * re-registered when the watcher mutates state.
 */

import type { SourceOptions } from "../sources.js";
import type { TraversalStore } from "../state/index.js";
import type { ValidatedGraph } from "../types.js";

export interface FreelanceToolDeps {
  manager: TraversalStore;
  graphs: Map<string, ValidatedGraph>;
  sourceOpts: SourceOptions;
  graphsDirs?: string[];
  validateSourcesOnStart?: boolean;
  getLoadErrors: () => Array<{ file: string; message: string }>;
}
