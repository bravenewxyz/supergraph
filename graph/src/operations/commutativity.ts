/**
 * Runtime commutativity checker for the orchestrator.
 *
 * Fundamental rule: Operations on DIFFERENT symbols ALWAYS commute.
 * The matrix only applies to operations on the SAME symbol.
 *
 * Results:
 * - "commutes": both operations can be applied in any order
 * - "conflict": operations conflict and need manual resolution
 * - "lww": last-writer-wins (use latest by timestamp)
 * - "idempotent": both operations produce the same result
 * - "contract-dependent": algebraically commutative but requires contract drift check
 */

import type { GraphOperation, OperationEntry } from "../schema/operations.js";

export type CommutativityResult = "commutes" | "conflict" | "lww" | "idempotent" | "contract-dependent";

/**
 * Extract the symbol IDs affected by an operation.
 */
export function getAffectedSymbolIds(op: GraphOperation): string[] {
  switch (op.type) {
    case "AddSymbol":
      return [op.symbol.id];
    case "RemoveSymbol":
      return [op.symbolId];
    case "ModifyBody":
      return [op.symbolId];
    case "ModifySignature":
      return [op.symbolId];
    case "RenameSymbol":
      return [op.symbolId];
    case "MoveSymbol":
      return [op.symbolId];
    case "AddEdge":
      return [op.edge.sourceId, op.edge.targetId];
    case "RemoveEdge":
      return []; // EdgeId doesn't expose symbol; treat as commutative
    case "SetExported":
      return [op.symbolId];
    case "AddModifier":
      return [op.symbolId];
    case "RemoveModifier":
      return [op.symbolId];
    case "ModifyDecorators":
      return [op.symbolId];
  }
}

// Commutativity matrix indexed by [rowType][colType].
// Only same-symbol pairs need lookup; different-symbol pairs always commute.
const MATRIX: Record<string, Record<string, CommutativityResult>> = {
  AddSymbol: {
    AddSymbol: "conflict",
    RemoveSymbol: "conflict",
    ModifyBody: "commutes",
    ModifySignature: "commutes",
    ModifyDecorators: "commutes",
    RenameSymbol: "commutes",
    MoveSymbol: "commutes",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "commutes",
    AddModifier: "commutes",
    RemoveModifier: "commutes",
  },
  RemoveSymbol: {
    AddSymbol: "conflict",
    RemoveSymbol: "idempotent",
    ModifyBody: "conflict",
    ModifySignature: "conflict",
    ModifyDecorators: "conflict",
    RenameSymbol: "conflict",
    MoveSymbol: "conflict",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "conflict",
    AddModifier: "conflict",
    RemoveModifier: "conflict",
  },
  ModifyBody: {
    AddSymbol: "commutes",
    RemoveSymbol: "conflict",
    ModifyBody: "lww",
    ModifySignature: "contract-dependent",
    ModifyDecorators: "commutes",
    RenameSymbol: "commutes",
    MoveSymbol: "commutes",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "commutes",
    AddModifier: "commutes",
    RemoveModifier: "commutes",
  },
  ModifySignature: {
    AddSymbol: "commutes",
    RemoveSymbol: "conflict",
    ModifyBody: "contract-dependent",
    ModifySignature: "lww",
    ModifyDecorators: "commutes",
    RenameSymbol: "conflict",
    MoveSymbol: "commutes",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "commutes",
    AddModifier: "commutes",
    RemoveModifier: "commutes",
  },
  ModifyDecorators: {
    AddSymbol: "commutes",
    RemoveSymbol: "conflict",
    ModifyBody: "commutes",
    ModifySignature: "commutes",
    ModifyDecorators: "lww",
    RenameSymbol: "commutes",
    MoveSymbol: "commutes",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "commutes",
    AddModifier: "commutes",
    RemoveModifier: "commutes",
  },
  RenameSymbol: {
    AddSymbol: "commutes",
    RemoveSymbol: "conflict",
    ModifyBody: "commutes",
    ModifySignature: "conflict",
    ModifyDecorators: "commutes",
    RenameSymbol: "conflict",
    MoveSymbol: "commutes",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "commutes",
    AddModifier: "commutes",
    RemoveModifier: "commutes",
  },
  MoveSymbol: {
    AddSymbol: "commutes",
    RemoveSymbol: "conflict",
    ModifyBody: "commutes",
    ModifySignature: "commutes",
    ModifyDecorators: "commutes",
    RenameSymbol: "commutes",
    MoveSymbol: "conflict",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "commutes",
    AddModifier: "commutes",
    RemoveModifier: "commutes",
  },
  AddEdge: {
    AddSymbol: "commutes",
    RemoveSymbol: "commutes",
    ModifyBody: "commutes",
    ModifySignature: "commutes",
    ModifyDecorators: "commutes",
    RenameSymbol: "commutes",
    MoveSymbol: "commutes",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "commutes",
    AddModifier: "commutes",
    RemoveModifier: "commutes",
  },
  RemoveEdge: {
    AddSymbol: "commutes",
    RemoveSymbol: "commutes",
    ModifyBody: "commutes",
    ModifySignature: "commutes",
    ModifyDecorators: "commutes",
    RenameSymbol: "commutes",
    MoveSymbol: "commutes",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "commutes",
    AddModifier: "commutes",
    RemoveModifier: "commutes",
  },
  SetExported: {
    AddSymbol: "commutes",
    RemoveSymbol: "conflict",
    ModifyBody: "commutes",
    ModifySignature: "commutes",
    ModifyDecorators: "commutes",
    RenameSymbol: "commutes",
    MoveSymbol: "commutes",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "lww",
    AddModifier: "commutes",
    RemoveModifier: "commutes",
  },
  AddModifier: {
    AddSymbol: "commutes",
    RemoveSymbol: "conflict",
    ModifyBody: "commutes",
    ModifySignature: "commutes",
    ModifyDecorators: "commutes",
    RenameSymbol: "commutes",
    MoveSymbol: "commutes",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "commutes",
    AddModifier: "idempotent",
    RemoveModifier: "conflict",
  },
  RemoveModifier: {
    AddSymbol: "commutes",
    RemoveSymbol: "conflict",
    ModifyBody: "commutes",
    ModifySignature: "commutes",
    ModifyDecorators: "commutes",
    RenameSymbol: "commutes",
    MoveSymbol: "commutes",
    AddEdge: "commutes",
    RemoveEdge: "commutes",
    SetExported: "commutes",
    AddModifier: "conflict",
    RemoveModifier: "idempotent",
  },
};

