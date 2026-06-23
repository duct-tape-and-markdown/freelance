import { evaluatePredicate } from "../evaluator.js";
import type { NodeDefinition, TransitionInfo } from "../types.js";

export function evaluateTransitions(
  node: NodeDefinition,
  context: Record<string, unknown>,
): TransitionInfo[] {
  if (!node.edges) return [];

  // Single allocation: build the wire-shape results directly, tracking
  // default-edge positions and whether any conditional edge fired in a
  // parallel pass. Default edges get conditionMet=false here, then a
  // final loop flips them to !anyConditionalMet — no transient field to
  // strip and no second .map().
  const results: { -readonly [K in keyof TransitionInfo]: TransitionInfo[K] }[] = [];
  const defaultIndices: number[] = [];
  let anyConditionalMet = false;

  node.edges.forEach((e, i) => {
    let conditionMet: boolean;
    if (e.default) {
      conditionMet = false;
      defaultIndices.push(i);
    } else if (e.condition) {
      conditionMet = evaluatePredicate(e.condition, context);
      if (conditionMet) anyConditionalMet = true;
    } else {
      conditionMet = true;
    }

    results.push({
      label: e.label,
      target: e.target,
      ...(e.condition ? { condition: e.condition } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(e.nextStepHint ? { nextStepHint: e.nextStepHint } : {}),
      conditionMet,
    });
  });

  for (const i of defaultIndices) {
    results[i].conditionMet = !anyConditionalMet;
  }

  return results;
}
