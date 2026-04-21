/**
 * Pre-build validation of graph definitions.
 *
 * Runs after schema parsing but before graphlib construction. Catches
 * problems that are correct at the structural level (Zod passed) but
 * wrong at the semantic level — malformed return schemas, invalid edge
 * condition expressions, enum literal mismatches against context
 * field descriptors. Each check throws a descriptive error tagged with
 * the file path so authors can jump straight to the offending node.
 *
 * Warning-level checks (non-fatal) return a `GraphLintWarning[]` instead
 * of throwing — the caller decides whether to surface them. See
 * `lintRequiredMeta` for the contract.
 *
 * Pure: no I/O, no graphlib, no side effects.
 */

import { extractPropertyComparisons, validateExpression } from "./evaluator.js";
import type { GraphDefinition } from "./schema/graph-schema.js";
import { isContextFieldDescriptor } from "./schema/graph-schema.js";

/**
 * Non-fatal lint finding. Unlike the throwing validators above, lint
 * checks accumulate warnings and return them so a caller can render
 * them without blocking validation. `rule` identifies the lint so
 * callers can filter / suppress by category in future.
 */
export interface GraphLintWarning {
  readonly file: string;
  readonly rule: string;
  readonly message: string;
}

/**
 * Validate return schema structure on nodes.
 * - items only valid on array type
 * - required/optional keys must not overlap
 * - terminal nodes must not have returns
 */
export function validateReturnSchemas(def: GraphDefinition, filePath: string): void {
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (!node.returns) continue;

    if (node.type === "terminal") {
      throw new Error(
        `[${filePath}] Node "${nodeId}": terminal node must not have a returns schema`,
      );
    }

    const requiredKeys = new Set(Object.keys(node.returns.required ?? {}));
    const optionalKeys = new Set(Object.keys(node.returns.optional ?? {}));

    for (const key of optionalKeys) {
      if (requiredKeys.has(key)) {
        throw new Error(
          `[${filePath}] Node "${nodeId}": returns key "${key}" appears in both required and optional`,
        );
      }
    }

    const allFields = {
      ...(node.returns.required ?? {}),
      ...(node.returns.optional ?? {}),
    };

    for (const [key, field] of Object.entries(allFields)) {
      if (field.items && field.type !== "array") {
        throw new Error(
          `[${filePath}] Node "${nodeId}": returns key "${key}" has "items" but type is "${field.type}" (items only valid on array type)`,
        );
      }
    }
  }
}

/**
 * Extract enum constraints from context field descriptors.
 * Returns a map of field name → set of allowed string values.
 */
function extractContextEnums(def: GraphDefinition): Map<string, Set<string>> {
  const enums = new Map<string, Set<string>>();
  if (!def.context) return enums;
  for (const [key, value] of Object.entries(def.context)) {
    if (isContextFieldDescriptor(value) && value.enum) {
      enums.set(key, new Set(value.enum.map(String)));
    }
  }
  return enums;
}

/**
 * Check an expression's string literals against declared context enums.
 * Throws if a literal is not in the declared enum for that field.
 */
function checkEnumCompliance(
  expr: string,
  enumMap: Map<string, Set<string>>,
  location: string,
): void {
  if (enumMap.size === 0) return;
  const comparisons = extractPropertyComparisons(expr);
  for (const { property, literal } of comparisons) {
    const allowed = enumMap.get(property);
    if (allowed && !allowed.has(literal)) {
      throw new Error(
        `${location} references context.${property} with value '${literal}' ` +
          `which is not in the declared enum [${[...allowed].join(", ")}]`,
      );
    }
  }
}

/**
 * Parse-check all expressions in edge conditions and validation rules.
 * Catches malformed expressions at load time, not at traversal time.
 * Also checks string literals against declared context enums.
 */
export function validateExpressions(def: GraphDefinition, filePath: string): void {
  const enumMap = extractContextEnums(def);

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (node.validations) {
      for (const v of node.validations) {
        try {
          validateExpression(v.expr);
          checkEnumCompliance(v.expr, enumMap, `[${filePath}] Node "${nodeId}": validation`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            `[${filePath}] Node "${nodeId}": invalid validation expression "${v.expr}": ${msg}`,
          );
        }
      }
    }
    if (node.edges) {
      for (const edge of node.edges) {
        if (edge.condition) {
          try {
            validateExpression(edge.condition);
            checkEnumCompliance(
              edge.condition,
              enumMap,
              `[${filePath}] Node "${nodeId}": edge "${edge.label}"`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(
              `[${filePath}] Node "${nodeId}": edge "${edge.label}" has invalid condition "${edge.condition}": ${msg}`,
            );
          }
        }
      }
    }
    // Validate subgraph condition expression
    if (node.subgraph?.condition) {
      try {
        validateExpression(node.subgraph.condition);
        checkEnumCompliance(
          node.subgraph.condition,
          enumMap,
          `[${filePath}] Node "${nodeId}": subgraph condition`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `[${filePath}] Node "${nodeId}": invalid subgraph condition "${node.subgraph.condition}": ${msg}`,
        );
      }
    }
  }
}

/**
 * Lint `requiredMeta` keys for reachability (issue #59).
 *
 * A graph can declare `requiredMeta: [foo]` to enforce that every
 * `freelance start` provides `meta.foo` (see
 * `state/traversal-store.ts` → `REQUIRED_META_MISSING`). But nothing
 * guarantees the agent actually learns the key exists: the start node
 * can lack a `meta_set` onEnter that sets it, and the graph description
 * can omit the key's name. Callers then hit a runtime error on every
 * start.
 *
 * Warn when a `requiredMeta` key has NONE of:
 *  1. A mention in the graph-level `description` (so a reader notices
 *     callers must pass it).
 *  2. A corresponding arg on a `meta_set` onEnter hook on the start node
 *     (so the key is satisfied from context without the caller).
 *
 * Explicit caller-supplied tagging with a documented description is a
 * valid pattern, so emit as a warning, not a hard error.
 */
export function lintRequiredMeta(def: GraphDefinition, filePath: string): GraphLintWarning[] {
  const required = def.requiredMeta;
  if (!required || required.length === 0) return [];

  const startNode = def.nodes[def.startNode];
  const metaSetKeys = new Set<string>();
  if (startNode?.onEnter) {
    for (const hook of startNode.onEnter) {
      if (hook.call !== "meta_set") continue;
      for (const argKey of Object.keys(hook.args ?? {})) {
        metaSetKeys.add(argKey);
      }
    }
  }

  const description = def.description;
  const warnings: GraphLintWarning[] = [];
  for (const key of required) {
    if (metaSetKeys.has(key)) continue;
    if (mentionsKey(description, key)) continue;
    warnings.push({
      file: filePath,
      rule: "required-meta-reachability",
      message:
        `Graph "${def.id}": requiredMeta key "${key}" is not mentioned in the graph description ` +
        `and is not set by a meta_set onEnter hook on start node "${def.startNode}". ` +
        `Callers have no way to learn they must pass meta.${key} at start. ` +
        `Either mention "${key}" in the description, or add an onEnter meta_set hook to the start node.`,
    });
  }
  return warnings;
}

/**
 * Whole-word match for a requiredMeta key inside the description.
 * Uses a word-boundary regex so `externalKey` doesn't spuriously match
 * inside `externalKeyring`, and so documented-by-exact-name is the
 * contract. Escapes regex metacharacters defensively — meta keys are
 * schema-constrained to non-empty strings but not to `[A-Za-z_][\w]*`.
 */
function mentionsKey(description: string, key: string): boolean {
  if (!description) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`);
  return pattern.test(description);
}
