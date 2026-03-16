// ── 5. Decision table scan ──────────────────────────────────────────

import ts from "typescript";
import { relative } from "node:path";
import { STATUS_VALUES } from "../util.js";
import type { StatusFunction, DecisionRow, DecisionTable, SuspiciousCell } from "./types.js";

export const FAILURE_NAME_RE = /exit.?code|error|fail|broke|empty|zero|timeout|abort/i;
export const SUCCESS_OUTCOMES = new Set(["complete", "completed", "success", "ok", "merged"]);

export function scanDecisionTables(
  program: ts.Program,
  nonTestFiles: string[],
  resolvedDir: string,
  statusFunctions: StatusFunction[],
): DecisionTable[] {
  const targets = statusFunctions.filter(fn => fn.branchCount >= 3);
  if (targets.length === 0) return [];

  const tables: DecisionTable[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!nonTestFiles.includes(sourceFile.fileName)) continue;
    const relPath = relative(resolvedDir, sourceFile.fileName);
    const targetFns = targets.filter(t => t.filePath === relPath);
    if (targetFns.length === 0) continue;

    ts.forEachChild(sourceFile, (node) => {
      const fnName = extractFnName(node);
      if (!fnName || !targetFns.some(t => t.name === fnName)) return;

      const table = buildDecisionTable(node, fnName, sourceFile, relPath);
      if (table && table.rows.length > 0) tables.push(table);
    });
  }

  return tables;
}

export function extractFnName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      let init = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return decl.name.text;
    }
  }
  return undefined;
}

export function normWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function abbreviateCond(text: string, varDefs: Map<string, string>): string {
  const trimmed = normWs(text);
  const expanded = varDefs.get(trimmed);
  if (expanded) return trimmed;
  if (trimmed.length > 60) return trimmed.slice(0, 57) + "...";
  return trimmed;
}

export function buildDecisionTable(
  node: ts.Node,
  functionName: string,
  sourceFile: ts.SourceFile,
  filePath: string,
): DecisionTable | null {
  const fnLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const varDefs = new Map<string, string>();
  collectDefs(node, sourceFile, varDefs);

  const rows: DecisionRow[] = [];

  walk(node, [], sourceFile, varDefs, rows);
  if (rows.length === 0) return null;

  const allSignals = new Set<string>();
  for (const row of rows) {
    for (const cond of Object.keys(row.conditions)) allSignals.add(cond);
  }

  const definitions: Record<string, string> = {};
  for (const signal of allSignals) {
    const def = varDefs.get(signal);
    if (def) definitions[signal] = def;
  }

  const paramNames = extractParamNames(node, sourceFile);
  const suspiciousCells = detectSuspiciousCells(rows, varDefs, allSignals, paramNames);

  return {
    functionName,
    filePath,
    line: fnLine,
    signals: [...allSignals],
    definitions,
    rows,
    suspiciousCells,
  };
}

export function collectDefs(n: ts.Node, sourceFile: ts.SourceFile, varDefs: Map<string, string>): void {
  if (ts.isVariableDeclaration(n) && n.initializer) {
    if (ts.isIdentifier(n.name)) {
      varDefs.set(n.name.text, normWs(n.initializer.getText(sourceFile)));
    } else if (ts.isObjectBindingPattern(n.name)) {
      // const { exitCode, errors } = params  →  exitCode = "params"
      const initText = normWs(n.initializer.getText(sourceFile));
      for (const el of n.name.elements) {
        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
          varDefs.set(el.name.text, initText);
        }
      }
    }
  }
  ts.forEachChild(n, child => collectDefs(child, sourceFile, varDefs));
}

