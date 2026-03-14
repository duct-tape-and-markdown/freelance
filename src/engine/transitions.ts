import { evaluate } from "../evaluator.js";
import type { NodeDefinition, TransitionInfo } from "../types.js";

export function evaluateTransitions(
  node: NodeDefinition,
  context: Record<string, unknown>
): TransitionInfo[] {
  if (!node.edges) return [];

  interface MutableTransition {
    label: string;
    target: string;
    condition?: string;
    description?: string;
    nextStepHint?: string;
    conditionMet: boolean;
    isDefault: boolean;
  }

  const results: MutableTransition[] = node.edges.map((e) => {
    let conditionMet: boolean;
    if (e.default) {
      conditionMet = false;
    } else if (e.condition) {
      try {
        conditionMet = evaluate(e.condition, context);
      } catch {
        conditionMet = false;
      }
    } else {
      conditionMet = true;
    }

    return {
      label: e.label,
      target: e.target,
      ...(e.condition ? { condition: e.condition } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(e.nextStepHint ? { nextStepHint: e.nextStepHint } : {}),
      conditionMet,
      isDefault: !!e.default,
    };
  });

  const anyConditionalMet = results.some(
    (r) =>
      !r.isDefault &&
      r.conditionMet &&
      node.edges!.find((e) => e.label === r.label)?.condition
  );

  for (const r of results) {
    if (r.isDefault) {
      r.conditionMet = !anyConditionalMet;
    }
  }

  return results.map(({ isDefault, ...rest }): TransitionInfo => rest);
}
