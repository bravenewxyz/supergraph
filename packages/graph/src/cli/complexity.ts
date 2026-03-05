#!/usr/bin/env bun
/**
 * Per-function cyclomatic complexity analysis for a TypeScript package.
 *
 * Complexity  = 1 + count of: if · else-if · for · while · do · switch-case ·
 *               catch · ternary (?:) · logical && · logical || · nullish (??)
 * Nesting     = max depth of nested control blocks (if/for/while/switch/try)
 * LOC         = function body line count
 *
 * Also reports per-file TypeScript escape-hatch density:
 *   any · as-cast · non-null (!.) · @ts-ignore · @ts-expect-error
 *
 * Usage:
 *   bun packages/graph/src/cli/complexity.ts <src-dir> [--out <file>]
 *                                             [--top N] [--min-complexity N]
 */

import { readFile } from "node:fs/promises";
import { join, relative, resolve, basename, dirname } from "node:path";
import * as ts from "typescript";
import { collectTsFiles } from "./utils.js";

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function isBranchNode(node: ts.Node): boolean {
  if (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node)
  )
    return true;
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  )
    return true;
  return false;
}

function isNestingNode(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isConditionalExpression(node)
  );
}

function isFunctionLike(node: ts.Node): node is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** Walk a function body counting branches and max nesting. Does NOT recurse
 *  into nested function literals (they get their own entry). */
function analyzeBody(body: ts.Node): { branches: number; maxNesting: number } {
  let branches = 0;
  let maxNesting = 0;

  function walk(node: ts.Node, depth: number): void {
    if (depth > maxNesting) maxNesting = depth;
    if (isBranchNode(node)) branches++;
    const childDepth = isNestingNode(node) ? depth + 1 : depth;
    ts.forEachChild(node, (child) => {
      if (!isFunctionLike(child)) walk(child, childDepth);
    });
  }

  walk(body, 0);
  return { branches, maxNesting };
}

function getFunctionName(
  node:
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration,
): string {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (
    ts.isMethodDeclaration(node) &&
    (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))
  )
    return node.name.text;

  // Variable declarations: const foo = () => ...
  const p = node.parent;
  if (p) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name))
      return p.name.text;
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
      return p.name.text;
    if (
      ts.isBinaryExpression(p) &&
      ts.isPropertyAccessExpression(p.left)
    )
      return p.left.name.text;
  }
  return "(anonymous)";
}

