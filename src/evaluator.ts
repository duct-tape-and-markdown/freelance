export class EvaluatorError extends Error {
  constructor(
    message: string,
    public expression: string,
    public position?: number,
  ) {
    super(message);
    this.name = "EvaluatorError";
  }
}

// --- Tokenizer ---

/**
 * Built-in functions callable from edge condition expressions.
 * Each one takes exactly one argument (any expression) and returns a value.
 * See callFunction() below for semantics.
 */
const BUILTIN_FUNCTIONS = new Set(["len"]);

type TokenType =
  | "STRING"
  | "NUMBER"
  | "BOOLEAN"
  | "NULL"
  | "PROPERTY"
  | "FUNCTION"
  | "OP"
  | "LOGIC"
  | "NOT"
  | "LPAREN"
  | "RPAREN"
  | "EOF";

interface Token {
  type: TokenType;
  value: string | number | boolean | null;
  pos: number;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) {
      i++;
      continue;
    }

    // Parentheses
    if (expr[i] === "(") {
      tokens.push({ type: "LPAREN", value: "(", pos: i });
      i++;
      continue;
    }
    if (expr[i] === ")") {
      tokens.push({ type: "RPAREN", value: ")", pos: i });
      i++;
      continue;
    }

    // Logical operators
    if (expr[i] === "&" && expr[i + 1] === "&") {
      tokens.push({ type: "LOGIC", value: "&&", pos: i });
      i += 2;
      continue;
    }
    if (expr[i] === "|" && expr[i + 1] === "|") {
      tokens.push({ type: "LOGIC", value: "||", pos: i });
      i += 2;
      continue;
    }

    // Not
    if (expr[i] === "!" && expr[i + 1] !== "=") {
      tokens.push({ type: "NOT", value: "!", pos: i });
      i++;
      continue;
    }

    // Comparison operators (must check two-char before one-char)
    if (expr[i] === "=" && expr[i + 1] === "=") {
      if (expr[i + 2] === "=") {
        throw new EvaluatorError(
          `Unknown operator '===' at position ${i}. Use '==' for equality.`,
          expr,
          i,
        );
      }
      tokens.push({ type: "OP", value: "==", pos: i });
      i += 2;
      continue;
    }
    if (expr[i] === "!" && expr[i + 1] === "=") {
      tokens.push({ type: "OP", value: "!=", pos: i });
      i += 2;
      continue;
    }
    if (expr[i] === ">" && expr[i + 1] === "=") {
      tokens.push({ type: "OP", value: ">=", pos: i });
      i += 2;
      continue;
    }
    if (expr[i] === "<" && expr[i + 1] === "=") {
      tokens.push({ type: "OP", value: "<=", pos: i });
      i += 2;
      continue;
    }
    if (expr[i] === ">") {
      tokens.push({ type: "OP", value: ">", pos: i });
      i++;
      continue;
    }
    if (expr[i] === "<") {
      tokens.push({ type: "OP", value: "<", pos: i });
      i++;
      continue;
    }

    // String literal
    if (expr[i] === "'") {
      const start = i;
      i++; // skip opening quote
      let str = "";
      while (i < expr.length && expr[i] !== "'") {
        str += expr[i];
        i++;
      }
      if (i >= expr.length) {
        throw new EvaluatorError(
          `Unclosed string literal starting at position ${start}`,
          expr,
          start,
        );
      }
      i++; // skip closing quote
      tokens.push({ type: "STRING", value: str, pos: start });
      continue;
    }

    // Number
    if (/[0-9]/.test(expr[i])) {
      const start = i;
      let num = "";
      while (i < expr.length && /[0-9]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      if (i < expr.length && expr[i] === ".") {
        num += ".";
        i++;
        while (i < expr.length && /[0-9]/.test(expr[i])) {
          num += expr[i];
          i++;
        }
      }
      tokens.push({ type: "NUMBER", value: parseFloat(num), pos: start });
      continue;
    }

    // Keywords and property access
    if (/[a-zA-Z_]/.test(expr[i])) {
      const start = i;
      let ident = "";
      // Read full dotted identifier (e.g. context.nested.value)
      while (i < expr.length && /[a-zA-Z0-9_.]/.test(expr[i])) {
        ident += expr[i];
        i++;
      }
      // Remove trailing dot if any
      if (ident.endsWith(".")) {
        ident = ident.slice(0, -1);
        i--;
      }

      if (ident === "true") {
        tokens.push({ type: "BOOLEAN", value: true, pos: start });
      } else if (ident === "false") {
        tokens.push({ type: "BOOLEAN", value: false, pos: start });
      } else if (ident === "null") {
        tokens.push({ type: "NULL", value: null, pos: start });
      } else if (BUILTIN_FUNCTIONS.has(ident)) {
        tokens.push({ type: "FUNCTION", value: ident, pos: start });
      } else if (ident.startsWith("context.")) {
        tokens.push({ type: "PROPERTY", value: ident, pos: start });
      } else {
        throw new EvaluatorError(
          `Unexpected identifier '${ident}' at position ${start}. Property access must start with 'context.', or call a built-in function (${[...BUILTIN_FUNCTIONS].join(", ")}).`,
          expr,
          start,
        );
      }
      continue;
    }

    throw new EvaluatorError(`Unexpected character '${expr[i]}' at position ${i}`, expr, i);
  }

  tokens.push({ type: "EOF", value: null, pos: i });
  return tokens;
}

