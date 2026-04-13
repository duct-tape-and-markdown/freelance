import { describe, expect, it } from "vitest";
import {
  CONTEXT_PATH_PATTERN,
  EvaluatorError,
  evaluate,
  extractPropertyComparisons,
  resolveContextPath,
} from "../src/evaluator.js";

describe("evaluate — basic equality", () => {
  it("context.value == true with true", () => {
    expect(evaluate("context.value == true", { value: true })).toBe(true);
  });
  it("context.value == true with false", () => {
    expect(evaluate("context.value == true", { value: false })).toBe(false);
  });
  it("context.value == 'hello' match", () => {
    expect(evaluate("context.value == 'hello'", { value: "hello" })).toBe(true);
  });
  it("context.value == 'hello' mismatch", () => {
    expect(evaluate("context.value == 'hello'", { value: "world" })).toBe(false);
  });
  it("context.value == null with null", () => {
    expect(evaluate("context.value == null", { value: null })).toBe(true);
  });
  it("context.value == null with undefined property", () => {
    expect(evaluate("context.value == null", {})).toBe(true);
  });
  it("context.value != null with value", () => {
    expect(evaluate("context.value != null", { value: "something" })).toBe(true);
  });
  it("context.count == 0", () => {
    expect(evaluate("context.count == 0", { count: 0 })).toBe(true);
  });
  it("context.count == 3", () => {
    expect(evaluate("context.count == 3", { count: 3 })).toBe(true);
  });
});

describe("evaluate — no type coercion", () => {
  it("1 is not true", () => {
    expect(evaluate("context.value == true", { value: 1 })).toBe(false);
  });
  it("false is not 0", () => {
    expect(evaluate("context.value == 0", { value: false })).toBe(false);
  });
  it("string '5' is not number 5", () => {
    expect(evaluate("context.value == '5'", { value: 5 })).toBe(false);
  });
});

describe("evaluate — comparison operators", () => {
  it("5 > 0", () => {
    expect(evaluate("context.count > 0", { count: 5 })).toBe(true);
  });
  it("0 > 0 is false", () => {
    expect(evaluate("context.count > 0", { count: 0 })).toBe(false);
  });
  it("2 < 3", () => {
    expect(evaluate("context.count < 3", { count: 2 })).toBe(true);
  });
  it("3 >= 3", () => {
    expect(evaluate("context.count >= 3", { count: 3 })).toBe(true);
  });
  it("4 <= 3 is false", () => {
    expect(evaluate("context.count <= 3", { count: 4 })).toBe(false);
  });
});

describe("evaluate — logical operators", () => {
  it("true && true", () => {
    expect(evaluate("context.a == true && context.b == true", { a: true, b: true })).toBe(true);
  });
  it("true && false", () => {
    expect(evaluate("context.a == true && context.b == true", { a: true, b: false })).toBe(false);
  });
  it("false || true", () => {
    expect(evaluate("context.a == true || context.b == true", { a: false, b: true })).toBe(true);
  });
  it("false || false", () => {
    expect(evaluate("context.a == true || context.b == true", { a: false, b: false })).toBe(false);
  });
  it("!false is true", () => {
    expect(evaluate("!context.value", { value: false })).toBe(true);
  });
  it("!true is false", () => {
    expect(evaluate("!context.value", { value: true })).toBe(false);
  });
});

describe("evaluate — nested property access", () => {
  it("nested.deep match", () => {
    expect(evaluate("context.nested.deep == 'found'", { nested: { deep: "found" } })).toBe(true);
  });
  it("nested.deep missing deep key", () => {
    expect(evaluate("context.nested.deep == null", { nested: {} })).toBe(true);
  });
  it("nested.deep missing nested key entirely", () => {
    expect(evaluate("context.nested.deep == null", {})).toBe(true);
  });
});

describe("evaluate — parentheses", () => {
  it("(a || b) && c — true", () => {
    expect(
      evaluate("(context.a == true || context.b == true) && context.c == true", {
        a: false,
        b: true,
        c: true,
      }),
    ).toBe(true);
  });
  it("(a || b) && c — false", () => {
    expect(
      evaluate("(context.a == true || context.b == true) && context.c == true", {
        a: false,
        b: true,
        c: false,
      }),
    ).toBe(false);
  });
});

