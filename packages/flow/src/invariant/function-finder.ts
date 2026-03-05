import ts from "typescript";
import { createHash } from "node:crypto";
import { collectSourceFiles, createProgram, resolveType } from "../extractor/typescript.js";
import { shapeToString } from "../schema/shapes.js";
import type { DiscoveredFunction, FunctionParam } from "./types.js";

export interface DiscoverOptions {
  minPurity?: number;
  suggestExtractions?: boolean;
  tsConfigPath?: string;
}

type PurityFlag =
  | "await"
  | "fs-import"
  | "mutation"
  | "this"
  | "console"
  | "process"
  | "random"
  | "global-write";

const PURITY_PENALTIES: Record<PurityFlag, number> = {
  "await": 0.3,
  "fs-import": 0.3,
  "mutation": 0.2,
  "this": 0.2,
  "console": 0.1,
  "process": 0.1,
  "random": 0.1,
  "global-write": 0.2,
};

const IMPURE_MODULES = new Set([
  "node:fs",
  "node:fs/promises",
  "fs",
  "fs/promises",
  "node:child_process",
  "child_process",
  "node:net",
  "net",
  "node:http",
  "http",
]);

const MUTATING_METHODS = new Set(["push", "set", "delete", "splice", "pop", "shift", "unshift"]);

export async function discoverFunctions(
  srcDir: string,
  options: DiscoverOptions = {},
): Promise<DiscoveredFunction[]> {
  const files = await collectSourceFiles(srcDir);
  if (files.length === 0) return [];

  const program = createProgram(files, options.tsConfigPath);
  const checker = program.getTypeChecker();
  const discovered: DiscoveredFunction[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!files.includes(sourceFile.fileName)) continue;

    const fileImports = collectImports(sourceFile);
    const moduleLevelNames = collectModuleLevelBindings(sourceFile);

    ts.forEachChild(sourceFile, (node) => {
      const extracted = tryExtractFunction(node, sourceFile, checker, fileImports, moduleLevelNames);
      if (extracted) discovered.push(extracted);
    });
  }

  if (options.suggestExtractions) {
    for (const fn of discovered) {
      if (fn.purityScore < 0.5) {
        fn.extractionHint = generateExtractionHint(fn);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const fn of discovered) {
    const existing = groups.get(fn.signatureHash);
    if (existing) existing.push(fn.name);
    else groups.set(fn.signatureHash, [fn.name]);
  }
  for (const fn of discovered) {
    const group = groups.get(fn.signatureHash);
    if (group && group.length > 1) {
      fn.similarFunctions = group.filter((n) => n !== fn.name);
    }
  }

  discovered.sort((a, b) => b.purityScore - a.purityScore);

  if (options.minPurity !== undefined) {
    return discovered.filter((fn) => fn.purityScore >= options.minPurity!);
  }

  return discovered;
}

function tryExtractFunction(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  fileImports: Set<string>,
  moduleLevelNames: Set<string>,
): DiscoveredFunction | null {
  if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
    return buildDiscoveredFunction(
      node.name.text,
      node,
      node.parameters,
      sourceFile,
      checker,
      getExportKind(node),
      fileImports,
      moduleLevelNames,
    );
  }

  if (
    ts.isVariableStatement(node) &&
    hasExportModifier(node)
  ) {
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer) continue;

      const init = unwrapParenthesized(decl.initializer);
      if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;

      return buildDiscoveredFunction(
        decl.name.text,
        init,
        init.parameters,
        sourceFile,
        checker,
        "named",
        fileImports,
        moduleLevelNames,
      );
    }
  }

  return null;
}

function buildDiscoveredFunction(
  name: string,
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  exportKind: "named" | "default",
  fileImports: Set<string>,
  moduleLevelNames: Set<string>,
): DiscoveredFunction {
  const params = resolveParams(parameters, checker);
  const returnType = resolveReturnType(node, checker);
  const sourceText = node.getText(sourceFile);
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const paramNames = new Set(params.map((p) => p.name));
  const purityFlags = computePurityFlags(sourceText, fileImports, paramNames, moduleLevelNames, returnType);
  const purityScore = computePurityScore(purityFlags);
  const signatureHash = computeSignatureHash(params, returnType);

  return {
    name,
    filePath: sourceFile.fileName,
    line,
    exportKind,
    params,
    returnType,
    purityScore,
    purityFlags,
    sourceText,
    signatureHash,
  };
}

function resolveParams(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  checker: ts.TypeChecker,
): FunctionParam[] {
  return parameters.map((param) => {
    const symbol = checker.getSymbolAtLocation(param.name);
    const paramType = symbol
      ? checker.getTypeOfSymbol(symbol)
      : checker.getTypeAtLocation(param);
    return {
      name: param.name.getText(),
      type: resolveType(checker, paramType),
      optional: !!param.questionToken || !!param.initializer,
    };
  });
}

function resolveReturnType(
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): import("../schema/shapes.js").ShapeType {
  const sig = checker.getSignatureFromDeclaration(node);
  if (!sig) return { kind: "primitive", value: "unknown" };
  const retType = checker.getReturnTypeOfSignature(sig);
  return resolveType(checker, retType);
}