export function walk(
  n: ts.Node,
  condPath: Array<{ cond: string; branch: "T" | "F" }>,
  sourceFile: ts.SourceFile,
  varDefs: Map<string, string>,
  rows: DecisionRow[],
): void {
  if (ts.isConditionalExpression(n)) {
    const condText = abbreviateCond(n.condition.getText(sourceFile), varDefs);
    walk(n.whenTrue, [...condPath, { cond: condText, branch: "T" }], sourceFile, varDefs, rows);
    walk(n.whenFalse, [...condPath, { cond: condText, branch: "F" }], sourceFile, varDefs, rows);
    return;
  }

  if (ts.isIfStatement(n)) {
    const condText = abbreviateCond(n.expression.getText(sourceFile), varDefs);
    walk(n.thenStatement, [...condPath, { cond: condText, branch: "T" }], sourceFile, varDefs, rows);
    if (n.elseStatement) {
      walk(n.elseStatement, [...condPath, { cond: condText, branch: "F" }], sourceFile, varDefs, rows);
    }
    return;
  }

  if (ts.isStringLiteral(n) && STATUS_VALUES.test(n.text) && n.text.length < 30) {
    if (condPath.length > 0 || isStatusAssignment(n)) {
      const conditions: Record<string, string> = {};
      for (const { cond, branch } of condPath) conditions[cond] = branch;
      const line = sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1;
      rows.push({ conditions, outcome: n.text, line });
    }
  }

  ts.forEachChild(n, child => walk(child, condPath, sourceFile, varDefs, rows));
}

export function isStatusAssignment(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  return ts.isPropertyAssignment(p) || ts.isReturnStatement(p) ||
    ts.isVariableDeclaration(p) || ts.isBinaryExpression(p);
}

export function collectLeafFailureSignals(varDefs: Map<string, string>): Set<string> {
  const leafSignals = new Set<string>();
  for (const [name, def] of varDefs) {
    const identifiers = def.match(/\b[a-zA-Z_]\w*\b/g) ?? [];
    for (const id of identifiers) {
      if (FAILURE_NAME_RE.test(id)) leafSignals.add(id);
    }
    if (FAILURE_NAME_RE.test(name)) leafSignals.add(name);
  }
  return leafSignals;
}

// ── Gap consequence automation helpers ──────────────────────────────

/** Extract parameter names from a function declaration or arrow/function-expression variable. */
export function extractParamNames(node: ts.Node, sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  let params: ts.NodeArray<ts.ParameterDeclaration> | undefined;

  if (ts.isFunctionDeclaration(node) && node.parameters) {
    params = node.parameters;
  } else if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (!decl.initializer) continue;
      let init = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.parameters) {
        params = init.parameters;
        break;
      }
    }
  }

  if (!params) return names;

  for (const param of params) {
    if (ts.isIdentifier(param.name)) {
      names.add(param.name.getText(sourceFile));
    } else if (ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
          names.add(el.name.getText(sourceFile));
        }
      }
    }
  }

  return names;
}

export const LEAF_SKIP = new Set(["null", "undefined", "true", "false", "NaN", "Infinity", "typeof", "instanceof", "void"]);

/**
 * Recursively expand a variable reference or expression through varDefs to find the
 * primitive leaf identifier tokens (those without a varDef entry).
 */
export function expandToLeafTokens(
  expr: string,
  varDefs: Map<string, string>,
  depth = 0,
  visited = new Set<string>(),
): string[] {
  const trimmed = expr.trim();
  if (depth > 5 || visited.has(trimmed)) return [];
  visited.add(trimmed);

  // Simple identifier that has a definition → expand it (only its failure parts if compound)
  if (/^\w+$/.test(trimmed)) {
    const def = varDefs.get(trimmed);
    if (def) {
      // Only recurse into failure-signal parts of AND-gated definitions to stay on the failure path
      const andParts = def.split(/\s*&&\s*/).map(s => s.trim()).filter(Boolean);
      const failParts = andParts.filter(p => FAILURE_NAME_RE.test(p));
      const partsToExpand = failParts.length > 0 ? failParts : andParts;
      return partsToExpand.flatMap(p => expandToLeafTokens(p, varDefs, depth + 1, new Set(visited)));
    }
  }

  // Not a simple identifier (or no def) → extract identifier tokens, then expand each through varDefs
  // This lets us trace "exitCode != null" → token "exitCode" → varDef "params" → paramNames
  const tokens = (trimmed.match(/\b[a-zA-Z_]\w*\b/g) ?? []).filter(t => !LEAF_SKIP.has(t));
  return tokens.flatMap(t =>
    varDefs.has(t)
      ? expandToLeafTokens(t, varDefs, depth + 1, new Set(visited))
      : [t],
  );
}

