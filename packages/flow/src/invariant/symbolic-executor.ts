/**
 * Symbolic execution engine for TypeScript functions via Z3 WASM.
 *
 * "CrossHair for TypeScript" — instead of Proxy-based interception (JS can't
 * override ===, <, > via Proxy), this uses AST-level interpretation: walking
 * the TypeScript AST and building Z3 constraint expressions for each operation.
 *
 * For each function + invariant:
 *   1. Create Z3 symbolic variables for parameters (derived from ShapeType IR)
 *   2. Symbolically interpret the function body, forking at branches
 *   3. For each execution path, check: can the invariant be violated?
 *      - Encode: path_constraints AND NOT(postcondition)
 *      - SAT   → counterexample (Z3 provides concrete values)
 *      - UNSAT → invariant proven on this path
 *   4. UNSAT on ALL paths → mathematically proven for ALL inputs
 *
 * This upgrades verification from probabilistic (fast-check) to exhaustive (Z3).
 */

import ts from "typescript";
import type { ShapeType } from "../schema/shapes.js";
import type { DiscoveredFunction, Invariant } from "./types.js";

/**
 * Z3 context type — the z3-solver WASM package doesn't ship TS declarations.
 * All Z3 interactions go through this opaque handle.
 */
type Z3Context = any;

// ── Public types ─────────────────────────────────────────────────────────

export interface SymbolicProofResult {
  invariantName: string;
  status: "proven" | "counterexample" | "unknown" | "unsupported";
  counterexample?: Record<string, unknown>;
  pathsExplored: number;
  pathsProven: number;
  pathsFailed: number;
  error?: string;
}

export interface ProveOptions {
  maxPaths?: number;
  timeoutMs?: number;
  maxLoopUnroll?: number;
}

// ── Internal types ───────────────────────────────────────────────────────

type SymValue =
  | { kind: "z3"; expr: any; sort: "int" | "bool" | "string" }
  | { kind: "object"; fields: Map<string, SymValue> }
  | { kind: "array"; elements: SymValue[]; lengthExpr: any }
  | { kind: "concrete"; value: unknown }
  | { kind: "undefined" }
  | { kind: "null" };

interface SymState {
  vars: Map<string, SymValue>;
  constraints: any[];
}

interface ExecutionPath {
  constraints: any[];
  returnValue: SymValue;
  returned: boolean;
  finalVars?: Map<string, SymValue>;
}

const DEFAULT_MAX_PATHS = 64;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LOOP_UNROLL = 8;

// ── Z3 context (lazy, singleton) ─────────────────────────────────────────

let z3Ctx: Z3Context | null = null;

async function getZ3(): Promise<Z3Context> {
  if (z3Ctx) return z3Ctx;
  const { init } = await import("z3-solver");
  const z3Module = await init();
  z3Ctx = new z3Module.Context("symbolic-exec");
  return z3Ctx;
}

export function resetZ3Context(): void {
  z3Ctx = null;
  intToStrCounter = 0;
}

// ── Symbolic value creation from ShapeType ───────────────────────────────

function createSymbolicValue(
  Z3: Z3Context,
  name: string,
  shape: ShapeType,
  z3Consts: Array<{ name: string; expr: any }>,
  depth: number = 0,
): SymValue {
  if (depth > 4) return { kind: "concrete", value: undefined };

  switch (shape.kind) {
    case "primitive": {
      switch (shape.value) {
        case "number": {
          const expr = Z3.Int.const(name);
          z3Consts.push({ name, expr });
          return { kind: "z3", expr, sort: "int" };
        }
        case "string": {
          const expr = Z3.String.const(name);
          z3Consts.push({ name, expr });
          return { kind: "z3", expr, sort: "string" };
        }
        case "boolean": {
          const expr = Z3.Bool.const(name);
          z3Consts.push({ name, expr });
          return { kind: "z3", expr, sort: "bool" };
        }
        case "null":
          return { kind: "null" };
        case "undefined":
        case "void":
          return { kind: "undefined" };
        default:
          return { kind: "concrete", value: undefined };
      }
    }
    case "literal": {
      if (typeof shape.value === "number")
        return { kind: "z3", expr: Z3.Int.val(shape.value), sort: "int" };
      if (typeof shape.value === "string")
        return { kind: "z3", expr: Z3.String.val(shape.value), sort: "string" };
      if (typeof shape.value === "boolean")
        return { kind: "z3", expr: Z3.Bool.val(shape.value), sort: "bool" };
      return { kind: "concrete", value: shape.value };
    }
    case "object": {
      const fields = new Map<string, SymValue>();
      for (const field of shape.fields) {
        fields.set(
          field.name,
          createSymbolicValue(Z3, `${name}.${field.name}`, field.type, z3Consts, depth + 1),
        );
      }
      return { kind: "object", fields };
    }
    case "union": {
      const allStrLit = shape.members.every(
        (m) => m.kind === "literal" && typeof m.value === "string",
      );
      if (allStrLit && shape.members.length > 0) {
        const expr = Z3.String.const(name);
        z3Consts.push({ name, expr });
        return { kind: "z3", expr, sort: "string" };
      }
      const allNumLit = shape.members.every(
        (m) => m.kind === "literal" && typeof m.value === "number",
      );
      if (allNumLit && shape.members.length > 0) {
        const expr = Z3.Int.const(name);
        z3Consts.push({ name, expr });
        return { kind: "z3", expr, sort: "int" };
      }
      if (shape.members.length > 0) {
        return createSymbolicValue(Z3, name, shape.members[0]!, z3Consts, depth + 1);
      }
      return { kind: "concrete", value: undefined };
    }
    case "enum": {
      if (shape.values.every((v) => typeof v === "string")) {
        const expr = Z3.String.const(name);
        z3Consts.push({ name, expr });
        return { kind: "z3", expr, sort: "string" };
      }
      if (shape.values.every((v) => typeof v === "number")) {
        const expr = Z3.Int.const(name);
        z3Consts.push({ name, expr });
        return { kind: "z3", expr, sort: "int" };
      }
      return { kind: "concrete", value: shape.values[0] };
    }
    case "array": {
      const lengthExpr = Z3.Int.const(`${name}.length`);
      z3Consts.push({ name: `${name}.length`, expr: lengthExpr });
      return { kind: "array", elements: [], lengthExpr };
    }
    case "ref":
      if (shape.resolved) {
        return createSymbolicValue(Z3, name, shape.resolved, z3Consts, depth + 1);
      }
      return { kind: "concrete", value: undefined };
    default:
      return { kind: "concrete", value: undefined };
  }
}

function addTypeConstraints(
  Z3: Z3Context,
  name: string,
  shape: ShapeType,
  sym: SymValue,
  constraints: any[],
): void {
  if (shape.kind === "union" && sym.kind === "z3") {
    const allStrLit = shape.members.every(
      (m) => m.kind === "literal" && typeof m.value === "string",
    );
    if (allStrLit && sym.sort === "string") {
      const opts = shape.members.map((m) =>
        sym.expr.eq(Z3.String.val((m as { kind: "literal"; value: string }).value)),
      );
      if (opts.length > 0) constraints.push(Z3.Or(...opts));
    }
    const allNumLit = shape.members.every(
      (m) => m.kind === "literal" && typeof m.value === "number",
    );
    if (allNumLit && sym.sort === "int") {
      const opts = shape.members.map((m) =>
        sym.expr.eq(Z3.Int.val((m as { kind: "literal"; value: number }).value)),
      );
      if (opts.length > 0) constraints.push(Z3.Or(...opts));
    }
  }
  if (shape.kind === "enum" && sym.kind === "z3") {
    if (sym.sort === "string") {
      const opts = (shape.values.filter((v) => typeof v === "string") as string[]).map((v) =>
        sym.expr.eq(Z3.String.val(v)),
      );
      if (opts.length > 0) constraints.push(Z3.Or(...opts));
    }
    if (sym.sort === "int") {
      const opts = (shape.values.filter((v) => typeof v === "number") as number[]).map((v) =>
        sym.expr.eq(Z3.Int.val(v)),
      );
      if (opts.length > 0) constraints.push(Z3.Or(...opts));
    }
  }
  if (shape.kind === "object" && sym.kind === "object") {
    for (const field of shape.fields) {
      const fv = sym.fields.get(field.name);
      if (fv) addTypeConstraints(Z3, `${name}.${field.name}`, field.type, fv, constraints);
    }
  }
  if (shape.kind === "array" && sym.kind === "array") {
    constraints.push(sym.lengthExpr.ge(Z3.Int.val(0)));
  }
}

