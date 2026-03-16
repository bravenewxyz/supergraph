// ── 3. Status determination scan ────────────────────────────────────

import ts from "typescript";
import { relative } from "node:path";
import { resolveType } from "../../extractor/typescript.js";
import { shapeToString } from "../../schema/shapes.js";
import { countBranches, STATUS_KEYWORDS, STATUS_VALUES, BOOL_PREDICATE_NAME } from "../util.js";
import type { StatusFunction } from "./types.js";

export function scanStatusFunctions(
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

export function tryExtractStatusFunction(
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
