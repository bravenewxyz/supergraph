export type EdgeKind =
  | "contains"
  | "calls"
  | "imports"
  | "extends"
  | "implements"
  | "references"
  | "tests"
  | "depends-on";

export interface SymbolEdge {
  id: string;
  kind: EdgeKind;
  sourceId: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

export function createSymbolEdge(
  partial: Pick<SymbolEdge, "id" | "kind" | "sourceId" | "targetId"> &
    Partial<SymbolEdge>,
): SymbolEdge {
  return {
    metadata: undefined,
    ...partial,
  };
}