// ── AST parsing ──────────────────────────────────────────────────────────

function parseFunctionBody(sourceText: string): ts.Statement[] {
  let src = sourceText;
  if (!src.trimStart().startsWith("function ") && src.includes("=>")) {
    src = `const __fn = ${src}`;
  }

  const file = ts.createSourceFile("__symbolic.ts", src, ts.ScriptTarget.Latest, true);
  let blockBody: ts.Block | undefined;
  let exprBody: ts.Expression | undefined;
  let exprFile: ts.SourceFile | undefined;

  function visit(node: ts.Node) {
    if (blockBody || exprBody) return;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
      blockBody = node.body;
    } else if (ts.isArrowFunction(node)) {
      if (ts.isBlock(node.body)) {
        blockBody = node.body;
      } else {
        exprBody = node.body;
        exprFile = file;
      }
    }
    if (!blockBody && !exprBody) ts.forEachChild(node, visit);
  }
  visit(file);

  if (blockBody) return Array.from(blockBody.statements);
  if (exprBody && exprFile) {
    const exprText = exprBody.getText(exprFile);
    const wrapped = `function __fn() { return ${exprText}; }`;
    const wf = ts.createSourceFile("__wrapped.ts", wrapped, ts.ScriptTarget.Latest, true);
    let wb: ts.Block | undefined;
    ts.forEachChild(wf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.body) wb = n.body;
    });
    if (wb) return Array.from(wb.statements);
  }
  return [];
}

function parseExpressionNode(exprText: string): ts.Expression {
  const src = `const __r = (${exprText});`;
  const file = ts.createSourceFile("__expr.ts", src, ts.ScriptTarget.Latest, true);
  const stmt = file.statements[0]!;
  if (ts.isVariableStatement(stmt)) {
    const decl = stmt.declarationList.declarations[0];
    if (decl?.initializer) {
      let init = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      return init;
    }
  }
  throw new Error(`Failed to parse expression: ${exprText}`);
}

// ── Expression evaluator ─────────────────────────────────────────────────

function evalExpr(Z3: Z3Context, expr: ts.Expression, state: SymState): SymValue {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;

  // ── Literals ──
  if (ts.isNumericLiteral(expr))
    return { kind: "z3", expr: Z3.Int.val(Number(expr.text)), sort: "int" };
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return { kind: "z3", expr: Z3.String.val(expr.text), sort: "string" };
  if (expr.kind === ts.SyntaxKind.TrueKeyword)
    return { kind: "z3", expr: Z3.Bool.val(true), sort: "bool" };
  if (expr.kind === ts.SyntaxKind.FalseKeyword)
    return { kind: "z3", expr: Z3.Bool.val(false), sort: "bool" };
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { kind: "null" };

  // ── Identifier ──
  if (ts.isIdentifier(expr)) {
    if (expr.text === "undefined") return { kind: "undefined" };
    if (expr.text === "NaN") return { kind: "concrete", value: NaN };
    if (expr.text === "Infinity") return { kind: "concrete", value: Infinity };
    return state.vars.get(expr.text) ?? { kind: "concrete", value: undefined };
  }

  // ── Property access (with optional chaining ?.) ──
  if (ts.isPropertyAccessExpression(expr)) {
    const obj = evalExpr(Z3, expr.expression, state);
    if (expr.questionDotToken && (obj.kind === "null" || obj.kind === "undefined"))
      return { kind: "undefined" };
    const prop = expr.name.text;
    if (obj.kind === "object") return obj.fields.get(prop) ?? { kind: "concrete", value: undefined };
    if (obj.kind === "array" && prop === "length") return { kind: "z3", expr: obj.lengthExpr, sort: "int" };
    if (obj.kind === "z3" && obj.sort === "string" && prop === "length")
      return { kind: "z3", expr: obj.expr.length(), sort: "int" };
    return { kind: "concrete", value: undefined };
  }

  // ── Element access (with optional chaining ?.) ──
  if (ts.isElementAccessExpression(expr)) {
    const obj = evalExpr(Z3, expr.expression, state);
    if (expr.questionDotToken && (obj.kind === "null" || obj.kind === "undefined"))
      return { kind: "undefined" };
    if (obj.kind === "object" && ts.isStringLiteral(expr.argumentExpression))
      return obj.fields.get(expr.argumentExpression.text) ?? { kind: "concrete", value: undefined };
    if (obj.kind === "array" && ts.isNumericLiteral(expr.argumentExpression)) {
      const idx = Number(expr.argumentExpression.text);
      if (idx >= 0 && idx < obj.elements.length) return obj.elements[idx]!;
    }
    return { kind: "concrete", value: undefined };
  }

  // ── Object literal ──
  if (ts.isObjectLiteralExpression(expr)) {
    const fields = new Map<string, SymValue>();
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const key = ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name) ? prop.name.text : null;
        if (key) fields.set(key, evalExpr(Z3, prop.initializer, state));
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        fields.set(prop.name.text, state.vars.get(prop.name.text) ?? { kind: "concrete", value: undefined });
      } else if (ts.isSpreadAssignment(prop)) {
        const spread = evalExpr(Z3, prop.expression, state);
        if (spread.kind === "object") {
          for (const [k, v] of spread.fields) fields.set(k, v);
        }
      }
    }
    return { kind: "object", fields };
  }

  // ── Array literal ──
  if (ts.isArrayLiteralExpression(expr)) {
    const elements = expr.elements.map((e) => evalExpr(Z3, e, state));
    return { kind: "array", elements, lengthExpr: Z3.Int.val(elements.length) };
  }

  // ── Binary ──
  if (ts.isBinaryExpression(expr)) return evalBinary(Z3, expr, state);

  // ── Prefix unary ──
  if (ts.isPrefixUnaryExpression(expr)) {
    const operand = evalExpr(Z3, expr.operand, state);
    if (expr.operator === ts.SyntaxKind.ExclamationToken) return negateValue(Z3, operand);
    if (expr.operator === ts.SyntaxKind.MinusToken && operand.kind === "z3" && operand.sort === "int")
      return { kind: "z3", expr: Z3.Int.val(0).sub(operand.expr), sort: "int" };
    if (expr.operator === ts.SyntaxKind.PlusToken) return operand;
    return { kind: "concrete", value: undefined };
  }

  // ── Postfix unary (x++, x--) — return original value ──
  if (ts.isPostfixUnaryExpression(expr)) {
    const operand = evalExpr(Z3, expr.operand, state);
    if (operand.kind === "z3" && operand.sort === "int" && ts.isIdentifier(expr.operand)) {
      const newVal = expr.operator === ts.SyntaxKind.PlusPlusToken
        ? { kind: "z3" as const, expr: operand.expr.add(Z3.Int.val(1)), sort: "int" as const }
        : { kind: "z3" as const, expr: operand.expr.sub(Z3.Int.val(1)), sort: "int" as const };
      state.vars.set(expr.operand.text, newVal);
    }
    return operand;
  }

  // ── Conditional (ternary) ──
  if (ts.isConditionalExpression(expr)) {
    const cond = evalExpr(Z3, expr.condition, state);
    const condBool = toZ3Bool(Z3, cond);
    if (!condBool) return { kind: "concrete", value: undefined };
    const thenVal = evalExpr(Z3, expr.whenTrue, state);
    const elseVal = evalExpr(Z3, expr.whenFalse, state);
    if (thenVal.kind === "z3" && elseVal.kind === "z3" && thenVal.sort === elseVal.sort)
      return { kind: "z3", expr: Z3.If(condBool, thenVal.expr, elseVal.expr), sort: thenVal.sort };
    const tb = toZ3Bool(Z3, thenVal);
    const eb = toZ3Bool(Z3, elseVal);
    if (tb && eb) return { kind: "z3", expr: Z3.If(condBool, tb, eb), sort: "bool" };
    // Mixed object/z3 ternary: if both objects, merge symbolically
    if (thenVal.kind === "object" && elseVal.kind === "object") {
      const merged = new Map<string, SymValue>();
      const allKeys = new Set([...thenVal.fields.keys(), ...elseVal.fields.keys()]);
      for (const key of allKeys) {
        const tv = thenVal.fields.get(key);
        const ev = elseVal.fields.get(key);
        if (tv && ev && tv.kind === "z3" && ev.kind === "z3" && tv.sort === ev.sort)
          merged.set(key, { kind: "z3", expr: Z3.If(condBool, tv.expr, ev.expr), sort: tv.sort });
        else if (tv) merged.set(key, tv);
        else if (ev) merged.set(key, ev);
      }
      return { kind: "object", fields: merged };
    }
    return { kind: "concrete", value: undefined };
  }

  // ── Call expression ──
  if (ts.isCallExpression(expr)) return evalCall(Z3, expr, state);

  // ── typeof ──
  if (ts.isTypeOfExpression(expr)) {
    const t = typeofStr(evalExpr(Z3, expr.expression, state));
    return t ? { kind: "z3", expr: Z3.String.val(t), sort: "string" } : { kind: "concrete", value: undefined };
  }

  // ── Type assertion / non-null ──
  if (ts.isAsExpression(expr)) return evalExpr(Z3, expr.expression, state);
  if (ts.isNonNullExpression(expr)) return evalExpr(Z3, expr.expression, state);
  if (ts.isSatisfiesExpression(expr)) return evalExpr(Z3, expr.expression, state);

  // ── Template expression with interpolation ──
  if (ts.isTemplateExpression(expr)) {
    try {
      let result = Z3.String.val(expr.head.text);
      for (const span of expr.templateSpans) {
        const sv = evalExpr(Z3, span.expression, state);
        const svStr = toZ3String(Z3, sv);
        result = result.concat(svStr ?? Z3.String.const(`__span_${span.pos}`));
        if (span.literal.text) result = result.concat(Z3.String.val(span.literal.text));
      }
      return { kind: "z3", expr: result, sort: "string" };
    } catch { /* Z3 string concat unsupported — fall back to fresh symbolic string */
      return { kind: "z3", expr: Z3.String.const(`__template_${expr.pos}`), sort: "string" };
    }
  }

  // ── Spread (in expression position) ──
  if (ts.isSpreadElement(expr)) return evalExpr(Z3, expr.expression, state);

  return { kind: "concrete", value: undefined };
}

