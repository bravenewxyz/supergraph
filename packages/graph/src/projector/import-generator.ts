import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import { filePathToModuleName, qualifiedNameToFilePath } from "./module-layout.js";

interface ImportInfo {
  targetModuleQualified: string;
  symbolName: string;
  isTypeOnly: boolean;
  isDefault: boolean;
}

export function generateImports(
  moduleNode: SymbolNode,
  children: SymbolNode[],
  edges: SymbolEdge[],
  resolveSymbol: (id: string) => SymbolNode | undefined,
): string {
  const childIds = new Set(children.map((c) => c.id));
  childIds.add(moduleNode.id);

  // Collect import info from "imports" edges originating from symbols in this module
  const imports: ImportInfo[] = [];
  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    if (!childIds.has(edge.sourceId)) continue;

    const targetSymbol = resolveSymbol(edge.targetId);
    if (!targetSymbol) continue;

    // Find the target's module by walking up via parentId
    const targetModule = findModule(targetSymbol, resolveSymbol);
    if (!targetModule || targetModule.id === moduleNode.id) continue;

    const isTypeOnly = edge.metadata?.typeOnly === true;
    const isDefault = edge.metadata?.isDefault === true || targetSymbol.name === "default";

    imports.push({
      targetModuleQualified: targetModule.qualifiedName,
      symbolName: targetSymbol.name,
      isTypeOnly,
      isDefault,
    });
  }

  if (imports.length === 0) return "";

  // Group by target module
  const byModule = new Map<string, ImportInfo[]>();
  for (const imp of imports) {
    const key = imp.targetModuleQualified;
    if (!byModule.has(key)) byModule.set(key, []);
    byModule.get(key)!.push(imp);
  }

  // Sort modules for deterministic output
  const sortedModules = [...byModule.keys()].sort();

  const lines: string[] = [];
  for (const modQualified of sortedModules) {
    const group = byModule.get(modQualified)!;
    const importPath = computeRelativeImport(moduleNode.qualifiedName, modQualified);

    // Separate default and named imports
    const defaultImports = group.filter((i) => i.isDefault);
    const namedImports = group.filter((i) => !i.isDefault);

    // Deduplicate named imports by name
    const uniqueNamed = deduplicateNamed(namedImports);

    // Determine if the entire import should be type-only
    const allTypeOnly =
      group.every((i) => i.isTypeOnly) && group.length > 0;

    if (defaultImports.length > 0 && uniqueNamed.length > 0) {
      // Combined: import [type] DefaultName, { Named1, Named2 } from "..."
      const defaultName = defaultImports[0]!.symbolName === "default"
        ? "defaultExport"
        : defaultImports[0]!.symbolName;
      const namedPart = formatNamedImports(uniqueNamed, allTypeOnly);
      const typePrefix = allTypeOnly ? "type " : "";
      lines.push(`import ${typePrefix}${defaultName}, ${namedPart} from "${importPath}";`);
    } else if (defaultImports.length > 0) {
      const defaultName = defaultImports[0]!.symbolName === "default"
        ? "defaultExport"
        : defaultImports[0]!.symbolName;
      const typePrefix = allTypeOnly ? "type " : "";
      lines.push(`import ${typePrefix}${defaultName} from "${importPath}";`);
    } else if (uniqueNamed.length > 0) {
      const typePrefix = allTypeOnly ? "type " : "";
      const namedPart = formatNamedImports(uniqueNamed, allTypeOnly);
      lines.push(`import ${typePrefix}${namedPart} from "${importPath}";`);
    }
  }

  return lines.join("\n");
}

function formatNamedImports(
  imports: ImportInfo[],
  allTypeOnly: boolean,
): string {
  const parts = imports
    .sort((a, b) => a.symbolName.localeCompare(b.symbolName))
    .map((i) => {
      // If the whole import is type-only, don't add individual type prefixes
      if (!allTypeOnly && i.isTypeOnly) {
        return `type ${i.symbolName}`;
      }
      return i.symbolName;
    });
  return `{ ${parts.join(", ")} }`;
}

function deduplicateNamed(imports: ImportInfo[]): ImportInfo[] {
  const seen = new Map<string, ImportInfo>();
  for (const imp of imports) {
    const existing = seen.get(imp.symbolName);
    if (!existing) {
      seen.set(imp.symbolName, imp);
    } else if (!imp.isTypeOnly && existing.isTypeOnly) {
      // Prefer value import over type-only
      seen.set(imp.symbolName, imp);
    }
  }
  return [...seen.values()];
}

function findModule(
  symbol: SymbolNode,
  resolveSymbol: (id: string) => SymbolNode | undefined,
): SymbolNode | undefined {
  if (symbol.kind === "module") return symbol;
  if (!symbol.parentId) return undefined;
  const parent = resolveSymbol(symbol.parentId);
  if (!parent) return undefined;
  return findModule(parent, resolveSymbol);
}

function computeRelativeImport(
  fromModuleQualified: string,
  toModuleQualified: string,
): string {
  const fromPath = qualifiedNameToFilePath(fromModuleQualified);
  const toPath = qualifiedNameToFilePath(toModuleQualified);

  const fromParts = fromPath.split("/");
  const toParts = toPath.split("/");

  // Remove file name from "from" to get directory
  fromParts.pop();

  // Find common prefix length
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const ups = fromParts.length - common;
  const remaining = toParts.slice(common);

  // Change .ts to .js for the import path
  const last = remaining[remaining.length - 1]!;
  if (last.endsWith(".ts")) {
    remaining[remaining.length - 1] = last.slice(0, -3) + ".js";
  } else if (last.endsWith(".tsx")) {
    remaining[remaining.length - 1] = last.slice(0, -4) + ".js";
  }

  let prefix: string;
  if (ups === 0) {
    prefix = "./";
  } else {
    prefix = "../".repeat(ups);
  }

  return prefix + remaining.join("/");
}
