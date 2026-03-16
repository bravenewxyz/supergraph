// ── 1. Cross-representation scan (schema vs type) ──────────────────
// Uses dataflow tracing instead of name guessing. Strategies are tried
// in priority order: z.infer ground truth > .parse() dataflow >
// Hono middleware inference > name-convention fallback.

import { readFile } from "node:fs/promises";
import ts from "typescript";
import { ExtractorRegistry } from "../../extractor/runtime-schema.js";
import type { RuntimeSchemaInfo } from "../../extractor/runtime-schema.js";
import { ZodExtractor } from "../../extractor/zod.js";
import { matchSchemasToTypes } from "../../analysis/schema-matcher.js";
import { diffShapes } from "../../analysis/shape-differ.js";
import type { ShapeType, ShapeField } from "../../schema/shapes.js";
import type { CrossRepField, CrossRepMismatch } from "./types.js";
import { createProgram, extractTypeShape } from "../../extractor/typescript.js";

// ── helpers ─────────────────────────────────────────────────────────

function resolveRefs(
  shape: ShapeType,
  byName: Map<string, RuntimeSchemaInfo>,
  seen: Set<string> = new Set(),
): ShapeType {
  if (shape.kind === "ref" && !shape.resolved) {
    if (seen.has(shape.name)) return shape;
    seen.add(shape.name);
    const target = byName.get(shape.name);
    if (target) return resolveRefs(target.shape, byName, seen);
  }
  if (shape.kind === "object") {
    return { ...shape, fields: shape.fields.map((f) => ({ ...f, type: resolveRefs(f.type, byName, seen) })) };
  }
  if (shape.kind === "array") return { ...shape, element: resolveRefs(shape.element, byName, seen) };
  if (shape.kind === "union") return { ...shape, members: shape.members.map((m) => resolveRefs(m, byName, seen)) };
  return shape;
}

/**
 * Diff a schema shape against a resolved TypeScript type shape and push
 * any mismatches into the output array. Shared by all strategies.
 */
function collectMismatches(
  schema: RuntimeSchemaInfo,
  schemaName: string,
  typeName: string,
  typeFields: ShapeField[],
  out: CrossRepMismatch[],
  _strategy: "infer" | "dataflow" | "hono" | "name",
): void {
  const schemaFields =
    schema.shape.kind === "object" ? schema.shape.fields : null;
  if (!schemaFields || typeFields.length === 0) return;

  const shapeMismatches = diffShapes(schemaFields, typeFields, "", {
    leftLabel: `schema "${schemaName}"`,
    rightLabel: `type "${typeName}"`,
  });

  for (const sm of shapeMismatches) {
    const fieldName = sm.path.split(".")[0] ?? sm.path;
    const schemaField = schemaFields.find((f) => f.name === fieldName);
    const typeField = typeFields.find((f) => f.name === fieldName);

    // Focus on what matters: optionality conflicts and type mismatches on
    // SHARED fields are real bugs. Extra/missing fields are usually expected
    // (input schemas validate a subset, full types include computed fields).
    // Only report extra/missing for strategy "infer" (z.infer should be exact).
    if (sm.category === "extra-field" && _strategy !== "infer") continue;
    if (sm.category === "missing-field" && _strategy !== "infer") continue;

    // Skip findings against anonymous types for non-dataflow strategies.
    // Anonymous types (e.g. `{ owner: string; taskIds: string[] }`) from Hono
    // middleware or name-fallback matching are often paired with the WRONG
    // schema — the same schema name exists in multiple routes and the checker
    // resolves a partial type from a different handler. Only trust named types
    // (matched via name convention to a real domain type) and z.infer/dataflow
    // matches (which trace exact code paths).
    if (_strategy !== "infer" && _strategy !== "dataflow" && typeName.startsWith("{")) continue;

    const field: CrossRepField = {
      fieldName,
      schemaOptional: schemaField?.optional ?? false,
      typeOptional: typeField?.optional ?? true,
    };

    let mismatchKind: string;
    switch (sm.category) {
      case "optionality":
        mismatchKind = "schema-type-optionality";
        break;
      case "missing-field":
        mismatchKind = "schema-type-missing-field";
        break;
      case "extra-field":
        mismatchKind = "schema-type-extra-field";
        break;
      case "type-mismatch":
        mismatchKind = "schema-type-mismatch";
        break;
      case "union-coverage":
        mismatchKind = "schema-type-union-coverage";
        break;
      default:
        mismatchKind = `schema-type-${sm.category}`;
    }

    out.push({
      schemaName,
      typeName,
      field,
      mismatchKind,
      message: sm.message,
    });
  }
}