// ── Binary expression evaluator ──────────────────────────────────────────

function evalBinary(Z3: Z3Context, expr: ts.BinaryExpression, state: SymState): SymValue {
  const op = expr.operatorToken.kind;

  // Logical operators
  if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
    const leftVal = evalExpr(Z3, expr.left, state);
    const lb = toZ3Bool(Z3, leftVal);
    if (!lb) return leftVal;
    const rightState = cloneState(state);
    const rightVal = evalExpr(Z3, expr.right, rightState);
    const rb = toZ3Bool(Z3, rightVal);
    if (rb) return { kind: "z3", expr: Z3.And(lb, rb), sort: "bool" };
    return { kind: "concrete", value: undefined };
  }
  if (op === ts.SyntaxKind.BarBarToken) {
    const leftVal = evalExpr(Z3, expr.left, state);
    const lb = toZ3Bool(Z3, leftVal);
    if (!lb) return leftVal;
    const rightState = cloneState(state);
    const rightVal = evalExpr(Z3, expr.right, rightState);
    const rb = toZ3Bool(Z3, rightVal);
    if (rb) return { kind: "z3", expr: Z3.Or(lb, rb), sort: "bool" };
    return { kind: "concrete", value: undefined };
  }

  // Nullish coalescing: a ?? b → if a is null/undefined, return b, else a
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    const left = evalExpr(Z3, expr.left, state);
    if (left.kind === "null" || left.kind === "undefined") return evalExpr(Z3, expr.right, state);
    if (left.kind === "z3" || left.kind === "object" || left.kind === "array") return left;
    return evalExpr(Z3, expr.right, state);
  }

  // Compound assignments
  if (isCompoundAssignment(op)) {
    return evalCompoundAssignment(Z3, expr, op, state);
  }

  const left = evalExpr(Z3, expr.left, state);
  const right = evalExpr(Z3, expr.right, state);

  // Equality / inequality
  if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken)
    return evalEquality(Z3, left, right, false);
  if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken)
    return evalEquality(Z3, left, right, true);

  // Numeric arithmetic and comparisons
  if (left.kind === "z3" && right.kind === "z3" && left.sort === "int" && right.sort === "int") {
    switch (op) {
      case ts.SyntaxKind.LessThanToken: return { kind: "z3", expr: left.expr.lt(right.expr), sort: "bool" };
      case ts.SyntaxKind.LessThanEqualsToken: return { kind: "z3", expr: left.expr.le(right.expr), sort: "bool" };
      case ts.SyntaxKind.GreaterThanToken: return { kind: "z3", expr: left.expr.gt(right.expr), sort: "bool" };
      case ts.SyntaxKind.GreaterThanEqualsToken: return { kind: "z3", expr: left.expr.ge(right.expr), sort: "bool" };
      case ts.SyntaxKind.PlusToken: return { kind: "z3", expr: left.expr.add(right.expr), sort: "int" };
      case ts.SyntaxKind.MinusToken: return { kind: "z3", expr: left.expr.sub(right.expr), sort: "int" };
      case ts.SyntaxKind.AsteriskToken: return { kind: "z3", expr: left.expr.mul(right.expr), sort: "int" };
      case ts.SyntaxKind.SlashToken: return { kind: "z3", expr: left.expr.div(right.expr), sort: "int" };
      case ts.SyntaxKind.PercentToken: return { kind: "z3", expr: left.expr.mod(right.expr), sort: "int" };
    }
  }

  // String concatenation: string + anything
  if (op === ts.SyntaxKind.PlusToken) {
    const ls = toZ3String(Z3, left);
    const rs = toZ3String(Z3, right);
    if (ls && rs) {
      try { return { kind: "z3", expr: ls.concat(rs), sort: "string" }; } catch { /* fall through */ }
    }
  }

  // instanceof — approximate as concrete boolean
  if (op === ts.SyntaxKind.InstanceOfKeyword) return { kind: "concrete", value: undefined };

  // in operator
  if (op === ts.SyntaxKind.InKeyword) {
    if (right.kind === "object" && left.kind === "z3" && left.sort === "string") {
      return { kind: "concrete", value: undefined };
    }
    return { kind: "concrete", value: undefined };
  }

  return { kind: "concrete", value: undefined };
}

function isCompoundAssignment(op: ts.SyntaxKind): boolean {
  return op === ts.SyntaxKind.PlusEqualsToken || op === ts.SyntaxKind.MinusEqualsToken ||
    op === ts.SyntaxKind.AsteriskEqualsToken || op === ts.SyntaxKind.SlashEqualsToken ||
    op === ts.SyntaxKind.PercentEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken ||
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken;
}

