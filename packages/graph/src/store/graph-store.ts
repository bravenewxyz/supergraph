import GraphConstructor from "graphology";
import type { AbstractGraph, Attributes } from "graphology-types";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import type { GraphOperation, OperationResult } from "../schema/operations.js";
import { SymbolRegistry } from "./symbol-registry.js";
import { DependencyIndex } from "./dependency-index.js";

// graphology's CJS/ESM interop is inconsistent under NodeNext resolution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Graph = GraphConstructor as any as new (opts: {
  type: string;
  multi: boolean;
}) => AbstractGraph<Attributes, Attributes, Attributes>;

export interface SerializedGraph {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
}

export class GraphStore {
  private graph: AbstractGraph;
  private registry: SymbolRegistry;
  private depIndex: DependencyIndex;

  constructor() {
    this.graph = new Graph({ type: "directed", multi: true });
    this.registry = new SymbolRegistry();
    this.depIndex = new DependencyIndex();
  }

  // --- Symbol operations ---

  addSymbol(node: SymbolNode): void {
    if (this.graph.hasNode(node.id)) return;
    this.graph.addNode(node.id, node);
    this.registry.add(node);
  }

  removeSymbol(id: string): void {
    if (!this.graph.hasNode(id)) return;
    const node = this.graph.getNodeAttributes(id) as SymbolNode;

    // Remove all edges touching this node (and update indexes)
    const edgeIds = [...this.graph.edges(id)];
    for (const eid of edgeIds) {
      const edge = this.graph.getEdgeAttributes(eid) as SymbolEdge;
      this.depIndex.removeEdge(edge);
      this.graph.dropEdge(eid);
    }

    this.registry.remove(node);
    this.graph.dropNode(id);
  }

  getSymbol(id: string): SymbolNode | undefined {
    if (!this.graph.hasNode(id)) return undefined;
    return this.graph.getNodeAttributes(id) as SymbolNode;
  }

  getSymbolByQualifiedName(qn: string): SymbolNode | undefined {
    const id = this.registry.getByQualifiedName(qn);
    if (!id) return undefined;
    return this.getSymbol(id);
  }

  getChildSymbols(parentId: string): SymbolNode[] {
    const childIds = this.registry.getChildrenOf(parentId);
    const result: SymbolNode[] = [];
    for (const cid of childIds) {
      const node = this.getSymbol(cid);
      if (node) result.push(node);
    }
    return result;
  }

  getModuleSymbols(moduleId: string): SymbolNode[] {
    return this.getChildSymbols(moduleId);
  }

  getAllSymbols(): SymbolNode[] {
    return this.graph.mapNodes((_id: string, attrs: Attributes) => attrs as SymbolNode);
  }

  // --- Edge operations ---

  addEdge(edge: SymbolEdge): void {
    if (this.graph.hasEdge(edge.id)) return;
    if (!this.graph.hasNode(edge.sourceId) || !this.graph.hasNode(edge.targetId)) {
      throw new Error(
        `Cannot add edge ${edge.id}: source (${edge.sourceId}) or target (${edge.targetId}) node missing`,
      );
    }
    this.graph.addEdgeWithKey(edge.id, edge.sourceId, edge.targetId, edge);
    this.depIndex.addEdge(edge);
  }

  removeEdge(id: string): void {
    if (!this.graph.hasEdge(id)) return;
    const edge = this.graph.getEdgeAttributes(id) as SymbolEdge;
    this.depIndex.removeEdge(edge);
    this.graph.dropEdge(id);
  }

  getEdge(id: string): SymbolEdge | undefined {
    if (!this.graph.hasEdge(id)) return undefined;
    return this.graph.getEdgeAttributes(id) as SymbolEdge;
  }

  getEdgesFrom(symbolId: string): SymbolEdge[] {
    if (!this.graph.hasNode(symbolId)) return [];
    return this.graph.mapOutEdges(
      symbolId,
      (_eid: string, attrs: Attributes) => attrs as SymbolEdge,
    );
  }

  getEdgesTo(symbolId: string): SymbolEdge[] {
    if (!this.graph.hasNode(symbolId)) return [];
    return this.graph.mapInEdges(
      symbolId,
      (_eid: string, attrs: Attributes) => attrs as SymbolEdge,
    );
  }

  getEdgesByKind(symbolId: string, kind: SymbolEdge["kind"]): SymbolEdge[] {
    const out = this.getEdgesFrom(symbolId);
    const into = this.getEdgesTo(symbolId);
    return [...out, ...into].filter((e) => e.kind === kind);
  }

  getAllEdges(): SymbolEdge[] {
    return this.graph.mapEdges((_eid: string, attrs: Attributes) => attrs as SymbolEdge);
  }

  // --- Graph queries ---

  getDependents(symbolId: string): string[] {
    return [...this.depIndex.getDependents(symbolId)];
  }

  getDependencies(symbolId: string): string[] {
    const deps = new Set<string>();
    for (const edge of this.getEdgesFrom(symbolId)) {
      if (
        edge.kind === "calls" ||
        edge.kind === "imports" ||
        edge.kind === "extends" ||
        edge.kind === "implements" ||
        edge.kind === "references" ||
        edge.kind === "depends-on"
      ) {
        deps.add(edge.targetId);
      }
    }
    return [...deps];
  }