/**
 * Returns true when the resolved type is useful for comparison (not `any`,
 * not `unknown`, not empty). When the TS checker cannot resolve Zod types
 * (e.g. missing node_modules) it returns `any` — we fall back in that case.
 */
function isUsableType(checker: ts.TypeChecker, type: ts.Type): boolean {
  const flags = type.getFlags();
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) return false;
  const str = checker.typeToString(type);
  if (str === "any" || str === "unknown") return false;
  return true;
}

// ── dataflow tracing helpers ─────────────────────────────────────────

/**
 * Walk up from a node to find the containing block (function body, arrow body,
 * or source file top-level). This is the scope we search for variable usages.
 */
function findContainingBlock(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isBlock(current)) return current;
    if (ts.isSourceFile(current)) return current;
    if (ts.isArrowFunction(current) && current.body) {
      return ts.isBlock(current.body) ? current.body : current.body;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Search a block for places where `varSymbol` is passed as an argument to a
 * function call. When found, resolve the parameter's declared type — that's
 * the "destination type" the schema result flows into.
 *
 * Also handles:
 *   - Type annotations on the variable itself: `const body: TaskInput = ...`
 *   - Return statements in typed functions: `return body` where fn returns TaskInput
 */
function findDestinationType(
  checker: ts.TypeChecker,
  varSymbol: ts.Symbol,
  block: ts.Node,
  varName: string,
): ts.Type | null {
  let result: ts.Type | null = null;

  function walk(node: ts.Node): void {
    if (result) return;

    // Case 1: Variable is passed as a function argument
    //   fn(body) → get fn's parameter type for that position
    if (ts.isCallExpression(node)) {
      for (let i = 0; i < node.arguments.length; i++) {
        const arg = node.arguments[i]!;
        if (ts.isIdentifier(arg) && arg.text === varName) {
          // Verify it's the same symbol, not a shadowed variable
          const argSymbol = checker.getSymbolAtLocation(arg);
          if (argSymbol === varSymbol) {
            const sig = checker.getResolvedSignature(node);
            if (sig && sig.parameters.length > i) {
              const paramType = checker.getTypeOfSymbol(sig.parameters[i]!);
              if (paramType) {
                result = paramType;
                return;
              }
            }
          }
        }
        // Case 1b: Variable is spread into a function argument
        //   fn({ ...body, extra }) → still counts, get param type
        if (ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression) && prop.expression.text === varName) {
              const argSymbol = checker.getSymbolAtLocation(prop.expression);
              if (argSymbol === varSymbol) {
                const sig = checker.getResolvedSignature(node);
                if (sig && sig.parameters.length > i) {
                  result = checker.getTypeOfSymbol(sig.parameters[i]!);
                  return;
                }
              }
            }
          }
        }
      }
    }

    // Case 2: Variable has an explicit type annotation
    //   const body: TaskInput = schema.parse(...)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === varName && node.type) {
      const annotationType = checker.getTypeAtLocation(node.type);
      if (annotationType) {
        result = annotationType;
        return;
      }
    }

    // Case 3: Variable is returned from a function with a return type
    //   function handler(): TaskOutput { return body; }
    if (ts.isReturnStatement(node) && node.expression && ts.isIdentifier(node.expression) && node.expression.text === varName) {
      const argSymbol = checker.getSymbolAtLocation(node.expression);
      if (argSymbol === varSymbol) {
        // Walk up to find the containing function and get its return type
        let parent: ts.Node | undefined = node.parent;
        while (parent) {
          if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
            const fnType = checker.getTypeAtLocation(parent);
            const signatures = fnType.getCallSignatures();
            if (signatures.length > 0) {
              const retType = checker.getReturnTypeOfSignature(signatures[0]!);
              // Unwrap Promise<T> → T
              const retStr = checker.typeToString(retType);
              if (retStr.startsWith("Promise<")) {
                const typeArgs = (retType as any).typeArguments;
                if (typeArgs && typeArgs.length > 0) {
                  result = typeArgs[0];
                  return;
                }
              }
              result = retType;
              return;
            }
            break;
          }
          parent = parent.parent;
        }
      }
    }

    ts.forEachChild(node, walk);
  }

  walk(block);
  return result;
}