// --- Parser / Evaluator ---

class Parser {
  private pos = 0;

  constructor(
    private tokens: Token[],
    private context: Record<string, unknown>,
    private expr: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  parse(): boolean {
    const result = this.parseOrExpr();
    if (this.peek().type !== "EOF") {
      const t = this.peek();
      throw new EvaluatorError(
        `Unexpected token '${t.value}' at position ${t.pos}`,
        this.expr,
        t.pos,
      );
    }
    return toBool(result);
  }

  private parseOrExpr(): unknown {
    let left = this.parseAndExpr();
    while (this.peek().type === "LOGIC" && this.peek().value === "||") {
      this.advance();
      const right = this.parseAndExpr();
      if (!toBool(left)) left = right; // short-circuit: keep left if truthy
    }
    return left;
  }

  private parseAndExpr(): unknown {
    let left = this.parseNotExpr();
    while (this.peek().type === "LOGIC" && this.peek().value === "&&") {
      this.advance();
      const right = this.parseNotExpr();
      if (toBool(left)) left = right; // short-circuit: keep left if falsy
    }
    return left;
  }

  private parseNotExpr(): unknown {
    if (this.peek().type === "NOT") {
      this.advance();
      const val = this.parseNotExpr();
      return !toBool(val);
    }
    return this.parseComparison();
  }

  private parseComparison(): unknown {
    const left = this.parseValue();
    if (this.peek().type === "OP") {
      const op = this.advance().value as string;
      const right = this.parseValue();
      return compare(left, op, right);
    }
    return left;
  }

  private parseValue(): unknown {
    const t = this.peek();

    if (t.type === "LPAREN") {
      this.advance();
      const val = this.parseOrExpr();
      if (this.peek().type !== "RPAREN") {
        throw new EvaluatorError(
          `Expected ')' at position ${this.peek().pos}`,
          this.expr,
          this.peek().pos,
        );
      }
      this.advance();
      return val;
    }

    if (t.type === "STRING" || t.type === "NUMBER" || t.type === "BOOLEAN" || t.type === "NULL") {
      this.advance();
      return t.value;
    }

    if (t.type === "PROPERTY") {
      this.advance();
      return this.resolveProperty(t.value as string);
    }

    if (t.type === "FUNCTION") {
      this.advance();
      if (this.peek().type !== "LPAREN") {
        throw new EvaluatorError(
          `Expected '(' after function '${t.value}' at position ${t.pos}`,
          this.expr,
          t.pos,
        );
      }
      this.advance();
      const arg = this.parseOrExpr();
      if (this.peek().type !== "RPAREN") {
        throw new EvaluatorError(
          `Expected ')' closing call to '${t.value}' at position ${this.peek().pos}`,
          this.expr,
          this.peek().pos,
        );
      }
      this.advance();
      return callFunction(t.value as string, arg);
    }

    if (t.type === "EOF") {
      throw new EvaluatorError(`Unexpected end of expression`, this.expr, t.pos);
    }

    throw new EvaluatorError(
      `Unexpected token '${t.value}' at position ${t.pos}`,
      this.expr,
      t.pos,
    );
  }

  private resolveProperty(path: string): unknown {
    // path is "context.foo.bar" — skip the "context." prefix
    return walkContextSegments(this.context, path.slice("context.".length).split("."));
  }
}

/**
 * Walk a pre-split dotted path against a context object. Missing or
 * non-object intermediates short-circuit to null so callers can treat
 * "absent" and "explicit null" uniformly. Shared by the expression
 * parser's property resolver and the public resolveContextPath below.
 */
function walkContextSegments(context: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = context;
  for (const seg of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current === undefined ? null : current;
}

/**
 * Dispatch a built-in function call.
 *
 * `len(v)` — returns the length of arrays and strings, 0 otherwise.
 *   Treats null/undefined/missing-property as 0 so that expressions like
 *   `len(context.maybeArray) > 0` work on both absent and empty arrays
 *   without needing an explicit null check.
 */
function callFunction(name: string, arg: unknown): unknown {
  switch (name) {
    case "len":
      if (Array.isArray(arg)) return arg.length;
      if (typeof arg === "string") return arg.length;
      return 0;
    default:
      // Unreachable: the tokenizer gates FUNCTION tokens to BUILTIN_FUNCTIONS.
      throw new EvaluatorError(`Unknown function '${name}'`, name, 0);
  }
}

function toBool(val: unknown): boolean {
  if (val === null || val === undefined || val === false || val === 0 || val === "") {
    return false;
  }
  return true;
}

function compare(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return typeof left === "number" && typeof right === "number" ? left > right : false;
    case "<":
      return typeof left === "number" && typeof right === "number" ? left < right : false;
    case ">=":
      return typeof left === "number" && typeof right === "number" ? left >= right : false;
    case "<=":
      return typeof left === "number" && typeof right === "number" ? left <= right : false;
    default:
      return false;
  }
}

/**
 * Validate expression syntax without evaluating.
 * Throws EvaluatorError if the expression is malformed.
 * Used at graph load time to catch typos early.
 */
export function validateExpression(expr: string): void {
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    throw new EvaluatorError("Empty expression", expr, 0);
  }
  // Tokenize to catch lexical errors, then parse with an empty context
  // to catch structural errors. Property access resolves to null against
  // empty context, which is fine — we're checking syntax, not semantics.
  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens, {}, expr);
  parser.parse();
}

