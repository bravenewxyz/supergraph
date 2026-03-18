import ts from "typescript";
import type { RuntimeSchemaInfo } from "../extractor/runtime-schema.js";
import {
  findNamedType,
  createProgram,
  collectSourceFiles,
  extractTypeShape,
} from "../extractor/typescript.js";
import type { ShapeField, ShapeType } from "../schema/shapes.js";

export interface SchemaTypeMatch {
  schema: RuntimeSchemaInfo;
  typeName: string;
  typeFilePath: string;
  typeLine: number;
  tsTypeShape: ShapeField[];
  confidence: "high" | "medium" | "low";
  matchReason: string;
}

export interface MatcherOptions {
  srcDir: string;
  tsConfigPath?: string;
  program?: ts.Program;
  checker?: ts.TypeChecker;
}

export async function matchSchemasToTypes(
  schemas: RuntimeSchemaInfo[],
  options: MatcherOptions,
): Promise<SchemaTypeMatch[]> {
  let program = options.program;
  let checker = options.checker;

  if (!program) {
    const files = await collectSourceFiles(options.srcDir);
    program = createProgram(files, options.tsConfigPath);
    checker = program.getTypeChecker();
  }
  if (!checker) checker = program.getTypeChecker();

  const matches: SchemaTypeMatch[] = [];

  for (const schema of schemas) {
    const match = findMatchForSchema(schema, program, checker);
    if (match) matches.push(match);
  }

  return matches;
}

function findMatchForSchema(
  schema: RuntimeSchemaInfo,
  program: ts.Program,
  checker: ts.TypeChecker,
): SchemaTypeMatch | null {
  // Strategy 1: Inferred type from z.infer<typeof schema> — explicit link, highest confidence
  const inferMatch = findInferMatch(schema, program, checker);
  if (inferMatch) return inferMatch;

  // Strategy 2: Find .parse()/.safeParse()/.validate() call sites and resolve cast types
  const castMatch = findCastMatch(schema, program, checker);
  if (castMatch) return castMatch;

  // Strategy 3: Trace validated data to consuming function parameter types
  const consumerMatch = findConsumerMatch(schema, program, checker);
  if (consumerMatch) return consumerMatch;

  // Strategy 4: Name convention — lowest confidence, validated by field overlap
  return findNameConventionMatch(schema, program, checker);
}

function generateCandidateNames(schemaName: string): string[] {
  const suffixes = ["Schema", "Validator", "Checker", "Validation", "Shape", "Zod"];
  let base = schemaName;
  for (const suffix of suffixes) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }

  if (!base || base.length < 2) return [];

  const capitalized = base.charAt(0).toUpperCase() + base.slice(1);

  return [
    capitalized,
    `${capitalized}Type`,
    `${capitalized}Data`,
    `I${capitalized}`,
    `${capitalized}Input`,
    `${capitalized}Output`,
    `${capitalized}Config`,
    `${capitalized}Options`,
    `${capitalized}Params`,
    `${capitalized}Args`,
    `${capitalized}Request`,
    `${capitalized}Payload`,
    `${capitalized}Body`,
    base,
  ];
}

function findCastMatch(
  schema: RuntimeSchemaInfo,
  program: ts.Program,
  checker: ts.TypeChecker,
): SchemaTypeMatch | null {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    const castType = findAsExpressionAfterSchema(
      sourceFile,
      schema.name,
      checker,
    );
    if (castType) {
      const props = castType.type.getProperties();
      if (props.length > 0) {
        const symbol = castType.type.getSymbol();
        const typeName = symbol?.getName() ?? checker.typeToString(castType.type);
        const decl = symbol?.getDeclarations()?.[0];
        const declFile = decl?.getSourceFile();

        return {
          schema,
          typeName,
          typeFilePath: declFile?.fileName ?? sourceFile.fileName,
          typeLine: decl && declFile
            ? declFile.getLineAndCharacterOfPosition(decl.getStart()).line + 1
            : 0,
          tsTypeShape: extractTypeShape(checker, castType.type),
          confidence: "medium",
          matchReason: `Cast after validation: ${schema.name}.${castType.method}(...) → as ${typeName}`,
        };
      }
    }
  }
  return null;
}

