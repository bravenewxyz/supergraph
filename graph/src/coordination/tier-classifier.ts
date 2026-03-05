import type { GraphOperation } from "../schema/operations.js";
import type { GraphStore } from "../store/graph-store.js";

export type CoordinationTier = "FREE" | "ADVISORY" | "CONTRACT" | "ARCHITECTURE";

export interface TierClassification {
  tier: CoordinationTier;
  reason: string;
  requiresApproval: boolean;
  impactScope: "local" | "module" | "cross-module";
}

const TIER_PRIORITY: Record<CoordinationTier, number> = {
  FREE: 0,
  ADVISORY: 1,
  CONTRACT: 2,
  ARCHITECTURE: 3,
};

/**
 * Classify a single operation by its coordination tier.
 *
 * Tier rules:
 * - FREE: AddSymbol (non-exported), AddEdge, RemoveEdge, AddModifier, RemoveModifier
 * - ADVISORY: ModifyBody, SetExported (to false only)
 * - CONTRACT: ModifySignature, RenameSymbol, SetExported (to true), any op on exported symbol
 * - ARCHITECTURE: MoveSymbol, RemoveSymbol (if has dependents)
 */
export function classifyOperation(
  op: GraphOperation,
  graphStore: GraphStore,
): TierClassification {
  switch (op.type) {
    case "AddSymbol": {
      if (op.symbol.exported) {
        return {
          tier: "CONTRACT",
          reason: "Adding an exported symbol affects the public contract",
          requiresApproval: true,
          impactScope: "cross-module",
        };
      }
      return {
        tier: "FREE",
        reason: "Adding a non-exported symbol is a local operation",
        requiresApproval: false,
        impactScope: "local",
      };
    }

    case "AddEdge":
      return {
        tier: "FREE",
        reason: "Adding an edge is a metadata operation",
        requiresApproval: false,
        impactScope: "local",
      };

    case "RemoveEdge":
      return {
        tier: "FREE",
        reason: "Removing an edge is a metadata operation",
        requiresApproval: false,
        impactScope: "local",
      };

    case "AddModifier":
      return classifyWithExportedCheck(
        op.symbolId,
        graphStore,
        {
          tier: "FREE",
          reason: "Adding a modifier is a local operation",
          requiresApproval: false,
          impactScope: "local",
        },
        "Adding a modifier to an exported symbol affects the public contract",
      );

    case "RemoveModifier":
      return classifyWithExportedCheck(
        op.symbolId,
        graphStore,
        {
          tier: "FREE",
          reason: "Removing a modifier is a local operation",
          requiresApproval: false,
          impactScope: "local",
        },
        "Removing a modifier from an exported symbol affects the public contract",
      );

    case "ModifyDecorators":
      return classifyWithExportedCheck(
        op.symbolId,
        graphStore,
        {
          tier: "FREE",
          reason: "Modifying decorators is a local operation",
          requiresApproval: false,
          impactScope: "local",
        },
        "Modifying decorators on an exported symbol affects the public contract",
      );

    case "ModifyBody":
      return classifyWithExportedCheck(
        op.symbolId,
        graphStore,
        {
          tier: "ADVISORY",
          reason: "Modifying body requires advisory coordination",
          requiresApproval: false,
          impactScope: "local",
        },
        "Modifying body of an exported symbol requires contract-level coordination",
      );

    case "SetExported": {
      if (op.exported) {
        return {
          tier: "CONTRACT",
          reason: "Exporting a symbol creates a new public contract",
          requiresApproval: true,
          impactScope: "cross-module",
        };
      }
      return {
        tier: "ADVISORY",
        reason: "Un-exporting a symbol requires advisory coordination",
        requiresApproval: false,
        impactScope: "module",
      };
    }

    case "ModifySignature": {
      return {
        tier: "CONTRACT",
        reason: "Modifying a signature changes the public contract",
        requiresApproval: true,
        impactScope: "cross-module",
      };
    }

    case "RenameSymbol": {
      return {
        tier: "CONTRACT",
        reason: "Renaming a symbol changes the public contract",
        requiresApproval: true,
        impactScope: "cross-module",
      };
    }

    case "MoveSymbol": {
      return {
        tier: "ARCHITECTURE",
        reason: "Moving a symbol is an architectural change",
        requiresApproval: true,
        impactScope: "cross-module",
      };
    }

    case "RemoveSymbol": {
      const dependents = graphStore.getDependents(op.symbolId);
      if (dependents.length > 0) {
        return {
          tier: "ARCHITECTURE",
          reason: `Removing a symbol with ${dependents.length} dependent(s) requires planner approval`,
          requiresApproval: true,
          impactScope: "cross-module",
        };
      }
      return classifyWithExportedCheck(
        op.symbolId,
        graphStore,
        {
          tier: "ADVISORY",
          reason: "Removing a non-exported symbol with no dependents requires advisory coordination",
          requiresApproval: false,
          impactScope: "local",
        },
        "Removing an exported symbol requires contract-level coordination",
      );
    }

    default: {
      // Exhaustiveness check
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

/**
 * Helper that upgrades a classification to CONTRACT tier if the target symbol
 * is exported.
 */
function classifyWithExportedCheck(
  symbolId: string,
  graphStore: GraphStore,
  baseClassification: TierClassification,
  exportedReason: string,
): TierClassification {
  const symbol = graphStore.getSymbol(symbolId);
  if (symbol?.exported) {
    return {
      tier: "CONTRACT",
      reason: exportedReason,
      requiresApproval: true,
      impactScope: "cross-module",
    };
  }
  return baseClassification;
}

/**
 * Classify a batch of operations. Returns the highest tier of any operation.
 */
export function classifyBatch(
  ops: GraphOperation[],
  graphStore: GraphStore,
): TierClassification {
  if (ops.length === 0) {
    return {
      tier: "FREE",
      reason: "Empty batch requires no coordination",
      requiresApproval: false,
      impactScope: "local",
    };
  }

  let highest: TierClassification = classifyOperation(ops[0]!, graphStore);

  for (let i = 1; i < ops.length; i++) {
    const current = classifyOperation(ops[i]!, graphStore);
    if (TIER_PRIORITY[current.tier] > TIER_PRIORITY[highest.tier]) {
      highest = current;
    }
  }

  return highest;
}
