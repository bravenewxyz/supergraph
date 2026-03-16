// ── 6. Enum/union exhaustiveness gap scan ───────────────────────────

import ts from "typescript";
import { relative } from "node:path";
import type { ExhaustivenessGap } from "./types.js";

export function scanExhaustivenessGaps(
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

export function analyzeSwitchExhaustiveness(
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
