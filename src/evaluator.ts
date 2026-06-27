// Grammar scope is a deliberate stop-line — see docs/decisions.md § "Expression language stop-line".

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
        // Reject empty path segments from consecutive dots — `context..foo`
        // or `context.foo..bar` would otherwise tokenize cleanly and
        // resolve to null at runtime, masking the typo (#282).
        if (contextPathSegments(ident).some((seg) => seg.length === 0)) {
          throw new EvaluatorError(
            `Malformed context path '${ident}' at position ${start}: empty path segment (check for consecutive dots).`,
            expr,
            start,
          );
        }
        tokens.push({ type: "PROPERTY", value: ident, pos: start });
      } else {
        throw new EvaluatorError(
          `Unexpected identifier '${ident}' at position ${start}. Property access must start with 'context.', or call a built-in function (${[...BUILTIN_FUNCTIONS].join(", ")}). Expressions are predicates, not computations — derive values in an onEnter hook and compare the result.`,
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

// --- AST ---

/**
 * Parsed expression tree. Context-independent: a given expression string
 * parses to one immutable `Ast` (cached in `astCache`) and is re-evaluated
 * against fresh context on every advance — no re-tokenize, no re-parse
 * per evaluation (#285). Expressions are pure (property reads + literal
 * comparisons, no side effects), so lazily evaluating the tree gives the
 * same result the old fused parse-and-eval produced eagerly.
 */
type Ast =
  | { kind: "lit"; value: string | number | boolean | null }
  | { kind: "prop"; path: string }
  | { kind: "not"; operand: Ast }
  | { kind: "logic"; op: "&&" | "||"; left: Ast; right: Ast }
  | { kind: "compare"; op: string; left: Ast; right: Ast }
  | { kind: "call"; name: string; arg: Ast };

// --- Parser (token stream → Ast; no evaluation) ---

class Parser {
  private pos = 0;

  constructor(
    private tokens: Token[],
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

  parse(): Ast {
    const ast = this.parseOrExpr();
    if (this.peek().type !== "EOF") {
      const t = this.peek();
      throw new EvaluatorError(
        `Unexpected token '${t.value}' at position ${t.pos}`,
        this.expr,
        t.pos,
      );
    }
    return ast;
  }

  private parseOrExpr(): Ast {
    let left = this.parseAndExpr();
    while (this.peek().type === "LOGIC" && this.peek().value === "||") {
      this.advance();
      const right = this.parseAndExpr();
      left = { kind: "logic", op: "||", left, right };
    }
    return left;
  }

  private parseAndExpr(): Ast {
    let left = this.parseNotExpr();
    while (this.peek().type === "LOGIC" && this.peek().value === "&&") {
      this.advance();
      const right = this.parseNotExpr();
      left = { kind: "logic", op: "&&", left, right };
    }
    return left;
  }

  private parseNotExpr(): Ast {
    if (this.peek().type === "NOT") {
      this.advance();
      return { kind: "not", operand: this.parseNotExpr() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Ast {
    const left = this.parseValue();
    if (this.peek().type === "OP") {
      const op = this.advance().value as string;
      const right = this.parseValue();
      return { kind: "compare", op, left, right };
    }
    return left;
  }

  private parseValue(): Ast {
    const t = this.peek();

    if (t.type === "LPAREN") {
      this.advance();
      const inner = this.parseOrExpr();
      if (this.peek().type !== "RPAREN") {
        throw new EvaluatorError(
          `Expected ')' at position ${this.peek().pos}`,
          this.expr,
          this.peek().pos,
        );
      }
      this.advance();
      return inner;
    }

    if (t.type === "STRING" || t.type === "NUMBER" || t.type === "BOOLEAN" || t.type === "NULL") {
      this.advance();
      return { kind: "lit", value: t.value };
    }

    if (t.type === "PROPERTY") {
      this.advance();
      return { kind: "prop", path: t.value as string };
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
      return { kind: "call", name: t.value as string, arg };
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
}

/**
 * Evaluate a parsed tree against a context object. Logic nodes
 * short-circuit; since expressions are side-effect-free the result is
 * identical to evaluating both arms eagerly.
 */
function evalAst(node: Ast, context: Record<string, unknown>): unknown {
  switch (node.kind) {
    case "lit":
      return node.value;
    case "prop":
      return walkContextSegments(context, contextPathSegments(node.path));
    case "not":
      return !toBool(evalAst(node.operand, context));
    case "logic": {
      const left = evalAst(node.left, context);
      if (node.op === "||") return toBool(left) ? left : evalAst(node.right, context);
      return toBool(left) ? evalAst(node.right, context) : left;
    }
    case "compare":
      return compare(evalAst(node.left, context), node.op, evalAst(node.right, context));
    case "call":
      return callFunction(node.name, evalAst(node.arg, context));
  }
}

// Expression strings come from graph definitions (finite), so this memo is
// bounded by the number of distinct expressions across loaded graphs — no
// eviction needed. Validating an expression at load warms the cache for
// the advances that later evaluate it.
const astCache = new Map<string, Ast>();

function parseToAst(expr: string): Ast {
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    throw new EvaluatorError("Empty expression", expr, 0);
  }
  const cached = astCache.get(trimmed);
  if (cached) return cached;
  const ast = new Parser(tokenize(trimmed), trimmed).parse();
  astCache.set(trimmed, ast);
  return ast;
}

/**
 * Strip the mandatory `context.` prefix from a PROPERTY path and split
 * into segments. The single place the prefix convention is encoded —
 * shared by the parser's property resolver, `resolveContextRef`, and
 * `extractPropertyComparisons` (which re-joins for its enum lookup).
 */
function contextPathSegments(path: string): string[] {
  return path.slice("context.".length).split(".");
}

/**
 * Walk a pre-split dotted path against a context object. Missing or
 * non-object intermediates short-circuit to null so callers can treat
 * "absent" and "explicit null" uniformly. Shared by the expression
 * parser's property resolver and the public resolveContextRef below.
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

// Numeric comparison operators. Each requires both operands to be
// numbers; a non-number operand makes the comparison false (a missing
// context path resolves to null, so `context.count > 3` is false until
// the count is set). Equality (`==`/`!=`) is handled separately because
// it's type-agnostic.
const NUMERIC_OPS: Record<string, (a: number, b: number) => boolean> = {
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
};

function compare(left: unknown, op: string, right: unknown): boolean {
  if (op === "==") return left === right;
  if (op === "!=") return left !== right;
  const numOp = NUMERIC_OPS[op];
  if (numOp) {
    return typeof left === "number" && typeof right === "number" ? numOp(left, right) : false;
  }
  return false;
}

/**
 * Validate expression syntax without evaluating.
 * Throws EvaluatorError if the expression is malformed.
 * Used at graph load time to catch typos early.
 */
export function validateExpression(expr: string): void {
  // parseToAst tokenizes + parses (and caches the tree, warming it for
  // the advances that later evaluate this expression). Throws on lexical
  // or structural errors; no evaluation needed to check syntax.
  parseToAst(expr);
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
      const prop = contextPathSegments(a.value as string).join(".");
      results.push({ property: prop, operator: op.value as string, literal: b.value as string });
    }
    // 'value' == context.X
    if (a.type === "STRING" && b.type === "PROPERTY") {
      const prop = contextPathSegments(b.value as string).join(".");
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
 * If `value` is a string addressing a context path (`context.foo[.bar]`),
 * resolve it against `context`; otherwise return it unchanged. The single
 * site that recognizes the `context.` reference convention for hook args:
 * the CONTEXT_PATH_PATTERN test that decides "reference vs literal" and the
 * resolution live together, so there's no separate caller pre-check plus a
 * re-validating guard that can never fire (#279).
 *
 * Returns null for missing or non-object intermediates so callers treat
 * "absent" and "explicit null" uniformly.
 */
export function resolveContextRef(context: Record<string, unknown>, value: unknown): unknown {
  if (typeof value !== "string" || !CONTEXT_PATH_PATTERN.test(value)) return value;
  return walkContextSegments(context, contextPathSegments(value));
}

/**
 * Evaluate a boolean expression against a context object.
 * Throws EvaluatorError on syntax errors.
 */
export function evaluate(expr: string, context: Record<string, unknown>): boolean {
  return toBool(evalAst(parseToAst(expr), context));
}

/**
 * Predicate-site wrapper: any throw resolves to `false` so a malformed
 * expression at runtime can't abort the advance. Use at gate checks,
 * edge conditions, validation rules, and subgraph conditions — every
 * site whose semantic contract is "no-pass on error". Validate-time
 * enumeration that needs to surface a throw keeps using `evaluate`.
 */
export function evaluatePredicate(expr: string, context: Record<string, unknown>): boolean {
  try {
    return evaluate(expr, context);
  } catch {
    return false;
  }
}