/**
 * Same as expandToLeafTokens but also returns the original surface token alongside its resolved leaf,
 * so we can say "exitCode (via params)" in the reachability note.
 */
export function expandToLeafTokensWithOrigin(
  expr: string,
  varDefs: Map<string, string>,
): Array<{ origin: string; leaf: string }> {
  const tokens = (expr.match(/\b[a-zA-Z_]\w*\b/g) ?? []).filter(t => !LEAF_SKIP.has(t));
  const result: Array<{ origin: string; leaf: string }> = [];
  for (const t of tokens) {
    const leaves = expandToLeafTokens(t, varDefs);
    for (const leaf of leaves) {
      result.push({ origin: t, leaf });
    }
  }
  return result;
}

/**
 * Find which leaf variables in the failure sub-expression trace back to function parameters.
 * Returns `{ origin, param }` pairs — origin is the surface variable (e.g. "exitCode"),
 * param is the parameter it expands to (e.g. "params"). The gap is unconditionally reachable
 * if any such pair is found, since the caller controls the param's value.
 */
export function findParamLeaves(
  failParts: string[],
  varDefs: Map<string, string>,
  paramNames: Set<string>,
): Array<{ origin: string; param: string }> {
  const pairs = failParts.flatMap(p => expandToLeafTokensWithOrigin(p, varDefs));
  const seen = new Set<string>();
  const result: Array<{ origin: string; param: string }> = [];
  for (const { origin, leaf } of pairs) {
    if (!paramNames.has(leaf)) continue;
    const key = `${origin}:${leaf}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ origin, param: leaf });
  }
  return result;
}

/**
 * Find what outcomes occur in rows where condName=T (the "when the gate is true" contrast).
 */
export function findContrastOutcomes(rows: DecisionRow[], condName: string): string[] {
  const outcomes = rows
    .filter(r => r.conditions[condName] === "T")
    .map(r => r.outcome);
  return [...new Set(outcomes)];
}

/**
 * Build the full automated gap analysis for an AND-gated suspicious cell.
 *
 * signal   — the AND-gated variable name (e.g. "buildBrokeScope")
 * condName — the row-level condition that is false in the success row; may equal signal
 *            (Case 1: direct AND-gate) or be an OR-variable containing signal (Case 2)
 */
export function buildGapAnalysis(opts: {
  signal: string;
  condName: string;
  outcome: string;
  varDefs: Map<string, string>;
  paramNames: Set<string>;
  rows: DecisionRow[];
}): Pick<SuspiciousCell, "gapScenario" | "reachabilityNote" | "contrastNote" | "verdictNote"> {
  const { signal, condName, outcome, varDefs, paramNames, rows } = opts;

  const signalDef = varDefs.get(signal) ?? "";
  const andParts = signalDef.split(/\s*&&\s*/).map(s => s.trim()).filter(Boolean);
  const failParts = andParts.filter(p => FAILURE_NAME_RE.test(p));
  const gateParts = andParts.filter(p => !FAILURE_NAME_RE.test(p));
  const failExpr = failParts.length > 0 ? failParts.join(" && ") : signal;

  // 1. Gap scenario
  const gapScenario =
    gateParts.length > 0
      ? `Gap: [${failExpr}=true] AND [${gateParts.join(" && ")}=false] → ${signal}=false → outcome="${outcome}"`
      : undefined;

  // 2. Reachability — do failure leaf variables trace to function parameters?
  const sourceLeaves = failParts.length > 0 ? failParts : andParts;
  const paramLeaves = findParamLeaves(sourceLeaves, varDefs, paramNames);
  let reachabilityNote: string | undefined;
  if (paramLeaves.length > 0) {
    const parts = paramLeaves.map(({ origin, param }) =>
      origin === param ? origin : `${origin} (via param "${param}")`,
    );
    const plural = parts.length > 1;
    reachabilityNote = `REACHABLE: ${parts.join(", ")} ${plural ? "are" : "is"} caller-controlled — gap is unconditionally reachable`;
  }

  // 3. Contrast — when condName=T, what outcomes appear?
  const contrastOutcomes = findContrastOutcomes(rows, condName);
  const failureContrasts = contrastOutcomes.filter(o => !SUCCESS_OUTCOMES.has(o));
  let contrastNote: string | undefined;
  if (failureContrasts.length > 0 && gateParts.length > 0) {
    const gateStr = gateParts.join(" && ");
    const contrastOutcome = failureContrasts[0];
    contrastNote =
      condName === signal
        ? `CONTRAST: when [${gateStr}]=true → ${signal}=T → outcome="${contrastOutcome}" (gate is sole differentiator)`
        : `CONTRAST: when [${gateStr}]=true → ${signal}=T → ${condName}=T → outcome="${contrastOutcome}" (gate is sole differentiator)`;
  }

  // 4. Verdict — synthesise reachability + contrast
  let verdictNote: string | undefined;
  if (gapScenario && reachabilityNote && contrastNote) {
    const leafStr = paramLeaves[0]?.origin ?? failExpr;
    const gateStr = gateParts.length > 0 ? gateParts.join(" && ") : "gate condition";
    const isSuccess = outcome === "complete" || outcome === "success";
    verdictNote = `VERDICT: ${leafStr} failure silently produces status="${outcome}" when [${gateStr}] is false — ${isSuccess ? "failure passes as success" : `outcome is "${outcome}"`}`;
  } else if (gapScenario && !reachabilityNote) {
    verdictNote = `VERDICT (unconfirmed): trace whether [${failExpr}] can be true independently of [${gateParts.join(" && ")}]`;
  }

  return { gapScenario, reachabilityNote, contrastNote, verdictNote };
}

export function findAndGatedFailureSignals(varDefs: Map<string, string>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [name, def] of varDefs) {
    const andParts = def.split(/\s*&&\s*/);
    if (andParts.length < 2) continue;
    const failParts = andParts.filter(p => FAILURE_NAME_RE.test(p));
    const nonFailParts = andParts.filter(p => !FAILURE_NAME_RE.test(p));
    if (failParts.length > 0 && nonFailParts.length > 0) {
      result.set(name, nonFailParts);
    }
  }
  return result;
}

export function detectSuspiciousCells(
  rows: DecisionRow[],
  varDefs: Map<string, string>,
  _allSignals: Set<string>,
  paramNames: Set<string>,
): SuspiciousCell[] {
  const suspicious: SuspiciousCell[] = [];
  const andGated = findAndGatedFailureSignals(varDefs);

  for (const row of rows) {
    if (!SUCCESS_OUTCOMES.has(row.outcome)) continue;

    for (const [condName, condBranch] of Object.entries(row.conditions)) {
      if (condBranch !== "F") continue;

      if (andGated.has(condName)) {
        // Case 1: the row-level condition itself is AND-gated (e.g. buildBrokeScope=F → complete)
        const suppressors = andGated.get(condName)!;
        const reason = `${condName}=F→${row.outcome}: AND-gated by ${suppressors.join(", ")} — failure may not propagate`;
        const analysis = buildGapAnalysis({ signal: condName, condName, outcome: row.outcome, varDefs, paramNames, rows });
        suspicious.push({ signal: condName, outcome: row.outcome, line: row.line, reason, ...analysis });
        continue;
      }

      const condDef = varDefs.get(condName);
      if (!condDef || !condDef.includes("||")) continue;

      // Case 2: the row-level condition is an OR of terms; one of those OR-terms is AND-gated
      // (e.g. hardFailed = isEmptyResponse || isZeroDiff || buildBrokeScope, hardFailed=F → complete)
      const orTerms = condDef.split(/\s*\|\|\s*/);
      for (const term of orTerms) {
        const trimmed = term.trim();
        if (andGated.has(trimmed)) {
          const reason = `${trimmed} AND-gated, negated via ${condName}=F (OR) → failure may not propagate`;
          const analysis = buildGapAnalysis({ signal: trimmed, condName, outcome: row.outcome, varDefs, paramNames, rows });
          suspicious.push({ signal: trimmed, outcome: row.outcome, line: row.line, reason, ...analysis });
        }
      }
    }
  }

  return suspicious;
}