describe("evaluate — short-circuit", () => {
  it("&& short-circuits on false", () => {
    // b is undefined, but shouldn't matter since a is false
    expect(evaluate("context.a == true && context.b == true", { a: false })).toBe(false);
  });
  it("|| short-circuits on true", () => {
    // b is undefined, but shouldn't matter since a is true
    expect(evaluate("context.a == true || context.b == true", { a: true })).toBe(true);
  });
});

describe("evaluate — truthiness (bare property access)", () => {
  it("true is truthy", () => {
    expect(evaluate("context.value", { value: true })).toBe(true);
  });
  it("nonempty string is truthy", () => {
    expect(evaluate("context.value", { value: "nonempty" })).toBe(true);
  });
  it("0 is falsy", () => {
    expect(evaluate("context.value", { value: 0 })).toBe(false);
  });
  it("null is falsy", () => {
    expect(evaluate("context.value", { value: null })).toBe(false);
  });
  it("empty string is falsy", () => {
    expect(evaluate("context.value", { value: "" })).toBe(false);
  });
  it("undefined is falsy", () => {
    expect(evaluate("context.value", {})).toBe(false);
  });
});

describe("evaluate — error cases", () => {
  it("=== is not supported", () => {
    expect(() => evaluate("context.value === true", { value: true })).toThrow(EvaluatorError);
  });
  it("unexpected end of expression", () => {
    expect(() => evaluate("context.value == ", { value: true })).toThrow(EvaluatorError);
  });
  it("unclosed string", () => {
    expect(() => evaluate("context.value == 'unclosed", { value: "" })).toThrow(EvaluatorError);
  });
  it("unexpected token at start", () => {
    expect(() => evaluate("&&", {})).toThrow(EvaluatorError);
  });
  it("empty expression", () => {
    expect(() => evaluate("", {})).toThrow(EvaluatorError);
  });
});

describe("evaluate — whitespace handling", () => {
  it("extra whitespace", () => {
    expect(evaluate("  context.value  ==  true  ", { value: true })).toBe(true);
  });
  it("no whitespace", () => {
    expect(evaluate("context.value==true", { value: true })).toBe(true);
  });
});

describe("evaluate — expressions from spec examples", () => {
  it("context.remainingItems > 0", () => {
    expect(evaluate("context.remainingItems > 0", { remainingItems: 5 })).toBe(true);
  });
  it("context.remainingItems == 0", () => {
    expect(evaluate("context.remainingItems == 0", { remainingItems: 0 })).toBe(true);
  });
  it("cycleCount < 3 && remainingItems > 0 — true", () => {
    expect(
      evaluate("context.cycleCount < 3 && context.remainingItems > 0", {
        cycleCount: 1,
        remainingItems: 3,
      }),
    ).toBe(true);
  });
  it("cycleCount < 3 && remainingItems > 0 — false", () => {
    expect(
      evaluate("context.cycleCount < 3 && context.remainingItems > 0", {
        cycleCount: 3,
        remainingItems: 3,
      }),
    ).toBe(false);
  });
  it("context.verificationPassed == true", () => {
    expect(evaluate("context.verificationPassed == true", { verificationPassed: true })).toBe(true);
  });
  it("context.qualityScore >= 80 — pass", () => {
    expect(evaluate("context.qualityScore >= 80", { qualityScore: 85 })).toBe(true);
  });
  it("context.qualityScore >= 80 — fail", () => {
    expect(evaluate("context.qualityScore >= 80", { qualityScore: 75 })).toBe(false);
  });
  it("context.changeType == 'standard'", () => {
    expect(evaluate("context.changeType == 'standard'", { changeType: "standard" })).toBe(true);
  });
  it("testsPass == false || lintPass == false — one fails", () => {
    expect(
      evaluate("context.testsPass == false || context.lintPass == false", {
        testsPass: false,
        lintPass: true,
      }),
    ).toBe(true);
  });
  it("testsPass == false || lintPass == false — both pass", () => {
    expect(
      evaluate("context.testsPass == false || context.lintPass == false", {
        testsPass: true,
        lintPass: true,
      }),
    ).toBe(false);
  });
  it("context.outputUrl != null — has value", () => {
    expect(evaluate("context.outputUrl != null", { outputUrl: "https://example.com" })).toBe(true);
  });
  it("context.outputUrl != null — null", () => {
    expect(evaluate("context.outputUrl != null", { outputUrl: null })).toBe(false);
  });
  it("context.scopeQuestionRaised == true", () => {
    expect(evaluate("context.scopeQuestionRaised == true", { scopeQuestionRaised: true })).toBe(
      true,
    );
  });
  it("reviewApproved || !touchesSensitiveArea", () => {
    expect(
      evaluate("context.reviewApproved == true || context.touchesSensitiveArea == false", {
        reviewApproved: false,
        touchesSensitiveArea: false,
      }),
    ).toBe(true);
  });
});

