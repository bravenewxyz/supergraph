import type { SymbolNode, SymbolKind } from "../schema/nodes.js";
import type { SymbolEdge, EdgeKind } from "../schema/edges.js";
import { generateImports } from "./import-generator.js";
import { qualifiedNameToFilePath } from "./module-layout.js";
import { formatTypeScript } from "./formatter.js";

export interface GraphReader {
  getSymbol(id: string): SymbolNode | undefined;
  getChildSymbols(parentId: string): SymbolNode[];
  getEdgesFrom(symbolId: string): SymbolEdge[];
  getEdgesTo(symbolId: string): SymbolEdge[];
  getEdgesByKind(symbolId: string, kind: EdgeKind): SymbolEdge[];
  getAllSymbols(): SymbolNode[];
}

export interface ProjectionResult {
  files: Map<string, string>;
}

// Order in which symbol kinds appear in a file
const KIND_ORDER: Record<SymbolKind, number> = {
  module: 0,
  namespace: 1,
  "enum-member": 2,
  parameter: 3,
  property: 4,
  method: 5,
  // Top-level ordering:
  "type-alias": 10,
  interface: 11,
  enum: 12,
  class: 13,
  function: 14,
  variable: 15,
  test: 16,
};

export function projectModule(
  moduleNode: SymbolNode,
  graph: GraphReader,
): string {
  const children = graph.getChildSymbols(moduleNode.id);

  // Collect all edges relevant to this module's symbols
  const allEdges: SymbolEdge[] = [];
  const seen = new Set<string>();
  for (const child of children) {
    for (const edge of graph.getEdgesFrom(child.id)) {
      if (!seen.has(edge.id)) {
        seen.add(edge.id);
        allEdges.push(edge);
      }
    }
  }
  // Also include edges from the module node itself
  for (const edge of graph.getEdgesFrom(moduleNode.id)) {
    if (!seen.has(edge.id)) {
      seen.add(edge.id);
      allEdges.push(edge);
    }
  }

  const resolveSymbol = (id: string) => graph.getSymbol(id);

  // Generate imports section
  const importBlock = generateImports(moduleNode, children, allEdges, resolveSymbol);

  // Filter to top-level symbols only (direct children of the module)
  const topLevel = children.filter(
    (c) => c.parentId === moduleNode.id && !isInternalKind(c.kind),
  );

  // Sort: types/interfaces first, then classes, functions, variables
  topLevel.sort((a, b) => {
    const orderA = KIND_ORDER[a.kind] ?? 99;
    const orderB = KIND_ORDER[b.kind] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return a.name.localeCompare(b.name);
  });

  // Emit each symbol
  const sections: string[] = [];
  if (importBlock) {
    sections.push(importBlock);
  }

  for (const symbol of topLevel) {
    const code = emitSymbol(symbol, graph);
    if (code) sections.push(code);
  }

  const raw = sections.join("\n\n") + "\n";
  const filePath = qualifiedNameToFilePath(moduleNode.qualifiedName);
  return formatTypeScript(raw, filePath);
}

export function projectGraph(graph: GraphReader): ProjectionResult {
  const files = new Map<string, string>();
  const allSymbols = graph.getAllSymbols();

  const modules = allSymbols
    .filter((s) => s.kind === "module")
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));

  for (const mod of modules) {
    const filePath = qualifiedNameToFilePath(mod.qualifiedName);
    const content = projectModule(mod, graph);
    files.set(filePath, content);
  }

  return { files };
}

function isInternalKind(kind: SymbolKind): boolean {
  return kind === "parameter" || kind === "enum-member" || kind === "property" || kind === "method";
}

function emitSymbol(symbol: SymbolNode, graph: GraphReader): string {
  switch (symbol.kind) {
    case "function":
      return emitFunction(symbol);
    case "class":
      return emitClass(symbol, graph);
    case "interface":
      return emitInterface(symbol);
    case "type-alias":
      return emitTypeAlias(symbol);
    case "enum":
      return emitEnum(symbol, graph);
    case "variable":
      return emitVariable(symbol);
    case "namespace":
      return emitNamespace(symbol, graph);
    case "test":
      return emitFunction(symbol);
    default:
      return "";
  }
}

function exportPrefix(symbol: SymbolNode): string {
  if (!symbol.exported) return "";
  if (symbol.modifiers.includes("default")) return "export default ";
  return "export ";
}

function decoratorsBlock(symbol: SymbolNode): string {
  if (symbol.decorators.length === 0) return "";
  return symbol.decorators.map((d) => (d.startsWith("@") ? d : `@${d}`)).join("\n") + "\n";
}

function emitFunction(symbol: SymbolNode): string {
  const parts: string[] = [];
  parts.push(decoratorsBlock(symbol));

  const exp = exportPrefix(symbol);
  const isAsync = symbol.modifiers.includes("async") ? "async " : "";

  // Use signature if provided, otherwise build from name
  const sig = symbol.signature || `${symbol.name}()`;
  const returnType = symbol.typeText ? `: ${symbol.typeText}` : "";

  // If signature already includes return type, don't append typeText
  const sigHasReturn = symbol.signature && symbol.signature.includes(":");
  const fullReturn = sigHasReturn ? "" : returnType;

  const body = symbol.body || "{}";
  const bodyBlock = body.startsWith("{") ? ` ${body}` : ` {\n  ${body}\n}`;

  parts.push(`${exp}${isAsync}function ${sig}${fullReturn}${bodyBlock}`);
  return parts.join("");
}

