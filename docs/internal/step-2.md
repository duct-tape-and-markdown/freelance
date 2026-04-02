Read SPEC.md, specifically the "Expression evaluator" section.

This is Step 2 of 5 — the custom micro-evaluator. This is a standalone module with no dependencies on the rest of the engine. It will be wired into the engine core in Step 3.

## What to build

### Expression evaluator (`src/evaluator.ts`)

A recursive descent parser/evaluator that takes an expression string and a context object, and returns a boolean.

```typescript
export function evaluate(expr: string, context: Record<string, unknown>): boolean
```

The expression language is intentionally minimal. Here is the exact grammar:

```
expression      := or_expr
or_expr         := and_expr ('||' and_expr)*
and_expr        := not_expr ('&&' not_expr)*
not_expr        := '!' not_expr | comparison
comparison      := value (('==' | '!=' | '>' | '<' | '>=' | '<=') value)?
value           := 'true' | 'false' | 'null' | NUMBER | STRING | property_access
property_access := 'context.' IDENTIFIER ('.' IDENTIFIER)*
STRING          := "'" [^']* "'"
NUMBER          := [0-9]+ ('.' [0-9]+)?
IDENTIFIER      := [a-zA-Z_][a-zA-Z0-9_]*
```

Implementation rules:

1. **No `eval()`, no `new Function()`, no third-party expression libraries.** This is a hand-written recursive descent parser. ~100-150 lines.

2. **Tokenizer first, parser second.** Write a simple tokenizer that produces tokens (string literal, number literal, boolean literal, null, operator, property access, paren, etc.), then a recursive descent parser that consumes tokens.

3. **Property access** resolves against the context object. `context.testsPass` looks up `context["testsPass"]`. `context.nested.value` looks up `context["nested"]["value"]`. If any segment is undefined, the whole expression resolves to `null` (not an error).

4. **Type coercion: none.** `==` is strict equality. `"5" == 5` is false. `null == false` is false. `0 == false` is false. Only identical values are equal.

5. **Comparison operators** (`>`, `<`, `>=`, `<=`) only work on numbers. If either side is not a number, return false (not an error).

6. **The final result** of the expression must be a boolean. If the expression evaluates to a non-boolean (e.g., a bare property access like `context.name`), apply truthiness: `null`, `undefined`, `false`, `0`, `""` are falsy, everything else is truthy.

7. **Error handling:** If the expression is syntactically invalid (malformed, unexpected token, unclosed string), throw a `EvaluatorError` with a descriptive message including the expression and the position of the error. Do not silently return false on parse errors — the graph author needs to know their expression is broken.

8. **Whitespace** is insignificant except inside string literals.

9. **Parentheses** for grouping: `(context.a == true || context.b == true) && context.c == true`. Add this to the grammar — `value` can also be `'(' expression ')'`.

### Export the error class too:

```typescript
export class EvaluatorError extends Error {
  constructor(message: string, public expression: string, public position?: number) {
    super(message);
    this.name = 'EvaluatorError';
  }
}
```

## Tests (`test/evaluator.test.ts`)

Write comprehensive vitest tests. This module is the enforcement backbone — it must be rock solid.

### Basic equality
- `"context.value == true"` with `{ value: true }` → true
- `"context.value == true"` with `{ value: false }` → false
- `"context.value == 'hello'"` with `{ value: "hello" }` → true
- `"context.value == 'hello'"` with `{ value: "world" }` → false
- `"context.value == null"` with `{ value: null }` → true
- `"context.value == null"` with `{}` → true (undefined property → null)
- `"context.value != null"` with `{ value: "something" }` → true
- `"context.count == 0"` with `{ count: 0 }` → true
- `"context.count == 3"` with `{ count: 3 }` → true

### No type coercion
- `"context.value == true"` with `{ value: 1 }` → false
- `"context.value == 0"` with `{ value: false }` → false
- `"context.value == '5'"` with `{ value: 5 }` → false