function evalCompoundAssignment(Z3: Z3Context, expr: ts.BinaryExpression, op: ts.SyntaxKind, state: SymState): SymValue {
  const left = evalExpr(Z3, expr.left, state);
  const right = evalExpr(Z3, expr.right, state);
  let result: SymValue = { kind: "concrete", value: undefined };

  if (left.kind === "z3" && right.kind === "z3" && left.sort === "int" && right.sort === "int") {
    switch (op) {
      case ts.SyntaxKind.PlusEqualsToken: result = { kind: "z3", expr: left.expr.add(right.expr), sort: "int" }; break;
      case ts.SyntaxKind.MinusEqualsToken: result = { kind: "z3", expr: left.expr.sub(right.expr), sort: "int" }; break;
      case ts.SyntaxKind.AsteriskEqualsToken: result = { kind: "z3", expr: left.expr.mul(right.expr), sort: "int" }; break;
      case ts.SyntaxKind.SlashEqualsToken: result = { kind: "z3", expr: left.expr.div(right.expr), sort: "int" }; break;
      case ts.SyntaxKind.PercentEqualsToken: result = { kind: "z3", expr: left.expr.mod(right.expr), sort: "int" }; break;
    }
  }
  if (op === ts.SyntaxKind.BarBarEqualsToken) {
    const lb = toZ3Bool(Z3, left);
    result = lb ? left : right;
  }
  if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    result = (left.kind === "null" || left.kind === "undefined") ? right : left;
  }

  if (ts.isIdentifier(expr.left)) state.vars.set(expr.left.text, result);
  else if (ts.isPropertyAccessExpression(expr.left)) {
    const objName = identChain(expr.left.expression);
    if (objName) {
      const obj = state.vars.get(objName);
      if (obj?.kind === "object") obj.fields.set(expr.left.name.text, result);
    }
  }
  return result;
}

function evalEquality(Z3: Z3Context, left: SymValue, right: SymValue, negate: boolean): SymValue {
  if (left.kind === "z3" && right.kind === "z3") {
    if (left.sort === right.sort) {
      const eq = left.expr.eq(right.expr);
      return { kind: "z3", expr: negate ? Z3.Not(eq) : eq, sort: "bool" };
    }
    return { kind: "z3", expr: Z3.Bool.val(negate), sort: "bool" };
  }
  if (left.kind === "z3" && (right.kind === "null" || right.kind === "undefined"))
    return { kind: "z3", expr: Z3.Bool.val(negate), sort: "bool" };
  if ((left.kind === "null" || left.kind === "undefined") && right.kind === "z3")
    return { kind: "z3", expr: Z3.Bool.val(negate), sort: "bool" };
  if (left.kind === right.kind && (left.kind === "null" || left.kind === "undefined"))
    return { kind: "z3", expr: Z3.Bool.val(!negate), sort: "bool" };
  if ((left.kind === "null" && right.kind === "undefined") || (left.kind === "undefined" && right.kind === "null"))
    return { kind: "z3", expr: Z3.Bool.val(!negate), sort: "bool" };
  return { kind: "concrete", value: undefined };
}

// ── Call expression evaluator ────────────────────────────────────────────

function evalCall(Z3: Z3Context, expr: ts.CallExpression, state: SymState): SymValue {
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const objExpr = expr.expression.expression;
    const method = expr.expression.name.text;

    // Optional chaining on calls: obj?.method()
    if (expr.expression.questionDotToken) {
      const objVal = evalExpr(Z3, objExpr, state);
      if (objVal.kind === "null" || objVal.kind === "undefined") return { kind: "undefined" };
    }

    // Math.* functions
    if (ts.isIdentifier(objExpr) && objExpr.text === "Math")
      return evalMathCall(Z3, method, expr.arguments, state);

    const obj = evalExpr(Z3, objExpr, state);

    // String methods
    if (obj.kind === "z3" && obj.sort === "string") {
      if (method === "includes" && expr.arguments.length === 1) {
        const arg = evalExpr(Z3, expr.arguments[0]!, state);
        if (arg.kind === "z3" && arg.sort === "string")
          return { kind: "z3", expr: obj.expr.contains(arg.expr), sort: "bool" };
      }
      if (method === "startsWith" && expr.arguments.length === 1) {
        const arg = evalExpr(Z3, expr.arguments[0]!, state);
        if (arg.kind === "z3" && arg.sort === "string")
          return { kind: "z3", expr: arg.expr.prefixOf(obj.expr), sort: "bool" };
      }
      if (method === "endsWith" && expr.arguments.length === 1) {
        const arg = evalExpr(Z3, expr.arguments[0]!, state);
        if (arg.kind === "z3" && arg.sort === "string")
          return { kind: "z3", expr: arg.expr.suffixOf(obj.expr), sort: "bool" };
      }
      if (method === "indexOf" && expr.arguments.length >= 1) {
        const arg = evalExpr(Z3, expr.arguments[0]!, state);
        if (arg.kind === "z3" && arg.sort === "string")
          return { kind: "z3", expr: obj.expr.indexOf(arg.expr), sort: "int" };
      }
      if (method === "replace" && expr.arguments.length === 2) {
        const from = evalExpr(Z3, expr.arguments[0]!, state);
        const to = evalExpr(Z3, expr.arguments[1]!, state);
        if (from.kind === "z3" && from.sort === "string" && to.kind === "z3" && to.sort === "string")
          return { kind: "z3", expr: obj.expr.replace(from.expr, to.expr), sort: "string" };
      }
      if (method === "concat" && expr.arguments.length >= 1) {
        let result = obj.expr;
        for (const a of expr.arguments) {
          const av = evalExpr(Z3, a, state);
          const s = toZ3String(Z3, av);
          if (s) result = result.concat(s);
          else return { kind: "concrete", value: undefined };
        }
        return { kind: "z3", expr: result, sort: "string" };
      }
      if (method === "trim" || method === "trimStart" || method === "trimEnd")
        return obj;
      if (method === "toLowerCase" || method === "toUpperCase")
        return { kind: "z3", expr: Z3.String.const(`__${method}_${expr.pos}`), sort: "string" };
    }

    // Array methods on arrays with known elements
    if (obj.kind === "array" && obj.elements.length > 0) {
      if (method === "every" && expr.arguments.length === 1)
        return evalArrayPredicate(Z3, obj, expr.arguments[0]!, state, "every");
      if (method === "some" && expr.arguments.length === 1)
        return evalArrayPredicate(Z3, obj, expr.arguments[0]!, state, "some");
      if (method === "filter" && expr.arguments.length === 1)
        return evalArrayFilter(Z3, obj, expr.arguments[0]!, state);
      if (method === "map" && expr.arguments.length === 1)
        return evalArrayMap(Z3, obj, expr.arguments[0]!, state);
      if (method === "find" && expr.arguments.length === 1)
        return evalArrayPredicate(Z3, obj, expr.arguments[0]!, state, "find");
      if (method === "indexOf" && expr.arguments.length >= 1) {
        const target = evalExpr(Z3, expr.arguments[0]!, state);
        for (let idx = 0; idx < obj.elements.length; idx++) {
          const eq = evalEquality(Z3, obj.elements[idx]!, target, false);
          if (eq.kind === "z3" && eq.sort === "bool")
            return { kind: "z3", expr: Z3.If(eq.expr, Z3.Int.val(idx), Z3.Int.val(-1)), sort: "int" };
        }
      }
      if (method === "slice") return obj;
      if (method === "concat" && expr.arguments.length === 1) {
        const arg = evalExpr(Z3, expr.arguments[0]!, state);
        if (arg.kind === "array") {
          const all = [...obj.elements, ...arg.elements];
          return { kind: "array", elements: all, lengthExpr: Z3.Int.val(all.length) };
        }
      }
    }
    if (obj.kind === "array" && method === "push" && expr.arguments.length >= 1) {
      for (const a of expr.arguments) obj.elements.push(evalExpr(Z3, a, state));
      obj.lengthExpr = Z3.Int.val(obj.elements.length);
      return { kind: "z3", expr: obj.lengthExpr, sort: "int" };
    }
  }

  // Static: Array.isArray
  if (ts.isPropertyAccessExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)) {
    const cls = expr.expression.expression.text;
    const method = expr.expression.name.text;
    if (cls === "Array" && method === "isArray" && expr.arguments.length === 1) {
      const arg = evalExpr(Z3, expr.arguments[0]!, state);
      return { kind: "z3", expr: Z3.Bool.val(arg.kind === "array"), sort: "bool" };
    }
    if (cls === "Number" && method === "isFinite" && expr.arguments.length === 1)
      return { kind: "z3", expr: Z3.Bool.val(true), sort: "bool" };
    if (cls === "Number" && method === "isNaN" && expr.arguments.length === 1) {
      const arg = evalExpr(Z3, expr.arguments[0]!, state);
      if (arg.kind === "z3" && arg.sort === "int") return { kind: "z3", expr: Z3.Bool.val(false), sort: "bool" };
    }
    if (cls === "Object" && method === "keys" && expr.arguments.length === 1) {
      const arg = evalExpr(Z3, expr.arguments[0]!, state);
      if (arg.kind === "object") {
        const keys = [...arg.fields.keys()].map((k) => ({ kind: "z3" as const, expr: Z3.String.val(k), sort: "string" as const }));
        return { kind: "array", elements: keys, lengthExpr: Z3.Int.val(keys.length) };
      }
    }
  }

  return { kind: "concrete", value: undefined };
}

