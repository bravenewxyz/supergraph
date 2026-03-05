#!/usr/bin/env bun
/**
 * Structural impedance analysis — detect accidental complexity from type misalignment.
 *
 * Three detections:
 *   1. PURE-ADAPTER  — function whose body is ≥70% direct field mapping, no real computation
 *   2. DATA-CLUMP    — object literal with ≥3 fields extracted from the same source object
 *   3. TYPE-OVERLAP  — interface/type pairs with Jaccard field-name similarity ≥0.70
 *
 * Usage:
 *   bun packages/flow/src/cli/complexity-audit.ts <src-dir> [--format text|json] [--out <file>]
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { collectSourceFiles, createProgram } from "../extractor/typescript.js";
import { getArg, shortPath } from "./util.js";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PureAdapterFinding {
  filePath: string;
  functionName: string;
  line: number;
  totalFields: number;
  directFields: number;
  computedFields: number;
  dominantSource: string;
  dominantSourceCount: number;
  score: number;
  confidence: "high" | "medium" | "low";
}

interface DataClumpFinding {
  filePath: string;
  enclosingFunction: string;
  line: number;
  sourceRoot: string;
  fields: string[];
  count: number;
}

interface TypeOverlapFinding {
  typeA: string;
  fileA: string;
  lineA: number;
  typeB: string;
  fileB: string;
  lineB: number;
  overlapFields: string[];
  jaccard: number;
  isSubset: boolean;
  subsetDirection?: "A⊂B" | "B⊂A";
}

interface ComplexityAuditResult {
  pureAdapters: PureAdapterFinding[];
  dataClumps: DataClumpFinding[];
  typeOverlaps: TypeOverlapFinding[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function nodeNameText(node: ts.PropertyName | ts.BindingName | ts.Identifier | ts.MemberName): string {
  if (ts.isIdentifier(node)) return node.text;
  if ("text" in node) return (node as { text: string }).text;
  return "<computed>";
}

/** Get the enclosing function name for a node. */
function enclosingFunctionName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) &&
      cur.name
    ) {
      return ts.isIdentifier(cur.name) ? cur.name.text : "<computed>";
    }
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    }
    if (ts.isMethodDeclaration(cur) && cur.name) {
      return nodeNameText(cur.name as ts.PropertyName);
    }
    cur = cur.parent;
  }
  return "<anonymous>";
}

/**
 * Classify a property assignment value:
 *   "access"   — direct property access like `x.y` or `x.y.z` or just `x`
 *   "call"     — simple call expression (no meaningful computation)
 *   "computed" — anything else
 */
function identText(node: ts.Identifier): string {
  // Prefer .text (always available) over .getText() which requires source file attachment
  return node.text ?? node.escapedText?.toString() ?? "<id>";
}

function classifyValue(node: ts.Expression): {
  kind: "access" | "call" | "computed";
  root: string;
} {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    // Walk to the root identifier
    let cur: ts.Expression = node;
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    }
    const root = ts.isIdentifier(cur) ? identText(cur) : "<expr>";
    return { kind: "access", root };
  }
  if (ts.isIdentifier(node)) {
    return { kind: "access", root: identText(node) };
  }
  if (ts.isCallExpression(node)) {
    // Calls are neutral (not heavy computation), but not direct access
    return { kind: "call", root: "<call>" };
  }
  return { kind: "computed", root: "<computed>" };
}

/**
 * Returns the root and second level of a property access for data-clump detection.
 * `d.config.maxWorkers` → root="d", second="config"
 * `config.maxWorkers` → root="config", second="maxWorkers"
 * `d.taskStore` → root="d", second="taskStore"
 */
function accessRoot(node: ts.Expression): { root: string; path: string } | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  // Walk to bottom
  const parts: string[] = [];
  let cur: ts.Expression = node;
  while (ts.isPropertyAccessExpression(cur)) {
    parts.unshift(cur.name.text ?? cur.name.escapedText?.toString() ?? "<name>");
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur)) return undefined;
  const root = identText(cur);
  parts.unshift(root);
  // Prefer "root.second" as the clump key so d.config.X groups on "d.config"
  const path = parts.length >= 2 ? parts.slice(0, 2).join(".") : root;
  return { root, path };
}

// ---------------------------------------------------------------------------
// Detection 1: Pure adapters
// ---------------------------------------------------------------------------

const MIN_FIELDS_ADAPTER = 4; // ignore tiny functions
const SCORE_HIGH = 0.70;
const SCORE_MEDIUM = 0.50;

