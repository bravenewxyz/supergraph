import ts from "typescript";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ShapeField, ShapeType } from "../schema/shapes.js";

const MAX_DEPTH = 12;

export async function collectSourceFiles(srcDir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(full);
      } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  }
  await walk(resolve(srcDir));
  return files;
}

export function createProgram(
  files: string[],
  tsConfigPath?: string,
): ts.Program {
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowJs: true,
  };

  if (tsConfigPath) {
    const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        resolve(tsConfigPath, ".."),
      );
      compilerOptions = { ...parsed.options, noEmit: true };
    }
  }

  return ts.createProgram(files, compilerOptions);
}

export function findNamedType(
  checker: ts.TypeChecker,
  program: ts.Program,
  typeName: string,
): { type: ts.Type; filePath: string; line: number } | undefined {
  let result: { type: ts.Type; filePath: string; line: number } | undefined;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    ts.forEachChild(sourceFile, function visit(node) {
      if (result) return;
      if (
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name.text === typeName
      ) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) {
          result = {
            type: checker.getDeclaredTypeOfSymbol(symbol),
            filePath: sourceFile.fileName,
            line:
              sourceFile.getLineAndCharacterOfPosition(node.getStart()).line +
              1,
          };
        }
      }
      if (!result) ts.forEachChild(node, visit);
    });
    if (result) break;
  }

  return result;
}

export function resolveExpressionType(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  position: number,
): ShapeType | null {
  function findNodeAt(node: ts.Node): ts.Node | undefined {
    if (position >= node.getStart() && position < node.getEnd()) {
      let found: ts.Node | undefined;
      ts.forEachChild(node, (child) => {
        if (!found) found = findNodeAt(child);
      });
      return found ?? node;
    }
    return undefined;
  }

  const targetNode = findNodeAt(sourceFile);
  if (!targetNode) return null;

  const type = checker.getTypeAtLocation(targetNode);
  return resolveType(checker, type);
}

export function extractTypeShape(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number = 0,
  seen?: WeakSet<ts.Type>,
): ShapeField[] {
  if (depth > MAX_DEPTH) return [];

  const fields: ShapeField[] = [];
  for (const prop of type.getProperties()) {
    const propType = checker.getTypeOfSymbol(prop);
    const declarations = prop.getDeclarations();
    const optional = declarations?.some(
      (d) => !!(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.None) &&
        ts.isPropertySignature(d) && !!d.questionToken,
    ) ?? false;

    fields.push({
      name: prop.name,
      type: resolveType(checker, propType, depth + 1, seen),
      optional,
    });
  }
  return fields;
}

