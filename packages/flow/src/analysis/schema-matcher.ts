import ts from "typescript";
import type { RuntimeSchemaInfo } from "../extractor/runtime-schema.js";
import {
  findNamedType,
  createProgram,
  collectSourceFiles,
  extractTypeShape,
} from "../extractor/typescript.js";
import type { ShapeField } from "../schema/shapes.js";

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
  // Strategy 1: Name convention
  const candidates = generateCandidateNames(schema.name);
  for (const candidate of candidates) {
    const found = findNamedType(checker, program, candidate);
    if (found) {
      return {
        schema,
        typeName: candidate,
        typeFilePath: found.filePath,
        typeLine: found.line,
        tsTypeShape: extractTypeShape(checker, found.type),
        confidence: "high",
        matchReason: `Name convention: ${schema.name} → ${candidate}`,
      };
    }
  }

  // Strategy 2: Find .parse()/.safeParse()/.validate() call sites and resolve argument types
  const castMatch = findCastMatch(schema, program, checker);
  if (castMatch) return castMatch;

  // Strategy 3: Inferred type from z.infer<typeof schema>
  const inferMatch = findInferMatch(schema, program, checker);
  if (inferMatch) return inferMatch;

  return null;
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
