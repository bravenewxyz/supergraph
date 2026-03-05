import { parse, registerDynamicLanguage } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import type { SymbolEdge } from "../schema/edges.js";
import { createSymbolEdge } from "../schema/edges.js";
import type { SymbolNode } from "../schema/nodes.js";
import { createSymbolNode } from "../schema/nodes.js";

// Register Go language once
let goRegistered = false;
function ensureGoRegistered(): void {
  if (goRegistered) return;

  // If AST_GREP_LANG_GO_PATH is set (standalone binary), use it directly
  // to construct the lang config instead of importing the package (which
  // would try to dlopen from a path that doesn't exist outside node_modules).
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
    // Normal mode: import from package (works in dev / bun run)
    const goLang = require("@ast-grep/lang-go");
    registerDynamicLanguage({ go: goLang.default ?? goLang });
  }
  goRegistered = true;
}

export interface ParseResult {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
}

function makeId(): string {
  return crypto.randomUUID();
}

function qualifiedName(modName: string, symbolName: string): string {
  return `${modName}.${symbolName}`;
}

function getSourceRange(node: SgNode): { startLine: number; endLine: number } {
  const range = node.range();
  return { startLine: range.start.line, endLine: range.end.line };
}

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

// ---------------------------------------------------------------------------
// Package clause
// ---------------------------------------------------------------------------

