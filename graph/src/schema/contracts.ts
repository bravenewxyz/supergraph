import type { SymbolKind } from "./nodes.js";

export interface Contract {
  symbolId: string;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  signature: string;
  exported: boolean;
  dependencies: string[]; // symbol IDs this contract references
}