function isExportedFunction(
  node:
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration,
): boolean {
  const hasExportKw = (n: ts.Node) => {
    const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined;
    return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  };
  if (ts.isFunctionDeclaration(node)) return hasExportKw(node);
  // For arrow / fn expressions: check the parent variable statement
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p)) {
    const list = p.parent;
    if (list && ts.isVariableDeclarationList(list)) {
      const stmt = list.parent;
      if (stmt && ts.isVariableStatement(stmt)) return hasExportKw(stmt);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-function metrics
// ---------------------------------------------------------------------------

interface FnMetrics {
  name: string;
  module: string; // path stripped of src/ prefix
  complexity: number; // 1 + branches
  nesting: number; // max nesting depth
  loc: number; // body line count
  exported: boolean;
  line: number; // start line
}

function analyzeFunctions(sourceFile: ts.SourceFile, module: string): FnMetrics[] {
  const results: FnMetrics[] = [];

  function visit(node: ts.Node): void {
    if (isFunctionLike(node)) {
      const body = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        ? node.body
        : ts.isMethodDeclaration(node)
          ? node.body
          : node.body ?? node; // ArrowFunction with concise body

      if (body) {
        const { branches, maxNesting } = analyzeBody(body);
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        results.push({
          name: getFunctionName(node),
          module,
          complexity: 1 + branches,
          nesting: maxNesting,
          loc: end.line - start.line + 1,
          exported: isExportedFunction(node),
          line: start.line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

// ---------------------------------------------------------------------------
// Per-file escape-hatch metrics
// ---------------------------------------------------------------------------

interface SafetyMetrics {
  module: string;
  any: number; // `any` type annotations
  casts: number; // `as X` that aren't `as const` or `as unknown`
  nonNull: number; // `!.` or `!` non-null assertions
  tsIgnore: number; // @ts-ignore
  tsExpect: number; // ts-expect-error suppressions
  score: number; // weighted total
}

const CAST_RE = /\bas\s+(?!const\b)(?!unknown\b)/g;
const ANY_RE = /:\s*any\b|<any\b/g;
const NON_NULL_RE = /\w![\.\[]/g;
const TS_IGNORE_RE = /@ts-ignore/g;
const TS_EXPECT_RE = /@ts-expect-error/g;

function analyzeEscapeHatches(code: string, module: string): SafetyMetrics {
  const anyCount = (code.match(ANY_RE) ?? []).length;
  const castCount = (code.match(CAST_RE) ?? []).length;
  const nonNullCount = (code.match(NON_NULL_RE) ?? []).length;
  const ignoreCount = (code.match(TS_IGNORE_RE) ?? []).length;
  const expectCount = (code.match(TS_EXPECT_RE) ?? []).length;
  return {
    module,
    any: anyCount,
    casts: castCount,
    nonNull: nonNullCount,
    tsIgnore: ignoreCount,
    tsExpect: expectCount,
    // weights: ignore/expect are high-risk (suppress errors), casts medium, any low
    score: anyCount + castCount * 2 + nonNullCount + ignoreCount * 3 + expectCount * 3,
  };
}

// ---------------------------------------------------------------------------
// Structural impedance detectors
// (pure adapters, data clumps, type overlaps)
// ---------------------------------------------------------------------------

const MIN_FIELDS_ADAPTER = 4;
const SCORE_HIGH = 0.70;
const SCORE_MEDIUM = 0.50;
const MIN_CLUMP_FIELDS = 3;
const MIN_FIELDS_TYPE = 4;
const JACCARD_THRESHOLD = 0.70;

interface PureAdapterFinding {
  module: string;
  functionName: string;
  line: number;
  totalFields: number;
  directFields: number;
  dominantSource: string;
  dominantSourceCount: number;
  score: number;
  confidence: "high" | "medium";
}

interface DataClumpFinding {
  module: string;
  enclosingFunction: string;
  line: number;
  sourceRoot: string;
  fields: string[];
}

interface TypeOverlapFinding {
  typeA: string;
  moduleA: string;
  lineA: number;
  typeB: string;
  moduleB: string;
  lineB: number;
  overlapFields: string[];
  jaccard: number;
  subsetDirection?: "A⊂B" | "B⊂A";
}

function idText(node: ts.Identifier): string {
  return node.text ?? String(node.escapedText ?? "<id>");
}

function nodeText(node: ts.PropertyName | ts.BindingName | ts.MemberName): string {
  if (ts.isIdentifier(node)) return idText(node as ts.Identifier);
  if ("text" in node) return (node as { text: string }).text;
  return "<computed>";
}

function classifyPropValue(node: ts.Expression): { kind: "access" | "call" | "computed"; root: string } {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    let cur: ts.Expression = node;
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    }
    return { kind: "access", root: ts.isIdentifier(cur) ? idText(cur as ts.Identifier) : "<expr>" };
  }
  if (ts.isIdentifier(node)) return { kind: "access", root: idText(node as ts.Identifier) };
  if (ts.isCallExpression(node)) return { kind: "call", root: "<call>" };
  return { kind: "computed", root: "<computed>" };
}

function propAccessRoot(node: ts.Expression): { path: string } | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const parts: string[] = [];
  let cur: ts.Expression = node;
  while (ts.isPropertyAccessExpression(cur)) {
    parts.unshift(cur.name.text ?? String(cur.name.escapedText ?? ""));
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur)) return undefined;
  parts.unshift(idText(cur as ts.Identifier));
  const path = parts.length >= 2 ? parts.slice(0, 2).join(".") : parts[0]!;
  return { path };
}

function enclosingName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if ((ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) && cur.name && ts.isIdentifier(cur.name)) {
      return idText(cur.name as ts.Identifier);
    }
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return idText(cur.name as ts.Identifier);
    if (ts.isMethodDeclaration(cur) && cur.name) return nodeText(cur.name as ts.PropertyName);
    cur = cur.parent;
  }
  return "<anonymous>";
}

function collectTypeMembers(members: ts.NodeArray<ts.TypeElement>): Set<string> {
  const fields = new Set<string>();
  for (const m of members) {
    if ((ts.isPropertySignature(m) || ts.isMethodSignature(m)) && m.name) {
      fields.add(nodeText(m.name as ts.PropertyName));
    }
  }
  return fields;
}

function detectAdaptersInFile(sf: ts.SourceFile, module: string): PureAdapterFinding[] {
  const findings: PureAdapterFinding[] = [];

  function visit(node: ts.Node, currentSf: ts.SourceFile): void {
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      checkFn(node as ts.FunctionLikeDeclaration, currentSf);
    }
    ts.forEachChild(node, child => visit(child, currentSf));
  }

  function checkFn(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): void {
    const body = fn.body;
    if (!body) return;

    let lit: ts.ObjectLiteralExpression | undefined;
    if (ts.isBlock(body)) {
      const stmts = body.statements.filter(s => !ts.isEmptyStatement(s));
      if (stmts.length === 1 && ts.isReturnStatement(stmts[0]!)) {
        const ret = stmts[0] as ts.ReturnStatement;
        if (ret.expression && ts.isObjectLiteralExpression(ret.expression)) lit = ret.expression;
      }
    } else if (ts.isObjectLiteralExpression(body)) {
      lit = body;
    }

    if (!lit) return;
    const props = lit.properties.filter(ts.isPropertyAssignment);
    if (props.length < MIN_FIELDS_ADAPTER) return;

    const rootCounts = new Map<string, number>();
    let directCount = 0;
    for (const p of props) {
      const c = classifyPropValue(p.initializer);
      if (c.kind === "access") {
        directCount++;
        rootCounts.set(c.root, (rootCounts.get(c.root) ?? 0) + 1);
      }
    }

    const score = directCount / props.length;
    if (score < SCORE_MEDIUM) return;

    let domSource = "<mixed>", domCount = 0;
    for (const [r, n] of rootCounts) { if (n > domCount) { domCount = n; domSource = r; } }

    let fnName = "<anonymous>";
    if (fn.name && ts.isIdentifier(fn.name)) fnName = idText(fn.name as ts.Identifier);
    else {
      const p = fn.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) fnName = idText(p.name as ts.Identifier);
    }

    findings.push({
      module,
      functionName: fnName,
      line: sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1,
      totalFields: props.length,
      directFields: directCount,
      dominantSource: domSource,
      dominantSourceCount: domCount,
      score,
      confidence: score >= SCORE_HIGH ? "high" : "medium",
    });
  }

  visit(sf, sf);
  return findings;
}

function detectClumpsInFile(sf: ts.SourceFile, module: string): DataClumpFinding[] {
  const findings: DataClumpFinding[] = [];
  const seen = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const groups = new Map<string, string[]>();
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const ar = propAccessRoot(prop.initializer);
        if (!ar) continue;
        const field = ts.isIdentifier(prop.name) ? idText(prop.name as ts.Identifier) : nodeText(prop.name as ts.PropertyName);
        if (!groups.has(ar.path)) groups.set(ar.path, []);
        groups.get(ar.path)!.push(field);
      }
      for (const [path, fields] of groups) {
        if (fields.length < MIN_CLUMP_FIELDS) continue;
        const fn = enclosingName(node);
        const key = `${module}|${fn}|${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          module,
          enclosingFunction: fn,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          sourceRoot: path,
          fields,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return findings;
}

interface TypeRecord { name: string; module: string; line: number; fields: Set<string> }

function collectTypesInFile(sf: ts.SourceFile, module: string): TypeRecord[] {
  const records: TypeRecord[] = [];
  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node)) {
      const f = collectTypeMembers(node.members);
      if (f.size >= MIN_FIELDS_TYPE) {
        records.push({ name: node.name.text, module, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, fields: f });
      }
    } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      const f = collectTypeMembers(node.type.members);
      if (f.size >= MIN_FIELDS_TYPE) {
        records.push({ name: node.name.text, module, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, fields: f });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return records;
}

function computeTypeOverlaps(types: TypeRecord[]): TypeOverlapFinding[] {
  const findings: TypeOverlapFinding[] = [];
  for (let i = 0; i < types.length; i++) {
    for (let j = i + 1; j < types.length; j++) {
      const a = types[i]!, b = types[j]!;
      if (a.name === b.name) continue;
      const intersection = [...a.fields].filter(f => b.fields.has(f));
      if (intersection.length < MIN_FIELDS_TYPE) continue;
      const jaccard = intersection.length / new Set([...a.fields, ...b.fields]).size;
      if (jaccard < JACCARD_THRESHOLD) continue;
      const aSubB = [...a.fields].every(f => b.fields.has(f));
      const bSubA = [...b.fields].every(f => a.fields.has(f));
      findings.push({
        typeA: a.name, moduleA: a.module, lineA: a.line,
        typeB: b.name, moduleB: b.module, lineB: b.line,
        overlapFields: intersection, jaccard,
        subsetDirection: aSubB ? "A⊂B" : bSubA ? "B⊂A" : undefined,
      });
    }
  }
  return findings.sort((a, b) => b.jaccard - a.jaccard);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function col(s: string | number, w: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(w) : str.padEnd(w);
}

function renderText(
  pkg: string,
  functions: FnMetrics[],
  safety: SafetyMetrics[],
  topN: number,
  minComplexity: number,
  adapters: PureAdapterFinding[],
  clumps: DataClumpFinding[],
  overlaps: TypeOverlapFinding[],
): string {
  const lines: string[] = [];
  const totalFiles = new Set(functions.map((f) => f.module)).size;

  lines.push(`# ${pkg} — Complexity & Type-Safety`);
  lines.push(`${totalFiles} files | ${functions.length} functions analyzed`);
  lines.push("");

  // --- Complexity hotspots ---
  const hot = functions
    .filter((f) => f.complexity >= minComplexity)
    .sort((a, b) => b.complexity - a.complexity || b.nesting - a.nesting)
    .slice(0, topN);

  lines.push("## Complexity Hotspots");
  lines.push(`(cyclomatic ≥ ${minComplexity}, top ${topN} by complexity)`);
  lines.push("");
  if (hot.length === 0) {
    lines.push(`  none above threshold`);
  } else {
    lines.push(
      `  ${col("complexity", 11, true)}  ${col("nesting", 7, true)}  ${col("loc", 5, true)}  ${col("function", 36)}  module`,
    );
    for (const f of hot) {
      const name = f.name.length > 34 ? f.name.slice(0, 33) + "…" : f.name;
      lines.push(
        `  ${col(f.complexity, 11, true)}  ${col(f.nesting, 7, true)}  ${col(f.loc, 5, true)}  ${col(name + (f.exported ? "" : " (unexp)"), 36)}  ${f.module}:${f.line}`,
      );
    }
  }
  lines.push("");

  // --- Nesting hotspots (depth ≥ 4, not already in top complexity) ---
  const hotNesting = functions
    .filter((f) => f.nesting >= 4)
    .sort((a, b) => b.nesting - a.nesting || b.complexity - a.complexity)
    .slice(0, topN);

  lines.push("## Nesting Hotspots");
  lines.push("(max nesting depth ≥ 4)");
  lines.push("");
  if (hotNesting.length === 0) {
    lines.push("  none above threshold");
  } else {
    lines.push(
      `  ${col("nesting", 7, true)}  ${col("complexity", 11, true)}  ${col("loc", 5, true)}  ${col("function", 36)}  module`,
    );
    for (const f of hotNesting) {
      const name = f.name.length > 34 ? f.name.slice(0, 33) + "…" : f.name;
      lines.push(
        `  ${col(f.nesting, 7, true)}  ${col(f.complexity, 11, true)}  ${col(f.loc, 5, true)}  ${col(name, 36)}  ${f.module}:${f.line}`,
      );
    }
  }
  lines.push("");

  // --- Type-safety surface ---
  const unsafeMods = safety
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  lines.push("## Type-Safety Surface");
  lines.push("(escape hatches: any · as-cast · non-null · @ts-ignore · @ts-expect-error)");
  lines.push("(score = any×1 + cast×2 + non-null×1 + ignore×3 + expect×3)");
  lines.push("");
  if (unsafeMods.length === 0) {
    lines.push("  no escape hatches found");
  } else {
    lines.push(
      `  ${col("score", 5, true)}  ${col("any", 3, true)}  ${col("casts", 5, true)}  ${col("!.", 2, true)}  ${col("ignore", 6, true)}  ${col("expect", 6, true)}  module`,
    );
    for (const s of unsafeMods) {
      lines.push(
        `  ${col(s.score, 5, true)}  ${col(s.any, 3, true)}  ${col(s.casts, 5, true)}  ${col(s.nonNull, 2, true)}  ${col(s.tsIgnore, 6, true)}  ${col(s.tsExpect, 6, true)}  ${s.module}`,
      );
    }
  }

  // --- Structural impedance ---
  if (adapters.length > 0 || clumps.length > 0 || overlaps.length > 0) {
    lines.push("");
    lines.push("## Structural Impedance");
    lines.push("(pure adapters · data clumps · type overlaps — indicate type misalignment, not control-flow complexity)");

    if (adapters.length > 0) {
      lines.push("");
      lines.push("### Pure Adapters");
      lines.push("(function bodies ≥50% direct field mapping — exist only to bridge mismatched types)");
      lines.push("");
      for (const f of adapters) {
        const pct = Math.round(f.score * 100);
        lines.push(`  PURE-ADAPTER [${f.confidence.toUpperCase()}]  ${f.functionName}  ${f.module}:${f.line}`);
        lines.push(`    fields=${f.totalFields} direct=${f.directFields} (${pct}%)  dominant-source=${f.dominantSource} (${f.dominantSourceCount}/${f.directFields})`);
      }
    }

    if (clumps.length > 0) {
      lines.push("");
      lines.push("### Data Clumps");
      lines.push("(≥3 fields extracted from the same source object — destination type should accept the source directly)");
      lines.push("");
      for (const f of clumps) {
        const fieldList = f.fields.slice(0, 6).join(", ") + (f.fields.length > 6 ? `, …(${f.fields.length})` : "");
        lines.push(`  DATA-CLUMP  ${f.enclosingFunction}  ${f.module}:${f.line}`);
        lines.push(`    source=${f.sourceRoot}  fields=${fieldList}`);
      }
    }

    if (overlaps.length > 0) {
      lines.push("");
      lines.push("### Type Overlaps");
      lines.push("(interface/type pairs with Jaccard field-name similarity ≥70% — likely redundant)");
      lines.push("");
      for (const f of overlaps) {
        const jPct = Math.round(f.jaccard * 100);
        const sub = f.subsetDirection ? ` ${f.subsetDirection}` : "";
        const fieldList = f.overlapFields.slice(0, 5).join(", ") + (f.overlapFields.length > 5 ? `, …` : "");
        lines.push(`  TYPE-OVERLAP [${jPct}%${sub}]  ${f.typeA} ↔ ${f.typeB}`);
        lines.push(`    ${f.moduleA}:${f.lineA} ↔ ${f.moduleB}:${f.lineB}`);
        lines.push(`    overlap: ${fieldList} (${f.overlapFields.length} fields)`);
      }
    }

    lines.push("");
    lines.push(
      `  Total: ${adapters.length} pure adapter${adapters.length !== 1 ? "s" : ""}, ${clumps.length} data clump${clumps.length !== 1 ? "s" : ""}, ${overlaps.length} type overlap${overlaps.length !== 1 ? "s" : ""}`,
    );
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export interface ComplexityOptions {
  srcRoot: string;
  outPath?: string;
  topN?: number;
  minComplexity?: number;
}

export async function runComplexity(opts: ComplexityOptions): Promise<string> {
  const srcRoot = opts.srcRoot;
  const outPath = opts.outPath;
  const topN = opts.topN ?? 30;
  const minComplexity = opts.minComplexity ?? 5;

  const pkgRoot = resolve(srcRoot, "..");
  let packageName = basename(pkgRoot);
  try {
    const pkgJson = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf-8"));
    packageName = pkgJson.name ?? packageName;
  } catch {
    /* use dir name */
  }

  const files = await collectTsFiles(srcRoot);
  const allFunctions: FnMetrics[] = [];
  const allSafety: SafetyMetrics[] = [];
  const allAdapters: PureAdapterFinding[] = [];
  const allClumps: DataClumpFinding[] = [];
  const allTypeRecords: TypeRecord[] = [];

  await Promise.all(
    files.map(async (filePath) => {
      const code = await readFile(filePath, "utf-8");
      const relPath = relative(srcRoot, filePath).replace(/\.(ts|tsx)$/, "");
      const module = relPath.replace(/^src\//, "");

      // Parse and analyze functions
      const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
      allFunctions.push(...analyzeFunctions(sf, module));

      // Escape-hatch density (regex-based, no AST needed)
      const safety = analyzeEscapeHatches(code, module);
      if (safety.score > 0) allSafety.push(safety);

      // Structural impedance
      allAdapters.push(...detectAdaptersInFile(sf, module));
      allClumps.push(...detectClumpsInFile(sf, module));
      allTypeRecords.push(...collectTypesInFile(sf, module));
    }),
  );

  const allOverlaps = computeTypeOverlaps(allTypeRecords);

  const output = renderText(packageName, allFunctions, allSafety, topN, minComplexity, allAdapters, allClumps, allOverlaps);

  if (outPath) {
    await Bun.write(outPath, output);
    console.error(
      `Output written to ${outPath} (${(output.length / 1024).toFixed(0)} KB)`,
    );
  }

  return output;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || args[0] === "--help" || args[0] === "-h") {
    console.error(
      "Usage: bun packages/graph/src/cli/complexity.ts <src-dir> [--out <file>] [--top N] [--min-complexity N]",
    );
    process.exit(1);
  }

  const srcRoot = resolve(args[0]!);
  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;
  const topIdx = args.indexOf("--top");
  const topN = topIdx !== -1 && args[topIdx + 1] ? parseInt(args[topIdx + 1]!, 10) : 30;
  const minIdx = args.indexOf("--min-complexity");
  const minComplexity = minIdx !== -1 && args[minIdx + 1] ? parseInt(args[minIdx + 1]!, 10) : 5;

  const output = await runComplexity({ srcRoot, outPath, topN, minComplexity });
  if (!outPath) process.stdout.write(output);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