function detectPureAdapters(
  sourceFiles: ts.SourceFile[],
  srcBase: string,
): PureAdapterFinding[] {
  const findings: PureAdapterFinding[] = [];

  for (const sf of sourceFiles) {
    visitForAdapters(sf, sf);
  }

  function visitForAdapters(node: ts.Node, currentSf: ts.SourceFile): void {
    // We want function declarations, arrow functions, and method declarations
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)
    ) {
      checkFunction(node as ts.FunctionLikeDeclaration, currentSf);
    }
    ts.forEachChild(node, child => visitForAdapters(child, currentSf));
  }

  function checkFunction(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): void {
    const body = fn.body;
    if (!body) return;

    let objectLiteral: ts.ObjectLiteralExpression | undefined;

    if (ts.isBlock(body)) {
      // body: { return { ... } }
      const stmts = body.statements.filter(
        s => !ts.isEmptyStatement(s)
      );
      if (stmts.length === 1 && ts.isReturnStatement(stmts[0]!)) {
        const ret = stmts[0] as ts.ReturnStatement;
        if (ret.expression && ts.isObjectLiteralExpression(ret.expression)) {
          objectLiteral = ret.expression;
        }
      }
      // Also allow functions with a leading variable declaration then return
      if (!objectLiteral && stmts.length === 2) {
        const [first, second] = stmts as [ts.Statement, ts.Statement];
        if (
          ts.isVariableStatement(first) &&
          ts.isReturnStatement(second) &&
          (second as ts.ReturnStatement).expression &&
          ts.isIdentifier((second as ts.ReturnStatement).expression!)
        ) {
          // Check if the variable is an object literal
          const decl = first.declarationList.declarations[0];
          if (decl?.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
            objectLiteral = decl.initializer;
          }
        }
      }
    } else if (ts.isObjectLiteralExpression(body)) {
      objectLiteral = body;
    }

    if (!objectLiteral) return;

    const props = objectLiteral.properties.filter(ts.isPropertyAssignment);
    if (props.length < MIN_FIELDS_ADAPTER) return;

    const rootCounts = new Map<string, number>();
    let directCount = 0;
    let computedCount = 0;

    for (const prop of props) {
      const classified = classifyValue(prop.initializer);
      if (classified.kind === "access") {
        directCount++;
        rootCounts.set(classified.root, (rootCounts.get(classified.root) ?? 0) + 1);
      } else if (classified.kind === "computed") {
        computedCount++;
      }
      // "call" is neutral
    }

    const total = props.length;
    const score = directCount / total;
    if (score < SCORE_MEDIUM) return;

    // Find dominant source
    let dominantSource = "<mixed>";
    let dominantCount = 0;
    for (const [root, count] of rootCounts) {
      if (count > dominantCount) {
        dominantCount = count;
        dominantSource = root;
      }
    }

    const confidence: "high" | "medium" | "low" =
      score >= SCORE_HIGH ? "high" : score >= SCORE_MEDIUM ? "medium" : "low";

    // Get function name
    let functionName = "<anonymous>";
    if (fn.name && ts.isIdentifier(fn.name)) {
      functionName = fn.name.text;
    } else if (fn.name && "text" in fn.name) {
      functionName = (fn.name as { text: string }).text;
    } else {
      // Arrow function assigned to a variable
      const parent = fn.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        functionName = parent.name.text;
      }
    }

    findings.push({
      filePath: shortPath(sf.fileName, srcBase),
      functionName,
      line: lineOf(fn, sf),
      totalFields: total,
      directFields: directCount,
      computedFields: computedCount,
      dominantSource,
      dominantSourceCount: dominantCount,
      score,
      confidence,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detection 2: Data clumps
// ---------------------------------------------------------------------------

const MIN_CLUMP_FIELDS = 3;

function detectDataClumps(
  sourceFiles: ts.SourceFile[],
  srcBase: string,
): DataClumpFinding[] {
  const findings: DataClumpFinding[] = [];
  const seen = new Set<string>(); // deduplicate: file+function+path

  for (const sf of sourceFiles) {
    ts.forEachChild(sf, function visit(node: ts.Node): void {
      if (ts.isObjectLiteralExpression(node)) {
        checkObjectLiteral(node, sf);
      }
      ts.forEachChild(node, visit);
    });
  }

  function checkObjectLiteral(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): void {
    // Group property values by their access path root
    const pathGroups = new Map<string, string[]>();

    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const ar = accessRoot(prop.initializer);
      if (!ar) continue;
      // Use the "path" (e.g. "d.config") as the group key
      const key = ar.path;
      const fieldName = ts.isIdentifier(prop.name) ? prop.name.text : nodeNameText(prop.name as ts.PropertyName);
      if (!pathGroups.has(key)) pathGroups.set(key, []);
      pathGroups.get(key)!.push(fieldName);
    }

    for (const [path, fields] of pathGroups) {
      if (fields.length < MIN_CLUMP_FIELDS) continue;
      const fnName = enclosingFunctionName(obj);
      const key = `${sf.fileName}|${fnName}|${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        filePath: shortPath(sf.fileName, srcBase),
        enclosingFunction: fnName,
        line: lineOf(obj, sf),
        sourceRoot: path,
        fields,
        count: fields.length,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detection 3: Type overlaps
// ---------------------------------------------------------------------------

const MIN_FIELDS_TYPE = 4;
const JACCARD_THRESHOLD = 0.70;

interface TypeRecord {
  name: string;
  filePath: string;
  line: number;
  fields: Set<string>;
}

function collectTypeFields(
  type: ts.InterfaceDeclaration | ts.TypeLiteralNode,
): Set<string> {
  const fields = new Set<string>();
  const members = ts.isInterfaceDeclaration(type) ? type.members : type.members;
  for (const member of members) {
      if (ts.isPropertySignature(member) && member.name) {
        fields.add(nodeNameText(member.name as ts.PropertyName));
      } else if (ts.isMethodSignature(member) && member.name) {
        fields.add(nodeNameText(member.name as ts.PropertyName));
      }
  }
  return fields;
}

function detectTypeOverlaps(
  sourceFiles: ts.SourceFile[],
  srcBase: string,
): TypeOverlapFinding[] {
  const types: TypeRecord[] = [];

  for (const sf of sourceFiles) {
    ts.forEachChild(sf, function visit(node: ts.Node): void {
      if (ts.isInterfaceDeclaration(node)) {
        const fields = collectTypeFields(node);
        if (fields.size >= MIN_FIELDS_TYPE) {
          types.push({
            name: node.name.text,
            filePath: shortPath(sf.fileName, srcBase),
            line: lineOf(node, sf),
            fields,
          });
        }
      } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
        const fields = collectTypeFields(node.type);
        if (fields.size >= MIN_FIELDS_TYPE) {
          types.push({
            name: node.name.text,
            filePath: shortPath(sf.fileName, srcBase),
            line: lineOf(node, sf),
            fields,
          });
        }
      }
      ts.forEachChild(node, visit);
    });
  }

  const findings: TypeOverlapFinding[] = [];

  for (let i = 0; i < types.length; i++) {
    for (let j = i + 1; j < types.length; j++) {
      const a = types[i]!;
      const b = types[j]!;

      // Skip same file same name (e.g. interface extended versions)
      if (a.name === b.name) continue;

      const intersection = [...a.fields].filter(f => b.fields.has(f));
      if (intersection.length < MIN_FIELDS_TYPE) continue;

      const union = new Set([...a.fields, ...b.fields]);
      const jaccard = intersection.length / union.size;

      if (jaccard < JACCARD_THRESHOLD) continue;

      const isASubsetOfB = [...a.fields].every(f => b.fields.has(f));
      const isBSubsetOfA = [...b.fields].every(f => a.fields.has(f));
      const isSubset = isASubsetOfB || isBSubsetOfA;
      const subsetDirection: "A⊂B" | "B⊂A" | undefined = isASubsetOfB
        ? "A⊂B"
        : isBSubsetOfA
        ? "B⊂A"
        : undefined;

      findings.push({
        typeA: a.name,
        fileA: a.filePath,
        lineA: a.line,
        typeB: b.name,
        fileB: b.filePath,
        lineB: b.line,
        overlapFields: intersection,
        jaccard,
        isSubset,
        subsetDirection,
      });
    }
  }

  // Sort by jaccard descending
  findings.sort((a, b) => b.jaccard - a.jaccard);
  return findings;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatText(result: ComplexityAuditResult, _srcBase: string): string {
  const lines: string[] = [];
  const { pureAdapters, dataClumps, typeOverlaps } = result;

  // Estimate wiring cost: sum lines of adapter functions (approx total_fields * 1.5)
  const estimatedLines = pureAdapters.reduce((n, f) => n + Math.round(f.totalFields * 1.5), 0);

  lines.push(
    `## Complexity Audit (${pureAdapters.length} pure adapters, ${dataClumps.length} data clumps, ${typeOverlaps.length} type overlaps)`,
  );
  lines.push("");

  if (pureAdapters.length > 0) {
    lines.push("### Pure Adapters");
    lines.push("Functions whose bodies are ≥50% direct field mapping — likely exist only to bridge mismatched types.");
    lines.push("");
    for (const f of pureAdapters) {
      const pct = Math.round(f.score * 100);
      lines.push(
        `PURE-ADAPTER  ${f.filePath}:${f.functionName} [${f.confidence.toUpperCase()}]`,
      );
      lines.push(
        `  fields=${f.totalFields} direct=${f.directFields} computed=${f.computedFields}  direct-access=${pct}%  dominant-source=${f.dominantSource} (${f.dominantSourceCount}/${f.directFields} direct fields)`,
      );
      lines.push(
        `  suggestion: the consumer type for '${f.dominantSource}' should accept the upstream type directly`,
      );
      lines.push("");
    }
  }

  if (dataClumps.length > 0) {
    lines.push("### Data Clumps");
    lines.push("Object literals where ≥3 fields are extracted from the same source — the destination type should accept the source directly.");
    lines.push("");
    for (const f of dataClumps) {
      const fieldList = f.fields.slice(0, 6).join(", ") + (f.fields.length > 6 ? `, ... (${f.fields.length} total)` : "");
      lines.push(
        `DATA-CLUMP  ${f.filePath}:${f.enclosingFunction} L${f.line}`,
      );
      lines.push(`  source=${f.sourceRoot}  fields=${fieldList}`);
      lines.push(
        `  suggestion: destination type should accept '${f.sourceRoot.split(".")[0]}' type directly`,
      );
      lines.push("");
    }
  }

  if (typeOverlaps.length > 0) {
    lines.push("### Type Overlaps");
    lines.push("Interface/type pairs with Jaccard field similarity ≥0.70 — likely redundant private views of the same concept.");
    lines.push("");
    for (const f of typeOverlaps) {
      const jPct = Math.round(f.jaccard * 100);
      const subsetLabel = f.subsetDirection ? ` ${f.subsetDirection}` : "";
      const fieldList = f.overlapFields.slice(0, 6).join(", ") + (f.overlapFields.length > 6 ? `, ...` : "");
      lines.push(
        `TYPE-OVERLAP  ${f.typeA} ↔ ${f.typeB} [Jaccard=${jPct}%${subsetLabel}]`,
      );
      lines.push(`  ${f.fileA}:${f.lineA} ↔ ${f.fileB}:${f.lineB}`);
      lines.push(`  overlap-fields: ${fieldList} (${f.overlapFields.length} shared)`);
      lines.push(
        `  suggestion: ${f.isSubset ? "replace the smaller type with the larger one" : "unify into a shared interface"}`,
      );
      lines.push("");
    }
  }

  lines.push(
    `Summary: ${pureAdapters.length} pure adapters, ${dataClumps.length} data clumps, ${typeOverlaps.length} type overlaps`,
  );
  if (estimatedLines > 0) {
    lines.push(`Wiring cost: ~${estimatedLines} lines of adapter code that structural type alignment could eliminate`);
  }

  return lines.join("\n");
}

function formatJson(result: ComplexityAuditResult): string {
  return JSON.stringify(
    {
      summary: {
        pureAdapters: result.pureAdapters.length,
        dataClumps: result.dataClumps.length,
        typeOverlaps: result.typeOverlaps.length,
      },
      pureAdapters: result.pureAdapters,
      dataClumps: result.dataClumps,
      typeOverlaps: result.typeOverlaps,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const srcDir = args.find(a => !a.startsWith("--"));
  if (!srcDir) {
    console.error("Usage: bun complexity-audit.ts <src-dir> [--format text|json] [--out <file>]");
    process.exit(1);
  }

  const format = getArg(args, "--format") ?? "text";
  const outFile = getArg(args, "--out");
  const resolvedDir = resolve(srcDir);

  const files = await collectSourceFiles(resolvedDir);
  const program = createProgram(files);
  const sourceFiles = program.getSourceFiles().filter(sf => !sf.isDeclarationFile && files.includes(sf.fileName));

  const pureAdapters = detectPureAdapters(sourceFiles, resolvedDir);
  const dataClumps = detectDataClumps(sourceFiles, resolvedDir);
  const typeOverlaps = detectTypeOverlaps(sourceFiles, resolvedDir);

  // Deduplicate data clumps that are already captured by a pure-adapter finding
  // (a pure adapter's object literal will also trigger data clumps — keep both but mark)
  const result: ComplexityAuditResult = { pureAdapters, dataClumps, typeOverlaps };

  const output = format === "json" ? formatJson(result) : formatText(result, resolvedDir);

  if (outFile) {
    await writeFile(outFile, output, "utf-8");
    console.error(`Written to ${outFile}`);
  } else {
    console.log(output);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
