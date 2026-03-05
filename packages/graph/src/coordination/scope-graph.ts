import type { GraphOperation } from "../schema/operations.js";
import type { GraphStore } from "../store/graph-store.js";
import type { SymbolLockTable } from "./symbol-lock-table.js";

export interface SymbolConflict {
  symbolId: string;
  symbolName: string;
  conflictingAgentId: string;
  conflictType: string;
}

export interface AdvisoryInfo {
  symbolId: string;
  symbolName: string;
  agentId: string;
  opType: string;
}

export class ScopeGraph {
  constructor(
    private graphStore: GraphStore,
    private lockTable: SymbolLockTable,
  ) {}

  // --- Core API (replaces ScopeTracker) ---

  claimSymbols(agentId: string, symbolIds: string[], opType: GraphOperation["type"] = "ModifyBody"): SymbolConflict[] {
    const result = this.lockTable.acquireBatch(symbolIds, agentId, opType);
    if (result.status === "acquired") {
      return [];
    }

    const conflicts: SymbolConflict[] = [];
    for (const info of result.conflicts) {
      const symbol = this.graphStore.getSymbol(info.symbolId);
      conflicts.push({
        symbolId: info.symbolId,
        symbolName: symbol?.name ?? info.symbolId,
        conflictingAgentId: info.existingAgent,
        conflictType: info.commutativity,
      });
    }
    return conflicts;
  }

  releaseSymbols(agentId: string): void {
    this.lockTable.releaseAgent(agentId);
  }

  // --- Enhanced queries ---

  getConflicts(agentId: string, symbolIds: string[]): SymbolConflict[] {
    const conflicts: SymbolConflict[] = [];

    for (const symbolId of symbolIds) {
      const locked = this.lockTable.getLockedBy(symbolId);
      for (const mod of locked) {
        if (mod.agentId === agentId) continue;
        const symbol = this.graphStore.getSymbol(symbolId);
        conflicts.push({
          symbolId,
          symbolName: symbol?.name ?? symbolId,
          conflictingAgentId: mod.agentId,
          conflictType: mod.opType,
        });
      }
    }

    return conflicts;
  }

  getAdvisory(symbolIds: string[]): AdvisoryInfo[] {
    const advisory: AdvisoryInfo[] = [];
    const seen = new Set<string>(); // dedupe by symbolId+agentId

    for (const symbolId of symbolIds) {
      // Check the symbol itself
      const locked = this.lockTable.getLockedBy(symbolId);
      for (const mod of locked) {
        const key = `${symbolId}:${mod.agentId}`;
        if (!seen.has(key)) {
          seen.add(key);
          const symbol = this.graphStore.getSymbol(symbolId);
          advisory.push({
            symbolId,
            symbolName: symbol?.name ?? symbolId,
            agentId: mod.agentId,
            opType: mod.opType,
          });
        }
      }

      // Check symbols in the same module (siblings)
      const symbol = this.graphStore.getSymbol(symbolId);
      if (symbol?.parentId) {
        const siblings = this.graphStore.getChildSymbols(symbol.parentId);
        for (const sibling of siblings) {
          if (sibling.id === symbolId) continue;
          const sibLocked = this.lockTable.getLockedBy(sibling.id);
          for (const mod of sibLocked) {
            const key = `${sibling.id}:${mod.agentId}`;
            if (!seen.has(key)) {
              seen.add(key);
              advisory.push({
                symbolId: sibling.id,
                symbolName: sibling.name,
                agentId: mod.agentId,
                opType: mod.opType,
              });
            }
          }
        }
      }

      // Check dependent symbols
      const dependents = this.graphStore.getDependents(symbolId);
      for (const depId of dependents) {
        const depLocked = this.lockTable.getLockedBy(depId);
        for (const mod of depLocked) {
          const key = `${depId}:${mod.agentId}`;
          if (!seen.has(key)) {
            seen.add(key);
            const depSymbol = this.graphStore.getSymbol(depId);
            advisory.push({
              symbolId: depId,
              symbolName: depSymbol?.name ?? depId,
              agentId: mod.agentId,
              opType: mod.opType,
            });
          }
        }
      }
    }

    return advisory;
  }

  // --- Cross-symbol dependency awareness ---

  getImpactedAgents(symbolId: string): string[] {
    const dependents = this.graphStore.getDependents(symbolId);
    const agents = new Set<string>();

    for (const depId of dependents) {
      const locked = this.lockTable.getLockedBy(depId);
      for (const mod of locked) {
        agents.add(mod.agentId);
      }
    }

    return [...agents];
  }

  // --- File-path compatibility (for migration from ScopeTracker) ---

  claimByFilePaths(agentId: string, filePaths: string[], opType: GraphOperation["type"] = "ModifyBody"): SymbolConflict[] {
    const allSymbolIds: string[] = [];
    for (const fp of filePaths) {
      const symbolIds = this.resolveFileToSymbols(fp);
      allSymbolIds.push(...symbolIds);
    }

    if (allSymbolIds.length === 0) {
      return [];
    }

    return this.claimSymbols(agentId, allSymbolIds, opType);
  }

  resolveFileToSymbols(filePath: string): string[] {
    // Normalize file path to module qualifiedName format:
    // "src/utils/helpers.ts" -> "src/utils/helpers"
    // Strip extension
    const withoutExt = filePath.replace(/\.\w+$/, "");
    const moduleQN = withoutExt;

    // Try to find the module by qualifiedName
    const moduleNode = this.graphStore.getSymbolByQualifiedName(moduleQN);
    if (moduleNode) {
      const children = this.graphStore.getChildSymbols(moduleNode.id);
      return [moduleNode.id, ...children.map((c) => c.id)];
    }

    // Fallback: check all symbols whose qualifiedName starts with a matching prefix
    // This handles cases where the file path and qualifiedName don't perfectly align
    const allSymbols = this.graphStore.getAllSymbols();
    const matchingIds: string[] = [];

    // Try matching the basename (last segment of path without extension)
    const basename = withoutExt.split("/").pop() ?? withoutExt;
    for (const sym of allSymbols) {
      if (sym.kind === "module" && sym.qualifiedName === basename) {
        matchingIds.push(sym.id);
        const children = this.graphStore.getChildSymbols(sym.id);
        matchingIds.push(...children.map((c) => c.id));
      }
    }

    return matchingIds;
  }
}