function emitClass(symbol: SymbolNode, graph: GraphReader): string {
  const parts: string[] = [];
  parts.push(decoratorsBlock(symbol));

  const exp = exportPrefix(symbol);
  const isAbstract = symbol.modifiers.includes("abstract") ? "abstract " : "";

  // Heritage: extends/implements from edges
  const extendsEdges = graph.getEdgesByKind(symbol.id, "extends");
  const implementsEdges = graph.getEdgesByKind(symbol.id, "implements");

  let heritage = "";
  if (extendsEdges.length > 0) {
    const edge = extendsEdges[0]!;
    const parentSymbol = graph.getSymbol(edge.targetId);
    const parentName = parentSymbol?.name ?? (edge.metadata?.targetName as string | undefined);
    if (parentName) heritage += ` extends ${parentName}`;
  }
  if (implementsEdges.length > 0) {
    const implNames = implementsEdges
      .map((e) => {
        const sym = graph.getSymbol(e.targetId);
        return sym?.name ?? (e.metadata?.targetName as string | undefined);
      })
      .filter(Boolean) as string[];
    if (implNames.length > 0) heritage += ` implements ${implNames.join(", ")}`;
  }

  // Gather members (properties, methods, constructor)
  const children = graph.getChildSymbols(symbol.id);
  const members = children.sort((a, b) => {
    // Constructor first, then properties, then methods
    const order = (s: SymbolNode) => {
      if (s.name === "constructor") return 0;
      if (s.kind === "property") return 1;
      return 2;
    };
    const diff = order(a) - order(b);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });

  const memberLines: string[] = [];
  for (const member of members) {
    memberLines.push(emitClassMember(member));
  }

  const bodyContent = memberLines.length > 0
    ? memberLines.join("\n\n")
    : "";

  parts.push(`${exp}${isAbstract}class ${symbol.name}${heritage} {\n${bodyContent}\n}`);
  return parts.join("");
}

function emitClassMember(symbol: SymbolNode): string {
  const decs = decoratorsBlock(symbol);
  const mods: string[] = [];

  if (symbol.modifiers.includes("static")) mods.push("static");
  if (symbol.modifiers.includes("abstract")) mods.push("abstract");
  if (symbol.modifiers.includes("readonly")) mods.push("readonly");
  if (symbol.modifiers.includes("private") && !symbol.name.startsWith("#")) mods.push("private");
  if (symbol.modifiers.includes("protected")) mods.push("protected");
  if (symbol.modifiers.includes("public")) mods.push("public");

  const modStr = mods.length > 0 ? mods.join(" ") + " " : "";

  if (symbol.kind === "property") {
    // Index signature properties are stored with name "[index]"
    if (symbol.name === "[index]") {
      return `  ${symbol.signature};`;
    }
    const type = symbol.typeText ? `: ${symbol.typeText}` : "";
    const init = symbol.body ? ` = ${symbol.body}` : "";
    return `${decs}  ${modStr}${symbol.name}${type}${init};`;
  }

  // method or constructor
  const isAbstract = symbol.modifiers.includes("abstract");
  const isAsync = symbol.modifiers.includes("async") ? "async " : "";
  const isGetter = symbol.modifiers.includes("getter");
  const isSetter = symbol.modifiers.includes("setter");
  const accessorPrefix = isGetter ? "get " : isSetter ? "set " : "";
  const sig = symbol.signature || `${symbol.name}()`;
  const returnType = symbol.typeText && !symbol.signature?.includes(":") ? `: ${symbol.typeText}` : "";

  if (isAbstract) {
    return `${decs}  ${modStr}${isAsync}${accessorPrefix}${sig}${returnType};`;
  }

  const body = symbol.body || "{}";
  const bodyBlock = body.startsWith("{") ? ` ${body}` : ` {\n    ${body}\n  }`;

  return `${decs}  ${modStr}${isAsync}${accessorPrefix}${sig}${returnType}${bodyBlock}`;
}

function emitInterface(symbol: SymbolNode): string {
  const parts: string[] = [];
  parts.push(decoratorsBlock(symbol));

  const exp = exportPrefix(symbol);
  const body = symbol.body || "{}";

  parts.push(`${exp}interface ${symbol.name} ${body}`);
  return parts.join("");
}

function emitTypeAlias(symbol: SymbolNode): string {
  const exp = exportPrefix(symbol);
  const typeValue = symbol.typeText || symbol.body || "unknown";
  return `${exp}type ${symbol.name} = ${typeValue};`;
}

function emitEnum(symbol: SymbolNode, graph: GraphReader): string {
  const exp = exportPrefix(symbol);
  const isConst = symbol.modifiers.includes("const") ? "const " : "";

  const members = graph.getChildSymbols(symbol.id);
  const memberLines = members
    .filter((m) => m.kind === "enum-member")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => {
      const value = m.body ? ` = ${m.body}` : "";
      return `  ${m.name}${value},`;
    });

  const body = memberLines.length > 0
    ? `{\n${memberLines.join("\n")}\n}`
    : "{}";

  return `${exp}${isConst}enum ${symbol.name} ${body}`;
}

function emitVariable(symbol: SymbolNode): string {
  const exp = exportPrefix(symbol);
  const isConst = symbol.modifiers.includes("let") ? "let" : "const";
  const type = symbol.typeText ? `: ${symbol.typeText}` : "";
  const init = symbol.body ? ` = ${symbol.body}` : "";
  return `${exp}${isConst} ${symbol.name}${type}${init};`;
}

function emitNamespace(symbol: SymbolNode, graph: GraphReader): string {
  const exp = exportPrefix(symbol);
  const children = graph.getChildSymbols(symbol.id);
  const childCode = children
    .filter((c) => !isInternalKind(c.kind))
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99))
    .map((c) => emitSymbol(c, graph))
    .filter(Boolean)
    .join("\n\n");

  return `${exp}namespace ${symbol.name} {\n${childCode}\n}`;
}
