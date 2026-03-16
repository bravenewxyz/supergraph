import { parse, Lang } from "@ast-grep/napi";
import {
  parseStructural,
  makeId,
  qualifiedName,
  getSourceRange,
  addSymbol,
  createSymbolEdge,
  createSymbolNode,
} from "./structural-core.js";
import type {
  ParseResult,
  ParseContext,
  LanguageConfig,
  SgNode,
  SymbolNode,
  SymbolEdge,
  SymbolKind,
} from "./structural-core.js";
import { filePathToModuleName } from "../projector/module-layout.js";

export type { ParseResult };

// ─── TS-specific helpers ────────────────────────────────────────────────────

/** Strip leading `: ` from type annotations (ast-grep includes the colon) */
function stripTypeAnnotationPrefix(text: string): string {
  return text.replace(/^:\s*/, "");
}

function hasModifier(node: SgNode, modifier: string): boolean {
  const text = node.text();
  const parent = node.parent();
  if (parent && parent.kind() === "export_statement") {
    if (modifier === "export") return true;
  }
  const beforeName = text.split(node.field("name")?.text() ?? "")[0] ?? "";
  return beforeName.includes(modifier);
}

function isExported(node: SgNode): boolean {
  const parent = node.parent();
  if (parent && parent.kind() === "export_statement") return true;
  const text = node.text();
  return text.trimStart().startsWith("export ");
}

function isDefaultExport(node: SgNode): boolean {
  const parent = node.parent();
  if (!parent || parent.kind() !== "export_statement") return false;
  for (const child of parent.children()) {
    if (child.kind() === "default") return true;
  }
  return false;
}

function collectPrecedingDecorators(target: SgNode, parent: SgNode): string[] {
  const decorators: string[] = [];
  const siblings = parent.children();
  const pendingDecorators: string[] = [];
  for (const sib of siblings) {
    if (sib.kind() === "decorator") {
      pendingDecorators.push(sib.text());
    } else if (sib.kind() === target.kind() && sib.text() === target.text()) {
      decorators.push(...pendingDecorators);
      pendingDecorators.length = 0;
    } else if (sib.kind() !== "export" && sib.kind() !== "default") {
      pendingDecorators.length = 0;
    }
  }
  return decorators;
}

function collectDecorators(node: SgNode): string[] {
  const decorators: string[] = [];

  const parent = node.parent();
  if (parent) {
    if (parent.kind() === "export_statement") {
      for (const sib of parent.children()) {
        if (sib.kind() === "decorator") {
          decorators.push(sib.text());
        }
      }
    } else {
      decorators.push(...collectPrecedingDecorators(node, parent));
    }
  }

  for (const child of node.children()) {
    if (child.kind() === "decorator") {
      decorators.push(child.text());
    }
  }

  return decorators;
}

function collectMethodDecorators(method: SgNode): string[] {
  const decorators: string[] = [];
  const parent = method.parent();
  if (!parent) return decorators;

  const siblings = parent.children();
  let prevWasDecorator = false;
  const pendingDecorators: string[] = [];
  for (const sib of siblings) {
    if (sib.kind() === "decorator") {
      pendingDecorators.push(sib.text());
      prevWasDecorator = true;
    } else {
      if (sib.kind() === method.kind() && sib.text() === method.text() && prevWasDecorator) {
        decorators.push(...pendingDecorators);
      }
      pendingDecorators.length = 0;
      prevWasDecorator = false;
    }
  }
  return decorators;
}

function collectModifiers(node: SgNode): string[] {
  const mods: string[] = [];
  const text = node.text();
  const nameField = node.field("name");
  const beforeName = nameField ? text.split(nameField.text())[0] ?? "" : text;

  if (beforeName.includes("async")) mods.push("async");
  if (beforeName.includes("static")) mods.push("static");
  if (beforeName.includes("readonly")) mods.push("readonly");
  if (beforeName.includes("abstract")) mods.push("abstract");
  if (beforeName.includes("override")) mods.push("override");
  if (beforeName.includes("private")) mods.push("private");
  if (beforeName.includes("protected")) mods.push("protected");
  if (beforeName.includes("public")) mods.push("public");
  if (beforeName.includes("declare")) mods.push("declare");

  return mods;
}

function getTypeParams(node: SgNode): string {
  return node.field("type_parameters")?.text() ?? "";
}

