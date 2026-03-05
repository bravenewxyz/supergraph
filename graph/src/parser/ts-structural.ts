import { parse, Lang } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import type { SymbolNode, SymbolKind } from "../schema/nodes.js";
import type { SymbolEdge, EdgeKind } from "../schema/edges.js";
import { createSymbolNode } from "../schema/nodes.js";
import { createSymbolEdge } from "../schema/edges.js";
import { filePathToModuleName } from "../projector/module-layout.js";

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

/** Strip leading `: ` from type annotations (ast-grep includes the colon) */
function stripTypeAnnotationPrefix(text: string): string {
  return text.replace(/^:\s*/, "");
}

function getSourceRange(node: SgNode): { startLine: number; endLine: number } {
  const range = node.range();
  return { startLine: range.start.line, endLine: range.end.line };
}

function hasModifier(node: SgNode, modifier: string): boolean {
  const text = node.text();
  // Check if the declaration text starts with the modifier
  // For export/async/etc. we check the parent or the node itself
  const parent = node.parent();
  if (parent && parent.kind() === "export_statement") {
    if (modifier === "export") return true;
  }
  // Check for inline modifiers in the node text
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
  // Method decorators appear as preceding siblings in class_body
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

function extractFunctions(
  root: SgNode,
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
): void {
  const funcs = root.findAll({ rule: { kind: "function_declaration" } });
  for (const func of funcs) {
    if (isNestedInClass(func)) continue;
    if (isNestedInNamespace(func)) continue;

    const name = func.field("name")?.text();
    if (!name) continue;

    const exported = isExported(func);
    const mods = collectModifiers(func);
    if (isDefaultExport(func)) mods.push("default");
    const params = func.field("parameters")?.text() ?? "()";
    const retTypeRaw = func.field("return_type")?.text() ?? "";
    const retType = stripTypeAnnotationPrefix(retTypeRaw);
    const body = func.field("body")?.text() ?? "";

    const id = makeId();
    const qn = qualifiedName(modName, name);

    nodes.push(
      createSymbolNode({
        id,
        kind: "function",
        name,
        qualifiedName: qn,
        parentId: moduleId,
        signature: buildSignature("function", name, func, mods),
        typeText: retType,
        exported,
        body,
        modifiers: mods,
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
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
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
    const classQn = qualifiedName(modName, name);

    nodes.push(
      createSymbolNode({
        id: classId,
        kind: "class",
        name,
        qualifiedName: classQn,
        parentId: moduleId,
        signature: buildSignature("class", name, cls, mods),
        typeText: "",
        exported,
        body,
        decorators,
        modifiers: mods,
        sourceRange: getSourceRange(cls),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: moduleId,
        targetId: classId,
      }),
    );

    extractHeritage(cls, classId, modName, edges);

    const classBody = cls.field("body");
    if (classBody) {
      extractMethods(classBody, modName, name, classId, nodes, edges);
      extractProperties(classBody, modName, name, classId, nodes, edges);
    }
  }
}

function extractHeritage(
  cls: SgNode,
  classId: string,
  modName: string,
  edges: SymbolEdge[],
): void {
  // Look for extends_clause and implements_clause in the class heritage
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
            edges.push(
              createSymbolEdge({
                id: makeId(),
                kind: "extends",
                sourceId: classId,
                targetId: typeName, // symbolic reference
                metadata: { targetName: typeName, unresolved: true },
              }),
            );
          }
        } else if (hkind === "implements_clause") {
          const typeNames = extractHeritageTypeNames(hc);
          for (const tn of typeNames) {
            edges.push(
              createSymbolEdge({
                id: makeId(),
                kind: "implements",
                sourceId: classId,
                targetId: tn, // symbolic reference
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
  // The first identifier or member expression child is the type name
  const children = clause.children();
  for (const child of children) {
    const k = child.kind();
    if (k === "identifier" || k === "type_identifier") {
      return child.text();
    }
    if (k === "member_expression") {
      return child.text();
    }
    // For generic types like Base<T>, get the name part
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
  modName: string,
  className: string,
  classId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
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

    const params = method.field("parameters")?.text() ?? "()";
    const retTypeRaw = method.field("return_type")?.text() ?? "";
    const retType = stripTypeAnnotationPrefix(retTypeRaw);
    const body = isAbstract ? "" : (method.field("body")?.text() ?? "");
    const id = makeId();
    const qn = qualifiedName(modName, `${className}.${name}`);

    nodes.push(
      createSymbolNode({
        id,
        kind: "method",
        name,
        qualifiedName: qn,
        parentId: classId,
        signature: buildSignature("method", name, method, mods),
        typeText: retType,
        exported: false,
        body,
        decorators,
        modifiers: mods,
        sourceRange: getSourceRange(method),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: classId,
        targetId: id,
      }),
    );
  }
}

function extractProperties(
  classBody: SgNode,
  modName: string,
  className: string,
  classId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
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
    const id = makeId();
    const qn = qualifiedName(modName, `${className}.${name}`);

    nodes.push(
      createSymbolNode({
        id,
        kind: "property",
        name,
        qualifiedName: qn,
        parentId: classId,
        signature: `${name}${typeAnnRaw}`,
        typeText: typeAnn,
        exported: false,
        body: value,
        decorators,
        modifiers: mods,
        sourceRange: getSourceRange(prop),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: classId,
        targetId: id,
      }),
    );
  }
}

function extractInterfaces(
  root: SgNode,
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
): void {
  const ifaces = root.findAll({ rule: { kind: "interface_declaration" } });
  for (const iface of ifaces) {
    if (isNestedInNamespace(iface)) continue;

    const name = iface.field("name")?.text();
    if (!name) continue;

    const exported = isExported(iface);
    const body = iface.field("body")?.text() ?? "";
    const id = makeId();
    const qn = qualifiedName(modName, name);

    // Extract index signatures from the interface body
    const indexSigs: string[] = [];
    const ifaceBody = iface.field("body");
    if (ifaceBody) {
      const idxSigNodes = ifaceBody.findAll({ rule: { kind: "index_signature" } });
      for (const sig of idxSigNodes) {
        indexSigs.push(sig.text());
      }
    }

    nodes.push(
      createSymbolNode({
        id,
        kind: "interface",
        name,
        qualifiedName: qn,
        parentId: moduleId,
        signature: buildSignature("interface", name, iface, []),
        typeText: "",
        exported,
        body,
        sourceRange: getSourceRange(iface),
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

    // Store index signatures as property symbols on the interface
    for (const sigText of indexSigs) {
      const sigId = makeId();
      const sigQn = qualifiedName(modName, `${name}.[index]`);

      nodes.push(
        createSymbolNode({
          id: sigId,
          kind: "property",
          name: "[index]",
          qualifiedName: sigQn,
          parentId: id,
          signature: sigText,
          typeText: sigText,
          exported: false,
          body: "",
          sourceRange: null,
        }),
      );

      edges.push(
        createSymbolEdge({
          id: makeId(),
          kind: "contains",
          sourceId: id,
          targetId: sigId,
        }),
      );
    }
  }
}

function extractTypeAliases(
  root: SgNode,
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
): void {
  const types = root.findAll({ rule: { kind: "type_alias_declaration" } });
  for (const ta of types) {
    if (isNestedInNamespace(ta)) continue;

    const name = ta.field("name")?.text();
    if (!name) continue;

    const exported = isExported(ta);
    const value = ta.field("value")?.text() ?? "";
    const id = makeId();
    const qn = qualifiedName(modName, name);

    nodes.push(
      createSymbolNode({
        id,
        kind: "type-alias",
        name,
        qualifiedName: qn,
        parentId: moduleId,
        signature: buildSignature("type-alias", name, ta, []),
        typeText: value,
        exported,
        body: value,
        sourceRange: getSourceRange(ta),
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

function extractEnums(
  root: SgNode,
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
): void {
  const enums = root.findAll({ rule: { kind: "enum_declaration" } });
  for (const en of enums) {
    if (isNestedInNamespace(en)) continue;

    const name = en.field("name")?.text();
    if (!name) continue;

    const exported = isExported(en);
    const body = en.field("body")?.text() ?? "";
    const id = makeId();
    const qn = qualifiedName(modName, name);

    nodes.push(
      createSymbolNode({
        id,
        kind: "enum",
        name,
        qualifiedName: qn,
        parentId: moduleId,
        signature: buildSignature("enum", name, en, []),
        typeText: "",
        exported,
        body,
        sourceRange: getSourceRange(en),
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

    // Extract enum members
    const enumBody = en.field("body");
    if (enumBody) {
      const members = enumBody.findAll({
        rule: { kind: "enum_assignment" },
      });
      // Also find plain identifiers that are property_identifiers in enum body
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

          const memberId = makeId();
          const memberQn = qualifiedName(modName, `${name}.${memberName}`);

          nodes.push(
            createSymbolNode({
              id: memberId,
              kind: "enum-member",
              name: memberName,
              qualifiedName: memberQn,
              parentId: id,
              signature: memberName,
              typeText: "",
              exported: false,
              body: child.kind() === "enum_assignment" ? child.text() : "",
              sourceRange: getSourceRange(child),
            }),
          );

          edges.push(
            createSymbolEdge({
              id: makeId(),
              kind: "contains",
              sourceId: id,
              targetId: memberId,
            }),
          );
        }
      }
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
  const lexDecls = root.findAll({ rule: { kind: "lexical_declaration" } });
  for (const decl of lexDecls) {
    if (isNestedDeclaration(decl)) continue;
    if (isNestedInNamespace(decl)) continue;

    const exported = isExported(decl);
    const declKind = decl.text().trimStart().startsWith("const")
      ? "const"
      : "let";

    const declarators = decl.findAll({
      rule: { kind: "variable_declarator" },
    });
    for (const declarator of declarators) {
      const name = declarator.field("name")?.text();
      if (!name) continue;

      const typeAnnRaw = declarator.field("type")?.text() ?? "";
      const typeAnn = stripTypeAnnotationPrefix(typeAnnRaw);
      const valueNode = declarator.field("value");
      const value = valueNode?.text() ?? "";
      const id = makeId();
      const qn = qualifiedName(modName, name);

      const isArrowFn = valueNode !== null && valueNode.kind() === "arrow_function";
      const kind: SymbolKind = isArrowFn ? "function" : "variable";

      const mods = [declKind];
      if (isArrowFn && value.trimStart().startsWith("async")) {
        mods.push("async");
      }

      nodes.push(
        createSymbolNode({
          id,
          kind,
          name,
          qualifiedName: qn,
          parentId: moduleId,
          signature: kind === "function" ? `${name}${typeAnnRaw}` : `${declKind} ${name}${typeAnnRaw}`,
          typeText: typeAnn,
          exported,
          body: value,
          modifiers: mods,
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
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
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
    const nsQn = qualifiedName(modName, name);

    nodes.push(
      createSymbolNode({
        id: nsId,
        kind: "namespace",
        name,
        qualifiedName: nsQn,
        parentId: moduleId,
        signature: buildSignature("namespace", name, nsMod, []),
        typeText: "",
        exported,
        body,
        sourceRange: getSourceRange(nsMod),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: moduleId,
        targetId: nsId,
      }),
    );

    // Extract members inside the namespace
    const nsBody = nsMod.field("body");
    if (nsBody) {
      extractNamespaceMembers(nsBody, modName, name, nsId, nodes, edges);
    }
  }
}

function extractNamespaceMembers(
  nsBody: SgNode,
  modName: string,
  nsName: string,
  nsId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
): void {
  // Functions inside namespace
  const funcs = nsBody.findAll({ rule: { kind: "function_declaration" } });
  for (const func of funcs) {
    const name = func.field("name")?.text();
    if (!name) continue;

    const exported = isExported(func);
    const mods = collectModifiers(func);
    const retTypeRaw = func.field("return_type")?.text() ?? "";
    const retType = stripTypeAnnotationPrefix(retTypeRaw);
    const body = func.field("body")?.text() ?? "";
    const id = makeId();
    const qn = qualifiedName(modName, `${nsName}.${name}`);

    nodes.push(
      createSymbolNode({
        id,
        kind: "function",
        name,
        qualifiedName: qn,
        parentId: nsId,
        signature: buildSignature("function", name, func, mods),
        typeText: retType,
        exported,
        body,
        modifiers: mods,
        sourceRange: getSourceRange(func),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: nsId,
        targetId: id,
      }),
    );
  }

  // Variables inside namespace
  const lexDecls = nsBody.findAll({ rule: { kind: "lexical_declaration" } });
  for (const decl of lexDecls) {
    const exported = isExported(decl);
    const declKind = decl.text().trimStart().startsWith("const") ? "const" : "let";

    const declarators = decl.findAll({ rule: { kind: "variable_declarator" } });
    for (const declarator of declarators) {
      const name = declarator.field("name")?.text();
      if (!name) continue;

      const typeAnnRaw = declarator.field("type")?.text() ?? "";
      const typeAnn = stripTypeAnnotationPrefix(typeAnnRaw);
      const valueNode = declarator.field("value");
      const value = valueNode?.text() ?? "";
      const id = makeId();
      const qn = qualifiedName(modName, `${nsName}.${name}`);

      const isArrowFn = valueNode !== null && valueNode.kind() === "arrow_function";
      const kind: SymbolKind = isArrowFn ? "function" : "variable";
      const mods = [declKind];

      nodes.push(
        createSymbolNode({
          id,
          kind,
          name,
          qualifiedName: qn,
          parentId: nsId,
          signature: kind === "function" ? `${name}${typeAnnRaw}` : `${declKind} ${name}${typeAnnRaw}`,
          typeText: typeAnn,
          exported,
          body: value,
          modifiers: mods,
          sourceRange: getSourceRange(decl),
        }),
      );

      edges.push(
        createSymbolEdge({
          id: makeId(),
          kind: "contains",
          sourceId: nsId,
          targetId: id,
        }),
      );
    }
  }

  // Interfaces inside namespace
  const ifaces = nsBody.findAll({ rule: { kind: "interface_declaration" } });
  for (const iface of ifaces) {
    const name = iface.field("name")?.text();
    if (!name) continue;

    const exported = isExported(iface);
    const body = iface.field("body")?.text() ?? "";
    const id = makeId();
    const qn = qualifiedName(modName, `${nsName}.${name}`);

    nodes.push(
      createSymbolNode({
        id,
        kind: "interface",
        name,
        qualifiedName: qn,
        parentId: nsId,
        signature: buildSignature("interface", name, iface, []),
        typeText: "",
        exported,
        body,
        sourceRange: getSourceRange(iface),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: nsId,
        targetId: id,
      }),
    );
  }

  // Classes inside namespace
  const classes = nsBody.findAll({ rule: { kind: "class_declaration" } });
  for (const cls of classes) {
    const name = cls.field("name")?.text();
    if (!name) continue;

    const exported = isExported(cls);
    const mods = collectModifiers(cls);
    const body = cls.field("body")?.text() ?? "";
    const id = makeId();
    const qn = qualifiedName(modName, `${nsName}.${name}`);

    nodes.push(
      createSymbolNode({
        id,
        kind: "class",
        name,
        qualifiedName: qn,
        parentId: nsId,
        signature: buildSignature("class", name, cls, mods),
        typeText: "",
        exported,
        body,
        modifiers: mods,
        sourceRange: getSourceRange(cls),
      }),
    );

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "contains",
        sourceId: nsId,
        targetId: id,
      }),
    );
  }
}

function extractImports(
  root: SgNode,
  modName: string,
  moduleId: string,
  edges: SymbolEdge[],
  nodes: SymbolNode[],
): void {
  const imports = root.findAll({ rule: { kind: "import_statement" } });
  for (const imp of imports) {
    const source = imp.field("source")?.text()?.replace(/['"]/g, "");
    if (!source) continue;

    const text = imp.text();
    const isTypeOnly = text.trimStart().startsWith("import type");

    edges.push(
      createSymbolEdge({
        id: makeId(),
        kind: "imports",
        sourceId: moduleId,
        targetId: source, // symbolic reference to be resolved later
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
  modName: string,
  moduleId: string,
  nodes: SymbolNode[],
  edges: SymbolEdge[],
): void {
  const exports = root.findAll({ rule: { kind: "export_statement" } });
  for (const exp of exports) {
    const text = exp.text();

    // Re-exports: export { ... } from "..." or export * from "..."
    const source = exp.field("source")?.text()?.replace(/['"]/g, "");
    if (source) {
      edges.push(
        createSymbolEdge({
          id: makeId(),
          kind: "imports",
          sourceId: moduleId,
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
    // Declarations inside export_statement are handled by the respective extractors
    // since they check isExported() via parent
  }
}

export function parseTypeScript(code: string, filePath: string): ParseResult {
  const nodes: SymbolNode[] = [];
  const edges: SymbolEdge[] = [];

  const lang = filePath.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript;
  const tree = parse(lang, code);
  const root = tree.root();

  const modName = filePathToModuleName(filePath);
  const moduleId = makeId();

  // Module node
  nodes.push(
    createSymbolNode({
      id: moduleId,
      kind: "module",
      name: modName,
      qualifiedName: modName,
      signature: `module ${modName}`,
      exported: true,
      sourceRange: { startLine: 0, endLine: code.split("\n").length - 1 },
    }),
  );

  extractFunctions(root, modName, moduleId, nodes, edges);
  extractClasses(root, modName, moduleId, nodes, edges);
  extractInterfaces(root, modName, moduleId, nodes, edges);
  extractTypeAliases(root, modName, moduleId, nodes, edges);
  extractEnums(root, modName, moduleId, nodes, edges);
  extractVariables(root, modName, moduleId, nodes, edges);
  extractNamespaces(root, modName, moduleId, nodes, edges);
  extractImports(root, modName, moduleId, edges, nodes);
  extractExports(root, modName, moduleId, nodes, edges);

  return { nodes, edges };
}
