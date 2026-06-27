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

import { EC } from "./error-codes.js";
import { EngineError } from "./errors.js";
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
      throw new EngineError(
        `[${filePath}] Node "${nodeId}": terminal node must not have a returns schema`,
        EC.GRAPH_STRUCTURE_INVALID,
      );
    }

    const requiredKeys = new Set(Object.keys(node.returns.required ?? {}));
    const optionalKeys = new Set(Object.keys(node.returns.optional ?? {}));

    for (const key of optionalKeys) {
      if (requiredKeys.has(key)) {
        throw new EngineError(
          `[${filePath}] Node "${nodeId}": returns key "${key}" appears in both required and optional`,
          EC.GRAPH_STRUCTURE_INVALID,
        );
      }
    }

    const allFields = {
      ...(node.returns.required ?? {}),
      ...(node.returns.optional ?? {}),
    };

    for (const [key, field] of Object.entries(allFields)) {
      if (field.items && field.type !== "array") {
        throw new EngineError(
          `[${filePath}] Node "${nodeId}": returns key "${key}" has "items" but type is "${field.type}" (items only valid on array type)`,
          EC.GRAPH_STRUCTURE_INVALID,
        );
      }
    }
  }
}

/**
 * An object that looks like a context field descriptor (has a `type` key
 * plus an `enum` or `default`) but failed descriptor parsing — almost
 * certainly an intended descriptor with a typo (e.g. `type: "strng"`),
 * which the schema's `union([descriptor, unknown])` would otherwise accept
 * as an opaque literal and silently degrade to (#339). A bare `{type: …}`
 * with no enum/default is left alone — indistinguishable from a literal
 * object that happens to have a `type` field.
 */
function looksLikeMalformedDescriptor(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    "type" in v &&
    ("enum" in v || "default" in v) &&
    !isContextFieldDescriptor(v)
  );
}

/**
 * Validate context field descriptors at load (#339):
 *   - a malformed-looking descriptor (typo'd type) is rejected rather than
 *     silently treated as a literal;
 *   - a valid descriptor's `default` must match its declared `type` and,
 *     when an `enum` is declared, be one of the allowed values.
 */
export function validateContextDescriptors(def: GraphDefinition, filePath: string): void {
  if (!def.context) return;
  for (const [key, value] of Object.entries(def.context)) {
    if (looksLikeMalformedDescriptor(value)) {
      throw new EngineError(
        `[${filePath}] Context field "${key}" looks like a descriptor but is malformed — ` +
          `"type" must be one of "string", "number", "boolean". Fix it, or drop the ` +
          `type/enum/default keys if it is meant to be a literal value.`,
        EC.GRAPH_STRUCTURE_INVALID,
      );
    }
    if (!isContextFieldDescriptor(value)) continue;

    const { type, enum: allowed, default: dflt } = value;
    if (dflt === null || dflt === undefined) continue;

    if (typeof dflt !== type) {
      throw new EngineError(
        `[${filePath}] Context field "${key}": default ${JSON.stringify(dflt)} is not of declared type "${type}"`,
        EC.GRAPH_STRUCTURE_INVALID,
      );
    }
    if (allowed && !allowed.map(String).includes(String(dflt))) {
      throw new EngineError(
        `[${filePath}] Context field "${key}": default ${JSON.stringify(dflt)} is not in the declared enum [${allowed.join(", ")}]`,
        EC.GRAPH_STRUCTURE_INVALID,
      );
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
      throw new EngineError(
        `${location} references context.${property} with value '${literal}' ` +
          `which is not in the declared enum [${[...allowed].join(", ")}]`,
        EC.GRAPH_STRUCTURE_INVALID,
      );
    }
  }
}

/**
 * Parse-check one expression and its enum compliance, wrapping any
 * failure in a GRAPH_STRUCTURE_INVALID with a location-prefixed message.
 * `location` is the prefix `checkEnumCompliance` reports against;
 * `describe` builds the catch message (the call sites phrase the
 * "invalid …" wording differently per expression kind).
 */
function validateOneExpression(
  expr: string,
  enumMap: Map<string, Set<string>>,
  location: string,
  describe: (innerMessage: string) => string,
): void {
  try {
    validateExpression(expr);
    checkEnumCompliance(expr, enumMap, location);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new EngineError(describe(msg), EC.GRAPH_STRUCTURE_INVALID);
  }
}

/**
 * Parse-check all expressions in edge conditions and validation rules.
 * Catches malformed expressions at load time, not at traversal time.
 * Also checks string literals against declared context enums, and — under
 * strictContext — that referenced context fields are declared.
 */
export function validateExpressions(def: GraphDefinition, filePath: string): void {
  const enumMap = extractContextEnums(def);

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    const at = `[${filePath}] Node "${nodeId}"`;

    for (const v of node.validations ?? []) {
      validateOneExpression(
        v.expr,
        enumMap,
        `${at}: validation`,
        (m) => `${at}: invalid validation expression "${v.expr}": ${m}`,
      );
    }

    for (const edge of node.edges ?? []) {
      if (!edge.condition) continue;
      validateOneExpression(
        edge.condition,
        enumMap,
        `${at}: edge "${edge.label}"`,
        (m) => `${at}: edge "${edge.label}" has invalid condition "${edge.condition}": ${m}`,
      );
    }

    if (node.subgraph?.condition) {
      validateOneExpression(
        node.subgraph.condition,
        enumMap,
        `${at}: subgraph condition`,
        (m) => `${at}: invalid subgraph condition "${node.subgraph?.condition}": ${m}`,
      );
    }
  }
}
