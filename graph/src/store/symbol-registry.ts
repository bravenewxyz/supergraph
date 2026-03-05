import type { SymbolNode } from "../schema/index.js";

export class SymbolRegistry {
  private byQualifiedName = new Map<string, string>();
  private byModule = new Map<string, Set<string>>();
  private byFile = new Map<string, Set<string>>();

  add(node: SymbolNode): void {
    this.byQualifiedName.set(node.qualifiedName, node.id);

    if (node.parentId) {
      let children = this.byModule.get(node.parentId);
      if (!children) {
        children = new Set();
        this.byModule.set(node.parentId, children);
      }
      children.add(node.id);
    }

    if (node.sourceRange !== null) {
      // Use qualifiedName prefix as a proxy for file path
      // The module-level node's qualifiedName serves as the file key
      const fileKey = node.qualifiedName.split(".")[0];
      if (fileKey) {
        let ids = this.byFile.get(fileKey);
        if (!ids) {
          ids = new Set();
          this.byFile.set(fileKey, ids);
        }
        ids.add(node.id);
      }
    }
  }

  remove(node: SymbolNode): void {
    this.byQualifiedName.delete(node.qualifiedName);

    if (node.parentId) {
      const children = this.byModule.get(node.parentId);
      if (children) {
        children.delete(node.id);
        if (children.size === 0) this.byModule.delete(node.parentId);
      }
    }

    for (const [key, ids] of this.byFile) {
      ids.delete(node.id);
      if (ids.size === 0) this.byFile.delete(key);
    }
  }

  updateQualifiedName(oldQn: string, newQn: string, nodeId: string): void {
    this.byQualifiedName.delete(oldQn);
    this.byQualifiedName.set(newQn, nodeId);
  }

  updateParent(nodeId: string, oldParentId: string | null, newParentId: string): void {
    if (oldParentId) {
      const children = this.byModule.get(oldParentId);
      if (children) {
        children.delete(nodeId);
        if (children.size === 0) this.byModule.delete(oldParentId);
      }
    }
    let children = this.byModule.get(newParentId);
    if (!children) {
      children = new Set();
      this.byModule.set(newParentId, children);
    }
    children.add(nodeId);
  }

  getByQualifiedName(qn: string): string | undefined {
    return this.byQualifiedName.get(qn);
  }

  getChildrenOf(parentId: string): Set<string> {
    return this.byModule.get(parentId) ?? new Set();
  }

  getByFile(fileKey: string): Set<string> {
    return this.byFile.get(fileKey) ?? new Set();
  }
}