function computePurityFlags(
  sourceText: string,
  fileImports: Set<string>,
  paramNames: Set<string>,
  moduleLevelNames: Set<string>,
  returnType: import("../schema/shapes.js").ShapeType,
): PurityFlag[] {
  const flags: PurityFlag[] = [];

  if (/\bawait\b/.test(sourceText) || returnType.kind === "promise") {
    flags.push("await");
  }

  for (const mod of fileImports) {
    if (IMPURE_MODULES.has(mod)) {
      flags.push("fs-import");
      break;
    }
  }

  if (hasMutation(sourceText, paramNames)) {
    flags.push("mutation");
  }

  if (/\bthis\b/.test(sourceText)) {
    flags.push("this");
  }

  if (/\bconsole\s*\./.test(sourceText)) {
    flags.push("console");
  }

  if (/\bprocess\s*\.\s*(exit|env)\b/.test(sourceText)) {
    flags.push("process");
  }

  if (/\bMath\s*\.\s*random\s*\(/.test(sourceText) || /\bDate\s*\.\s*now\s*\(/.test(sourceText)) {
    flags.push("random");
  }

  if (hasGlobalWrite(sourceText, moduleLevelNames)) {
    flags.push("global-write");
  }

  return flags;
}

function hasMutation(sourceText: string, paramNames: Set<string>): boolean {
  for (const name of paramNames) {
    const assignPattern = new RegExp(`\\b${escapeRegex(name)}\\s*\\.\\s*\\w+\\s*=`);
    if (assignPattern.test(sourceText)) return true;

    for (const method of MUTATING_METHODS) {
      const callPattern = new RegExp(`\\b${escapeRegex(name)}(?:\\s*\\.\\s*\\w+)*\\s*\\.\\s*${method}\\s*\\(`);
      if (callPattern.test(sourceText)) return true;
    }
  }
  return false;
}

function hasGlobalWrite(sourceText: string, moduleLevelNames: Set<string>): boolean {
  for (const name of moduleLevelNames) {
    const pattern = new RegExp(`(?<!\\.)\\b${escapeRegex(name)}\\s*=[^=]`);
    if (pattern.test(sourceText)) return true;
  }
  return false;
}

function computePurityScore(flags: PurityFlag[]): number {
  let score = 1.0;
  for (const flag of flags) {
    score -= PURITY_PENALTIES[flag];
  }
  return Math.max(0, Math.min(1, score));
}

function computeSignatureHash(
  params: FunctionParam[],
  returnType: import("../schema/shapes.js").ShapeType,
): string {
  const paramStr = params.map((p) => shapeToString(p.type)).join(", ");
  const sig = `(${paramStr}) → ${shapeToString(returnType)}`;
  return createHash("sha256").update(sig).digest("hex").slice(0, 16);
}

function generateExtractionHint(fn: DiscoveredFunction): string {
  const lines = fn.sourceText.split("\n");
  const hints: string[] = [];

  let blockStart = -1;
  let blockKind = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(if|switch)\s*\(/.test(line) && !/await|fetch|fs\.|process\./.test(line)) {
      blockStart = i;
      blockKind = "Status determination logic";
    } else if (blockStart >= 0 && /^\s*\}/.test(line)) {
      const span = i - blockStart + 1;
      if (span >= 3) {
        hints.push(
          `${blockKind} (lines ${fn.line + blockStart}-${fn.line + i}) could be extracted into a pure function`,
        );
      }
      blockStart = -1;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/\.\s*(map|filter|reduce|flatMap)\s*\(/.test(line) && !/await/.test(line)) {
      hints.push(
        `Data transformation chain (line ${fn.line + i}) could be extracted into a pure function`,
      );
    }
  }

  if (hints.length === 0 && fn.purityFlags.includes("await")) {
    const awaitLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/\bawait\b/.test(lines[i]!)) awaitLines.push(i);
    }
    if (awaitLines.length >= 2) {
      for (let idx = 0; idx < awaitLines.length - 1; idx++) {
        const gapStart = awaitLines[idx]! + 1;
        const gapEnd = awaitLines[idx + 1]! - 1;
        if (gapEnd - gapStart >= 2) {
          hints.push(
            `Pure computation block (lines ${fn.line + gapStart}-${fn.line + gapEnd}) between awaits could be extracted`,
          );
        }
      }
    }
  }

  return hints[0] ?? "Contains mixed pure and impure logic that may be separable";
}

function collectImports(sourceFile: ts.SourceFile): Set<string> {
  const imports = new Set<string>();
  ts.forEachChild(sourceFile, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.add(node.moduleSpecifier.text);
    }
  });
  return imports;
}

function collectModuleLevelBindings(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isVariableStatement(node) && !hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
          if (!isConst) names.add(decl.name.text);
        }
      }
    }
  });
  return names;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function getExportKind(node: ts.FunctionDeclaration): "named" | "default" {
  const modifiers = ts.getModifiers(node);
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return "default";
  return "named";
}

function unwrapParenthesized(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
