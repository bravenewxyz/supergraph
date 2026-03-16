import { readFile } from "node:fs/promises";
import type { LogInvariant } from "./types.js";

export interface LogCheckResult {
  invariant: string;
  severity: "critical" | "high" | "medium";
  violations: Array<{ line: number; event: unknown }>;
  totalChecked: number;
}

const FILTER_EQ = /^\.(\w+)\s*==\s*["']([^"']*)["']$/;
const FILTER_NE = /^\.(\w+)\s*!=\s*["']([^"']*)["']$/;
const FILTER_TRUTHY = /^\.(\w+)$/;

function getProp(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

export function matchesFilter(event: unknown, filter: string): boolean {
  const trimmed = filter.trim();
  let m = trimmed.match(FILTER_EQ);
  if (m) {
    const val = getProp(event, m[1]!);
    return val === m[2]!;
  }
  m = trimmed.match(FILTER_NE);
  if (m) {
    const val = getProp(event, m[1]!);
    return val !== m[2]!;
  }
  m = trimmed.match(FILTER_TRUTHY);
  if (m) {
    return Boolean(getProp(event, m[1]!));
  }
  return false;
}

/**
 * Safely resolve a dotted property path (e.g. "data.foo.bar") on a value.
 * Only allows identifier segments — no brackets, no computed access.
 */
function resolvePath(root: unknown, path: string): unknown {
  const segments = path.split(".");
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// Identifier / dotted-path starting with "data"
const PATH_RE = /^data(?:\.\w+)+$/;
// Numeric literal (integer or decimal, optional leading minus)
const NUM_RE = /^-?\d+(?:\.\d+)?$/;
// String literal (single- or double-quoted, no embedded quotes)
const STR_RE = /^(?:"[^"]*"|'[^']*')$/;
// Boolean / null / undefined literals
const KEYWORD_RE = /^(?:true|false|null|undefined)$/;

type Comparator = "===" | "!==" | "==" | "!=" | ">=" | "<=" | ">" | "<";
const COMPARATORS: Comparator[] = ["===", "!==", "==", "!=", ">=", "<=", ">", "<"];

/**
 * Parse a literal token into its JS value.
 */
function parseLiteral(token: string): unknown {
  if (NUM_RE.test(token)) return Number(token);
  if (STR_RE.test(token)) return token.slice(1, -1);
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null") return null;
  if (token === "undefined") return undefined;
  return undefined;
}

function isLiteral(token: string): boolean {
  return NUM_RE.test(token) || STR_RE.test(token) || KEYWORD_RE.test(token);
}

/**
 * Evaluate a single simple expression. Supported forms:
 *   data.field === value
 *   data.field !== value
 *   data.field > / >= / < / <= value
 *   data.field == value / data.field != value
 *   typeof data.field === "string"
 *   data.field              (truthy check)
 *   data.field.length > 0   (property chain including .length)
 */
function evaluateSingle(data: unknown, expr: string): boolean {
  const trimmed = expr.trim();

  // typeof data.field === "type"
  const typeofMatch = trimmed.match(
    /^typeof\s+(data(?:\.\w+)+)\s*(===|!==|==|!=)\s*("[^"]*"|'[^']*')$/
  );
  if (typeofMatch) {
    const val = resolvePath({ data }, typeofMatch[1]!);
    const actual = typeof val;
    const expected = typeofMatch[3]!.slice(1, -1);
    const op = typeofMatch[2] as Comparator;
    if (op === "===" || op === "==") return actual === expected;
    if (op === "!==" || op === "!=") return actual !== expected;
    return false;
  }

  // Comparison: path <op> literal  or  literal <op> path
  for (const op of COMPARATORS) {
    const idx = trimmed.indexOf(op);
    if (idx === -1) continue;
    const lhs = trimmed.slice(0, idx).trim();
    const rhs = trimmed.slice(idx + op.length).trim();
    if (!lhs || !rhs) continue;

    let pathVal: unknown;
    let literalVal: unknown;

    if (PATH_RE.test(lhs) && isLiteral(rhs)) {
      pathVal = resolvePath({ data }, lhs);
      literalVal = parseLiteral(rhs);
    } else if (PATH_RE.test(rhs) && isLiteral(lhs)) {
      pathVal = resolvePath({ data }, rhs);
      literalVal = parseLiteral(lhs);
      // Swap so comparison direction is literal <op> path → path <reverseOp> literal
      // Easier to just evaluate directly with original operand positions
      return compareValues(parseLiteral(lhs), op, resolvePath({ data }, rhs));
    } else {
      continue;
    }

    return compareValues(pathVal, op, literalVal);
  }

  // Bare truthy check: data.field or data.field.nested
  if (PATH_RE.test(trimmed)) {
    return Boolean(resolvePath({ data }, trimmed));
  }

  // Nothing matched — reject
  throw new Error(`Unrecognized invariant expression: ${trimmed}`);
}

function compareValues(lhs: unknown, op: Comparator, rhs: unknown): boolean {
  switch (op) {
    case "===": return lhs === rhs;
    case "!==": return lhs !== rhs;
    case "==":  return lhs == rhs;  // eslint-disable-line eqeqeq
    case "!=":  return lhs != rhs;  // eslint-disable-line eqeqeq
    case ">":   return Number(lhs) > Number(rhs);
    case ">=":  return Number(lhs) >= Number(rhs);
    case "<":   return Number(lhs) < Number(rhs);
    case "<=":  return Number(lhs) <= Number(rhs);
    default:    return false;
  }
}

/**
 * Safely evaluate a condition string against `data`.
 *
 * Only allows simple property-access comparisons joined by && / ||.
 * No function calls, no assignment, no arbitrary code execution.
 */
export function evaluateCondition(data: unknown, condition: string): boolean {
  try {
    // Split on || first (lower precedence), then && within each group
    const orGroups = condition.split("||");
    return orGroups.some((orGroup) => {
      const andParts = orGroup.split("&&");
      return andParts.every((part) => evaluateSingle(data, part));
    });
  } catch {
    return false;
  }
}

export async function checkLogInvariants(
  logFile: string,
  invariants: LogInvariant[]
): Promise<LogCheckResult[]> {
  const content = await readFile(logFile, "utf-8");
  const lines = content.split(/\r?\n/).filter((line) => line.trim());

  const resultMap = new Map<string, LogCheckResult>();
  for (const inv of invariants) {
    resultMap.set(inv.name, {
      invariant: inv.name,
      severity: inv.severity,
      violations: [],
      totalChecked: 0,
    });
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineNum = lineIdx + 1;
    let event: unknown;
    try {
      event = JSON.parse(lines[lineIdx]!) as Record<string, unknown>;
    } catch {
      continue;
    }

    for (const inv of invariants) {
      if (!matchesFilter(event, inv.eventFilter)) continue;

      const result = resultMap.get(inv.name)!;
      result.totalChecked++;

      const data = (event as Record<string, unknown>).data;
      if (!evaluateCondition(data, inv.condition)) {
        result.violations.push({ line: lineNum, event });
      }
    }
  }

  return Array.from(resultMap.values());
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2 };

export function formatLogReport(results: LogCheckResult[]): string {
  const sorted = [...results]
    .filter((r) => r.violations.length > 0)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  if (sorted.length === 0) return "No invariant violations found.\n";

  const parts: string[] = [];
  for (const r of sorted) {
    parts.push(`[${r.severity.toUpperCase()}] ${r.invariant}`);
    parts.push(`  Violations: ${r.violations.length} / ${r.totalChecked} checked`);
    for (const v of r.violations) {
      parts.push(`    Line ${v.line}`);
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd() + "\n";
}
