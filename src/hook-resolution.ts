/**
 * Resolve `onEnter[].call` fields for a loaded graph.
 *
 * Two modes, both checked at graph-load time:
 *   - Bare identifier (e.g. `memory_status`) must match a built-in hook.
 *   - Relative path (`./foo.js`, `../scripts/bar.js`) is resolved against
 *     the directory containing the graph file and must point to an
 *     existing file. Absolute paths are rejected.
 *
 * Programmatic graphs (GraphBuilder) skip this pass entirely — they have
 * no source file to anchor relative paths against, and the builder API
 * doesn't currently expose `onEnter`. Engine-side, a missing hook
 * resolution map is treated as "no hooks declared", which is safe because
 * any node without `onEnter` is a no-op regardless.
 */

import fs from "node:fs";
import path from "node:path";
import { BUILTIN_HOOK_NAMES } from "./engine/builtin-hooks.js";
import type { GraphDefinition } from "./schema/graph-schema.js";

export type ResolvedHook =
  | { readonly kind: "builtin"; readonly call: string; readonly name: string }
  | { readonly kind: "script"; readonly call: string; readonly absolutePath: string };

export type HookResolutionMap = ReadonlyMap<string, readonly ResolvedHook[]>;

/**
 * Walk every node's `onEnter` list and resolve each hook reference.
 * Returns a map keyed by node id; nodes without hooks are absent.
 * Throws a single error listing every problem found (so the author
 * fixes all of them in one pass instead of whack-a-mole).
 */
export function resolveGraphHooks(def: GraphDefinition, graphFilePath: string): HookResolutionMap {
  const graphDir = path.dirname(path.resolve(graphFilePath));
  const resolutions = new Map<string, ResolvedHook[]>();
  const errors: string[] = [];

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (!node.onEnter || node.onEnter.length === 0) continue;

    const nodeResolutions: ResolvedHook[] = [];
    for (const [i, hook] of node.onEnter.entries()) {
      const resolved = resolveOneHook(hook.call, graphDir);
      if (typeof resolved === "string") {
        errors.push(`Node "${nodeId}", onEnter[${i}]: ${resolved}`);
      } else {
        nodeResolutions.push(resolved);
      }
    }
    if (nodeResolutions.length > 0) {
      resolutions.set(nodeId, nodeResolutions);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `[${graphFilePath}] Hook resolution failed:\n${errors.map((e) => `  ${e}`).join("\n")}`,
    );
  }

  return resolutions;
}

/**
 * Resolve every `onEnter` entry on a programmatically built graph,
 * accepting BUILT-IN HOOK NAMES ONLY. Script paths are rejected because
 * a programmatic graph has no source-file directory to anchor them
 * against. Throws a single error listing every problem found.
 */
export function resolveBuiltinOnlyHooks(def: GraphDefinition): HookResolutionMap {
  const resolutions = new Map<string, ResolvedHook[]>();
  const errors: string[] = [];

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (!node.onEnter || node.onEnter.length === 0) continue;

    const nodeResolutions: ResolvedHook[] = [];
    for (const [i, hook] of node.onEnter.entries()) {
      const call = hook.call;
      if (call.length === 0) {
        errors.push(`Node "${nodeId}", onEnter[${i}]: empty call value`);
        continue;
      }
      if (call.startsWith("./") || call.startsWith("../") || call.includes("/")) {
        errors.push(
          `Node "${nodeId}", onEnter[${i}]: programmatic graphs may only reference ` +
            `built-in hooks by name; script paths like "${call}" require a YAML graph ` +
            `with a source-file directory to anchor against.`,
        );
        continue;
      }
      if (!BUILTIN_HOOK_NAMES.has(call)) {
        errors.push(
          `Node "${nodeId}", onEnter[${i}]: unknown built-in hook "${call}". ` +
            `Registered built-ins: [${[...BUILTIN_HOOK_NAMES].join(", ")}]`,
        );
        continue;
      }
      nodeResolutions.push({ kind: "builtin", call, name: call });
    }
    if (nodeResolutions.length > 0) {
      resolutions.set(nodeId, nodeResolutions);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Programmatic graph hook resolution failed:\n${errors.map((e) => `  ${e}`).join("\n")}`,
    );
  }
  return resolutions;
}

/**
 * Resolve a single `call:` string. Returns the resolved hook on success
 * or an error string on failure so the caller can collect multiple
 * failures into one error message.
 */
function resolveOneHook(call: string, graphDir: string): ResolvedHook | string {
  if (call.length === 0) {
    return `empty call value`;
  }

  const isRelativePath = call.startsWith("./") || call.startsWith("../");
  const looksLikePath = isRelativePath || call.startsWith("/") || call.includes("/");

  if (!looksLikePath) {
    if (!BUILTIN_HOOK_NAMES.has(call)) {
      return (
        `unknown built-in hook "${call}". Registered built-ins: ` +
        `[${[...BUILTIN_HOOK_NAMES].join(", ")}]. ` +
        `For a local script, use a relative path like "./scripts/${call}.js".`
      );
    }
    return { kind: "builtin", call, name: call };
  }

  if (!isRelativePath) {
    return (
      `script path "${call}" must be relative (start with "./" or "../"). ` +
      `Absolute paths are rejected to keep graphs portable.`
    );
  }

  const absolutePath = path.resolve(graphDir, call);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `script "${call}" not found at ${absolutePath}`;
  }
  if (!stat.isFile()) {
    return `script "${call}" at ${absolutePath} is not a regular file`;
  }

  return { kind: "script", call, absolutePath };
}
