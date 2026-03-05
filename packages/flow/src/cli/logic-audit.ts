#!/usr/bin/env bun
/**
 * Logic audit CLI — mechanically detect decision-logic bugs.
 *
 * Runs three targeted analyses:
 *   1. Cross-representation: Zod schema vs TS type field-level comparison
 *   2. Guard consistency: parallel collection pushes with mismatched guards
 *   3. Decision tables: status-determining functions with suspicious gaps
 *
 * Usage:
 *   bun packages/flow/src/cli/logic-audit.ts <src-dir> [--format text|json] [--out <file>]
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { collectSourceFiles, createProgram, resolveType } from "../extractor/typescript.js";
import { getArg, shortPath, countBranches, STATUS_KEYWORDS, STATUS_VALUES, BOOL_PREDICATE_NAME } from "./util.js";
import { ExtractorRegistry } from "../extractor/runtime-schema.js";
import type { RuntimeSchemaInfo } from "../extractor/runtime-schema.js";
import { ZodExtractor } from "../extractor/zod.js";
import { matchSchemasToTypes } from "../analysis/schema-matcher.js";
import type { ShapeType, ShapeField } from "../schema/shapes.js";
import { shapeToString } from "../schema/shapes.js";
import ts from "typescript";

// ── types ───────────────────────────────────────────────────────────

interface CrossRepField {
  fieldName: string;
  schemaOptional: boolean;
  typeOptional: boolean;
}

interface CrossRepMismatch {
  schemaName: string;
  typeName: string;
  field: CrossRepField;
  mismatchKind: string;
  message: string;
}

interface GuardInconsistency {
  filePath: string;
  line: number;
  loopVariable: string;
  guardedPush: { collection: string; guard: string; line: number };
  unguardedPush: { collection: string; line: number };
  message: string;
  confidence: "high" | "med" | "low";
}

interface StatusFunction {
  name: string;
  filePath: string;
  line: number;
  returnType: string;
  branchCount: number;
  lineCount: number;
}

interface DecisionRow {
  conditions: Record<string, string>;
  outcome: string;
  line: number;
}

interface SuspiciousCell {
  signal: string;
  outcome: string;
  line: number;
  reason: string;
  /** Explicit gap scenario: the case where the failure sub-expression is true but the AND-gate
   *  suppressor is false, producing a success outcome. Makes the predicate soundness question
   *  concrete so auditors cannot stop at verifying the downstream gate logic. */
  gapScenario?: string;
  /** Whether the gap is reachable by the caller, and why. "certain" = failure leaf is a function
   *  param; "likely" = leaf comes from external call result; "unknown" = static analysis insufficient. */
  reachabilityNote?: string;
  /** Contrast row: what the outcome becomes when the gate condition IS true (the suppressed path).
   *  Proves the gate condition is the sole differentiator between success and failure outcomes. */
  contrastNote?: string;
  /** One-sentence verdict synthesised from reachability + contrast. */
  verdictNote?: string;
}

interface DecisionTable {
  functionName: string;
  filePath: string;
  line: number;
  signals: string[];
  definitions: Record<string, string>;
  rows: DecisionRow[];
  suspiciousCells: SuspiciousCell[];
}

interface ExhaustivenessGap {
  filePath: string;
  line: number;
  switchExpression: string;
  knownMembers: string[];
  handledMembers: string[];
  missingMembers: string[];
  hasDefault: boolean;
  message: string;
}

interface LogicAuditResult {
  crossRep: CrossRepMismatch[];
  guards: GuardInconsistency[];
  broadGuards: GuardInconsistency[];
  statusFunctions: StatusFunction[];
  decisionTables: DecisionTable[];
  exhaustivenessGaps: ExhaustivenessGap[];
}

// ── 1. Cross-representation scan (schema vs type) ──────────────────

function extractObjectFields(shape: ShapeType): ShapeField[] | null {
  if (shape.kind === "object") return shape.fields;
  return null;
}