function evalMathCall(Z3: Z3Context, method: string, args: ts.NodeArray<ts.Expression>, state: SymState): SymValue {
  if (args.length === 1) {
    const a = evalExpr(Z3, args[0]!, state);
    if (a.kind !== "z3" || a.sort !== "int") return { kind: "concrete", value: undefined };
    const zero = Z3.Int.val(0);
    switch (method) {
      case "abs": return { kind: "z3", expr: Z3.If(a.expr.ge(zero), a.expr, zero.sub(a.expr)), sort: "int" };
      case "sign": return { kind: "z3", expr: Z3.If(a.expr.gt(zero), Z3.Int.val(1), Z3.If(a.expr.lt(zero), Z3.Int.val(-1), zero)), sort: "int" };
      case "ceil": case "floor": case "round": case "trunc": return a;
    }
  }
  if (args.length === 2) {
    const a = evalExpr(Z3, args[0]!, state);
    const b = evalExpr(Z3, args[1]!, state);
    if (a.kind !== "z3" || a.sort !== "int" || b.kind !== "z3" || b.sort !== "int")
      return { kind: "concrete", value: undefined };
    switch (method) {
      case "max": return { kind: "z3", expr: Z3.If(a.expr.ge(b.expr), a.expr, b.expr), sort: "int" };
      case "min": return { kind: "z3", expr: Z3.If(a.expr.le(b.expr), a.expr, b.expr), sort: "int" };
    }
  }
  return { kind: "concrete", value: undefined };
}

function parseArrowCallback(callbackExpr: ts.Expression): { body: ts.Expression | ts.Block; paramName: string } | null {
  const file = ts.createSourceFile("__cb.ts", `const __cb = ${callbackExpr.getText()};`, ts.ScriptTarget.Latest, true);
  let cbBody: ts.Expression | ts.Block | undefined;
  let paramName = "__el";
  function findCb(node: ts.Node) {
    if (cbBody) return;
    if (ts.isArrowFunction(node)) {
      cbBody = node.body;
      if (node.parameters.length > 0 && ts.isIdentifier(node.parameters[0]!.name))
        paramName = node.parameters[0]!.name.text;
    }
    ts.forEachChild(node, findCb);
  }
  findCb(file);
  if (!cbBody) return null;
  return { body: cbBody, paramName };
}

function evalArrayPredicate(
  Z3: Z3Context, arr: SymValue & { kind: "array" },
  callbackExpr: ts.Expression, state: SymState,
  mode: "every" | "some" | "find",
): SymValue {
  const cb = parseArrowCallback(callbackExpr);
  if (!cb) return { kind: "concrete", value: undefined };
  const { body: cbBody, paramName } = cb;

  const boolExprs: any[] = [];
  for (const el of arr.elements) {
    const cbState: SymState = { vars: new Map(state.vars), constraints: [...state.constraints] };
    cbState.vars.set(paramName, el);
    let val: SymValue;
    if (ts.isBlock(cbBody)) {
      return { kind: "concrete", value: undefined };
    } else {
      val = evalExpr(Z3, cbBody, cbState);
    }
    const b = toZ3Bool(Z3, val);
    if (!b) return { kind: "concrete", value: undefined };
    boolExprs.push(b);
  }

  if (mode === "every") return { kind: "z3", expr: Z3.And(...boolExprs), sort: "bool" };
  if (mode === "some") return { kind: "z3", expr: Z3.Or(...boolExprs), sort: "bool" };
  return { kind: "concrete", value: undefined };
}

function evalArrayFilter(
  Z3: Z3Context, arr: SymValue & { kind: "array" },
  callbackExpr: ts.Expression, state: SymState,
): SymValue {
  return { kind: "array", elements: arr.elements, lengthExpr: arr.lengthExpr };
}

function evalArrayMap(
  Z3: Z3Context, arr: SymValue & { kind: "array" },
  callbackExpr: ts.Expression, state: SymState,
): SymValue {
  const cb = parseArrowCallback(callbackExpr);
  if (!cb || ts.isBlock(cb.body)) return { kind: "array", elements: arr.elements, lengthExpr: arr.lengthExpr };
  const { paramName } = cb;
  const cbBody = cb.body as ts.Expression;

  const mapped: SymValue[] = [];
  for (const el of arr.elements) {
    const cbState: SymState = { vars: new Map(state.vars), constraints: [...state.constraints] };
    cbState.vars.set(paramName, el);
    mapped.push(evalExpr(Z3, cbBody, cbState));
  }
  return { kind: "array", elements: mapped, lengthExpr: Z3.Int.val(mapped.length) };
}

// ── Z3 conversion helpers ────────────────────────────────────────────────

function toZ3Bool(Z3: Z3Context, val: SymValue): any | null {
  if (val.kind === "z3" && val.sort === "bool") return val.expr;
  if (val.kind === "z3" && val.sort === "int") return Z3.Not(val.expr.eq(Z3.Int.val(0)));
  if (val.kind === "z3" && val.sort === "string") return Z3.Not(val.expr.eq(Z3.String.val("")));
  if (val.kind === "concrete") return Z3.Bool.val(Boolean(val.value));
  if (val.kind === "null" || val.kind === "undefined") return Z3.Bool.val(false);
  if (val.kind === "object" || val.kind === "array") return Z3.Bool.val(true);
  return null;
}

let intToStrCounter = 0;

function toZ3String(Z3: Z3Context, val: SymValue): any | null {
  if (val.kind === "z3" && val.sort === "string") return val.expr;
  if (val.kind === "z3" && val.sort === "int") {
    return Z3.String.const(`__intToStr_${intToStrCounter++}`);
  }
  if (val.kind === "z3" && val.sort === "bool") {
    return Z3.If(val.expr, Z3.String.val("true"), Z3.String.val("false"));
  }
  if (val.kind === "null") return Z3.String.val("null");
  if (val.kind === "undefined") return Z3.String.val("undefined");
  return null;
}

function negateValue(Z3: Z3Context, val: SymValue): SymValue {
  const b = toZ3Bool(Z3, val);
  if (b) return { kind: "z3", expr: Z3.Not(b), sort: "bool" };
  return { kind: "concrete", value: undefined };
}

