import type { GraphOperation } from "../schema/operations.js";
import { checkCommutativityByType, type CommutativityResult } from "../operations/commutativity.js";

export interface ActiveModification {
  agentId: string;
  symbolId: string;
  opType: GraphOperation["type"];
  acquiredAt: number;
}

export type AcquireResult =
  | { status: "acquired" }
  | { status: "conflict"; conflicts: ConflictInfo[] };

export interface ConflictInfo {
  symbolId: string;
  existingAgent: string;
  existingOpType: GraphOperation["type"];
  requestedOpType: GraphOperation["type"];
  commutativity: CommutativityResult;
}

function isConflicting(result: CommutativityResult): boolean {
  return result === "conflict" || result === "contract-dependent";
}

export class SymbolLockTable {
  private active: Map<string, ActiveModification[]>; // symbolId -> mods
  private agentSymbols: Map<string, Set<string>>; // agentId -> symbolIds

  constructor() {
    this.active = new Map();
    this.agentSymbols = new Map();
  }

  acquire(
    symbolId: string,
    agentId: string,
    opType: GraphOperation["type"],
  ): AcquireResult {
    const existing = this.active.get(symbolId) ?? [];
    const conflicts: ConflictInfo[] = [];

    for (const mod of existing) {
      // Same agent is always allowed (re-entrant)
      if (mod.agentId === agentId) continue;

      const commutativity = checkCommutativityByType(mod.opType, opType);
      if (isConflicting(commutativity)) {
        conflicts.push({
          symbolId,
          existingAgent: mod.agentId,
          existingOpType: mod.opType,
          requestedOpType: opType,
          commutativity,
        });
      }
    }

    if (conflicts.length > 0) {
      return { status: "conflict", conflicts };
    }

    // Acquire the lock
    const mod: ActiveModification = {
      agentId,
      symbolId,
      opType,
      acquiredAt: Date.now(),
    };

    if (!this.active.has(symbolId)) {
      this.active.set(symbolId, []);
    }
    this.active.get(symbolId)!.push(mod);

    if (!this.agentSymbols.has(agentId)) {
      this.agentSymbols.set(agentId, new Set());
    }
    this.agentSymbols.get(agentId)!.add(symbolId);

    return { status: "acquired" };
  }

  acquireBatch(
    symbolIds: string[],
    agentId: string,
    opType: GraphOperation["type"],
  ): AcquireResult {
    // Pre-check all symbols for conflicts before acquiring any
    const allConflicts: ConflictInfo[] = [];

    for (const symbolId of symbolIds) {
      const existing = this.active.get(symbolId) ?? [];
      for (const mod of existing) {
        if (mod.agentId === agentId) continue;
        const commutativity = checkCommutativityByType(mod.opType, opType);
        if (isConflicting(commutativity)) {
          allConflicts.push({
            symbolId,
            existingAgent: mod.agentId,
            existingOpType: mod.opType,
            requestedOpType: opType,
            commutativity,
          });
        }
      }
    }

    if (allConflicts.length > 0) {
      return { status: "conflict", conflicts: allConflicts };
    }

    // All clear — acquire all locks atomically
    for (const symbolId of symbolIds) {
      const mod: ActiveModification = {
        agentId,
        symbolId,
        opType,
        acquiredAt: Date.now(),
      };

      if (!this.active.has(symbolId)) {
        this.active.set(symbolId, []);
      }
      this.active.get(symbolId)!.push(mod);

      if (!this.agentSymbols.has(agentId)) {
        this.agentSymbols.set(agentId, new Set());
      }
      this.agentSymbols.get(agentId)!.add(symbolId);
    }

    return { status: "acquired" };
  }

  release(symbolId: string, agentId: string): void {
    const mods = this.active.get(symbolId);
    if (!mods) return;

    const filtered = mods.filter((m) => m.agentId !== agentId);
    if (filtered.length === 0) {
      this.active.delete(symbolId);
    } else {
      this.active.set(symbolId, filtered);
    }

    const agentSet = this.agentSymbols.get(agentId);
    if (agentSet) {
      agentSet.delete(symbolId);
      if (agentSet.size === 0) {
        this.agentSymbols.delete(agentId);
      }
    }
  }

  releaseAgent(agentId: string): void {
    const symbols = this.agentSymbols.get(agentId);
    if (!symbols) return;

    for (const symbolId of symbols) {
      const mods = this.active.get(symbolId);
      if (!mods) continue;
      const filtered = mods.filter((m) => m.agentId !== agentId);
      if (filtered.length === 0) {
        this.active.delete(symbolId);
      } else {
        this.active.set(symbolId, filtered);
      }
    }

    this.agentSymbols.delete(agentId);
  }

  getActiveSymbols(): Map<string, ActiveModification[]> {
    return new Map(this.active);
  }

  getAgentSymbols(agentId: string): Set<string> {
    return new Set(this.agentSymbols.get(agentId) ?? []);
  }

  isLocked(symbolId: string): boolean {
    const mods = this.active.get(symbolId);
    return mods !== undefined && mods.length > 0;
  }

  getLockedBy(symbolId: string): ActiveModification[] {
    return [...(this.active.get(symbolId) ?? [])];
  }
}