function buildSignature(
  kind: string,
  name: string,
  node: SgNode,
  mods: string[],
): string {
  const tp = getTypeParams(node);
  switch (kind) {
    case "function": {
      const params = node.field("parameters")?.text() ?? "()";
      const ret = node.field("return_type")?.text() ?? "";
      return `${name}${tp}${params}${ret}`;
    }
    case "method": {
      const params = node.field("parameters")?.text() ?? "()";
      const ret = node.field("return_type")?.text() ?? "";
      return `${name}${tp}${params}${ret}`;
    }
    case "class": {
      return `class ${name}${tp}`;
    }
    case "interface": {
      return `interface ${name}${tp}`;
    }
    case "type-alias": {
      const value = node.field("value")?.text() ?? "";
      return `type ${name}${tp} = ${value}`;
    }
    case "enum": {
      return `enum ${name}`;
    }
    case "variable": {
      const typeAnn = node.field("type")?.text() ?? "";
      return `${name}${typeAnn}`;
    }
    case "namespace": {
      return `namespace ${name}`;
    }
    default:
      return name;
  }
}

// ─── Extraction functions ───────────────────────────────────────────────────

function extractFunctions(
  root: SgNode,
  ctx: ParseContext,
): void {
  const funcs = root.findAll({ rule: { kind: "function_declaration" } });
  for (const func of funcs) {
    if (isNestedInClass(func)) continue;
    if (isNestedInNamespace(func)) continue;
    if (isNestedDeclaration(func)) continue;

    const name = func.field("name")?.text();
    if (!name) continue;

    const exported = isExported(func);
    const mods = collectModifiers(func);
    if (isDefaultExport(func)) mods.push("default");
    const retTypeRaw = func.field("return_type")?.text() ?? "";
    const retType = stripTypeAnnotationPrefix(retTypeRaw);
    const body = func.field("body")?.text() ?? "";

    addSymbol(ctx, ctx.moduleId, {
      id: makeId(),
      kind: "function",
      name,
      qualifiedName: qualifiedName(ctx.modName, name),
      parentId: ctx.moduleId,
      signature: buildSignature("function", name, func, mods),
      typeText: retType,
      exported,
      body,
      modifiers: mods,
      sourceRange: getSourceRange(func),
    });
  }
}

function isNestedInClass(node: SgNode): boolean {
  let current = node.parent();
  while (current) {
    const kind = current.kind();
    if (kind === "class_declaration" || kind === "abstract_class_declaration" || kind === "class") return true;
    current = current.parent();
  }
  return false;
}

function extractClasses(
  root: SgNode,
  ctx: ParseContext,
): void {
  const regularClasses = root.findAll({ rule: { kind: "class_declaration" } });
  const abstractClasses = root.findAll({ rule: { kind: "abstract_class_declaration" } });
  const allClasses = [...regularClasses, ...abstractClasses];
  for (const cls of allClasses) {
    if (isNestedInNamespace(cls)) continue;

    const name = cls.field("name")?.text();
    if (!name) continue;

    const exported = isExported(cls);
    const mods = collectModifiers(cls);
    if (isDefaultExport(cls)) mods.push("default");
    const decorators = collectDecorators(cls);
    const body = cls.field("body")?.text() ?? "";
    const classId = makeId();
    const classQn = qualifiedName(ctx.modName, name);

    addSymbol(ctx, ctx.moduleId, {
      id: classId,
      kind: "class",
      name,
      qualifiedName: classQn,
      parentId: ctx.moduleId,
      signature: buildSignature("class", name, cls, mods),
      typeText: "",
      exported,
      body,
      decorators,
      modifiers: mods,
      sourceRange: getSourceRange(cls),
    });

    extractHeritage(cls, classId, ctx);

    const classBody = cls.field("body");
    if (classBody) {
      extractMethods(classBody, name, classId, ctx);
      extractProperties(classBody, name, classId, ctx);
    }
  }
}

function extractHeritage(
  cls: SgNode,
  classId: string,
  ctx: ParseContext,
): void {
  const allChildren = cls.children();
  for (const child of allChildren) {
    const kind = child.kind();
    if (kind === "class_heritage") {
      const heritageChildren = child.children();
      for (const hc of heritageChildren) {
        const hkind = hc.kind();
        if (hkind === "extends_clause") {
          const typeName = extractHeritageTypeName(hc);
          if (typeName) {
            ctx.edges.push(
              createSymbolEdge({
                id: makeId(),
                kind: "extends",
                sourceId: classId,
                targetId: typeName,
                metadata: { targetName: typeName, unresolved: true },
              }),
            );
          }
        } else if (hkind === "implements_clause") {
          const typeNames = extractHeritageTypeNames(hc);
          for (const tn of typeNames) {
            ctx.edges.push(
              createSymbolEdge({
                id: makeId(),
                kind: "implements",
                sourceId: classId,
                targetId: tn,
                metadata: { targetName: tn, unresolved: true },
              }),
            );
          }
        }
      }
    }
  }
}