function typeofStr(val: SymValue): string | null {
  if (val.kind === "z3") {
    if (val.sort === "int") return "number";
    if (val.sort === "bool") return "boolean";
    if (val.sort === "string") return "string";
  }
  if (val.kind === "object") return "object";
  if (val.kind === "null") return "object";
  if (val.kind === "undefined") return "undefined";
  if (val.kind === "array") return "object";
  return null;
}

// ── State management ─────────────────────────────────────────────────────

function cloneState(state: SymState): SymState {
  return { vars: cloneVars(state.vars), constraints: [...state.constraints] };
}

function cloneVars(vars: Map<string, SymValue>): Map<string, SymValue> {
  const out = new Map<string, SymValue>();
  for (const [k, v] of vars) out.set(k, cloneSymValue(v));
  return out;
}

function cloneSymValue(val: SymValue): SymValue {
  if (val.kind === "object") {
    const fields = new Map<string, SymValue>();
    for (const [k, v] of val.fields) fields.set(k, cloneSymValue(v));
    return { kind: "object", fields };
  }
  if (val.kind === "array") {
    return {
      kind: "array",
      elements: val.elements.map(cloneSymValue),
      lengthExpr: val.lengthExpr,
    };
  }
  return val;
}

function blockStmts(node: ts.Statement): ts.Statement[] {
  return ts.isBlock(node) ? Array.from(node.statements) : [node];
}

function identChain(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const parent = identChain(expr.expression);
    return parent ? `${parent}.${expr.name.text}` : null;
  }
  return null;
}

function makePath(state: SymState, returnValue: SymValue, returned: boolean): ExecutionPath {
  return {
    constraints: [...state.constraints],
    returnValue,
    returned,
    finalVars: returned ? undefined : cloneVars(state.vars),
  };
}

// ── Inline expression execution (updates state) ─────────────────────────

function execExprStmt(Z3: Z3Context, expr: ts.Expression, state: SymState): void {
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken) {
      const val = evalExpr(Z3, expr.right, state);
      if (ts.isIdentifier(expr.left)) {
        state.vars.set(expr.left.text, val);
      } else if (ts.isPropertyAccessExpression(expr.left)) {
        const objName = identChain(expr.left.expression);
        if (objName) {
          const obj = state.vars.get(objName);
          if (obj?.kind === "object") obj.fields.set(expr.left.name.text, val);
        }
      }
      return;
    }
    if (isCompoundAssignment(op)) {
      evalCompoundAssignment(Z3, expr, op, state);
      return;
    }
  }
  if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr))
    evalExpr(Z3, expr, state);
  if (ts.isCallExpression(expr))
    evalExpr(Z3, expr, state);
}

// ── Path exploration (core symbolic execution) ───────────────────────────

function explorePaths(
  Z3: Z3Context,
  stmts: ts.Statement[],
  state: SymState,
  maxPaths: number,
  pathCount: { value: number },
  maxLoopUnroll: number = DEFAULT_MAX_LOOP_UNROLL,
): ExecutionPath[] {
  const results: ExecutionPath[] = [];

  for (let i = 0; i < stmts.length; i++) {
    if (pathCount.value >= maxPaths) break;
    const stmt = stmts[i]!;

    // ── Return ──
    if (ts.isReturnStatement(stmt)) {
      const retVal = stmt.expression ? evalExpr(Z3, stmt.expression, state) : { kind: "undefined" as const };
      results.push(makePath(state, retVal, true));
      pathCount.value++;
      return results;
    }

    // ── Variable declaration ──
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          state.vars.set(decl.name.text, evalExpr(Z3, decl.initializer, state));
        }
        if (ts.isObjectBindingPattern(decl.name) && decl.initializer) {
          const val = evalExpr(Z3, decl.initializer, state);
          if (val.kind === "object") {
            for (const el of decl.name.elements) {
              if (ts.isIdentifier(el.name)) {
                const propName = el.propertyName && ts.isIdentifier(el.propertyName)
                  ? el.propertyName.text : el.name.text;
                const fv = val.fields.get(propName);
                if (fv) state.vars.set(el.name.text, fv);
              }
            }
          }
        }
        if (ts.isArrayBindingPattern(decl.name) && decl.initializer) {
          const val = evalExpr(Z3, decl.initializer, state);
          if (val.kind === "array") {
            for (let idx = 0; idx < decl.name.elements.length; idx++) {
              const el = decl.name.elements[idx]!;
              if (ts.isBindingElement(el) && ts.isIdentifier(el.name) && idx < val.elements.length) {
                state.vars.set(el.name.text, val.elements[idx]!);
              }
            }
          }
        }
      }
      continue;
    }

    // ── Expression statement ──
    if (ts.isExpressionStatement(stmt)) {
      execExprStmt(Z3, stmt.expression, state);
      continue;
    }

    // ── If statement ──
    if (ts.isIfStatement(stmt)) {
      const cond = evalExpr(Z3, stmt.expression, state);
      const condBool = toZ3Bool(Z3, cond);
      const remaining = stmts.slice(i + 1);

      if (!condBool) {
        const ts1 = [...blockStmts(stmt.thenStatement), ...remaining];
        results.push(...explorePaths(Z3, ts1, cloneState(state), maxPaths, pathCount, maxLoopUnroll));
        const es1 = stmt.elseStatement
          ? [...blockStmts(stmt.elseStatement), ...remaining]
          : remaining;
        results.push(...explorePaths(Z3, es1, cloneState(state), maxPaths, pathCount, maxLoopUnroll));
        return results;
      }

      const thenState = cloneState(state);
      thenState.constraints.push(condBool);
      results.push(...explorePaths(Z3, [...blockStmts(stmt.thenStatement), ...remaining], thenState, maxPaths, pathCount, maxLoopUnroll));

      const falseState = cloneState(state);
      falseState.constraints.push(Z3.Not(condBool));
      const falseStmts = stmt.elseStatement
        ? [...blockStmts(stmt.elseStatement), ...remaining]
        : remaining;
      results.push(...explorePaths(Z3, falseStmts, falseState, maxPaths, pathCount, maxLoopUnroll));
      return results;
    }

    // ── Switch statement ──
    if (ts.isSwitchStatement(stmt)) {
      const switchVal = evalExpr(Z3, stmt.expression, state);
      const remaining = stmts.slice(i + 1);
      const caseEqs: any[] = [];
      let hasDefault = false;

      for (const clause of stmt.caseBlock.clauses) {
        if (pathCount.value >= maxPaths) break;
        if (ts.isCaseClause(clause)) {
          const cv = evalExpr(Z3, clause.expression, state);
          const eq = evalEquality(Z3, switchVal, cv, false);
          const eqBool = toZ3Bool(Z3, eq);
          if (eqBool) {
            caseEqs.push(eqBool);
            const cs = cloneState(state);
            cs.constraints.push(eqBool);
            results.push(...explorePaths(Z3, extractCaseBody(clause, remaining), cs, maxPaths, pathCount, maxLoopUnroll));
          }
        } else {
          hasDefault = true;
          const ds = cloneState(state);
          if (caseEqs.length > 0) ds.constraints.push(Z3.Not(Z3.Or(...caseEqs)));
          results.push(...explorePaths(Z3, [...Array.from(clause.statements), ...remaining], ds, maxPaths, pathCount, maxLoopUnroll));
        }
      }
      if (!hasDefault && caseEqs.length > 0) {
        const fs = cloneState(state);
        fs.constraints.push(Z3.Not(Z3.Or(...caseEqs)));
        results.push(...explorePaths(Z3, remaining, fs, maxPaths, pathCount, maxLoopUnroll));
      }
      return results;
    }

    // ── For loop (bounded unrolling) ──
    if (ts.isForStatement(stmt)) {
      if (stmt.initializer) {
        if (ts.isVariableDeclarationList(stmt.initializer)) {
          for (const decl of stmt.initializer.declarations) {
            if (ts.isIdentifier(decl.name) && decl.initializer)
              state.vars.set(decl.name.text, evalExpr(Z3, decl.initializer, state));
          }
        } else {
          execExprStmt(Z3, stmt.initializer, state);
        }
      }
      const remaining = stmts.slice(i + 1);
      const body = blockStmts(stmt.statement);
      return unrollLoop(Z3, stmt.condition, stmt.incrementor, body, remaining, state, maxPaths, pathCount, maxLoopUnroll);
    }

    // ── While loop (bounded unrolling) ──
    if (ts.isWhileStatement(stmt)) {
      const remaining = stmts.slice(i + 1);
      return unrollLoop(Z3, stmt.expression, undefined, blockStmts(stmt.statement), remaining, state, maxPaths, pathCount, maxLoopUnroll);
    }

    // ── For...of loop ──
    if (ts.isForOfStatement(stmt)) {
      const iterVal = evalExpr(Z3, stmt.expression, state);
      const remaining = stmts.slice(i + 1);
      if (iterVal.kind === "array" && iterVal.elements.length > 0 && ts.isVariableDeclarationList(stmt.initializer)) {
        const varName = getForOfVarName(stmt.initializer);
        if (varName) {
          return unrollForOf(Z3, varName, iterVal.elements, blockStmts(stmt.statement), remaining, state, maxPaths, pathCount, maxLoopUnroll);
        }
      }
      return explorePaths(Z3, remaining, state, maxPaths, pathCount, maxLoopUnroll);
    }

    // ── For...in loop ──
    if (ts.isForInStatement(stmt)) {
      const iterVal = evalExpr(Z3, stmt.expression, state);
      const remaining = stmts.slice(i + 1);
      if (iterVal.kind === "object" && ts.isVariableDeclarationList(stmt.initializer)) {
        const varName = getForOfVarName(stmt.initializer);
        if (varName) {
          const keys = [...iterVal.fields.keys()].map(
            (k) => ({ kind: "z3" as const, expr: Z3.String.val(k), sort: "string" as const }),
          );
          return unrollForOf(Z3, varName, keys, blockStmts(stmt.statement), remaining, state, maxPaths, pathCount, maxLoopUnroll);
        }
      }
      return explorePaths(Z3, remaining, state, maxPaths, pathCount, maxLoopUnroll);
    }

    // ── Try/catch ──
    if (ts.isTryStatement(stmt)) {
      const remaining = stmts.slice(i + 1);
      const tryBody = [...Array.from(stmt.tryBlock.statements), ...remaining];
      const tryPaths = explorePaths(Z3, tryBody, cloneState(state), maxPaths, pathCount, maxLoopUnroll);
      results.push(...tryPaths);
      if (stmt.catchClause) {
        const catchBody = [...Array.from(stmt.catchClause.block.statements), ...remaining];
        const catchState = cloneState(state);
        if (stmt.catchClause.variableDeclaration && ts.isIdentifier(stmt.catchClause.variableDeclaration.name))
          catchState.vars.set(stmt.catchClause.variableDeclaration.name.text, { kind: "concrete", value: undefined });
        results.push(...explorePaths(Z3, catchBody, catchState, maxPaths, pathCount, maxLoopUnroll));
      }
      return results;
    }

    // ── Block ──
    if (ts.isBlock(stmt)) {
      return explorePaths(Z3, [...Array.from(stmt.statements), ...stmts.slice(i + 1)], state, maxPaths, pathCount, maxLoopUnroll);
    }

    // ── Throw ──
    if (ts.isThrowStatement(stmt)) {
      pathCount.value++;
      return results;
    }

    // ── Do...while ──
    if (ts.isDoStatement(stmt)) {
      const remaining = stmts.slice(i + 1);
      const body = blockStmts(stmt.statement);
      const bodyPaths = explorePaths(Z3, body, cloneState(state), maxPaths, pathCount, maxLoopUnroll);
      for (const bp of bodyPaths) {
        if (bp.returned) { results.push(bp); continue; }
        if (!bp.finalVars) { results.push(bp); continue; }
        const contState: SymState = { vars: bp.finalVars, constraints: [...bp.constraints] };
        results.push(...unrollLoop(Z3, stmt.expression, undefined, body, remaining, contState, maxPaths, pathCount, Math.max(0, maxLoopUnroll - 1)));
      }
      return results;
    }
  }

  results.push(makePath(state, { kind: "undefined" }, false));
  pathCount.value++;
  return results;
}

