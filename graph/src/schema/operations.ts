import type { SymbolNode } from "./nodes.js";
import type { SymbolEdge } from "./edges.js";

export type GraphOperation =
  | { type: "AddSymbol"; symbol: SymbolNode }
  | { type: "RemoveSymbol"; symbolId: string }
  | { type: "ModifyBody"; symbolId: string; newBody: string }
  | {
      type: "ModifySignature";
      symbolId: string;
      newSignature: string;
      newTypeText: string;
    }
  | { type: "RenameSymbol"; symbolId: string; newName: string }
  | { type: "MoveSymbol"; symbolId: string; newParentId: string }
  | { type: "AddEdge"; edge: SymbolEdge }
  | { type: "RemoveEdge"; edgeId: string }
  | { type: "SetExported"; symbolId: string; exported: boolean }
  | { type: "AddModifier"; symbolId: string; modifier: string }
  | { type: "RemoveModifier"; symbolId: string; modifier: string }
  | { type: "ModifyDecorators"; symbolId: string; newDecorators: string[] };

export interface OperationResult {
  applied: boolean;
  operationType: GraphOperation['type'];
  symbolId?: string;
  reason?: string;
}

export interface OperationEntry {
  id: string;
  op: GraphOperation;
  agentId: string;
  lamport: number;
  timestamp: number;
  batchId: string;
  symbolIds: string[];
  contractId?: string;
  _inverse?: GraphOperation;
}