function extractHeritageTypeName(clause: SgNode): string | null {
  const children = clause.children();
  for (const child of children) {
    const k = child.kind();
    if (k === "identifier" || k === "type_identifier") {
      return child.text();
    }
    if (k === "member_expression") {
      return child.text();
    }
    if (k === "generic_type") {
      const nameNode = child.children()[0];
      return nameNode ? nameNode.text() : null;
    }
  }
  return null;
}

function extractHeritageTypeNames(clause: SgNode): string[] {
  const names: string[] = [];
  const children = clause.children();
  for (const child of children) {
    const k = child.kind();
    if (k === "identifier" || k === "type_identifier") {
      names.push(child.text());
    } else if (k === "generic_type") {
      const nameNode = child.children()[0];
      if (nameNode) names.push(nameNode.text());
    }
  }
  return names;
}

function detectGetterSetter(method: SgNode): "getter" | "setter" | null {
  for (const child of method.children()) {
    if (child.kind() === "get") return "getter";
    if (child.kind() === "set") return "setter";
  }
  return null;
}

function extractMethods(
  classBody: SgNode,
  className: string,
  classId: string,
  ctx: ParseContext,
): void {
  const concreteMethods = classBody.findAll({
    rule: { kind: "method_definition" },
  });
  const abstractMethods = classBody.findAll({
    rule: { kind: "abstract_method_signature" },
  });
  const allMethods = [...concreteMethods, ...abstractMethods];

  for (const method of allMethods) {
    const name = method.field("name")?.text();
    if (!name) continue;

    const isAbstract = method.kind() === "abstract_method_signature";
    const mods = collectModifiers(method);
    if (isAbstract && !mods.includes("abstract")) {
      mods.push("abstract");
    }

    const getterSetter = detectGetterSetter(method);
    if (getterSetter) mods.push(getterSetter);

    const decorators = collectMethodDecorators(method);

    const retTypeRaw = method.field("return_type")?.text() ?? "";
    const retType = stripTypeAnnotationPrefix(retTypeRaw);
    const body = isAbstract ? "" : (method.field("body")?.text() ?? "");

    addSymbol(ctx, classId, {
      id: makeId(),
      kind: "method",
      name,
      qualifiedName: qualifiedName(ctx.modName, `${className}.${name}`),
      parentId: classId,
      signature: buildSignature("method", name, method, mods),
      typeText: retType,
      exported: false,
      body,
      decorators,
      modifiers: mods,
      sourceRange: getSourceRange(method),
    });
  }
}

function extractProperties(
  classBody: SgNode,
  className: string,
  classId: string,
  ctx: ParseContext,
): void {
  const props = classBody.findAll({
    rule: { kind: "public_field_definition" },
  });
  for (const prop of props) {
    const name = prop.field("name")?.text();
    if (!name) continue;

    const mods = collectModifiers(prop);
    const isPrivateField = name.startsWith("#");
    if (isPrivateField && !mods.includes("private")) {
      mods.push("private");
    }

    const decorators = collectDecorators(prop);
    const typeAnnRaw = prop.field("type")?.text() ?? "";
    const typeAnn = stripTypeAnnotationPrefix(typeAnnRaw);
    const value = prop.field("value")?.text() ?? "";

    addSymbol(ctx, classId, {
      id: makeId(),
      kind: "property",
      name,
      qualifiedName: qualifiedName(ctx.modName, `${className}.${name}`),
      parentId: classId,
      signature: `${name}${typeAnnRaw}`,
      typeText: typeAnn,
      exported: false,
      body: value,
      decorators,
      modifiers: mods,
      sourceRange: getSourceRange(prop),
    });
  }
}