function extractPackageName(root: SgNode): string {
  const pkgClause = root.find({ rule: { kind: "package_clause" } });
  if (!pkgClause) return "main";
  const pkgId = pkgClause.find({ rule: { kind: "package_identifier" } });
  return pkgId?.text() ?? "main";
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function extractImports(
  root: SgNode,
  moduleId: string,
  edges: SymbolEdge[],
): void {
  const importDecls = root.findAll({ rule: { kind: "import_declaration" } });
  for (const decl of importDecls) {
    const specs = decl.findAll({ rule: { kind: "import_spec" } });
    for (const spec of specs) {
      const pathNode = spec.field("path");
      if (!pathNode) continue;
      const importPath = pathNode.text().replace(/"/g, "");
      const alias = spec.field("name")?.text() ?? undefined;

      edges.push(
        createSymbolEdge({
          id: makeId(),
          kind: "imports",
          sourceId: moduleId,
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

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

function extractFunctions(
  root: SgNode,
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
): void {
  const funcs = root.findAll({ rule: { kind: "function_declaration" } });
  for (const func of funcs) {
    const name = func.field("name")?.text();
    if (!name) continue;

    const params = func.field("parameters")?.text() ?? "()";
    const result = func.field("result")?.text() ?? "";
    const body = func.field("body")?.text() ?? "";
    const exported = isGoExported(name);
    const id = makeId();
    const qn = qualifiedName(modName, name);
    const retStr = result ? ` ${result}` : "";

    nodes.push(
      createSymbolNode({
        id,
        kind: "function",
        name,
        qualifiedName: qn,
        parentId: moduleId,
        signature: `${name}${params}${retStr}`,
        typeText: result,
        exported,
        body,
        sourceRange: getSourceRange(func),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: moduleId,
        targetId: id,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Methods (with receiver)
// ---------------------------------------------------------------------------

function extractMethods(
  root: SgNode,
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
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

    // Extract receiver type name (e.g., "(m *MyStruct)" → "MyStruct")
    const receiverTypeName = extractReceiverType(receiver);

    // Find the parent struct if it exists in this file
    const parentId = receiverTypeName
      ? (structIds.get(receiverTypeName) ?? moduleId)
      : moduleId;
    const parentPrefix = receiverTypeName ?? "";

    const id = makeId();
    const qn = qualifiedName(
      modName,
      parentPrefix ? `${parentPrefix}.${name}` : name,
    );

    nodes.push(
      createSymbolNode({
        id,
        kind: "method",
        name,
        qualifiedName: qn,
        parentId,
        signature: `${name}${params}${retStr}`,
        typeText: result,
        exported,
        body,
        modifiers: receiver ? [`receiver:${receiver}`] : [],
        sourceRange: getSourceRange(method),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: parentId,
        targetId: id,
      }),
    );
  }
}

/** Extract the type name from a Go receiver: "(m *MyStruct)" → "MyStruct" */
function extractReceiverType(receiver: string): string | null {
  // Match patterns: (m MyStruct), (m *MyStruct), (*MyStruct)
  const match = receiver.match(/\*?(\w+)\s*\)/);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Type declarations (struct, interface, type alias)
// ---------------------------------------------------------------------------

function extractTypes(
  root: SgNode,
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
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
      const qn = qualifiedName(modName, name);

      if (typeKind === "struct_type") {
        structIds.set(name, id);

        const body = typeNode.text();
        nodes.push(
          createSymbolNode({
            id,
            kind: "class", // Map Go struct → class (closest analogy)
            name,
            qualifiedName: qn,
            parentId: moduleId,
            signature: `type ${name} struct`,
            typeText: "",
            exported,
            body,
            sourceRange: getSourceRange(decl),
          }),
        );

        edges.push(
          createSymbolEdge({
            id: makeId(),
            kind: "contains",
            sourceId: moduleId,
            targetId: id,
          }),
        );

        // Extract struct fields
        extractStructFields(typeNode, modName, name, id, nodes, edges);
      } else if (typeKind === "interface_type") {
        const body = typeNode.text();
        nodes.push(
          createSymbolNode({
            id,
            kind: "interface",
            name,
            qualifiedName: qn,
            parentId: moduleId,
            signature: `type ${name} interface`,
            typeText: "",
            exported,
            body,
            sourceRange: getSourceRange(decl),
          }),
        );

        edges.push(
          createSymbolEdge({
            id: makeId(),
            kind: "contains",
            sourceId: moduleId,
            targetId: id,
          }),
        );

        // Extract interface methods
        extractInterfaceMethods(typeNode, modName, name, id, nodes, edges);
      } else {
        // Type alias: type Foo = Bar, or named type: type Foo int
        const typeText = typeNode.text();
        nodes.push(
          createSymbolNode({
            id,
            kind: "type-alias",
            name,
            qualifiedName: qn,
            parentId: moduleId,
            signature: `type ${name} = ${typeText}`,
            typeText,
            exported,
            body: typeText,
            sourceRange: getSourceRange(decl),
          }),
        );

        edges.push(
          createSymbolEdge({
            id: makeId(),
            kind: "contains",
            sourceId: moduleId,
            targetId: id,
          }),
        );
      }
    }
  }
}

function extractStructFields(
  structNode: SgNode,
  modName: string,
  structName: string,
  structId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
): void {
  const fields = structNode.findAll({ rule: { kind: "field_declaration" } });
  for (const field of fields) {
    const name = field.field("name")?.text();
    if (!name) continue; // Embedded field (no name) — skip for now

    const fieldType = field.field("type")?.text() ?? "";
    const tag = field.field("tag")?.text() ?? "";
    const exported = isGoExported(name);
    const id = makeId();
    const qn = qualifiedName(modName, `${structName}.${name}`);

    nodes.push(
      createSymbolNode({
        id,
        kind: "property",
        name,
        qualifiedName: qn,
        parentId: structId,
        signature: `${name} ${fieldType}`,
        typeText: fieldType,
        exported,
        body: tag,
        sourceRange: getSourceRange(field),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: structId,
        targetId: id,
      }),
    );
  }
}

function extractInterfaceMethods(
  ifaceNode: SgNode,
  modName: string,
  ifaceName: string,
  ifaceId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
): void {
  // Interface methods are method_elem children
  const methodElems = ifaceNode.findAll({ rule: { kind: "method_elem" } });
  for (const me of methodElems) {
    const children = me.children();
    // First field_identifier is the method name
    const nameNode = children.find((c) => c.kind() === "field_identifier");
    if (!nameNode) continue;

    const name = nameNode.text();
    const exported = isGoExported(name);

    // parameter_list is params, type_identifier or parameter_list after it is return type
    const paramNode = children.find((c) => c.kind() === "parameter_list");
    const params = paramNode?.text() ?? "()";

    // Everything after params but not the params itself is the return type
    const allChildren = children.filter(
      (c) => c.kind() !== "field_identifier" && c.kind() !== "parameter_list",
    );
    const resultText = allChildren
      .map((c) => c.text())
      .join(" ")
      .trim();
    const retStr = resultText ? ` ${resultText}` : "";

    const id = makeId();
    const qn = qualifiedName(modName, `${ifaceName}.${name}`);

    nodes.push(
      createSymbolNode({
        id,
        kind: "method",
        name,
        qualifiedName: qn,
        parentId: ifaceId,
        signature: `${name}${params}${retStr}`,
        typeText: resultText,
        exported,
        body: "",
        modifiers: ["abstract"], // Interface method = abstract
        sourceRange: getSourceRange(me),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: ifaceId,
        targetId: id,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Constants and Variables
// ---------------------------------------------------------------------------

function extractConstants(
  root: SgNode,
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
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
      const id = makeId();
      const qn = qualifiedName(modName, name);

      nodes.push(
        createSymbolNode({
          id,
          kind: "variable",
          name,
          qualifiedName: qn,
          parentId: moduleId,
          signature: `const ${name}${typeText ? ` ${typeText}` : ""}`,
          typeText,
          exported,
          body: value,
          modifiers: ["const"],
          sourceRange: getSourceRange(spec),
        }),
      );

      edges.push(
        createSymbolEdge({
          id: makeId(),
          kind: "contains",
          sourceId: moduleId,
          targetId: id,
        }),
      );
    }
  }
}

function extractVariables(
  root: SgNode,
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
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
      const id = makeId();
      const qn = qualifiedName(modName, name);

      nodes.push(
        createSymbolNode({
          id,
          kind: "variable",
          name,
          qualifiedName: qn,
          parentId: moduleId,
          signature: `var ${name}${typeText ? ` ${typeText}` : ""}`,
          typeText,
          exported,
          body: value,
          modifiers: ["var"],
          sourceRange: getSourceRange(spec),
        }),
      );

      edges.push(
        createSymbolEdge({
          id: makeId(),
          kind: "contains",
          sourceId: moduleId,
          targetId: id,
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

export function parseGo(code: string, filePath: string): ParseResult {
  ensureGoRegistered();

  const nodes: SymbolNode[] = [];
  const edges: SymbolEdge[] = [];

  const tree = parse("go", code);
  const root = tree.root();

  const modName = goFilePathToModuleName(filePath);
  const moduleId = makeId();
  const packageName = extractPackageName(root);

  // Module node
  nodes.push(
    createSymbolNode({
      id: moduleId,
      kind: "module",
      name: modName,
      qualifiedName: modName,
      signature: `package ${packageName}`,
      exported: true,
      sourceRange: { startLine: 0, endLine: code.split("\n").length - 1 },
    }),
  );

  // Track struct IDs for method → struct parent linking
  const structIds = new Map<string, string>();

  extractImports(root, moduleId, edges);
  extractTypes(root, modName, moduleId, nodes, edges, structIds);
  extractFunctions(root, modName, moduleId, nodes, edges);
  extractMethods(root, modName, moduleId, nodes, edges, structIds);
  extractConstants(root, modName, moduleId, nodes, edges);
  extractVariables(root, modName, moduleId, nodes, edges);

  return { nodes, edges };
}