function findAsExpressionAfterSchema(
  sourceFile: ts.SourceFile,
  schemaName: string,
  checker: ts.TypeChecker,
): { type: ts.Type; method: string } | null {
  let result: { type: ts.Type; method: string } | null = null;

  function visit(node: ts.Node): void {
    if (result) return;

    if (ts.isAsExpression(node)) {
      const expr = node.expression;
      const exprText = expr.getText(sourceFile);
      if (
        exprText.includes(`${schemaName}.parse`) ||
        exprText.includes(`${schemaName}.safeParse`)
      ) {
        const type = checker.getTypeAtLocation(node);
        const method = exprText.includes("safeParse") ? "safeParse" : "parse";
        result = { type, method };
        return;
      }

      if (ts.isPropertyAccessExpression(expr) && expr.name.text === "data") {
        const objExpr = expr.expression;
        const objText = objExpr.getText(sourceFile);
        if (
          objText.includes(`${schemaName}.safeParse`) ||
          objText.includes(`${schemaName}.parse`)
        ) {
          const type = checker.getTypeAtLocation(node);
          const method = "safeParse";
          result = { type, method };
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function findInferMatch(
  schema: RuntimeSchemaInfo,
  program: ts.Program,
  checker: ts.TypeChecker,
): SchemaTypeMatch | null {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    let found: SchemaTypeMatch | null = null;

    ts.forEachChild(sourceFile, function visit(node) {
      if (found) return;

      if (ts.isTypeAliasDeclaration(node)) {
        const typeNode = node.type;
        const typeText = typeNode.getText(sourceFile);
        if (
          typeText.includes(`z.infer<typeof ${schema.name}>`) ||
          typeText.includes(`z.output<typeof ${schema.name}>`) ||
          typeText.includes(`z.input<typeof ${schema.name}>`)
        ) {
          const symbol = checker.getSymbolAtLocation(node.name);
          if (symbol) {
            const type = checker.getDeclaredTypeOfSymbol(symbol);
            found = {
              schema,
              typeName: node.name.text,
              typeFilePath: sourceFile.fileName,
              typeLine:
                sourceFile.getLineAndCharacterOfPosition(node.getStart())
                  .line + 1,
              tsTypeShape: extractTypeShape(checker, type),
              confidence: "high",
              matchReason: `z.infer<typeof ${schema.name}> → ${node.name.text}`,
            };
          }
        }
      }

      if (!found) ts.forEachChild(node, visit);
    });

    if (found) return found;
  }

  return null;
}

/**
 * Strategy 3: Trace validated data to the function that consumes it.
 * Finds `schemaName.parse(...)` call sites, then checks if the result
 * is passed as an argument to a function — and resolves that function's
 * parameter type.
 */
function findConsumerMatch(
  schema: RuntimeSchemaInfo,
  program: ts.Program,
  checker: ts.TypeChecker,
): SchemaTypeMatch | null {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    let result: SchemaTypeMatch | null = null;

    ts.forEachChild(sourceFile, function visit(node) {
      if (result) return;

      // Find variable declarations: const x = schemaName.parse(...)
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
      ) {
        const callText = node.initializer.expression.getText(sourceFile);
        if (
          callText === `${schema.name}.parse` ||
          callText === `${schema.name}.safeParse`
        ) {
          // Found schema validation call. Now find where the variable is used
          // as a function argument in the same scope.
          const varName = node.name.getText(sourceFile);
          const parent = findContainingBlock(node);
          if (parent) {
            result = findConsumerOfVariable(
              varName,
              parent,
              sourceFile,
              schema,
              checker,
            );
          }
        }
      }

      // Also match: someFunction(schemaName.parse(...))
      // where the parse result is passed directly as an argument
      if (
        ts.isCallExpression(node) &&
        node.arguments.length > 0
      ) {
        for (let i = 0; i < node.arguments.length; i++) {
          const arg = node.arguments[i]!;
          if (ts.isCallExpression(arg)) {
            const callText = arg.expression.getText(sourceFile);
            if (
              callText === `${schema.name}.parse` ||
              callText === `${schema.name}.safeParse`
            ) {
              // Resolve the parameter type of the consuming function
              const sig = checker.getResolvedSignature(node);
              if (sig) {
                const params = sig.getParameters();
                if (params[i]) {
                  const paramType = checker.getTypeOfSymbol(params[i]!);
                  const fields = extractTypeShape(checker, paramType);
                  if (fields.length > 0) {
                    const symbol = paramType.getSymbol();
                    const typeName = symbol?.getName() ?? checker.typeToString(paramType);
                    const decl = symbol?.getDeclarations()?.[0];
                    const declFile = decl?.getSourceFile();
                    result = {
                      schema,
                      typeName: typeName === "__type" ? checker.typeToString(paramType) : typeName,
                      typeFilePath: declFile?.fileName ?? sourceFile.fileName,
                      typeLine: decl && declFile
                        ? declFile.getLineAndCharacterOfPosition(decl.getStart()).line + 1
                        : 0,
                      tsTypeShape: fields,
                      confidence: "high",
                      matchReason: `Call-site parameter type: ${schema.name}.parse() → param of ${node.expression.getText(sourceFile)}`,
                    };
                  }
                }
              }
            }
          }
        }
      }

      if (!result) ts.forEachChild(node, visit);
    });

    if (result) return result;
  }
  return null;
}

function findContainingBlock(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function findConsumerOfVariable(
  varName: string,
  block: ts.Node,
  sourceFile: ts.SourceFile,
  schema: RuntimeSchemaInfo,
  checker: ts.TypeChecker,
): SchemaTypeMatch | null {
  let result: SchemaTypeMatch | null = null;

  ts.forEachChild(block, function visit(node) {
    if (result) return;

    // Look for function calls where varName is passed as an argument
    if (ts.isCallExpression(node)) {
      for (let i = 0; i < node.arguments.length; i++) {
        const arg = node.arguments[i]!;
        if (ts.isIdentifier(arg) && arg.text === varName) {
          const sig = checker.getResolvedSignature(node);
          if (sig) {
            const params = sig.getParameters();
            if (params[i]) {
              const paramType = checker.getTypeOfSymbol(params[i]!);
              const fields = extractTypeShape(checker, paramType);
              if (fields.length > 0) {
                const symbol = paramType.getSymbol();
                const typeName = symbol?.getName() ?? checker.typeToString(paramType);
                const decl = symbol?.getDeclarations()?.[0];
                const declFile = decl?.getSourceFile();
                result = {
                  schema,
                  typeName: typeName === "__type" ? checker.typeToString(paramType) : typeName,
                  typeFilePath: declFile?.fileName ?? sourceFile.fileName,
                  typeLine: decl && declFile
                    ? declFile.getLineAndCharacterOfPosition(decl.getStart()).line + 1
                    : 0,
                  tsTypeShape: fields,
                  confidence: "high",
                  matchReason: `Call-site parameter type: ${varName} → param of ${node.expression.getText(sourceFile)}`,
                };
                return;
              }
            }
          }
        }
      }
    }

    if (!result) ts.forEachChild(node, visit);
  });

  return result;
}

/**
 * Strategy 4: Name convention with field-overlap scoring.
 * Generates candidate type names from the schema name, finds all matching types,
 * scores them by field overlap with the schema, and filters out low-confidence matches.
 */
function findNameConventionMatch(
  schema: RuntimeSchemaInfo,
  program: ts.Program,
  checker: ts.TypeChecker,
): SchemaTypeMatch | null {
  const candidates = generateCandidateNames(schema.name);
  const schemaFieldNames = getShapeFieldNames(schema.shape);

  // If the schema has no extractable fields, we can't score — return first match with low confidence
  if (schemaFieldNames.size === 0) {
    for (const candidate of candidates) {
      const found = findNamedType(checker, program, candidate);
      if (found) {
        return {
          schema,
          typeName: candidate,
          typeFilePath: found.filePath,
          typeLine: found.line,
          tsTypeShape: extractTypeShape(checker, found.type),
          confidence: "low",
          matchReason: `Name convention (no schema fields to verify): ${schema.name} → ${candidate}`,
        };
      }
    }
    return null;
  }

  // Collect all matching candidates with their field overlap scores
  interface ScoredCandidate {
    candidate: string;
    found: { type: ts.Type; filePath: string; line: number };
    typeFieldNames: Set<string>;
    overlapRatio: number;
    tsTypeShape: ShapeField[];
  }

  const scored: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    const found = findNamedType(checker, program, candidate);
    if (!found) continue;

    const tsTypeShape = extractTypeShape(checker, found.type);
    const typeFieldNames = new Set(tsTypeShape.map((f) => f.name));

    // Compute Jaccard-like field overlap ratio
    let intersection = 0;
    for (const f of schemaFieldNames) {
      if (typeFieldNames.has(f)) intersection++;
    }
    const unionSize = new Set([...schemaFieldNames, ...typeFieldNames]).size;
    const overlapRatio = unionSize > 0 ? intersection / unionSize : 0;

    scored.push({ candidate, found, typeFieldNames, overlapRatio, tsTypeShape });
  }

  if (scored.length === 0) return null;

  // Pick the candidate with highest overlap
  scored.sort((a, b) => b.overlapRatio - a.overlapRatio);
  const best = scored[0]!;

  // Creation pattern: schema has 1-3 fields but type has 10+ → likely a creation input
  const isCreationPattern =
    schemaFieldNames.size <= 3 && best.typeFieldNames.size >= 10;

  // Require minimum 25% field overlap to avoid false positives
  const MIN_OVERLAP = 0.25;
  if (best.overlapRatio < MIN_OVERLAP || isCreationPattern) {
    return null;
  }

  const confidence: SchemaTypeMatch["confidence"] =
    best.overlapRatio >= 0.6 ? "high" : best.overlapRatio >= 0.4 ? "medium" : "low";

  return {
    schema,
    typeName: best.candidate,
    typeFilePath: best.found.filePath,
    typeLine: best.found.line,
    tsTypeShape: best.tsTypeShape,
    confidence,
    matchReason: `Name convention (${Math.round(best.overlapRatio * 100)}% field overlap): ${schema.name} → ${best.candidate}`,
  };
}

function getShapeFieldNames(shape: ShapeType): Set<string> {
  if (shape.kind === "object") {
    return new Set(shape.fields.map((f) => f.name));
  }
  return new Set();
}