function extractInterfaces(
  root: SgNode,
  ctx: ParseContext,
): void {
  const ifaces = root.findAll({ rule: { kind: "interface_declaration" } });
  for (const iface of ifaces) {
    if (isNestedInNamespace(iface)) continue;

    const name = iface.field("name")?.text();
    if (!name) continue;

    const exported = isExported(iface);
    const body = iface.field("body")?.text() ?? "";
    const id = makeId();

    // Extract index signatures from the interface body
    const indexSigs: string[] = [];
    const ifaceBody = iface.field("body");
    if (ifaceBody) {
      const idxSigNodes = ifaceBody.findAll({ rule: { kind: "index_signature" } });
      for (const sig of idxSigNodes) {
        indexSigs.push(sig.text());
      }
    }

    addSymbol(ctx, ctx.moduleId, {
      id,
      kind: "interface",
      name,
      qualifiedName: qualifiedName(ctx.modName, name),
      parentId: ctx.moduleId,
      signature: buildSignature("interface", name, iface, []),
      typeText: "",
      exported,
      body,
      sourceRange: getSourceRange(iface),
    });

    // Store index signatures as property symbols on the interface
    for (const sigText of indexSigs) {
      addSymbol(ctx, id, {
        id: makeId(),
        kind: "property",
        name: "[index]",
        qualifiedName: qualifiedName(ctx.modName, `${name}.[index]`),
        parentId: id,
        signature: sigText,
        typeText: sigText,
        exported: false,
        body: "",
        sourceRange: null,
      });
    }
  }
}

function extractTypeAliases(
  root: SgNode,
  ctx: ParseContext,
): void {
  const types = root.findAll({ rule: { kind: "type_alias_declaration" } });
  for (const ta of types) {
    if (isNestedInNamespace(ta)) continue;

    const name = ta.field("name")?.text();
    if (!name) continue;

    const exported = isExported(ta);
    const value = ta.field("value")?.text() ?? "";

    addSymbol(ctx, ctx.moduleId, {
      id: makeId(),
      kind: "type-alias",
      name,
      qualifiedName: qualifiedName(ctx.modName, name),
      parentId: ctx.moduleId,
      signature: buildSignature("type-alias", name, ta, []),
      typeText: value,
      exported,
      body: value,
      sourceRange: getSourceRange(ta),
    });
  }
}

function extractEnums(
  root: SgNode,
  ctx: ParseContext,
): void {
  const enums = root.findAll({ rule: { kind: "enum_declaration" } });
  for (const en of enums) {
    if (isNestedInNamespace(en)) continue;

    const name = en.field("name")?.text();
    if (!name) continue;

    const exported = isExported(en);
    const body = en.field("body")?.text() ?? "";
    const id = makeId();

    addSymbol(ctx, ctx.moduleId, {
      id,
      kind: "enum",
      name,
      qualifiedName: qualifiedName(ctx.modName, name),
      parentId: ctx.moduleId,
      signature: buildSignature("enum", name, en, []),
      typeText: "",
      exported,
      body,
      sourceRange: getSourceRange(en),
    });

    // Extract enum members
    const enumBody = en.field("body");
    if (enumBody) {
      const allChildren = enumBody.children();
      for (const child of allChildren) {
        if (
          child.kind() === "property_identifier" ||
          child.kind() === "enum_assignment"
        ) {
          const memberName =
            child.kind() === "enum_assignment"
              ? (child.field("name")?.text() ?? child.children()[0]?.text())
              : child.text();
          if (!memberName) continue;

          addSymbol(ctx, id, {
            id: makeId(),
            kind: "enum-member",
            name: memberName,
            qualifiedName: qualifiedName(ctx.modName, `${name}.${memberName}`),
            parentId: id,
            signature: memberName,
            typeText: "",
            exported: false,
            body: child.kind() === "enum_assignment" ? child.text() : "",
            sourceRange: getSourceRange(child),
          });
        }
      }
    }
  }
}

