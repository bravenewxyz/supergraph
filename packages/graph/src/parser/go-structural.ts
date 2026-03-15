import { parse, registerDynamicLanguage } from "@ast-grep/napi";
import {
  parseStructural,
  makeId,
  qualifiedName,
  getSourceRange,
  addSymbol,
  createSymbolEdge,
} from "./structural-core.js";
import type {
  ParseResult,
  ParseContext,
  LanguageConfig,
  SgNode,
} from "./structural-core.js";

export type { ParseResult };

// ─── Go language registration ───────────────────────────────────────────────

let goRegistered = false;
function ensureGoRegistered(): void {
  if (goRegistered) return;

  const envPath = process.env.AST_GREP_LANG_GO_PATH;
  if (envPath) {
    registerDynamicLanguage({
      go: {
        libraryPath: envPath,
        extensions: ["go"],
        languageSymbol: "tree_sitter_go",
        expandoChar: "µ",
      },
    });
  } else {
    const goLang = require("@ast-grep/lang-go");
    registerDynamicLanguage({ go: goLang.default ?? goLang });
  }
  goRegistered = true;
}

// ─── Go-specific helpers ────────────────────────────────────────────────────

/** In Go, exported symbols start with an uppercase letter */
function isGoExported(name: string): boolean {
  if (!name || name.length === 0) return false;
  const first = name.charCodeAt(0);
  return first >= 65 && first <= 90; // A-Z
}

/** Convert Go file path to module name: strip .go extension */
function goFilePathToModuleName(filePath: string): string {
  return filePath.replace(/\.go$/, "");
}

function extractPackageName(root: SgNode): string {
  const pkgClause = root.find({ rule: { kind: "package_clause" } });
  if (!pkgClause) return "main";
  const pkgId = pkgClause.find({ rule: { kind: "package_identifier" } });
  return pkgId?.text() ?? "main";
}

/** Extract the type name from a Go receiver: "(m *MyStruct)" -> "MyStruct" */
function extractReceiverType(receiver: string): string | null {
  const match = receiver.match(/\*?(\w+)\s*\)/);
  return match?.[1] ?? null;
}

// ─── Extraction functions ───────────────────────────────────────────────────