async function crossRepScan(
  files: string[],
  resolvedDir: string,
): Promise<CrossRepMismatch[]> {
  const registry = new ExtractorRegistry();
  registry.register(new ZodExtractor());

  const allSchemas: RuntimeSchemaInfo[] = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf-8");
    allSchemas.push(...registry.extractAll(source, filePath));
  }

  if (allSchemas.length === 0) return [];

  // Resolve inter-schema refs
  const byName = new Map(allSchemas.map((s) => [s.name, s]));
  function resolveRefs(shape: ShapeType): ShapeType {
    if (shape.kind === "ref" && !shape.resolved) {
      const target = byName.get(shape.name);
      if (target) return resolveRefs(target.shape);
    }
    if (shape.kind === "object") {
      return { ...shape, fields: shape.fields.map((f) => ({ ...f, type: resolveRefs(f.type) })) };
    }
    if (shape.kind === "array") return { ...shape, element: resolveRefs(shape.element) };
    if (shape.kind === "union") return { ...shape, members: shape.members.map(resolveRefs) };
    return shape;
  }
  for (const schema of allSchemas) {
    schema.shape = resolveRefs(schema.shape);
  }

  const program = createProgram(files);
  const checker = program.getTypeChecker();
  const matches = await matchSchemasToTypes(allSchemas, { srcDir: resolvedDir, program, checker });

  const mismatches: CrossRepMismatch[] = [];

  for (const match of matches) {
    const schemaFields = extractObjectFields(match.schema.shape);
    const typeFields: ShapeField[] | null =
      match.tsTypeShape.length > 0 ? match.tsTypeShape : null;

    if (!schemaFields || !typeFields) continue;

    const typeFieldMap = new Map(typeFields.map((f: ShapeField) => [f.name, f]));

    for (const sf of schemaFields) {
      const tf = typeFieldMap.get(sf.name);

      const field: CrossRepField = {
        fieldName: sf.name,
        schemaOptional: sf.optional,
        typeOptional: tf?.optional ?? true,
      };

      if (!sf.optional && tf && tf.optional) {
        mismatches.push({
          schemaName: match.schema.name,
          typeName: match.typeName,
          field,
          mismatchKind: "schema-type-optionality",
          message: `Schema "${match.schema.name}" requires "${sf.name}" but TypeScript type "${match.typeName}" marks it optional (?:)`,
        });
      }

      if (sf.optional && tf && !tf.optional) {
        mismatches.push({
          schemaName: match.schema.name,
          typeName: match.typeName,
          field,
          mismatchKind: "schema-type-optionality",
          message: `TypeScript type "${match.typeName}" requires "${sf.name}" but schema "${match.schema.name}" marks it .optional()`,
        });
      }
    }
  }

  return mismatches;
}

// ── 2. Guard consistency scan ───────────────────────────────────────

interface PushSite {
  collection: string;
  line: number;
  guard: string | null;
  guardLine: number | null;
}