/**
 * Extract property-to-string-literal comparisons from an expression.
 * Used for static enum validation at load time.
 * Returns entries for patterns like `context.X == 'value'` or `'value' == context.X`.
 */
export function extractPropertyComparisons(expr: string): Array<{
  property: string;
  operator: string;
  literal: string;
}> {
  const trimmed = expr.trim();
  if (trimmed.length === 0) return [];

  let tokens: Token[];
  try {
    tokens = tokenize(trimmed);
  } catch {
    return []; // syntax errors are caught by validateExpression
  }

  const results: Array<{ property: string; operator: string; literal: string }> = [];

  for (let i = 0; i < tokens.length - 2; i++) {
    const a = tokens[i];
    const op = tokens[i + 1];
    const b = tokens[i + 2];
    if (op.type !== "OP" || (op.value !== "==" && op.value !== "!=")) continue;

    // context.X == 'value'
    if (a.type === "PROPERTY" && b.type === "STRING") {
      const prop = (a.value as string).replace(/^context\./, "");
      results.push({ property: prop, operator: op.value as string, literal: b.value as string });
    }
    // 'value' == context.X
    if (a.type === "STRING" && b.type === "PROPERTY") {
      const prop = (b.value as string).replace(/^context\./, "");
      results.push({ property: prop, operator: op.value as string, literal: a.value as string });
    }
  }

  return results;
}

/**
 * Regex for strings that address a live context path: `context.foo`,
 * `context.foo.bar`, etc. Anchored — any leading or trailing character
 * (whitespace, punctuation) disqualifies the string, so user data that
 * happens to start with "context." won't be treated as a reference.
 */
export const CONTEXT_PATH_PATTERN =
  /^context\.[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

/**
 * Resolve a `context.foo.bar` path against a live context object.
 * Returns null for missing or non-object intermediates so callers can
 * treat "absent" and "explicit null" uniformly. Throws if the path
 * string doesn't match CONTEXT_PATH_PATTERN.
 */
export function resolveContextPath(context: Record<string, unknown>, path: string): unknown {
  if (!CONTEXT_PATH_PATTERN.test(path)) {
    throw new EvaluatorError(
      `Invalid context path "${path}"; expected format "context.foo[.bar...]"`,
      path,
      0,
    );
  }
  return walkContextSegments(context, path.slice("context.".length).split("."));
}

/**
 * Evaluate a boolean expression against a context object.
 * Throws EvaluatorError on syntax errors.
 */
export function evaluate(expr: string, context: Record<string, unknown>): boolean {
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    throw new EvaluatorError("Empty expression", expr, 0);
  }
  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens, context, expr);
  return parser.parse();
}