export function resolveType(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number = 0,
  seen?: WeakSet<ts.Type>,
): ShapeType {
  if (depth > MAX_DEPTH) return { kind: "opaque", raw: checker.typeToString(type) };

  if (!seen) seen = new WeakSet();
  if (seen.has(type)) return { kind: "ref", name: checker.typeToString(type) };
  seen.add(type);

  const flags = type.getFlags();

  if (flags & ts.TypeFlags.String) return { kind: "primitive", value: "string" };
  if (flags & ts.TypeFlags.Number) return { kind: "primitive", value: "number" };
  if (flags & ts.TypeFlags.Boolean) return { kind: "primitive", value: "boolean" };
  if (flags & ts.TypeFlags.Null) return { kind: "primitive", value: "null" };
  if (flags & ts.TypeFlags.Undefined) return { kind: "primitive", value: "undefined" };
  if (flags & ts.TypeFlags.Void) return { kind: "primitive", value: "void" };
  if (flags & ts.TypeFlags.Never) return { kind: "primitive", value: "never" };
  if (flags & ts.TypeFlags.BigInt) return { kind: "primitive", value: "bigint" };
  if (flags & ts.TypeFlags.ESSymbol) return { kind: "primitive", value: "symbol" };
  if (flags & ts.TypeFlags.Any) return { kind: "primitive", value: "any" };
  if (flags & ts.TypeFlags.Unknown) return { kind: "primitive", value: "unknown" };

  if (type.isStringLiteral()) return { kind: "literal", value: type.value };
  if (type.isNumberLiteral()) return { kind: "literal", value: type.value };
  if (flags & ts.TypeFlags.BooleanLiteral) {
    const intrinsicName = (type as { intrinsicName?: string }).intrinsicName;
    return { kind: "literal", value: intrinsicName === "true" };
  }

  if (type.isUnion()) {
    const members = type.types.map((t) => resolveType(checker, t, depth + 1, seen));
    return { kind: "union", members };
  }

  if (type.isIntersection()) {
    const members = type.types.map((t) => resolveType(checker, t, depth + 1, seen));
    return { kind: "intersection", members };
  }

  if (flags & ts.TypeFlags.Object) {
    const objFlags = (type as ts.ObjectType).objectFlags;
    const typeStr = checker.typeToString(type);

    if (checker.isArrayType(type)) {
      const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
      const elem = typeArgs[0];
      return {
        kind: "array",
        element: elem
          ? resolveType(checker, elem, depth + 1, seen)
          : { kind: "primitive", value: "unknown" },
      };
    }

    if (checker.isTupleType(type)) {
      const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
      return {
        kind: "tuple",
        elements: typeArgs.map((t) => ({
          type: resolveType(checker, t, depth + 1, seen),
          optional: false,
        })),
      };
    }

    const symbol = type.getSymbol();
    const name = symbol?.getName();

    if (name === "Date") return { kind: "date" };
    if (name === "RegExp") return { kind: "regex" };

    if (name === "Map" || name === "__type" && typeStr.startsWith("Map<")) {
      const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
      if (typeArgs.length >= 2) {
        return {
          kind: "map",
          key: resolveType(checker, typeArgs[0]!, depth + 1, seen),
          value: resolveType(checker, typeArgs[1]!, depth + 1, seen),
        };
      }
    }

    if (name === "Set") {
      const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
      if (typeArgs.length >= 1) {
        return {
          kind: "set",
          element: resolveType(checker, typeArgs[0]!, depth + 1, seen),
        };
      }
    }

    if (name === "Promise") {
      const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
      if (typeArgs.length >= 1) {
        return {
          kind: "promise",
          resolved: resolveType(checker, typeArgs[0]!, depth + 1, seen),
        };
      }
    }

    const callSigs = type.getCallSignatures();
    if (callSigs.length > 0 && type.getProperties().length === 0) {
      const sig = callSigs[0]!;
      const params = sig
        .getParameters()
        .map((p) => resolveType(checker, checker.getTypeOfSymbol(p), depth + 1, seen));
      const ret = resolveType(checker, sig.getReturnType(), depth + 1, seen);
      return { kind: "function", params, returnType: ret };
    }

    const stringIndex = type.getStringIndexType();
    const props = type.getProperties();
    if (stringIndex && props.length === 0) {
      return {
        kind: "record",
        key: { kind: "primitive", value: "string" },
        value: resolveType(checker, stringIndex, depth + 1, seen),
      };
    }

    const numberIndex = type.getNumberIndexType();
    if (numberIndex && props.length === 0) {
      return {
        kind: "record",
        key: { kind: "primitive", value: "number" },
        value: resolveType(checker, numberIndex, depth + 1, seen),
      };
    }

    if (props.length > 0) {
      const fields = extractTypeShape(checker, type, depth, seen);
      return { kind: "object", fields };
    }

    if (objFlags & ts.ObjectFlags.Reference) {
      const refName = symbol?.getName() ?? typeStr;
      return { kind: "ref", name: refName };
    }
  }

  if (flags & ts.TypeFlags.Enum || flags & ts.TypeFlags.EnumLiteral) {
    if (type.isUnion()) {
      const values = type.types
        .map((t) => {
          if (t.isStringLiteral()) return t.value;
          if (t.isNumberLiteral()) return t.value;
          return undefined;
        })
        .filter((v): v is string | number => v !== undefined);
      if (values.length > 0) return { kind: "enum", values };
    }
  }

  return { kind: "opaque", raw: checker.typeToString(type) };
}