describe("extractPropertyComparisons", () => {
  it("extracts simple context.X == 'value'", () => {
    const result = extractPropertyComparisons("context.phase == 'base'");
    expect(result).toEqual([{ property: "phase", operator: "==", literal: "base" }]);
  });

  it("extracts reversed 'value' == context.X", () => {
    const result = extractPropertyComparisons("'base' == context.phase");
    expect(result).toEqual([{ property: "phase", operator: "==", literal: "base" }]);
  });

  it("extracts != comparisons", () => {
    const result = extractPropertyComparisons("context.status != 'draft'");
    expect(result).toEqual([{ property: "status", operator: "!=", literal: "draft" }]);
  });

  it("extracts multiple comparisons from compound expression", () => {
    const result = extractPropertyComparisons("context.x == 'a' && context.y == 'b'");
    expect(result).toHaveLength(2);
    expect(result[0].property).toBe("x");
    expect(result[1].property).toBe("y");
  });

  it("ignores non-string comparisons (numbers)", () => {
    const result = extractPropertyComparisons("context.count == 5");
    expect(result).toHaveLength(0);
  });

  it("ignores boolean comparisons", () => {
    const result = extractPropertyComparisons("context.done == true");
    expect(result).toHaveLength(0);
  });

  it("ignores null comparisons", () => {
    const result = extractPropertyComparisons("context.phase != null");
    expect(result).toHaveLength(0);
  });

  it("returns empty for invalid expressions", () => {
    const result = extractPropertyComparisons("not valid {{}}");
    expect(result).toHaveLength(0);
  });
});

describe("evaluate — len() builtin", () => {
  it("len(array) returns element count", () => {
    expect(evaluate("len(context.items) == 3", { items: ["a", "b", "c"] })).toBe(true);
  });

  it("len(empty array) is 0", () => {
    expect(evaluate("len(context.items) == 0", { items: [] })).toBe(true);
  });

  it("len(array) > 0 with non-empty array", () => {
    expect(evaluate("len(context.items) > 0", { items: ["x"] })).toBe(true);
  });

  it("len(array) > 0 with empty array", () => {
    expect(evaluate("len(context.items) > 0", { items: [] })).toBe(false);
  });

  it("len(string) returns character count", () => {
    expect(evaluate("len(context.name) == 5", { name: "hello" })).toBe(true);
  });

  it("len(empty string) is 0", () => {
    expect(evaluate("len(context.name) == 0", { name: "" })).toBe(true);
  });

  it("len(missing property) is 0", () => {
    expect(evaluate("len(context.nothing) == 0", {})).toBe(true);
  });

  it("len(null) is 0", () => {
    expect(evaluate("len(context.value) == 0", { value: null })).toBe(true);
  });

  it("len(number) is 0 (non-sequence)", () => {
    expect(evaluate("len(context.value) == 0", { value: 42 })).toBe(true);
  });

  it("len(boolean) is 0 (non-sequence)", () => {
    expect(evaluate("len(context.value) == 0", { value: true })).toBe(true);
  });

  it("len composes with logical operators", () => {
    expect(evaluate("len(context.a) > 0 && len(context.b) > 0", { a: [1], b: ["x"] })).toBe(true);
    expect(evaluate("len(context.a) > 0 && len(context.b) > 0", { a: [1], b: [] })).toBe(false);
  });

  it("len on nested property", () => {
    expect(evaluate("len(context.data.items) == 2", { data: { items: [1, 2] } })).toBe(true);
  });

  it("rejects unknown functions at tokenize time", () => {
    expect(() => evaluate("foo(context.x) == 0", { x: [] })).toThrow(EvaluatorError);
  });

  it("rejects missing opening paren", () => {
    expect(() => evaluate("len context.x", { x: [] })).toThrow(EvaluatorError);
  });

  it("rejects missing closing paren", () => {
    expect(() => evaluate("len(context.x", { x: [] })).toThrow(EvaluatorError);
  });

  it("rejects empty argument", () => {
    expect(() => evaluate("len()", {})).toThrow(EvaluatorError);
  });
});

