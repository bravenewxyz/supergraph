export type SymbolKind =
  | "module"
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type-alias"
  | "enum"
  | "enum-member"
  | "variable"
  | "parameter"
  | "property"
  | "test"
  | "namespace";

export interface SymbolNode {
  id: string;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  parentId: string | null;

  // Contract (public-facing signature)
  signature: string;
  typeText: string;
  exported: boolean;

  // Implementation
  body: string;
  decorators: string[];
  modifiers: string[]; // async, static, readonly, abstract, etc.

  // Source mapping
  sourceRange: { startLine: number; endLine: number } | null;

  // Provenance
  createdBy: string;
  lastModifiedBy: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export function createSymbolNode(
  partial: Pick<SymbolNode, "id" | "kind" | "name" | "qualifiedName"> &
    Partial<SymbolNode>,
): SymbolNode {
  const now = Date.now();
  return {
    parentId: null,
    signature: "",
    typeText: "",
    exported: false,
    body: "",
    decorators: [],
    modifiers: [],
    sourceRange: null,
    createdBy: "system",
    lastModifiedBy: "system",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}