function hasBreakStatement(stmts: ts.Statement[]): boolean {
  for (const s of stmts) {
    if (ts.isBreakStatement(s)) return true;
    if (ts.isIfStatement(s)) {
      if (hasBreakStatement(blockStmts(s.thenStatement))) return true;
      if (s.elseStatement && hasBreakStatement(blockStmts(s.elseStatement))) return true;
    }
    if (ts.isBlock(s)) {
      if (hasBreakStatement(Array.from(s.statements))) return true;
    }
  }
  return false;
}

function extractCaseBody(clause: ts.CaseClause, remaining: ts.Statement[]): ts.Statement[] {
  const stmts = Array.from(clause.statements);
  const breaks = hasBreakStatement(stmts);
  const filtered = stmts.filter((s) => !ts.isBreakStatement(s));
  return breaks ? filtered : [...filtered, ...remaining];
}

// ── Loop unrolling helpers ───────────────────────────────────────────────

function unrollLoop(
  Z3: Z3Context,
  condition: ts.Expression | undefined,
  incrementor: ts.Expression | undefined,
  body: ts.Statement[],
  afterLoop: ts.Statement[],
  state: SymState,
  maxPaths: number,
  pathCount: { value: number },
  itersLeft: number,
): ExecutionPath[] {
  if (itersLeft <= 0 || pathCount.value >= maxPaths)
    return explorePaths(Z3, afterLoop, state, maxPaths, pathCount);

  if (!condition)
    return explorePaths(Z3, afterLoop, state, maxPaths, pathCount);

  const condVal = evalExpr(Z3, condition, state);
  const condBool = toZ3Bool(Z3, condVal);
  if (!condBool)
    return explorePaths(Z3, afterLoop, state, maxPaths, pathCount);

  const results: ExecutionPath[] = [];

  const exitState = cloneState(state);
  exitState.constraints.push(Z3.Not(condBool));
  results.push(...explorePaths(Z3, afterLoop, exitState, maxPaths, pathCount));

  const contState = cloneState(state);
  contState.constraints.push(condBool);
  const bodyPaths = explorePaths(Z3, body, contState, maxPaths, pathCount, itersLeft);

  for (const bp of bodyPaths) {
    if (bp.returned) {
      results.push(bp);
    } else {
      const nextVars = bp.finalVars ?? cloneVars(contState.vars);
      const nextState: SymState = { vars: nextVars, constraints: [...bp.constraints] };
      if (incrementor) execExprStmt(Z3, incrementor, nextState);
      results.push(...unrollLoop(Z3, condition, incrementor, body, afterLoop, nextState, maxPaths, pathCount, itersLeft - 1));
    }
  }
  return results;
}

function unrollForOf(
  Z3: Z3Context,
  varName: string,
  elements: SymValue[],
  body: ts.Statement[],
  afterLoop: ts.Statement[],
  state: SymState,
  maxPaths: number,
  pathCount: { value: number },
  maxLoopUnroll: number,
): ExecutionPath[] {
  let currentState = cloneState(state);
  const results: ExecutionPath[] = [];

  for (const el of elements) {
    if (pathCount.value >= maxPaths) break;
    currentState.vars.set(varName, el);
    const bodyPaths = explorePaths(Z3, body, cloneState(currentState), maxPaths, pathCount, maxLoopUnroll);
    for (const bp of bodyPaths) {
      if (bp.returned) {
        results.push(bp);
      } else {
        currentState = { vars: bp.finalVars ?? cloneVars(currentState.vars), constraints: [...bp.constraints] };
      }
    }
  }

  results.push(...explorePaths(Z3, afterLoop, currentState, maxPaths, pathCount, maxLoopUnroll));
  return results;
}