function extractImports(
  root: SgNode,
  ctx: ParseContext,
): void {
  const importDecls = root.findAll({ rule: { kind: "import_declaration" } });
  for (const decl of importDecls) {
    const specs = decl.findAll({ rule: { kind: "import_spec" } });
    for (const spec of specs) {
      const pathNode = spec.field("path");
      if (!pathNode) continue;
      const importPath = pathNode.text().replace(/"/g, "");
      const alias = spec.field("name")?.text() ?? undefined;

      ctx.edges.push(
        createSymbolEdge({
          id: makeId(),
          kind: "imports",
          sourceId: ctx.moduleId,
          targetId: importPath,
          metadata: {
            moduleSpecifier: importPath,
            alias,
            unresolved: true,
            raw: spec.text(),
          },
        }),
      );
    }
  }
}

function extractFunctions(
  root: SgNode,
  ctx: ParseContext,
): void {
  const funcs = root.findAll({ rule: { kind: "function_declaration" } });
  for (const func of funcs) {
    const name = func.field("name")?.text();
    if (!name) continue;

    const params = func.field("parameters")?.text() ?? "()";
    const result = func.field("result")?.text() ?? "";
    const body = func.field("body")?.text() ?? "";
    const exported = isGoExported(name);
    const retStr = result ? ` ${result}` : "";

    addSymbol(ctx, ctx.moduleId, {
      id: makeId(),
      kind: "function",
      name,
      qualifiedName: qualifiedName(ctx.modName, name),
      parentId: ctx.moduleId,
      signature: `${name}${params}${retStr}`,
      typeText: result,
      exported,
      body,
      sourceRange: getSourceRange(func),
    });
  }
}

function extractMethods(
  root: SgNode,
  ctx: ParseContext,
  structIds: Map<string, string>,
): void {
  const methods = root.findAll({ rule: { kind: "method_declaration" } });
  for (const method of methods) {
    const name = method.field("name")?.text();
    if (!name) continue;

    const receiver = method.field("receiver")?.text() ?? "";
    const params = method.field("parameters")?.text() ?? "()";
    const result = method.field("result")?.text() ?? "";
    const body = method.field("body")?.text() ?? "";
    const exported = isGoExported(name);
    const retStr = result ? ` ${result}` : "";

    const receiverTypeName = extractReceiverType(receiver);
    const parentId = receiverTypeName
      ? (structIds.get(receiverTypeName) ?? ctx.moduleId)
      : ctx.moduleId;
    const parentPrefix = receiverTypeName ?? "";

    addSymbol(ctx, parentId, {
      id: makeId(),
      kind: "method",
      name,
      qualifiedName: qualifiedName(
        ctx.modName,
        parentPrefix ? `${parentPrefix}.${name}` : name,
      ),
      parentId,
      signature: `${name}${params}${retStr}`,
      typeText: result,
      exported,
      body,
      modifiers: receiver ? [`receiver:${receiver}`] : [],
      sourceRange: getSourceRange(method),
    });
  }
}

function extractTypes(
  root: SgNode,
  ctx: ParseContext,
  structIds: Map<string, string>,
): void {
  const typeDecls = root.findAll({ rule: { kind: "type_declaration" } });
  for (const decl of typeDecls) {
    const specs = decl.findAll({ rule: { kind: "type_spec" } });
    for (const spec of specs) {
      const name = spec.field("name")?.text();
      if (!name) continue;

      const typeNode = spec.field("type");
      if (!typeNode) continue;

      const typeKind = typeNode.kind();
      const exported = isGoExported(name);
      const id = makeId();

      if (typeKind === "struct_type") {
        structIds.set(name, id);

        const body = typeNode.text();
        addSymbol(ctx, ctx.moduleId, {
          id,
          kind: "class", // Map Go struct -> class (closest analogy)
          name,
          qualifiedName: qualifiedName(ctx.modName, name),
          parentId: ctx.moduleId,
          signature: `type ${name} struct`,
          typeText: "",
          exported,
          body,
          sourceRange: getSourceRange(decl),
        });

        extractStructFields(typeNode, name, id, ctx);
      } else if (typeKind === "interface_type") {
        const body = typeNode.text();
        addSymbol(ctx, ctx.moduleId, {
          id,
          kind: "interface",
          name,
          qualifiedName: qualifiedName(ctx.modName, name),
          parentId: ctx.moduleId,
          signature: `type ${name} interface`,
          typeText: "",
          exported,
          body,
          sourceRange: getSourceRange(decl),
        });

        extractInterfaceMethods(typeNode, name, id, ctx);
      } else {
        // Type alias or named type
        const typeText = typeNode.text();
        addSymbol(ctx, ctx.moduleId, {
          id,
          kind: "type-alias",
          name,
          qualifiedName: qualifiedName(ctx.modName, name),
          parentId: ctx.moduleId,
          signature: `type ${name} = ${typeText}`,
          typeText,
          exported,
          body: typeText,
          sourceRange: getSourceRange(decl),
        });
      }
    }
  }
}

function extractStructFields(
  structNode: SgNode,
  structName: string,
  structId: string,
  ctx: ParseContext,
): void {
  const fields = structNode.findAll({ rule: { kind: "field_declaration" } });
  for (const field of fields) {
    const name = field.field("name")?.text();
    if (!name) continue; // Embedded field — skip for now

    const fieldType = field.field("type")?.text() ?? "";
    const tag = field.field("tag")?.text() ?? "";
    const exported = isGoExported(name);

    addSymbol(ctx, structId, {
      id: makeId(),
      kind: "property",
      name,
      qualifiedName: qualifiedName(ctx.modName, `${structName}.${name}`),
      parentId: structId,
      signature: `${name} ${fieldType}`,
      typeText: fieldType,
      exported,
      body: tag,
      sourceRange: getSourceRange(field),
    });
  }
}

function extractInterfaceMethods(
  ifaceNode: SgNode,
  ifaceName: string,
  ifaceId: string,
  ctx: ParseContext,
): void {
  const methodElems = ifaceNode.findAll({ rule: { kind: "method_elem" } });
  for (const me of methodElems) {
    const children = me.children();
    const nameNode = children.find((c) => c.kind() === "field_identifier");
    if (!nameNode) continue;

    const name = nameNode.text();
    const exported = isGoExported(name);

    const paramNode = children.find((c) => c.kind() === "parameter_list");
    const params = paramNode?.text() ?? "()";

    const allChildren = children.filter(
      (c) => c.kind() !== "field_identifier" && c.kind() !== "parameter_list",
    );
    const resultText = allChildren
      .map((c) => c.text())
      .join(" ")
      .trim();
    const retStr = resultText ? ` ${resultText}` : "";

    addSymbol(ctx, ifaceId, {
      id: makeId(),
      kind: "method",
      name,
      qualifiedName: qualifiedName(ctx.modName, `${ifaceName}.${name}`),
      parentId: ifaceId,
      signature: `${name}${params}${retStr}`,
      typeText: resultText,
      exported,
      body: "",
      modifiers: ["abstract"],
      sourceRange: getSourceRange(me),
    });
  }
}

function extractConstants(
  root: SgNode,
  ctx: ParseContext,
): void {
  const constDecls = root.findAll({ rule: { kind: "const_declaration" } });
  for (const decl of constDecls) {
    const specs = decl.findAll({ rule: { kind: "const_spec" } });
    for (const spec of specs) {
      const name = spec.field("name")?.text();
      if (!name) continue;

      const typeText = spec.field("type")?.text() ?? "";
      const value = spec.field("value")?.text() ?? "";
      const exported = isGoExported(name);

      addSymbol(ctx, ctx.moduleId, {
        id: makeId(),
        kind: "variable",
        name,
        qualifiedName: qualifiedName(ctx.modName, name),
        parentId: ctx.moduleId,
        signature: `const ${name}${typeText ? ` ${typeText}` : ""}`,
        typeText,
        exported,
        body: value,
        modifiers: ["const"],
        sourceRange: getSourceRange(spec),
      });
    }
  }
}

function extractVariables(
  root: SgNode,
  ctx: ParseContext,
): void {
  const varDecls = root.findAll({ rule: { kind: "var_declaration" } });
  for (const decl of varDecls) {
    const specs = decl.findAll({ rule: { kind: "var_spec" } });
    for (const spec of specs) {
      const name = spec.field("name")?.text();
      if (!name) continue;

      const typeText = spec.field("type")?.text() ?? "";
      const value = spec.field("value")?.text() ?? "";
      const exported = isGoExported(name);

      addSymbol(ctx, ctx.moduleId, {
        id: makeId(),
        kind: "variable",
        name,
        qualifiedName: qualifiedName(ctx.modName, name),
        parentId: ctx.moduleId,
        signature: `var ${name}${typeText ? ` ${typeText}` : ""}`,
        typeText,
        exported,
        body: value,
        modifiers: ["var"],
        sourceRange: getSourceRange(spec),
      });
    }
  }
}

// ─── Language config ────────────────────────────────────────────────────────

const goConfig: LanguageConfig = {
  parseRoot(code: string, _filePath: string): SgNode {
    ensureGoRegistered();
    return parse("go", code).root();
  },

  filePathToModuleName: goFilePathToModuleName,

  moduleSignature(root: SgNode, _modName: string): string {
    return `package ${extractPackageName(root)}`;
  },

  extract(root: SgNode, ctx: ParseContext): void {
    // Track struct IDs for method -> struct parent linking
    const structIds = new Map<string, string>();

    extractImports(root, ctx);
    extractTypes(root, ctx, structIds);
    extractFunctions(root, ctx);
    extractMethods(root, ctx, structIds);
    extractConstants(root, ctx);
    extractVariables(root, ctx);
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────

export function parseGo(code: string, filePath: string): ParseResult {
  return parseStructural(code, filePath, goConfig);
}
