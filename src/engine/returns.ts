import type { NodeDefinition, ReturnField } from "../types.js";

export function checkType(value: unknown, expectedType: ReturnField["type"]): boolean {
  switch (expectedType) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && !Array.isArray(value) && value !== null;
  }
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateField(key: string, field: ReturnField, value: unknown): string | null {
  if (!checkType(value, field.type)) {
    return `key "${key}" expected type "${field.type}" but got "${actualType(value)}"`;
  }
  if (field.type === "array" && field.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!checkType(value[i], field.items)) {
        return `key "${key}" array item [${i}] expected type "${field.items}" but got "${actualType(value[i])}"`;
      }
    }
  }
  return null;
}

export function validateReturnSchema(
  returns: NonNullable<NodeDefinition["returns"]>,
  context: Record<string, unknown>,
): string | null {
  if (returns.required) {
    for (const [key, field] of Object.entries(returns.required)) {
      if (!(key in context) || context[key] === undefined) {
        return `required key "${key}" (type: ${field.type}) is missing from context`;
      }
      const violation = validateField(key, field, context[key]);
      if (violation) return violation;
    }
  }

  if (returns.optional) {
    for (const [key, field] of Object.entries(returns.optional)) {
      if (!(key in context) || context[key] === undefined) continue;
      const violation = validateField(key, field, context[key]);
      if (violation) return violation;
    }
  }

  return null;
}