function scanGuardConsistency(
  source: string,
  filePath: string,
): GuardInconsistency[] {
  const lines = source.split("\n");
  const results: GuardInconsistency[] = [];

  // Find for-loops and their bodies
  const forPattern = /^\s*for\s*\(\s*(const|let|var)\s+(\w+)\s+(of|in)\s+/;
  const pushPattern = /(\w+(?:\.\w+)*)\s*\.\s*push\s*\(/;
  const ifPattern = /^\s*if\s*\(/;

  let loopStart = -1;
  let loopVar = "";
  let braceDepth = 0;
  let inLoop = false;
  let loopDepth = 0;

  const pushSites: PushSite[] = [];
  let currentIfGuard: string | null = null;
  let currentIfLine = -1;
  let ifDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const forMatch = line.match(forPattern);
    if (forMatch && !inLoop) {
      loopStart = i;
      loopVar = forMatch[2]!;
      inLoop = true;
      loopDepth = braceDepth;
      pushSites.length = 0;
      currentIfGuard = null;
    }

    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (inLoop && braceDepth <= loopDepth) {
          analyzePushSites(pushSites, loopVar, filePath, loopStart, results, lines);
          inLoop = false;
          pushSites.length = 0;
        }
        if (ifDepth > 0 && braceDepth < ifDepth) {
          currentIfGuard = null;
          ifDepth = 0;
        }
      }
    }

    if (inLoop) {
      const ifMatch = line.match(ifPattern);
      if (ifMatch) {
        const guardText = line.replace(/^\s*if\s*\(/, "").replace(/\)\s*\{?\s*$/, "").trim();
        currentIfGuard = guardText;
        currentIfLine = i;
        ifDepth = braceDepth;
      }

      const pushMatch = line.match(pushPattern);
      if (pushMatch) {
        pushSites.push({
          collection: pushMatch[1]!,
          line: i + 1,
          guard: currentIfGuard,
          guardLine: currentIfGuard ? currentIfLine + 1 : null,
        });
      }
    }
  }

  return results;
}

function analyzePushSites(
  pushSites: PushSite[],
  loopVar: string,
  filePath: string,
  loopStart: number,
  results: GuardInconsistency[],
  sourceLines?: string[],
): void {
  if (pushSites.length < 2) return;

  const guarded = pushSites.filter((p) => p.guard !== null);
  const unguarded = pushSites.filter((p) => p.guard === null);

  if (guarded.length > 0 && unguarded.length > 0) {
    for (const g of guarded) {
      for (const u of unguarded) {
        if (g.collection === u.collection) continue;
        const confidence = scoreGuardConfidence(
          g.collection, u.collection, sourceLines,
        );
        results.push({
          filePath,
          line: loopStart + 1,
          loopVariable: loopVar,
          guardedPush: {
            collection: g.collection,
            guard: g.guard!,
            line: g.line,
          },
          unguardedPush: {
            collection: u.collection,
            line: u.line,
          },
          message: `"${u.collection}.push()" at line ${u.line} has no guard, but "${g.collection}.push()" at line ${g.line} is guarded by "${g.guard}". Possible missing check.`,
          confidence,
        });
      }
    }
  }
}

function scoreGuardConfidence(
  guardedCol: string,
  unguardedCol: string,
  sourceLines?: string[],
): "high" | "med" | "low" {
  if (!sourceLines) return "med";
  const guardedBase = guardedCol.split(".").pop() ?? guardedCol;
  const unguardedBase = unguardedCol.split(".").pop() ?? unguardedCol;
  const coConsumed = sourceLines.some(
    (line) => line.includes(guardedBase) && line.includes(unguardedBase),
  );
  if (coConsumed) return "high";
  let guardedUsages = 0;
  let unguardedUsages = 0;
  for (const line of sourceLines) {
    if (line.includes(guardedBase) && !line.includes(".push")) guardedUsages++;
    if (line.includes(unguardedBase) && !line.includes(".push")) unguardedUsages++;
  }
  if (guardedUsages > 0 && unguardedUsages > 0) return "med";
  return "low";
}

// ── 2b. Broad guard consistency scan ────────────────────────────────

function scanBroadGuardConsistency(
  source: string,
  filePath: string,
): GuardInconsistency[] {
  const lines = source.split("\n");
  const results: GuardInconsistency[] = [];

  // Pattern 1: forEach/map with conditional operations
  scanForEachMapGuards(lines, filePath, results);

  // Pattern 2: Switch statements with missing cases (no default)
  scanSwitchMissingCases(lines, filePath, results);

  // Pattern 3: Parallel conditional assignments
  scanConditionalAssignments(lines, filePath, results);

  // Pattern 4: Promise.all with mixed error handling
  scanPromiseAllMixedCatch(lines, filePath, results);

  return results;
}

/**
 * Pattern 1: array.forEach / array.map with mixed guarded/unguarded operations
 * Detects: arr.forEach(item => { if (cond) doA(item); doB(item); })
 */
function scanForEachMapGuards(
  lines: string[],
  filePath: string,
  results: GuardInconsistency[],
): void {
  const forEachPattern = /(\w+(?:\.\w+)*)\s*\.\s*(forEach|map)\s*\(\s*(?:\(?\s*(\w+))/;
  const callPattern = /(\w+(?:\.\w+)*)\s*\(/;
  const ifPattern = /^\s*if\s*\(/;

  let inCallback = false;
  let callbackStart = -1;
  let callbackVar = "";
  let braceDepth = 0;
  let callbackDepth = 0;

  interface OpSite {
    op: string;
    line: number;
    guard: string | null;
  }

  let opSites: OpSite[] = [];
  let currentIfGuard: string | null = null;
  let ifDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const feMatch = line.match(forEachPattern);
    if (feMatch && !inCallback) {
      callbackStart = i;
      callbackVar = feMatch[3] ?? "";
      inCallback = true;
      callbackDepth = braceDepth;
      opSites = [];
      currentIfGuard = null;
    }

    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (inCallback && braceDepth <= callbackDepth) {
          analyzeOpSites(opSites, callbackVar, filePath, callbackStart, results);
          inCallback = false;
          opSites = [];
        }
        if (ifDepth > 0 && braceDepth < ifDepth) {
          currentIfGuard = null;
          ifDepth = 0;
        }
      }
    }

    if (inCallback) {
      const ifMatch = line.match(ifPattern);
      if (ifMatch) {
        const guardText = line.replace(/^\s*if\s*\(/, "").replace(/\)\s*\{?\s*$/, "").trim();
        currentIfGuard = guardText;
        ifDepth = braceDepth;
      }

      // Look for function calls (but skip the forEach/map itself and control-flow keywords)
      const trimmed = line.trim();
      if (!trimmed.startsWith("if") && !trimmed.startsWith("for") && !trimmed.startsWith("while") &&
          !trimmed.startsWith("//") && !trimmed.startsWith("}") && !trimmed.startsWith("{")) {
        const cm = trimmed.match(callPattern);
        if (cm && !cm[1]!.match(/\b(forEach|map|filter|reduce|console|if|for|while|switch)\b/)) {
          opSites.push({
            op: cm[1]!,
            line: i + 1,
            guard: currentIfGuard,
          });
        }
      }
    }
  }
}

function analyzeOpSites(
  opSites: { op: string; line: number; guard: string | null }[],
  callbackVar: string,
  filePath: string,
  callbackStart: number,
  results: GuardInconsistency[],
): void {
  if (opSites.length < 2) return;

  const guarded = opSites.filter((p) => p.guard !== null);
  const unguarded = opSites.filter((p) => p.guard === null);

  if (guarded.length > 0 && unguarded.length > 0) {
    for (const g of guarded) {
      for (const u of unguarded) {
        if (g.op === u.op) continue;
        results.push({
          filePath,
          line: callbackStart + 1,
          loopVariable: callbackVar,
          guardedPush: {
            collection: g.op,
            guard: g.guard!,
            line: g.line,
          },
          unguardedPush: {
            collection: u.op,
            line: u.line,
          },
          message: `"${u.op}()" at line ${u.line} has no guard, but "${g.op}()" at line ${g.line} is guarded by "${g.guard}" inside forEach/map callback. Possible missing check.`,
          confidence: "med",
        });
      }
    }
  }
}

/**
 * Pattern 2: Switch statements with missing cases
 * Detects switch on union/enum values without covering all cases and no default
 */
function scanSwitchMissingCases(
  lines: string[],
  filePath: string,
  results: GuardInconsistency[],
): void {
  const switchPattern = /^\s*switch\s*\(\s*(\w+(?:\.\w+)*)\s*\)/;
  const casePattern = /^\s*case\s+["'](\w+)["']\s*:/;
  const defaultPattern = /^\s*default\s*:/;

  let inSwitch = false;
  let switchLine = -1;
  let switchVar = "";
  let braceDepth = 0;
  let switchDepth = 0;
  let cases: string[] = [];
  let hasDefault = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const sm = line.match(switchPattern);
    if (sm && !inSwitch) {
      switchLine = i;
      switchVar = sm[1]!;
      inSwitch = true;
      switchDepth = braceDepth;
      cases = [];
      hasDefault = false;
    }

    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (inSwitch && braceDepth <= switchDepth) {
          // Switch ended — if we have cases but no default and few cases, flag it
          if (cases.length >= 2 && !hasDefault) {
            results.push({
              filePath,
              line: switchLine + 1,
              loopVariable: switchVar,
              guardedPush: {
                collection: `case "${cases[0]}"`,
                guard: `switch(${switchVar})`,
                line: switchLine + 1,
              },
              unguardedPush: {
                collection: "default",
                line: switchLine + 1,
              },
              message: `switch(${switchVar}) at line ${switchLine + 1} handles ${cases.length} cases [${cases.join(", ")}] but has no default. Possible missing case.`,
              confidence: "low",
            });
          }
          inSwitch = false;
        }
      }
    }

    if (inSwitch) {
      const cm = line.match(casePattern);
      if (cm) cases.push(cm[1]!);
      if (defaultPattern.test(line)) hasDefault = true;
    }
  }
}

/**
 * Pattern 3: Parallel conditional assignments
 * Detects: if (cond) { a = x; } b = y; — where some assignments are guarded, others aren't
 */
function scanConditionalAssignments(
  lines: string[],
  filePath: string,
  results: GuardInconsistency[],
): void {
  const assignPattern = /^\s*(\w+)\s*=\s*.+;/;
  const ifPattern = /^\s*if\s*\(/;

  interface AssignSite {
    varName: string;
    line: number;
    guard: string | null;
  }

  // Scan blocks of closely-spaced assignments
  const assignSites: AssignSite[] = [];
  let currentGuard: string | null = null;
  let guardBraceDepth = 0;
  let braceDepth = 0;
  let inIfBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const ifMatch = line.match(ifPattern);
    if (ifMatch) {
      const guardText = line.replace(/^\s*if\s*\(/, "").replace(/\)\s*\{?\s*$/, "").trim();
      currentGuard = guardText;
      inIfBlock = true;
      guardBraceDepth = braceDepth;
    }

    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (inIfBlock && braceDepth <= guardBraceDepth) {
          currentGuard = null;
          inIfBlock = false;
        }
      }
    }

    const am = line.match(assignPattern);
    if (am && !line.trim().startsWith("//") && !line.trim().startsWith("const ") &&
        !line.trim().startsWith("let ") && !line.trim().startsWith("var ")) {
      assignSites.push({
        varName: am[1]!,
        line: i + 1,
        guard: currentGuard,
      });
    }
  }

  // Look for groups of assignments to related variables where some are guarded and some aren't
  // Group by proximity (within 5 lines of each other)
  for (let i = 0; i < assignSites.length; i++) {
    for (let j = i + 1; j < assignSites.length; j++) {
      const a = assignSites[i]!;
      const b = assignSites[j]!;
      if (Math.abs(a.line - b.line) > 5) continue;
      if (a.varName === b.varName) continue;

      if (a.guard !== null && b.guard === null) {
        results.push({
          filePath,
          line: a.line,
          loopVariable: "",
          guardedPush: {
            collection: `${a.varName} =`,
            guard: a.guard,
            line: a.line,
          },
          unguardedPush: {
            collection: `${b.varName} =`,
            line: b.line,
          },
          message: `Assignment to "${b.varName}" at line ${b.line} is unguarded, but assignment to "${a.varName}" at line ${a.line} is guarded by "${a.guard}". Possible missing check for parallel assignment.`,
          confidence: "low",
        });
      } else if (b.guard !== null && a.guard === null) {
        results.push({
          filePath,
          line: b.line,
          loopVariable: "",
          guardedPush: {
            collection: `${b.varName} =`,
            guard: b.guard,
            line: b.line,
          },
          unguardedPush: {
            collection: `${a.varName} =`,
            line: a.line,
          },
          message: `Assignment to "${a.varName}" at line ${a.line} is unguarded, but assignment to "${b.varName}" at line ${b.line} is guarded by "${b.guard}". Possible missing check for parallel assignment.`,
          confidence: "low",
        });
      }
    }
  }
}