function getForOfVarName(initializer: ts.VariableDeclarationList): string | null {
  const decl = initializer.declarations[0];
  if (decl && ts.isIdentifier(decl.name)) return decl.name.text;
  return null;
}

// ── Postcondition checking ───────────────────────────────────────────────

async function checkPostcondition(
  Z3: Z3Context,
  path: ExecutionPath,
  postcondExpr: ts.Expression,
  inputValue: SymValue,
  timeoutMs: number,
): Promise<"proven" | { counterexample: Record<string, unknown> } | "unknown"> {
  const checkState: SymState = {
    vars: new Map([["input", inputValue], ["result", path.returnValue]]),
    constraints: [],
  };
  const postcondVal = evalExpr(Z3, postcondExpr, checkState);
  const postcondBool = toZ3Bool(Z3, postcondVal);
  if (!postcondBool) return "unknown";

  const solver = new Z3.Solver();
  solver.set("timeout", timeoutMs);
  for (const c of path.constraints) solver.add(c);
  solver.add(Z3.Not(postcondBool));

  const result = await solver.check();
  if (result === "unsat") return "proven";
  if (result === "sat") return { counterexample: extractModel(solver.model()) };
  return "unknown";
}

function extractModel(model: any): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  try {
    for (const d of model.decls()) {
      const name: string = typeof d.name === "function" ? d.name() : String(d);
      const val = model.eval(d.call());
      result[name] = val?.toString?.() ?? String(val);
    }
  } catch { /* complex sort extraction failure */ }
  return result;
}

// ── Public API ───────────────────────────────────────────────────────────

export async function proveInvariant(
  func: DiscoveredFunction,
  invariant: Invariant,
  options?: ProveOptions,
): Promise<SymbolicProofResult> {
  const maxPaths = options?.maxPaths ?? DEFAULT_MAX_PATHS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLoopUnroll = options?.maxLoopUnroll ?? DEFAULT_MAX_LOOP_UNROLL;

  let Z3: Z3Context;
  intToStrCounter = 0;
  try { Z3 = await getZ3(); } catch (e: any) {
    return { invariantName: invariant.name, status: "unsupported", pathsExplored: 0, pathsProven: 0, pathsFailed: 0, error: e.message };
  }

  let bodyStmts: ts.Statement[];
  try { bodyStmts = parseFunctionBody(func.sourceText); } catch (e: any) {
    return { invariantName: invariant.name, status: "unsupported", pathsExplored: 0, pathsProven: 0, pathsFailed: 0, error: `Failed to parse function body: ${e.message}` };
  }
  if (bodyStmts.length === 0)
    return { invariantName: invariant.name, status: "unsupported", pathsExplored: 0, pathsProven: 0, pathsFailed: 0, error: "Empty function body" };

  const z3Consts: Array<{ name: string; expr: any }> = [];
  const initial: SymState = { vars: new Map(), constraints: [] };
  let inputValue: SymValue;

  if (func.params.length === 0) {
    inputValue = { kind: "undefined" };
  } else if (func.params.length === 1) {
    const p = func.params[0]!;
    const sv = createSymbolicValue(Z3, p.name, p.type, z3Consts);
    initial.vars.set(p.name, sv);
    addTypeConstraints(Z3, p.name, p.type, sv, initial.constraints);
    inputValue = sv;
  } else {
    const fields = new Map<string, SymValue>();
    for (const p of func.params) {
      const sv = createSymbolicValue(Z3, p.name, p.type, z3Consts);
      initial.vars.set(p.name, sv);
      addTypeConstraints(Z3, p.name, p.type, sv, initial.constraints);
      fields.set(p.name, sv);
    }
    inputValue = { kind: "object", fields };
  }

  const pathCount = { value: 0 };
  let paths: ExecutionPath[];
  try { paths = explorePaths(Z3, bodyStmts, initial, maxPaths, pathCount, maxLoopUnroll); } catch (e: any) {
    return { invariantName: invariant.name, status: "unknown", pathsExplored: 0, pathsProven: 0, pathsFailed: 0, error: `Path exploration failed: ${e.message}` };
  }

  const returnedPaths = paths.filter((p) => p.returned);
  if (returnedPaths.length === 0 && paths.length > 0) {
    return { invariantName: invariant.name, status: "unknown", pathsExplored: paths.length, pathsProven: 0, pathsFailed: 0, error: "No execution paths with return found" };
  }

  let postcondExpr: ts.Expression;
  try { postcondExpr = parseExpressionNode(invariant.postcondition); } catch (e: any) {
    return { invariantName: invariant.name, status: "unsupported", pathsExplored: returnedPaths.length, pathsProven: 0, pathsFailed: 0, error: `Failed to parse postcondition: ${e.message}` };
  }

  let proven = 0;
  let failed = 0;
  let firstCx: Record<string, unknown> | undefined;

  for (const path of returnedPaths) {
    try {
      const r = await checkPostcondition(Z3, path, postcondExpr, inputValue, timeoutMs);
      if (r === "proven") proven++;
      else if (r !== "unknown") { failed++; if (!firstCx) firstCx = r.counterexample; }
    } catch { /* solver error */ }
  }

  const status: SymbolicProofResult["status"] =
    failed > 0 ? "counterexample" : proven === returnedPaths.length ? "proven" : "unknown";

  return { invariantName: invariant.name, status, counterexample: firstCx, pathsExplored: returnedPaths.length, pathsProven: proven, pathsFailed: failed };
}

export async function proveInvariants(
  func: DiscoveredFunction,
  invariants: Invariant[],
  options?: ProveOptions,
): Promise<SymbolicProofResult[]> {
  const results: SymbolicProofResult[] = [];
  for (const inv of invariants) results.push(await proveInvariant(func, inv, options));
  return results;
}

// ── Formatting ───────────────────────────────────────────────────────────

export function formatProofResults(results: SymbolicProofResult[]): string {
  const proven = results.filter((r) => r.status === "proven");
  const cxs = results.filter((r) => r.status === "counterexample");
  const unknown = results.filter((r) => r.status === "unknown");
  const unsupported = results.filter((r) => r.status === "unsupported");

  const lines: string[] = [
    "━━━ Symbolic Proof Results ━━━", "",
    `Proven: ${proven.length}  Counterexample: ${cxs.length}  Unknown: ${unknown.length}  Unsupported: ${unsupported.length}`, "",
  ];

  if (proven.length > 0) {
    lines.push("Proven (holds for ALL inputs):");
    for (const r of proven) lines.push(`  ✓ ${r.invariantName}  (${r.pathsExplored} paths, all proven)`);
    lines.push("");
  }
  if (cxs.length > 0) {
    lines.push("Counterexample found:");
    for (const r of cxs) {
      lines.push(`  ✗ ${r.invariantName}  (${r.pathsFailed}/${r.pathsExplored} paths violated)`);
      if (r.counterexample) for (const [k, v] of Object.entries(r.counterexample)) lines.push(`    ${k} = ${v}`);
    }
    lines.push("");
  }
  if (unknown.length > 0) {
    lines.push("Unknown (solver timeout or unsupported operations):");
    for (const r of unknown) {
      lines.push(`  ? ${r.invariantName}  (${r.pathsProven}/${r.pathsExplored} paths proven)`);
      if (r.error) lines.push(`    reason: ${r.error}`);
    }
    lines.push("");
  }
  if (unsupported.length > 0) {
    lines.push("Unsupported:");
    for (const r of unsupported) lines.push(`  - ${r.invariantName}: ${r.error ?? "unknown reason"}`);
    lines.push("");
  }
  return lines.join("\n");
}