  getTransitiveDependencies(symbolId: string): string[] {
    const visited = new Set<string>();
    const queue = [symbolId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const dep of this.getDependencies(current)) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }
    return [...visited];
  }

  // --- Operation application ---

  applyOperation(op: GraphOperation): OperationResult {
    switch (op.type) {
      case "AddSymbol":
        this.addSymbol(op.symbol);
        return { applied: true, operationType: op.type, symbolId: op.symbol.id };
      case "RemoveSymbol":
        this.removeSymbol(op.symbolId);
        return { applied: true, operationType: op.type, symbolId: op.symbolId };
      case "ModifyBody": {
        const node = this.getSymbol(op.symbolId);
        if (!node) return { applied: false, operationType: op.type, symbolId: op.symbolId, reason: "symbol not found" };
        node.body = op.newBody;
        node.updatedAt = Date.now();
        node.version++;
        this.graph.replaceNodeAttributes(op.symbolId, node);
        return { applied: true, operationType: op.type, symbolId: op.symbolId };
      }
      case "ModifySignature": {
        const node = this.getSymbol(op.symbolId);
        if (!node) return { applied: false, operationType: op.type, symbolId: op.symbolId, reason: "symbol not found" };
        node.signature = op.newSignature;
        node.typeText = op.newTypeText;
        node.updatedAt = Date.now();
        node.version++;
        this.graph.replaceNodeAttributes(op.symbolId, node);
        return { applied: true, operationType: op.type, symbolId: op.symbolId };
      }
      case "RenameSymbol": {
        const node = this.getSymbol(op.symbolId);
        if (!node) return { applied: false, operationType: op.type, symbolId: op.symbolId, reason: "symbol not found" };
        const oldQn = node.qualifiedName;
        node.name = op.newName;
        const parts = node.qualifiedName.split(".");
        parts[parts.length - 1] = op.newName;
        node.qualifiedName = parts.join(".");
        node.updatedAt = Date.now();
        node.version++;
        this.graph.replaceNodeAttributes(op.symbolId, node);
        this.registry.updateQualifiedName(oldQn, node.qualifiedName, node.id);
        return { applied: true, operationType: op.type, symbolId: op.symbolId };
      }
      case "MoveSymbol": {
        const node = this.getSymbol(op.symbolId);
        if (!node) return { applied: false, operationType: op.type, symbolId: op.symbolId, reason: "symbol not found" };
        const oldParentId = node.parentId;
        node.parentId = op.newParentId;
        node.updatedAt = Date.now();
        node.version++;
        this.graph.replaceNodeAttributes(op.symbolId, node);
        this.registry.updateParent(node.id, oldParentId, op.newParentId);
        return { applied: true, operationType: op.type, symbolId: op.symbolId };
      }
      case "AddEdge": {
        if (!this.graph.hasNode(op.edge.sourceId) || !this.graph.hasNode(op.edge.targetId)) {
          return { applied: false, operationType: op.type, reason: "source or target node not found" };
        }
        this.addEdge(op.edge);
        return { applied: true, operationType: op.type };
      }
      case "RemoveEdge":
        this.removeEdge(op.edgeId);
        return { applied: true, operationType: op.type };
      case "SetExported": {
        const node = this.getSymbol(op.symbolId);
        if (!node) return { applied: false, operationType: op.type, symbolId: op.symbolId, reason: "symbol not found" };
        node.exported = op.exported;
        node.updatedAt = Date.now();
        node.version++;
        this.graph.replaceNodeAttributes(op.symbolId, node);
        return { applied: true, operationType: op.type, symbolId: op.symbolId };
      }
      case "AddModifier": {
        const node = this.getSymbol(op.symbolId);
        if (!node) return { applied: false, operationType: op.type, symbolId: op.symbolId, reason: "symbol not found" };
        if (!node.modifiers.includes(op.modifier)) {
          node.modifiers.push(op.modifier);
          node.updatedAt = Date.now();
          node.version++;
          this.graph.replaceNodeAttributes(op.symbolId, node);
          return { applied: true, operationType: op.type, symbolId: op.symbolId };
        }
        return { applied: false, operationType: op.type, symbolId: op.symbolId, reason: "modifier already present" };
      }
      case "RemoveModifier": {
        const node = this.getSymbol(op.symbolId);
        if (!node) return { applied: false, operationType: op.type, symbolId: op.symbolId, reason: "symbol not found" };
        const idx = node.modifiers.indexOf(op.modifier);
        if (idx !== -1) {
          node.modifiers.splice(idx, 1);
          node.updatedAt = Date.now();
          node.version++;
          this.graph.replaceNodeAttributes(op.symbolId, node);
          return { applied: true, operationType: op.type, symbolId: op.symbolId };
        }
        return { applied: false, operationType: op.type, symbolId: op.symbolId, reason: "modifier not present" };
      }
      case "ModifyDecorators": {
        const node = this.getSymbol(op.symbolId);
        if (!node) return { applied: false, operationType: op.type, symbolId: op.symbolId, reason: "symbol not found" };
        node.decorators = [...op.newDecorators];
        node.updatedAt = Date.now();
        node.version++;
        this.graph.replaceNodeAttributes(op.symbolId, node);
        return { applied: true, operationType: op.type, symbolId: op.symbolId };
      }
    }
  }

  // --- Serialization ---

  export(): SerializedGraph {
    return {
      nodes: this.getAllSymbols(),
      edges: this.getAllEdges(),
    };
  }

  import(data: SerializedGraph): void {
    for (const node of data.nodes) {
      this.addSymbol(node);
    }
    for (const edge of data.edges) {
      this.addEdge(edge);
    }
  }

  exportJSON(): string {
    return JSON.stringify(this.export());
  }

  importJSON(json: string): void {
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      throw new Error("Invalid SerializedGraph: expected { nodes: [], edges: [] }");
    }
    this.import(data as SerializedGraph);
  }

  // --- Stats ---

  get nodeCount(): number {
    return this.graph.order;
  }

  get edgeCount(): number {
    return this.graph.size;
  }
}