/**
 * Check commutativity by operation type strings alone (no full operation objects).
 * Used by the lock table which only stores operation types, not full operations.
 */
export function checkCommutativityByType(
  typeA: GraphOperation["type"],
  typeB: GraphOperation["type"],
): CommutativityResult {
  return MATRIX[typeA]?.[typeB] ?? "conflict";
}

/**
 * Check if two operations commute.
 * Operations on different symbols always commute.
 */
export function checkCommutativity(
  opA: GraphOperation,
  opB: GraphOperation,
): CommutativityResult {
  const symbolsA = getAffectedSymbolIds(opA);
  const symbolsB = getAffectedSymbolIds(opB);

  // Different symbols -> always commute
  const overlap = symbolsA.some((s) => symbolsB.includes(s));
  if (!overlap) return "commutes";

  return MATRIX[opA.type]?.[opB.type] ?? "conflict";
}

/**
 * Check commutativity between two operation batches (from different agents).
 * Compares every pair of operations across the two batches that share symbols.
 */
export function checkBatchCommutativity(
  batchA: OperationEntry[],
  batchB: OperationEntry[],
): {
  result: CommutativityResult;
  conflicts: Array<{
    opA: OperationEntry;
    opB: OperationEntry;
    result: CommutativityResult;
  }>;
} {
  const pairResults: Array<{
    opA: OperationEntry;
    opB: OperationEntry;
    result: CommutativityResult;
  }> = [];

  for (const entryA of batchA) {
    for (const entryB of batchB) {
      const r = checkCommutativity(entryA.op, entryB.op);
      if (r !== "commutes") {
        pairResults.push({ opA: entryA, opB: entryB, result: r });
      }
    }
  }

  // Overall result: worst-case across all pairs
  // Severity order: conflict > contract-dependent > lww > idempotent > commutes
  let overall: CommutativityResult = "commutes";
  for (const pr of pairResults) {
    if (pr.result === "conflict") {
      overall = "conflict";
      break;
    }
    if (pr.result === "contract-dependent") {
      overall = "contract-dependent";
    }
    if (pr.result === "lww" && overall !== "contract-dependent") {
      overall = "lww";
    }
    if (pr.result === "idempotent" && overall === "commutes") {
      overall = "idempotent";
    }
  }

  return {
    result: overall,
    conflicts: pairResults,
  };
}