function extractVariables(
  root: SgNode,
  ctx: ParseContext,
): void {
  const lexDecls = root.findAll({ rule: { kind: "lexical_declaration" } });
  for (const decl of lexDecls) {
    if (isNestedDeclaration(decl)) continue;
    if (isNestedInNamespace(decl)) continue;

    const exported = isExported(decl);
    const declKind = decl.text().trimStart().startsWith("const")
      ? "const"
      : "let";

    const declarators = decl.children().filter(
      (c) => c.kind() === "variable_declarator",
    );
    for (const declarator of declarators) {
      const name = declarator.field("name")?.text();
      if (!name) continue;

      const typeAnnRaw = declarator.field("type")?.text() ?? "";
      const typeAnn = stripTypeAnnotationPrefix(typeAnnRaw);
      const valueNode = declarator.field("value");
      const value = valueNode?.text() ?? "";

      const isArrowFn = valueNode !== null && valueNode.kind() === "arrow_function";
      const kind: SymbolKind = isArrowFn ? "function" : "variable";

      const mods = [declKind];
      if (isArrowFn && value.trimStart().startsWith("async")) {
        mods.push("async");
      }

      addSymbol(ctx, ctx.moduleId, {
        id: makeId(),
        kind,
        name,
        qualifiedName: qualifiedName(ctx.modName, name),
        parentId: ctx.moduleId,
        signature: kind === "function" ? `${name}${typeAnnRaw}` : `${declKind} ${name}${typeAnnRaw}`,
        typeText: typeAnn,
        exported,
        body: value,
        modifiers: mods,
        sourceRange: getSourceRange(decl),
      });
    }
  }
}

function isNestedInNamespace(node: SgNode): boolean {
  let current = node.parent();
  while (current) {
    const kind = current.kind();
    if (kind === "internal_module") return true;
    if (kind === "program") return false;
    current = current.parent();
  }
  return false;
}

function isNestedDeclaration(node: SgNode): boolean {
  let current = node.parent();
  while (current) {
    const kind = current.kind();
    if (
      kind === "function_declaration" ||
      kind === "method_definition" ||
      kind === "arrow_function" ||
      kind === "class_declaration" ||
      kind === "class"
    ) {
      return true;
    }
    if (kind === "program" || kind === "export_statement" || kind === "internal_module") return false;
    current = current.parent();
  }
  return false;
}

function extractNamespaces(
  root: SgNode,
  ctx: ParseContext,
): void {
  const nsMods = root.findAll({ rule: { kind: "internal_module" } });
  for (const nsMod of nsMods) {
    // Only top-level namespaces (not nested)
    let parent = nsMod.parent();
    while (parent && (parent.kind() === "export_statement" || parent.kind() === "expression_statement")) {
      parent = parent.parent();
    }
    if (parent && parent.kind() !== "program") continue;

    const name = nsMod.field("name")?.text();
    if (!name) continue;

    const exported = isExported(nsMod);
    const body = nsMod.field("body")?.text() ?? "";
    const nsId = makeId();

    addSymbol(ctx, ctx.moduleId, {
      id: nsId,
      kind: "namespace",
      name,
      qualifiedName: qualifiedName(ctx.modName, name),
      parentId: ctx.moduleId,
      signature: buildSignature("namespace", name, nsMod, []),
      typeText: "",
      exported,
      body,
      sourceRange: getSourceRange(nsMod),
    });

    // Extract members inside the namespace
    const nsBody = nsMod.field("body");
    if (nsBody) {
      extractNamespaceMembers(nsBody, name, nsId, ctx);
    }
  }
}