// ── main entry point ────────────────────────────────────────────────

export async function crossRepScan(
  files: string[],
  resolvedDir: string,
  shared?: { program: ts.Program; checker: ts.TypeChecker },
): Promise<CrossRepMismatch[]> {
  // 1. Extract all Zod schemas via AST
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
  for (const schema of allSchemas) {
    schema.shape = resolveRefs(schema.shape, byName);
  }

  // 2. Get or create TypeScript program
  const program = shared?.program ?? createProgram(files);
  const checker = shared?.checker ?? program.getTypeChecker();

  const matched = new Set<string>(); // schema names already matched
  const mismatches: CrossRepMismatch[] = [];

  // ── Strategy 1: z.infer ground truth (highest confidence) ───────
  // Find `type X = z.infer<typeof someSchema>` declarations. These are
  // explicit pairings — the TypeScript checker can resolve X's shape
  // which we compare against the schema's shape.
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isTypeAliasDeclaration(node)) {
        const typeText = node.type.getText(sourceFile);
        const inferMatch = typeText.match(
          /z\.(?:infer|output|input)\s*<\s*typeof\s+(\w+)\s*>/,
        );
        if (inferMatch) {
          const schemaName = inferMatch[1]!;
          const schema = byName.get(schemaName);
          if (schema && schema.shape.kind === "object" && !matched.has(schemaName)) {
            const symbol = checker.getSymbolAtLocation(node.name);
            if (symbol) {
              const resolvedType = checker.getDeclaredTypeOfSymbol(symbol);
              if (isUsableType(checker, resolvedType)) {
                const typeShape = extractTypeShape(checker, resolvedType);
                if (typeShape.length > 0) {
                  const typeName = node.name.text;
                  matched.add(schemaName);
                  collectMismatches(schema, schemaName, typeName, typeShape, mismatches, "infer");
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }

  // ── Strategy 2: .parse() / .safeParse() dataflow (high confidence) ──
  // Find where the .parse() result FLOWS TO — what typed parameter or
  // typed variable it ends up in. Comparing schema vs its own return type
  // is circular; comparing schema vs the DESTINATION type catches real drift.
  //
  // Pattern: const body = schema.parse(x); fn(body) → compare schema vs fn's param type
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    ts.forEachChild(sourceFile, function visit(node) {
      // Look for: const VAR = SCHEMA.parse(DATA) or SCHEMA.safeParse(DATA)
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isPropertyAccessExpression(node.initializer.expression)
      ) {
        const methodName = node.initializer.expression.name.text;
        if (methodName !== "parse" && methodName !== "safeParse") {
          ts.forEachChild(node, visit);
          return;
        }

        const schemaExpr = node.initializer.expression.expression;
        const schemaName = ts.isIdentifier(schemaExpr) ? schemaExpr.text : null;
        if (!schemaName || !byName.has(schemaName) || matched.has(schemaName)) {
          ts.forEachChild(node, visit);
          return;
        }

        const schema = byName.get(schemaName)!;
        if (schema.shape.kind !== "object") {
          ts.forEachChild(node, visit);
          return;
        }

        // Get the symbol for the result variable (e.g., `body`)
        const varSymbol = checker.getSymbolAtLocation(node.name);
        if (!varSymbol) {
          ts.forEachChild(node, visit);
          return;
        }

        // Walk the containing block/function to find where this variable
        // is passed as an argument to a typed function.
        const container = findContainingBlock(node);
        if (!container) {
          ts.forEachChild(node, visit);
          return;
        }

        const destType = findDestinationType(checker, varSymbol, container, node.name.text);
        if (destType && isUsableType(checker, destType)) {
          const typeShape = extractTypeShape(checker, destType);
          if (typeShape.length > 0) {
            const typeName = checker.typeToString(destType);
            // Skip anonymous inline types — they're just the schema's own output
            // repeated by the checker. Only compare against named types.
            if (!typeName.startsWith("{")) {
              matched.add(schemaName);
              collectMismatches(schema, schemaName, typeName, typeShape, mismatches, "dataflow");
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }

  // ── Strategy 3: Hono middleware inference (medium confidence) ─────
  // Patterns: zValidator("json", schema), validateJson(schema), validateQuery(schema)
  // For these, the schema shape IS the validated type (Hono infers
  // z.infer<typeof schema> internally). The useful check is whether the
  // route handler accesses fields that are not in the schema. We scan for
  // `c.req.valid("json")` usage and check property accesses against the
  // schema shape.
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    // First, find all schemas used in Hono validation middleware calls
    const honoSchemas = new Map<string, string>(); // schemaName -> middleware kind

    ts.forEachChild(sourceFile, function findMiddleware(node) {
      if (ts.isCallExpression(node)) {
        const fnText = node.expression.getText(sourceFile);
        let kind: string | null = null;
        let schemaArg: ts.Expression | null = null;

        if (
          (fnText === "validateJson" || fnText === "validateQuery" || fnText === "validateParam") &&
          node.arguments.length >= 1
        ) {
          kind = fnText.replace("validate", "").toLowerCase();
          schemaArg = node.arguments[0]!;
        } else if (fnText === "zValidator" && node.arguments.length >= 2) {
          // zValidator("json", schema) — first arg is the target string
          const targetArg = node.arguments[0]!;
          if (ts.isStringLiteral(targetArg)) {
            kind = targetArg.text;
          }
          schemaArg = node.arguments[1]!;
        }

        if (kind && schemaArg && ts.isIdentifier(schemaArg)) {
          const schemaName = schemaArg.text;
          if (byName.has(schemaName) && !matched.has(schemaName)) {
            honoSchemas.set(schemaName, kind);
          }
        }
      }
      ts.forEachChild(node, findMiddleware);
    });

    if (honoSchemas.size === 0) continue;

    // Now find c.req.valid("json"|"query") calls and check their usage
    ts.forEachChild(sourceFile, function findValidCalls(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "valid" &&
        node.arguments.length >= 1
      ) {
        const validTarget = node.arguments[0]!;
        if (!ts.isStringLiteral(validTarget)) {
          ts.forEachChild(node, findValidCalls);
          return;
        }

        const validKind = validTarget.text; // "json", "query", etc.

        // Find which schema corresponds to this valid() kind
        let matchedSchemaName: string | null = null;
        for (const [name, kind] of honoSchemas) {
          if (kind === validKind) {
            matchedSchemaName = name;
            break;
          }
        }
        if (!matchedSchemaName) {
          ts.forEachChild(node, findValidCalls);
          return;
        }

        // Resolve the type that the checker infers for this call expression
        const validType = checker.getTypeAtLocation(node);
        if (isUsableType(checker, validType)) {
          const typeShape = extractTypeShape(checker, validType);
          const schema = byName.get(matchedSchemaName)!;
          if (schema.shape.kind === "object" && typeShape.length > 0) {
            const typeName = checker.typeToString(validType);
            matched.add(matchedSchemaName);
            collectMismatches(schema, matchedSchemaName, typeName, typeShape, mismatches, "hono");
          }
        }
      }
      ts.forEachChild(node, findValidCalls);
    });
  }

  // ── Strategy 4: Name-convention fallback (low confidence) ────────
  // For schemas not matched by strategies 1-3, fall back to the existing
  // name-based matching heuristic from schema-matcher.
  const unmatchedSchemas = allSchemas.filter((s) => !matched.has(s.name));
  if (unmatchedSchemas.length > 0) {
    const fallbackMatches = await matchSchemasToTypes(unmatchedSchemas, {
      srcDir: resolvedDir,
      program,
      checker,
    });

    // Deduplicate: if the same schema name appears multiple times (e.g., defined
    // in multiple route files), keep only the first match to avoid duplicate reports.
    const seenSchemas = new Set<string>();

    for (const match of fallbackMatches) {
      if (seenSchemas.has(match.schema.name)) continue;
      seenSchemas.add(match.schema.name);

      const typeFields: ShapeField[] | null =
        match.tsTypeShape.length > 0 ? match.tsTypeShape : null;
      if (!typeFields) continue;

      const schema = match.schema;
      if (schema.shape.kind !== "object") continue;

      collectMismatches(
        schema,
        schema.name,
        match.typeName,
        typeFields,
        mismatches,
        "name",
      );
    }
  }

  return mismatches;
}