/**
 * Pattern 4: Promise.all with mixed error handling
 * Detects: Promise.all([a.catch(...), b, c.catch(...)]) where some have .catch and some don't
 */
function scanPromiseAllMixedCatch(
  lines: string[],
  filePath: string,
  results: GuardInconsistency[],
): void {
  const source = lines.join("\n");
  // Match Promise.all([ ... ]) spans — simple heuristic on single or multi-line
  const promiseAllRe = /Promise\.all\s*\(\s*\[([^\]]*)\]\s*\)/gs;
  let match: RegExpExecArray | null;

  while ((match = promiseAllRe.exec(source)) !== null) {
    const inner = match[1]!;
    const lineOffset = source.slice(0, match.index).split("\n").length;
    const args = splitTopLevelComma(inner);

    const withCatch: string[] = [];
    const withoutCatch: string[] = [];

    for (const arg of args) {
      const trimmed = arg.trim();
      if (!trimmed) continue;
      if (/\.catch\s*\(/.test(trimmed)) {
        withCatch.push(trimmed);
      } else {
        withoutCatch.push(trimmed);
      }
    }

    if (withCatch.length > 0 && withoutCatch.length > 0) {
      const firstWithCatch = withCatch[0]!.slice(0, 40);
      const firstWithout = withoutCatch[0]!.slice(0, 40);
      results.push({
        filePath,
        line: lineOffset,
        loopVariable: "",
        guardedPush: {
          collection: firstWithCatch,
          guard: ".catch()",
          line: lineOffset,
        },
        unguardedPush: {
          collection: firstWithout,
          line: lineOffset,
        },
        message: `Promise.all at line ${lineOffset}: ${withCatch.length} promise(s) have .catch() but ${withoutCatch.length} don't. Mixed error handling may cause unhandled rejections.`,
        confidence: "med",
      });
    }
  }
}

