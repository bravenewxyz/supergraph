import type { EdgeKind, SymbolEdge } from "../schema/index.js";

const DEPENDENCY_KINDS: Set<EdgeKind> = new Set([
  "calls",
  "imports",
  "extends",
  "implements",
  "references",
  "depends-on",
]);

export class DependencyIndex {
  private dependents = new Map<string, Set<string>>();

  addEdge(edge: SymbolEdge): void {
    if (!DEPENDENCY_KINDS.has(edge.kind)) return;
    let set = this.dependents.get(edge.targetId);
    if (!set) {
      set = new Set();
      this.dependents.set(edge.targetId, set);
    }
    set.add(edge.sourceId);
  }

  removeEdge(edge: SymbolEdge): void {
    if (!DEPENDENCY_KINDS.has(edge.kind)) return;
    const set = this.dependents.get(edge.targetId);
    if (set) {
      set.delete(edge.sourceId);
      if (set.size === 0) this.dependents.delete(edge.targetId);
    }
  }

  getDependents(symbolId: string): Set<string> {
    return this.dependents.get(symbolId) ?? new Set();
  }
}