describe("resolveContextPath", () => {
  it("resolves a top-level key", () => {
    expect(resolveContextPath({ foo: "bar" }, "context.foo")).toBe("bar");
  });
  it("resolves a nested path", () => {
    expect(resolveContextPath({ a: { b: { c: 7 } } }, "context.a.b.c")).toBe(7);
  });
  it("returns null for a missing top-level key", () => {
    expect(resolveContextPath({}, "context.missing")).toBeNull();
  });
  it("returns null for a missing nested segment", () => {
    expect(resolveContextPath({ a: {} }, "context.a.b.c")).toBeNull();
  });
  it("returns null when traversing through a non-object", () => {
    expect(resolveContextPath({ a: 5 }, "context.a.b")).toBeNull();
  });
  it("returns null for an explicitly undefined value", () => {
    expect(resolveContextPath({ a: undefined }, "context.a")).toBeNull();
  });
  it("preserves null explicitly stored in context", () => {
    expect(resolveContextPath({ a: null }, "context.a")).toBeNull();
  });
  it("preserves an empty array", () => {
    expect(resolveContextPath({ a: [] }, "context.a")).toEqual([]);
  });
  it("preserves an array value at depth", () => {
    expect(resolveContextPath({ a: { b: [1, 2] } }, "context.a.b")).toEqual([1, 2]);
  });
  it("throws on a path missing the context. prefix", () => {
    expect(() => resolveContextPath({ foo: "bar" }, "foo")).toThrow(EvaluatorError);
  });
  it("throws on an empty path", () => {
    expect(() => resolveContextPath({}, "")).toThrow(EvaluatorError);
  });
  it("shares semantics with the expression evaluator", () => {
    // Parity check: the boolean evaluator and the exported resolver must
    // agree on how null/undefined propagate, so both code paths can rely on
    // a single source of truth for path semantics.
    const context = { a: { b: [1, 2, 3] }, c: null, d: undefined };
    expect(evaluate("len(context.a.b) == 3", context)).toBe(true);
    expect(resolveContextPath(context, "context.a.b")).toEqual([1, 2, 3]);
    expect(evaluate("context.c == null", context)).toBe(true);
    expect(resolveContextPath(context, "context.c")).toBeNull();
    expect(evaluate("context.d == null", context)).toBe(true);
    expect(resolveContextPath(context, "context.d")).toBeNull();
  });
});

describe("CONTEXT_PATH_PATTERN", () => {
  it("matches a top-level context path", () => {
    expect(CONTEXT_PATH_PATTERN.test("context.foo")).toBe(true);
  });
  it("matches a nested context path", () => {
    expect(CONTEXT_PATH_PATTERN.test("context.foo.bar.baz")).toBe(true);
  });
  it("matches segments with underscores and digits", () => {
    expect(CONTEXT_PATH_PATTERN.test("context.foo_bar.item2")).toBe(true);
  });
  it("rejects the bare 'context' keyword", () => {
    expect(CONTEXT_PATH_PATTERN.test("context")).toBe(false);
  });
  it("rejects a trailing dot", () => {
    expect(CONTEXT_PATH_PATTERN.test("context.foo.")).toBe(false);
  });
  it("rejects a leading digit on a segment", () => {
    expect(CONTEXT_PATH_PATTERN.test("context.1foo")).toBe(false);
  });
  it("rejects a string that merely contains 'context.'", () => {
    expect(CONTEXT_PATH_PATTERN.test("see context.foo for details")).toBe(false);
  });
  it("rejects an empty string", () => {
    expect(CONTEXT_PATH_PATTERN.test("")).toBe(false);
  });
  it("rejects a path rooted at something other than context", () => {
    expect(CONTEXT_PATH_PATTERN.test("other.foo")).toBe(false);
  });
});