/** Split a string by commas at the top level (not inside parens/brackets) */
function splitTopLevelComma(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// ── 3. Status determination scan ────────────────────────────────────

function scanStatusFunctions(
  program: ts.Program,
  checker: ts.TypeChecker,
  nonTestFiles: string[],
  resolvedDir: string,
): StatusFunction[] {
  const results: StatusFunction[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!nonTestFiles.includes(sourceFile.fileName)) continue;

    ts.forEachChild(sourceFile, (node) => {
      const fnInfo = tryExtractStatusFunction(node, sourceFile, checker);
      if (fnInfo) {
        results.push({
          ...fnInfo,
          filePath: relative(resolvedDir, sourceFile.fileName),
        });
      }
    });
  }

  return results.sort((a, b) => b.branchCount - a.branchCount);
}

function tryExtractStatusFunction(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): Omit<StatusFunction, "filePath"> | null {
  let name: string | undefined;
  let funcNode: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;

  if (ts.isFunctionDeclaration(node) && node.name) {
    name = node.name.text;
    funcNode = node;
  } else if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      let init = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        name = decl.name.text;
        funcNode = init;
        break;
      }
    }
  }

  if (!name || !funcNode) return null;

  const sig = checker.getSignatureFromDeclaration(funcNode);
  if (!sig) return null;

  const retType = checker.getReturnTypeOfSignature(sig);
  const retShape = resolveType(checker, retType);
  const retStr = shapeToString(retShape);

  // Check for boolean return with complex decision logic
  const isBoolReturn = retStr === "boolean" || retStr === "Boolean";
  const isBoolPredicateName = BOOL_PREDICATE_NAME.test(name);

  // Check for { success: boolean, ... } or { ok: boolean, ... } return pattern
  const isResultObject = retShape.kind === "object" &&
    retShape.fields.some((f) =>
      (f.name === "success" || f.name === "ok") &&
      (f.type.kind === "primitive" && f.type.value === "boolean"),
    );

  const isStatus =
    STATUS_VALUES.test(retStr) ||
    STATUS_KEYWORDS.test(name) ||
    (retShape.kind === "union" &&
      retShape.members.some(
        (m) => m.kind === "literal" && typeof m.value === "string" && STATUS_VALUES.test(m.value),
      )) ||
    (retShape.kind === "object" &&
      retShape.fields.some((f) => STATUS_KEYWORDS.test(f.name))) ||
    isResultObject ||
    isBoolPredicateName;

  // For boolean returns, require at least 3 branches to be interesting
  const sourceText = funcNode.getText(sourceFile);
  const branchCount = countBranches(sourceText);

  if (!isStatus && !(isBoolReturn && branchCount >= 3)) return null;
  if (isBoolReturn && !isBoolPredicateName && !isStatus && branchCount < 3) return null;

  const line = sourceFile.getLineAndCharacterOfPosition(funcNode.getStart(sourceFile)).line + 1;
  const lineCount = sourceText.split("\n").length;

  return { name, line, returnType: retStr, branchCount, lineCount };
}