function extractNamespaceMembers(
  nsBody: SgNode,
  nsName: string,
  nsId: string,
  ctx: ParseContext,
): void {
  // Functions inside namespace
  const funcs = nsBody.findAll({ rule: { kind: "function_declaration" } });
  for (const func of funcs) {
    if (isNestedDeclaration(func)) continue;
    const name = func.field("name")?.text();
    if (!name) continue;

    const exported = isExported(func);
    const mods = collectModifiers(func);
    const retTypeRaw = func.field("return_type")?.text() ?? "";
    const retType = stripTypeAnnotationPrefix(retTypeRaw);
    const body = func.field("body")?.text() ?? "";

    addSymbol(ctx, nsId, {
      id: makeId(),
      kind: "function",
      name,
      qualifiedName: qualifiedName(ctx.modName, `${nsName}.${name}`),
      parentId: nsId,
      signature: buildSignature("function", name, func, mods),
      typeText: retType,
      exported,
      body,
      modifiers: mods,
      sourceRange: getSourceRange(func),
    });
  }

  // Variables inside namespace
  const lexDecls = nsBody.findAll({ rule: { kind: "lexical_declaration" } });
  for (const decl of lexDecls) {
    if (isNestedDeclaration(decl)) continue;
    const exported = isExported(decl);
    const declKind = decl.text().trimStart().startsWith("const") ? "const" : "let";

    const declarators = decl.children().filter(
      (c) => c.kind() === "variable_declarator",
    );
    for (const declarator of declarators) {
      const name = declarator.field("name")?.text();
      if (!name) continue;

      const typeAnnRaw = declarator.field("type")?.text() ?? "";
      const typeAnn = stripTypeAnnotationPrefix(typeAnnRaw);
      const valueNode = declarator.field("value");
      const value = valueNode?.text() ?? "";

      const isArrowFn = valueNode !== null && valueNode.kind() === "arrow_function";
      const kind: SymbolKind = isArrowFn ? "function" : "variable";
      const mods = [declKind];

      addSymbol(ctx, nsId, {
        id: makeId(),
        kind,
        name,
        qualifiedName: qualifiedName(ctx.modName, `${nsName}.${name}`),
        parentId: nsId,
        signature: kind === "function" ? `${name}${typeAnnRaw}` : `${declKind} ${name}${typeAnnRaw}`,
        typeText: typeAnn,
        exported,
        body: value,
        modifiers: mods,
        sourceRange: getSourceRange(decl),
      });
    }
  }

  // Interfaces inside namespace
  const ifaces = nsBody.findAll({ rule: { kind: "interface_declaration" } });
  for (const iface of ifaces) {
    const name = iface.field("name")?.text();
    if (!name) continue;

    const exported = isExported(iface);
    const body = iface.field("body")?.text() ?? "";

    addSymbol(ctx, nsId, {
      id: makeId(),
      kind: "interface",
      name,
      qualifiedName: qualifiedName(ctx.modName, `${nsName}.${name}`),
      parentId: nsId,
      signature: buildSignature("interface", name, iface, []),
      typeText: "",
      exported,
      body,
      sourceRange: getSourceRange(iface),
    });
  }

  // Classes inside namespace
  const classes = nsBody.findAll({ rule: { kind: "class_declaration" } });
  for (const cls of classes) {
    const name = cls.field("name")?.text();
    if (!name) continue;

    const exported = isExported(cls);
    const mods = collectModifiers(cls);
    const body = cls.field("body")?.text() ?? "";

    addSymbol(ctx, nsId, {
      id: makeId(),
      kind: "class",
      name,
      qualifiedName: qualifiedName(ctx.modName, `${nsName}.${name}`),
      parentId: nsId,
      signature: buildSignature("class", name, cls, mods),
      typeText: "",
      exported,
      body,
      modifiers: mods,
      sourceRange: getSourceRange(cls),
    });
  }
}

function extractImports(
  root: SgNode,
  ctx: ParseContext,
): void {
  const imports = root.findAll({ rule: { kind: "import_statement" } });
  for (const imp of imports) {
    const source = imp.field("source")?.text()?.replace(/['"]/g, "");
    if (!source) continue;

    const text = imp.text();
    const isTypeOnly = text.trimStart().startsWith("import type");

    ctx.edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "imports",
        sourceId: ctx.moduleId,
        targetId: source,
        metadata: {
          moduleSpecifier: source,
          typeOnly: isTypeOnly,
          unresolved: true,
          raw: text,
        },
      }),
    );
  }
}

function extractExports(
  root: SgNode,
  ctx: ParseContext,
): void {
  const exports = root.findAll({ rule: { kind: "export_statement" } });
  for (const exp of exports) {
    const text = exp.text();

    // Re-exports: export { ... } from "..." or export * from "..."
    const source = exp.field("source")?.text()?.replace(/['"]/g, "");
    if (source) {
      ctx.edges.push(
        createSymbolEdge({
          id: makeId(),
          kind: "imports",
          sourceId: ctx.moduleId,
          targetId: source,
          metadata: {
            moduleSpecifier: source,
            reexport: true,
            unresolved: true,
            raw: text,
          },
        }),
      );
    }
  }
}

// ─── Language config ────────────────────────────────────────────────────────

const tsConfig: LanguageConfig = {
  parseRoot(code: string, filePath: string): SgNode {
    const lang = filePath.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript;
    return parse(lang, code).root();
  },

  filePathToModuleName,

  moduleSignature(_root: SgNode, modName: string): string {
    return `module ${modName}`;
  },

  extract(root: SgNode, ctx: ParseContext): void {
    extractFunctions(root, ctx);
    extractClasses(root, ctx);
    extractInterfaces(root, ctx);
    extractTypeAliases(root, ctx);
    extractEnums(root, ctx);
    extractVariables(root, ctx);
    extractNamespaces(root, ctx);
    extractImports(root, ctx);
    extractExports(root, ctx);
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────

export function parseTypeScript(code: string, filePath: string): ParseResult {
  return parseStructural(code, filePath, tsConfig);
}