### Comparison operators
- `"context.count > 0"` with `{ count: 5 }` → true
- `"context.count > 0"` with `{ count: 0 }` → false
- `"context.count < 3"` with `{ count: 2 }` → true
- `"context.count >= 3"` with `{ count: 3 }` → true
- `"context.count <= 3"` with `{ count: 4 }` → false

### Logical operators
- `"context.a == true && context.b == true"` with `{ a: true, b: true }` → true
- `"context.a == true && context.b == true"` with `{ a: true, b: false }` → false
- `"context.a == true || context.b == true"` with `{ a: false, b: true }` → true
- `"context.a == true || context.b == true"` with `{ a: false, b: false }` → false
- `"!context.value"` with `{ value: false }` → true
- `"!context.value"` with `{ value: true }` → false

### Nested property access
- `"context.nested.deep == 'found'"` with `{ nested: { deep: "found" } }` → true
- `"context.nested.deep == null"` with `{ nested: {} }` → true (missing deep key)
- `"context.nested.deep == null"` with `{}` → true (missing nested key entirely)

### Parentheses
- `"(context.a == true || context.b == true) && context.c == true"` with `{ a: false, b: true, c: true }` → true
- `"(context.a == true || context.b == true) && context.c == true"` with `{ a: false, b: true, c: false }` → false

### Short-circuit evaluation
- `"context.a == true && context.b == true"` — if a is false, b should not matter (test with b undefined)
- `"context.a == true || context.b == true"` — if a is true, b should not matter

### Truthiness (bare property access)
- `"context.value"` with `{ value: true }` → true
- `"context.value"` with `{ value: "nonempty" }` → true
- `"context.value"` with `{ value: 0 }` → false
- `"context.value"` with `{ value: null }` → false
- `"context.value"` with `{ value: "" }` → false
- `"context.value"` with `{}` → false (undefined → falsy)

### Error cases
- `"context.value ==="` → EvaluatorError (unknown operator)
- `"context.value == "` → EvaluatorError (unexpected end)
- `"context.value == 'unclosed"` → EvaluatorError (unclosed string)
- `"&&"` → EvaluatorError (unexpected token)
- `""` → EvaluatorError (empty expression)

### Whitespace handling
- `"  context.value  ==  true  "` with `{ value: true }` → true (extra whitespace)
- `"context.value==true"` with `{ value: true }` → true (no whitespace)

### Expressions from the spec examples
These are the actual expressions used in the example graph definitions. They must all work:
- `"context.remainingItems > 0"` with `{ remainingItems: 5 }` → true
- `"context.remainingItems == 0"` with `{ remainingItems: 0 }` → true
- `"context.cycleCount < 3 && context.remainingItems > 0"` with `{ cycleCount: 1, remainingItems: 3 }` → true
- `"context.cycleCount < 3 && context.remainingItems > 0"` with `{ cycleCount: 3, remainingItems: 3 }` → false
- `"context.verificationPassed == true"` with `{ verificationPassed: true }` → true
- `"context.qualityScore >= 80"` with `{ qualityScore: 85 }` → true
- `"context.qualityScore >= 80"` with `{ qualityScore: 75 }` → false
- `"context.changeType == 'standard'"` with `{ changeType: "standard" }` → true
- `"context.testsPass == false || context.lintPass == false"` with `{ testsPass: false, lintPass: true }` → true
- `"context.testsPass == false || context.lintPass == false"` with `{ testsPass: true, lintPass: true }` → false
- `"context.outputUrl != null"` with `{ outputUrl: "https://example.com" }` → true
- `"context.outputUrl != null"` with `{ outputUrl: null }` → false
- `"context.scopeQuestionRaised == true"` with `{ scopeQuestionRaised: true }` → true
- `"context.reviewApproved == true || context.touchesSensitiveArea == false"` with `{ reviewApproved: false, touchesSensitiveArea: false }` → true

## What NOT to build

- No changes to the loader, schema, or types from Step 1
- No MCP integration
- No session state
- This is a pure, isolated module with its own tests

## Quality checks

1. `npm run build` — compiles cleanly
2. `npm test` — all loader tests still pass, all new evaluator tests pass
3. The evaluator module has zero imports from other src/ files (it's standalone)