// ── 5. Decision table scan ──────────────────────────────────────────

const FAILURE_NAME_RE = /exit.?code|error|fail|broke|empty|zero|timeout|abort/i;
const SUCCESS_OUTCOMES = new Set(["complete", "completed", "success", "ok", "merged"]);

function scanDecisionTables(
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

function extractFnName(node: ts.Node): string | undefined {
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

function normWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function abbreviateCond(text: string, varDefs: Map<string, string>): string {
  const trimmed = normWs(text);
  const expanded = varDefs.get(trimmed);
  if (expanded) return trimmed;
  if (trimmed.length > 60) return trimmed.slice(0, 57) + "...";
  return trimmed;
}

function buildDecisionTable(
  node: ts.Node,
  functionName: string,
  sourceFile: ts.SourceFile,
  filePath: string,
): DecisionTable | null {
  const fnLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const varDefs = new Map<string, string>();
  function collectDefs(n: ts.Node) {
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
    ts.forEachChild(n, collectDefs);
  }
  collectDefs(node);

  const rows: DecisionRow[] = [];

  function walk(n: ts.Node, condPath: Array<{ cond: string; branch: "T" | "F" }>) {
    if (ts.isConditionalExpression(n)) {
      const condText = abbreviateCond(n.condition.getText(sourceFile), varDefs);
      walk(n.whenTrue, [...condPath, { cond: condText, branch: "T" }]);
      walk(n.whenFalse, [...condPath, { cond: condText, branch: "F" }]);
      return;
    }

    if (ts.isIfStatement(n)) {
      const condText = abbreviateCond(n.expression.getText(sourceFile), varDefs);
      walk(n.thenStatement, [...condPath, { cond: condText, branch: "T" }]);
      if (n.elseStatement) {
        walk(n.elseStatement, [...condPath, { cond: condText, branch: "F" }]);
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

    ts.forEachChild(n, child => walk(child, condPath));
  }

  walk(node, []);
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

function isStatusAssignment(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  return ts.isPropertyAssignment(p) || ts.isReturnStatement(p) ||
    ts.isVariableDeclaration(p) || ts.isBinaryExpression(p);
}

function collectLeafFailureSignals(varDefs: Map<string, string>): Set<string> {
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
function extractParamNames(node: ts.Node, sourceFile: ts.SourceFile): Set<string> {
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

const LEAF_SKIP = new Set(["null", "undefined", "true", "false", "NaN", "Infinity", "typeof", "instanceof", "void"]);

/**
 * Recursively expand a variable reference or expression through varDefs to find the
 * primitive leaf identifier tokens (those without a varDef entry).
 */
function expandToLeafTokens(
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
function expandToLeafTokensWithOrigin(
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
function findParamLeaves(
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
function findContrastOutcomes(rows: DecisionRow[], condName: string): string[] {
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
function buildGapAnalysis(opts: {
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

function findAndGatedFailureSignals(varDefs: Map<string, string>): Map<string, string[]> {
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

function detectSuspiciousCells(
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

// ── 6. Enum/union exhaustiveness gap scan ───────────────────────────

function scanExhaustivenessGaps(
  program: ts.Program,
  checker: ts.TypeChecker,
  nonTestFiles: string[],
  resolvedDir: string,
): ExhaustivenessGap[] {
  const results: ExhaustivenessGap[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!nonTestFiles.includes(sourceFile.fileName)) continue;
    const relPath = relative(resolvedDir, sourceFile.fileName);

    function visit(node: ts.Node) {
      if (ts.isSwitchStatement(node)) {
        const gap = analyzeSwitchExhaustiveness(node, sourceFile, checker, relPath);
        if (gap) results.push(gap);
      }
      ts.forEachChild(node, visit);
    }
    ts.forEachChild(sourceFile, visit);
  }

  return results;
}

function analyzeSwitchExhaustiveness(
  node: ts.SwitchStatement,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filePath: string,
): ExhaustivenessGap | null {
  const exprType = checker.getTypeAtLocation(node.expression);
  if (!exprType) return null;

  // Get the union members or enum members
  const knownMembers: string[] = [];

  if (exprType.isUnion()) {
    for (const member of exprType.types) {
      if (member.isStringLiteral()) {
        knownMembers.push(member.value);
      } else if (member.isNumberLiteral()) {
        knownMembers.push(String(member.value));
      }
    }
  }

  // Also check if it's an enum type by looking at the symbol
  if (knownMembers.length === 0) {
    const symbol = exprType.getSymbol?.();
    if (symbol && symbol.flags & ts.SymbolFlags.Enum) {
      const enumDecl = symbol.declarations?.[0];
      if (enumDecl && ts.isEnumDeclaration(enumDecl)) {
        for (const member of enumDecl.members) {
          if (ts.isIdentifier(member.name)) {
            knownMembers.push(member.name.text);
          }
        }
      }
    }
  }

  // Need at least 2 known members to be meaningful
  if (knownMembers.length < 2) return null;

  // Collect handled cases
  const handledMembers: string[] = [];
  let hasDefault = false;

  for (const clause of node.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      hasDefault = true;
    } else if (ts.isCaseClause(clause) && clause.expression) {
      if (ts.isStringLiteral(clause.expression)) {
        handledMembers.push(clause.expression.text);
      } else if (ts.isNumericLiteral(clause.expression)) {
        handledMembers.push(clause.expression.text);
      } else if (ts.isPropertyAccessExpression(clause.expression)) {
        // EnumType.Member
        handledMembers.push(clause.expression.name.text);
      }
    }
  }

  // If there's a default clause, all cases are technically handled
  if (hasDefault) return null;

  const missingMembers = knownMembers.filter(m => !handledMembers.includes(m));

  if (missingMembers.length === 0) return null;

  const switchExpr = node.expression.getText(sourceFile);
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  return {
    filePath,
    line,
    switchExpression: switchExpr,
    knownMembers,
    handledMembers,
    missingMembers,
    hasDefault,
    message: `switch(${switchExpr}) at line ${line} handles ${handledMembers.length}/${knownMembers.length} cases. Missing: ${missingMembers.join(", ")}. No default clause.`,
  };
}

// ── formatting ──────────────────────────────────────────────────────

function formatText(result: LogicAuditResult, resolvedDir: string, minConfidence: "high" | "med" | "low"): string {
  const o: string[] = [];
  const sp = (p: string) => shortPath(p, resolvedDir);

  // Cross-representation — 1 line per mismatch
  o.push(`## Cross-Rep Mismatches (${result.crossRep.length})`);
  for (const m of result.crossRep) {
    const s = m.field.schemaOptional ? "opt" : "req";
    const t = m.field.typeOptional ? "opt" : "req";
    o.push(`[${m.mismatchKind}] ${m.schemaName}.${m.field.fieldName} schema=${s} type=${t}`);
  }

  // Decision tables — compact rows
  const suspectCount = result.decisionTables.reduce((n, t) => n + t.suspiciousCells.length, 0);
  o.push(`## Decision Tables (${result.decisionTables.length} fn, ${suspectCount} suspect)`);
  for (const dt of result.decisionTables) {
    o.push(`${dt.functionName} ${sp(dt.filePath)}:${dt.line}`);
    if (dt.signals.length > 0) o.push(`  signals: ${dt.signals.join(",")}`);
    for (const [name, def] of Object.entries(dt.definitions)) {
      o.push(`  ${name} = ${def}`);
    }
    for (const row of dt.rows) {
      const conds = Object.entries(row.conditions)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      const suspects = dt.suspiciousCells.filter(s => s.line === row.line);
      if (suspects.length > 0) {
        o.push(`  ${conds || "(default)"} → ${row.outcome}`);
        for (const s of suspects) {
          o.push(`    ⚠ ${s.reason}`);
          if (s.gapScenario) o.push(`      → ${s.gapScenario}`);
          if (s.reachabilityNote) o.push(`      → ${s.reachabilityNote}`);
          if (s.contrastNote) o.push(`      → ${s.contrastNote}`);
          if (s.verdictNote) o.push(`      → ${s.verdictNote}`);
        }
      } else {
        o.push(`  ${conds || "(default)"} → ${row.outcome}`);
      }
    }
  }

  // Guard consistency — sorted by confidence, filtered
  const confOrder = { high: 0, med: 1, low: 2 };
  const confThreshold = confOrder[minConfidence];
  const filtered = result.guards.filter(g => confOrder[g.confidence] <= confThreshold);
  const highCount = result.guards.filter(g => g.confidence === "high").length;
  o.push(`## Guard Consistency (${filtered.length} warnings, ${highCount} high)`);
  const sorted = [...filtered].sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence]);
  for (const g of sorted) {
    const marker = g.confidence === "high" ? "⚠high" : ` ${g.confidence} `;
    o.push(`${marker} ${sp(g.filePath)}:${g.line} loop(${g.loopVariable}) ${g.unguardedPush.collection}.push unguarded, ${g.guardedPush.collection}.push guarded(${g.guardedPush.guard})`);
  }

  // Broad guard consistency
  const broadFiltered = result.broadGuards.filter(g => confOrder[g.confidence] <= confThreshold);
  const broadHighCount = result.broadGuards.filter(g => g.confidence === "high").length;
  o.push(`## Broad Guard Consistency (${broadFiltered.length} warnings, ${broadHighCount} high)`);
  const broadSorted = [...broadFiltered].sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence]);
  for (const g of broadSorted) {
    const marker = g.confidence === "high" ? "⚠high" : ` ${g.confidence} `;
    o.push(`${marker} ${sp(g.filePath)}:${g.line} ${g.message}`);
  }

  // Exhaustiveness gaps
  o.push(`## Exhaustiveness Gaps (${result.exhaustivenessGaps.length})`);
  for (const gap of result.exhaustivenessGaps) {
    o.push(`${sp(gap.filePath)}:${gap.line} switch(${gap.switchExpression}) missing: ${gap.missingMembers.join(", ")} (handled ${gap.handledMembers.length}/${gap.knownMembers.length})`);
  }

  // Status functions — 1 line each, return type truncated
  o.push(`## Status Functions (${result.statusFunctions.length})`);
  for (const fn of result.statusFunctions) {
    const ret = fn.returnType.length > 80 ? fn.returnType.slice(0, 77) + "..." : fn.returnType;
    o.push(`${fn.name} ${fn.filePath}:${fn.line} branches=${fn.branchCount} lines=${fn.lineCount} returns:${ret}`);
  }

  // Summary line
  const total = result.crossRep.length + filtered.length + broadFiltered.length + suspectCount + result.exhaustivenessGaps.length;
  o.push(`## Summary: crossRep=${result.crossRep.length} guards=${filtered.length} broadGuards=${broadFiltered.length} statusFn=${result.statusFunctions.length} decisionTables=${result.decisionTables.length} suspect=${suspectCount} exhaustiveness=${result.exhaustivenessGaps.length} total=${total}`);

  return o.join("\n");
}

function formatJson(result: LogicAuditResult): string {
  return JSON.stringify(result, null, 2);
}

// ── exported function ───────────────────────────────────────────────

export interface LogicAuditOptions {
  srcDir: string;
  format?: "text" | "json";
  outFile?: string;
  minConfidence?: "high" | "med" | "low";
}

export async function runLogicAudit(opts: LogicAuditOptions): Promise<string> {
  const format = opts.format ?? "text";
  const minConfidence = opts.minConfidence ?? "med";
  const resolvedDir = resolve(opts.srcDir);
  const files = await collectSourceFiles(resolvedDir);

  const crossRep = await crossRepScan(files, resolvedDir);

  const guards: GuardInconsistency[] = [];
  const broadGuards: GuardInconsistency[] = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf-8");
    guards.push(...scanGuardConsistency(source, filePath));
    broadGuards.push(...scanBroadGuardConsistency(source, filePath));
  }

  const nonTestFiles = files.filter(
    (f) => !f.includes("__tests__") && !f.includes(".test.") && !f.includes(".spec."),
  );
  const program = createProgram(nonTestFiles);
  const checker = program.getTypeChecker();

  const statusFunctions = scanStatusFunctions(program, checker, nonTestFiles, resolvedDir);

  const decisionTables = scanDecisionTables(program, nonTestFiles, resolvedDir, statusFunctions);

  const exhaustivenessGaps = scanExhaustivenessGaps(program, checker, nonTestFiles, resolvedDir);

  const result: LogicAuditResult = {
    crossRep,
    guards,
    broadGuards,
    statusFunctions,
    decisionTables,
    exhaustivenessGaps,
  };

  const output = format === "json" ? formatJson(result) : formatText(result, resolvedDir, minConfidence);

  if (opts.outFile) {
    await writeFile(opts.outFile, output, "utf-8");
  }
  return output;
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const srcDir = args.find((a) => !a.startsWith("--"));

  if (!srcDir) {
    console.error("Usage: bun logic-audit.ts <src-dir> [--format text|json] [--out <file>] [--min-confidence high|med|low]");
    process.exit(1);
  }

  const format = (getArg(args, "--format") ?? "text") as "text" | "json";
  const outFile = getArg(args, "--out");
  const minConfidence = (getArg(args, "--min-confidence") ?? "med") as "high" | "med" | "low";

  console.error(`Scanning in ${shortPath(resolve(srcDir))}...`);

  const output = await runLogicAudit({ srcDir, format, outFile, minConfidence });
  if (!outFile) console.log(output);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
