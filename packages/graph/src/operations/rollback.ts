import type { OperationEntry, GraphOperation } from "../schema/operations.js";
import type { GraphStore } from "../store/graph-store.js";
import type { OperationLog } from "./op-log.js";

export interface RollbackResult {
  rolledBack: OperationEntry[];
  cascaded: GraphOperation[];
  orphanedSymbols: string[];
}

/**
 * Compute the inverse of a graph operation given current graph state.
 *
 * - AddSymbol -> RemoveSymbol
 * - RemoveSymbol -> AddSymbol (needs current node data; null if node is gone)
 * - ModifyBody -> ModifyBody with old body
 * - ModifySignature -> ModifySignature with old sig/type
 * - RenameSymbol -> RenameSymbol with old name
 * - MoveSymbol -> MoveSymbol with old parentId
 * - AddEdge -> RemoveEdge
 * - RemoveEdge -> AddEdge (needs current edge data; null if edge is gone)
 * - SetExported -> SetExported with old value
 * - AddModifier -> RemoveModifier
 * - RemoveModifier -> AddModifier
 */
export function computeInverse(
  op: GraphOperation,
  graphStore: GraphStore,
): GraphOperation | null {
  switch (op.type) {
    case "AddSymbol":
      return { type: "RemoveSymbol", symbolId: op.symbol.id };

    case "RemoveSymbol": {
      // We need the node data to recreate it; if it's already gone we can't invert
      const node = graphStore.getSymbol(op.symbolId);
      if (!node) return null;
      return { type: "AddSymbol", symbol: { ...node } };
    }

    case "ModifyBody": {
      const node = graphStore.getSymbol(op.symbolId);
      if (!node) return null;
      return { type: "ModifyBody", symbolId: op.symbolId, newBody: node.body };
    }

    case "ModifySignature": {
      const node = graphStore.getSymbol(op.symbolId);
      if (!node) return null;
      return {
        type: "ModifySignature",
        symbolId: op.symbolId,
        newSignature: node.signature,
        newTypeText: node.typeText,
      };
    }

    case "RenameSymbol": {
      const node = graphStore.getSymbol(op.symbolId);
      if (!node) return null;
      return {
        type: "RenameSymbol",
        symbolId: op.symbolId,
        newName: node.name,
      };
    }

    case "MoveSymbol": {
      const node = graphStore.getSymbol(op.symbolId);
      if (!node) return null;
      return {
        type: "MoveSymbol",
        symbolId: op.symbolId,
        newParentId: node.parentId ?? "",
      };
    }

    case "AddEdge":
      return { type: "RemoveEdge", edgeId: op.edge.id };

    case "RemoveEdge": {
      const edge = graphStore.getEdge(op.edgeId);
      if (!edge) return null;
      return { type: "AddEdge", edge: { ...edge } };
    }

    case "SetExported": {
      const node = graphStore.getSymbol(op.symbolId);
      if (!node) return null;
      return {
        type: "SetExported",
        symbolId: op.symbolId,
        exported: node.exported,
      };
    }

    case "AddModifier":
      return {
        type: "RemoveModifier",
        symbolId: op.symbolId,
        modifier: op.modifier,
      };

    case "RemoveModifier":
      return {
        type: "AddModifier",
        symbolId: op.symbolId,
        modifier: op.modifier,
      };

    case "ModifyDecorators": {
      const node = graphStore.getSymbol(op.symbolId);
      if (!node) return null;
      return {
        type: "ModifyDecorators",
        symbolId: op.symbolId,
        newDecorators: [...(node.decorators ?? [])],
      };
    }
  }
}

/**
 * Roll back all operations by a specific agent.
 *
 * Algorithm:
 * 1. Collect all ops by target agent from op-log (ordered by Lamport, reversed)
 * 2. For each op, compute inverse before applying (capture current state)
 * 3. Check for cascading effects (edges referencing removed symbols)
 * 4. Apply inverses in reverse order
 * 5. Report orphaned symbols (symbols with broken calls/references edges)
 */
export function rollbackAgent(
  agentId: string,
  opLog: OperationLog,
  graphStore: GraphStore,
): RollbackResult {
  const agentOps = opLog.getByAgent(agentId);

  // Sort by Lamport descending (reverse chronological)
  const sorted = [...agentOps].sort((a, b) => b.lamport - a.lamport);

  const rolledBack: OperationEntry[] = [];
  const cascaded: GraphOperation[] = [];
  const orphanedSymbolSet = new Set<string>();

  // Track symbols that had edges removed during rollback
  const removedEdgeEndpoints = new Set<string>();

  for (const entry of sorted) {
    // Compute inverse BEFORE applying it (uses current graph state)
    const inverse = computeInverse(entry.op, graphStore);
    if (!inverse) continue;

    // If this is removing a symbol (inverse of AddSymbol), check for edges
    // that reference it and cascade their removal
    if (inverse.type === "RemoveSymbol") {
      const edgesFrom = graphStore.getEdgesFrom(inverse.symbolId);
      const edgesTo = graphStore.getEdgesTo(inverse.symbolId);
      for (const edge of [...edgesFrom, ...edgesTo]) {
        const removeEdgeOp: GraphOperation = {
          type: "RemoveEdge",
          edgeId: edge.id,
        };
        cascaded.push(removeEdgeOp);
        // Track the other end as potentially orphaned
        const otherId =
          edge.sourceId === inverse.symbolId ? edge.targetId : edge.sourceId;
        orphanedSymbolSet.add(otherId);
        removedEdgeEndpoints.add(edge.sourceId);
        removedEdgeEndpoints.add(edge.targetId);
      }
    }

    // If this is removing an edge (inverse of AddEdge), track endpoints
    // for orphan detection and record as cascaded
    if (inverse.type === "RemoveEdge") {
      const edge = graphStore.getEdge(inverse.edgeId);
      if (edge) {
        cascaded.push(inverse);
        removedEdgeEndpoints.add(edge.sourceId);
        removedEdgeEndpoints.add(edge.targetId);
        // Both endpoints may become orphaned
        orphanedSymbolSet.add(edge.sourceId);
        orphanedSymbolSet.add(edge.targetId);
      }
    }

    // Apply the inverse
    graphStore.applyOperation(inverse);
    rolledBack.push(entry);
  }

  // Filter orphaned symbols: only those that still exist in the graph
  // (symbols that were removed are not orphaned, they're just gone)
  const orphanedSymbols = [...orphanedSymbolSet].filter((id) => {
    const sym = graphStore.getSymbol(id);
    return sym !== undefined;
  });

  return {
    rolledBack,
    cascaded,
    orphanedSymbols,
  };
}
