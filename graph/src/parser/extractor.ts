import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import { parseTypeScript } from "./ts-structural.js";

export interface ExtractionResult {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
  moduleId: string;
}

export function extractFromFile(
  code: string,
  filePath: string,
): ExtractionResult {
  const result = parseTypeScript(code, filePath);
  const moduleNode = result.nodes.find((n) => n.kind === "module");
  return {
    nodes: result.nodes,
    edges: result.edges,
    moduleId: moduleNode?.id ?? "",
  };
}

export function extractFromFiles(
  files: Map<string, string>,
): ExtractionResult {
  const allNodes: SymbolNode[] = [];
  const allEdges: SymbolEdge[] = [];
  let firstModuleId = "";

  for (const [filePath, code] of files) {
    const result = extractFromFile(code, filePath);
    allNodes.push(...result.nodes);
    allEdges.push(...result.edges);
    if (!firstModuleId && result.moduleId) {
      firstModuleId = result.moduleId;
    }
  }

  return {
    nodes: allNodes,
    edges: allEdges,
    moduleId: firstModuleId,
  };
}
