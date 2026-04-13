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
 * Pure: no I/O, no graphlib, no side effects.
 */

import { extractPropertyComparisons, validateExpression } from "./evaluator.js";
import type { GraphDefinition } from "./schema/graph-schema.js";
import { isContextFieldDescriptor } from "./schema/graph-schema.js";

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
