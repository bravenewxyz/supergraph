import { createSymbolNode } from "../schema/nodes.js";
import { createSymbolEdge } from "../schema/edges.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";

export function makeNode(
  overrides: Partial<SymbolNode> & { id: string; name: string },
): SymbolNode {
  return createSymbolNode({
    kind: "function",
    qualifiedName: overrides.qualifiedName ?? `mod.${overrides.name}`,
    ...overrides,
  });
}

export function makeEdge(
  overrides: Partial<SymbolEdge> & {
    id: string;
    sourceId: string;
    targetId: string;
  },
): SymbolEdge {
  return createSymbolEdge({
    kind: "calls",
    ...overrides,
  });
}
