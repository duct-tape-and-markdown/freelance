export class EvaluatorError extends Error {
  constructor(
    message: string,
    public expression: string,
    public position?: number
  ) {
    super(message);
    this.name = "EvaluatorError";
  }
}

// --- Tokenizer ---

type TokenType =
  | "STRING"
  | "NUMBER"
  | "BOOLEAN"
  | "NULL"
  | "PROPERTY"
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
          i
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
          start
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
      } else if (ident.startsWith("context.")) {
        tokens.push({ type: "PROPERTY", value: ident, pos: start });
      } else {
        throw new EvaluatorError(
          `Unexpected identifier '${ident}' at position ${start}. Property access must start with 'context.'`,
          expr,
          start
        );
      }
      continue;
    }

    throw new EvaluatorError(
      `Unexpected character '${expr[i]}' at position ${i}`,
      expr,
      i
    );
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
    private expr: string
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
        t.pos
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
          this.peek().pos
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

    if (t.type === "EOF") {
      throw new EvaluatorError(
        `Unexpected end of expression`,
        this.expr,
        t.pos
      );
    }

    throw new EvaluatorError(
      `Unexpected token '${t.value}' at position ${t.pos}`,
      this.expr,
      t.pos
    );
  }

  private resolveProperty(path: string): unknown {
    // path is "context.foo.bar" — skip the "context." prefix
    const segments = path.slice("context.".length).split(".");
    let current: unknown = this.context;
    for (const seg of segments) {
      if (current === null || current === undefined || typeof current !== "object") {
        return null;
      }
      current = (current as Record<string, unknown>)[seg];
    }
    return current === undefined ? null : current;
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
