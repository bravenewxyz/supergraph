import { describe, test, expect, beforeEach } from "bun:test";
import { GraphStore } from "../store/graph-store.js";
import { createSymbolNode } from "../schema/nodes.js";
import { createSymbolEdge } from "../schema/edges.js";
import type { GraphOperation } from "../schema/operations.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";

function makeNode(overrides: Partial<SymbolNode> & { id: string; name: string }): SymbolNode {
  return createSymbolNode({
    kind: "function",
    qualifiedName: overrides.qualifiedName ?? `mod.${overrides.name}`,
    ...overrides,
  });
}

function makeEdge(
  overrides: Partial<SymbolEdge> & { id: string; sourceId: string; targetId: string },
): SymbolEdge {
  return createSymbolEdge({
    kind: "calls",
    ...overrides,
  });
}

describe("GraphStore", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore();
  });

  // --- Symbol CRUD ---

  describe("symbol operations", () => {
    test("add and get symbol", () => {
      const node = makeNode({ id: "n1", name: "foo" });
      store.addSymbol(node);
      expect(store.getSymbol("n1")).toEqual(node);
      expect(store.nodeCount).toBe(1);
    });

    test("get nonexistent symbol returns undefined", () => {
      expect(store.getSymbol("nope")).toBeUndefined();
    });

    test("duplicate add is idempotent", () => {
      const node = makeNode({ id: "n1", name: "foo" });
      store.addSymbol(node);
      store.addSymbol(node);
      expect(store.nodeCount).toBe(1);
    });

    test("remove symbol", () => {
      const node = makeNode({ id: "n1", name: "foo" });
      store.addSymbol(node);
      store.removeSymbol("n1");
      expect(store.getSymbol("n1")).toBeUndefined();
      expect(store.nodeCount).toBe(0);
    });

    test("remove nonexistent symbol is a no-op", () => {
      store.removeSymbol("nope"); // should not throw
      expect(store.nodeCount).toBe(0);
    });

    test("getSymbolByQualifiedName", () => {
      const node = makeNode({ id: "n1", name: "foo", qualifiedName: "mod.foo" });
      store.addSymbol(node);
      expect(store.getSymbolByQualifiedName("mod.foo")).toEqual(node);
      expect(store.getSymbolByQualifiedName("mod.bar")).toBeUndefined();
    });

    test("getAllSymbols", () => {
      store.addSymbol(makeNode({ id: "n1", name: "a" }));
      store.addSymbol(makeNode({ id: "n2", name: "b" }));
      const all = store.getAllSymbols();
      expect(all).toHaveLength(2);
      const ids = all.map((n) => n.id).sort();
      expect(ids).toEqual(["n1", "n2"]);
    });
  });

  // --- Child / Module symbols ---

  describe("getChildSymbols and getModuleSymbols", () => {
    test("returns children of a parent", () => {
      const mod = makeNode({ id: "mod1", name: "myModule", kind: "module", qualifiedName: "myModule" });
      const fn1 = makeNode({ id: "fn1", name: "foo", parentId: "mod1", qualifiedName: "myModule.foo" });
      const fn2 = makeNode({ id: "fn2", name: "bar", parentId: "mod1", qualifiedName: "myModule.bar" });
      const fn3 = makeNode({ id: "fn3", name: "baz", parentId: "other", qualifiedName: "other.baz" });
      store.addSymbol(mod);
      store.addSymbol(fn1);
      store.addSymbol(fn2);
      store.addSymbol(fn3);

      const children = store.getChildSymbols("mod1");
      expect(children).toHaveLength(2);
      const names = children.map((n) => n.name).sort();
      expect(names).toEqual(["bar", "foo"]);

      // getModuleSymbols is an alias
      expect(store.getModuleSymbols("mod1")).toEqual(children);
    });

    test("returns empty for node with no children", () => {
      store.addSymbol(makeNode({ id: "n1", name: "lonely" }));
      expect(store.getChildSymbols("n1")).toEqual([]);
    });
  });

  // --- Edge CRUD ---

  describe("edge operations", () => {
    test("add and get edge", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      const edge = makeEdge({ id: "e1", sourceId: "a", targetId: "b" });
      store.addEdge(edge);
      expect(store.getEdge("e1")).toEqual(edge);
      expect(store.edgeCount).toBe(1);
    });

    test("duplicate edge add is idempotent", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      const edge = makeEdge({ id: "e1", sourceId: "a", targetId: "b" });
      store.addEdge(edge);
      store.addEdge(edge);
      expect(store.edgeCount).toBe(1);
    });

    test("add edge throws when nodes missing", () => {
      const edge = makeEdge({ id: "e1", sourceId: "missing1", targetId: "missing2" });
      expect(() => store.addEdge(edge)).toThrow(/source.*or target.*missing/);
    });

    test("remove edge", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b" }));
      store.removeEdge("e1");
      expect(store.getEdge("e1")).toBeUndefined();
      expect(store.edgeCount).toBe(0);
    });

    test("remove nonexistent edge is a no-op", () => {
      store.removeEdge("nope"); // should not throw
    });

    test("getEdgesFrom and getEdgesTo", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addSymbol(makeNode({ id: "c", name: "c" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b" }));
      store.addEdge(makeEdge({ id: "e2", sourceId: "a", targetId: "c" }));
      store.addEdge(makeEdge({ id: "e3", sourceId: "b", targetId: "c" }));

      expect(store.getEdgesFrom("a")).toHaveLength(2);
      expect(store.getEdgesTo("c")).toHaveLength(2);
      expect(store.getEdgesFrom("c")).toHaveLength(0);
    });

    test("getEdgesFrom / getEdgesTo for nonexistent node returns empty", () => {
      expect(store.getEdgesFrom("nope")).toEqual([]);
      expect(store.getEdgesTo("nope")).toEqual([]);
    });

    test("getEdgesByKind filters correctly", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b", kind: "calls" }));
      store.addEdge(makeEdge({ id: "e2", sourceId: "a", targetId: "b", kind: "imports" }));
      store.addEdge(makeEdge({ id: "e3", sourceId: "b", targetId: "a", kind: "calls" }));

      const callEdges = store.getEdgesByKind("a", "calls");
      expect(callEdges).toHaveLength(2); // e1 (out) + e3 (in)
      expect(callEdges.every((e) => e.kind === "calls")).toBe(true);
    });

    test("getAllEdges", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b" }));
      store.addEdge(makeEdge({ id: "e2", sourceId: "b", targetId: "a", kind: "imports" }));
      expect(store.getAllEdges()).toHaveLength(2);
    });

    test("multiple edges between same nodes (multigraph)", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b", kind: "calls" }));
      store.addEdge(makeEdge({ id: "e2", sourceId: "a", targetId: "b", kind: "imports" }));
      store.addEdge(makeEdge({ id: "e3", sourceId: "a", targetId: "b", kind: "references" }));
      expect(store.edgeCount).toBe(3);
      expect(store.getEdgesFrom("a")).toHaveLength(3);
    });
  });

  // --- Remove symbol cleans up edges ---

  describe("remove symbol cascades to edges", () => {
    test("removing a symbol removes all its edges", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addSymbol(makeNode({ id: "c", name: "c" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b" }));
      store.addEdge(makeEdge({ id: "e2", sourceId: "c", targetId: "a" }));
      expect(store.edgeCount).toBe(2);

      store.removeSymbol("a");
      expect(store.edgeCount).toBe(0);
      expect(store.getEdge("e1")).toBeUndefined();
      expect(store.getEdge("e2")).toBeUndefined();
    });
  });

  // --- Dependency queries ---

  describe("getDependents and getDependencies", () => {
    test("getDependencies returns targets of dependency edges", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addSymbol(makeNode({ id: "c", name: "c" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b", kind: "calls" }));
      store.addEdge(makeEdge({ id: "e2", sourceId: "a", targetId: "c", kind: "imports" }));
      // "contains" is not a dependency kind
      store.addEdge(makeEdge({ id: "e3", sourceId: "a", targetId: "c", kind: "contains" }));

      const deps = store.getDependencies("a");
      expect(deps.sort()).toEqual(["b", "c"]);
    });

    test("getDependents returns who depends on a symbol", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addSymbol(makeNode({ id: "c", name: "c" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "c", kind: "calls" }));
      store.addEdge(makeEdge({ id: "e2", sourceId: "b", targetId: "c", kind: "imports" }));

      const dependents = store.getDependents("c").sort();
      expect(dependents).toEqual(["a", "b"]);
    });

    test("getTransitiveDependencies", () => {
      // a -> b -> c -> d
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addSymbol(makeNode({ id: "c", name: "c" }));
      store.addSymbol(makeNode({ id: "d", name: "d" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b", kind: "calls" }));
      store.addEdge(makeEdge({ id: "e2", sourceId: "b", targetId: "c", kind: "calls" }));
      store.addEdge(makeEdge({ id: "e3", sourceId: "c", targetId: "d", kind: "imports" }));

      const transitive = store.getTransitiveDependencies("a").sort();
      expect(transitive).toEqual(["b", "c", "d"]);
    });

    test("getTransitiveDependencies handles cycles", () => {
      // a -> b -> c -> a (cycle)
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addSymbol(makeNode({ id: "c", name: "c" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b", kind: "calls" }));
      store.addEdge(makeEdge({ id: "e2", sourceId: "b", targetId: "c", kind: "calls" }));
      store.addEdge(makeEdge({ id: "e3", sourceId: "c", targetId: "a", kind: "calls" }));

      const transitive = store.getTransitiveDependencies("a").sort();
      expect(transitive).toEqual(["a", "b", "c"]);
    });

    test("dependents index updated on edge removal", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b", kind: "calls" }));
      expect(store.getDependents("b")).toEqual(["a"]);

      store.removeEdge("e1");
      expect(store.getDependents("b")).toEqual([]);
    });
  });

  // --- applyOperation ---

  describe("applyOperation", () => {
    test("AddSymbol", () => {
      const node = makeNode({ id: "n1", name: "foo" });
      store.applyOperation({ type: "AddSymbol", symbol: node });
      expect(store.getSymbol("n1")).toEqual(node);
    });

    test("RemoveSymbol", () => {
      store.addSymbol(makeNode({ id: "n1", name: "foo" }));
      store.applyOperation({ type: "RemoveSymbol", symbolId: "n1" });
      expect(store.getSymbol("n1")).toBeUndefined();
    });

    test("ModifyBody", () => {
      store.addSymbol(makeNode({ id: "n1", name: "foo", body: "old" }));
      store.applyOperation({ type: "ModifyBody", symbolId: "n1", newBody: "new body" });
      const node = store.getSymbol("n1")!;
      expect(node.body).toBe("new body");
      expect(node.version).toBe(2);
    });

    test("ModifySignature", () => {
      store.addSymbol(makeNode({ id: "n1", name: "foo", signature: "old", typeText: "old" }));
      store.applyOperation({
        type: "ModifySignature",
        symbolId: "n1",
        newSignature: "new sig",
        newTypeText: "new type",
      });
      const node = store.getSymbol("n1")!;
      expect(node.signature).toBe("new sig");
      expect(node.typeText).toBe("new type");
      expect(node.version).toBe(2);
    });

    test("RenameSymbol", () => {
      store.addSymbol(makeNode({ id: "n1", name: "old", qualifiedName: "mod.old" }));
      store.applyOperation({ type: "RenameSymbol", symbolId: "n1", newName: "renamed" });
      const node = store.getSymbol("n1")!;
      expect(node.name).toBe("renamed");
      expect(node.qualifiedName).toBe("mod.renamed");
      // Registry updated
      expect(store.getSymbolByQualifiedName("mod.renamed")).toEqual(node);
      expect(store.getSymbolByQualifiedName("mod.old")).toBeUndefined();
    });

    test("MoveSymbol", () => {
      store.addSymbol(makeNode({ id: "parent1", name: "p1", kind: "module", qualifiedName: "p1" }));
      store.addSymbol(makeNode({ id: "parent2", name: "p2", kind: "module", qualifiedName: "p2" }));
      store.addSymbol(makeNode({ id: "child", name: "c", parentId: "parent1", qualifiedName: "p1.c" }));

      expect(store.getChildSymbols("parent1")).toHaveLength(1);
      store.applyOperation({ type: "MoveSymbol", symbolId: "child", newParentId: "parent2" });

      expect(store.getChildSymbols("parent1")).toHaveLength(0);
      expect(store.getChildSymbols("parent2")).toHaveLength(1);
      expect(store.getSymbol("child")!.parentId).toBe("parent2");
    });

    test("AddEdge", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      const edge = makeEdge({ id: "e1", sourceId: "a", targetId: "b" });
      store.applyOperation({ type: "AddEdge", edge });
      expect(store.getEdge("e1")).toEqual(edge);
    });

    test("RemoveEdge", () => {
      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b" }));
      store.applyOperation({ type: "RemoveEdge", edgeId: "e1" });
      expect(store.getEdge("e1")).toBeUndefined();
    });

    test("SetExported", () => {
      store.addSymbol(makeNode({ id: "n1", name: "foo", exported: false }));
      store.applyOperation({ type: "SetExported", symbolId: "n1", exported: true });
      expect(store.getSymbol("n1")!.exported).toBe(true);
    });

    test("AddModifier", () => {
      store.addSymbol(makeNode({ id: "n1", name: "foo" }));
      store.applyOperation({ type: "AddModifier", symbolId: "n1", modifier: "async" });
      expect(store.getSymbol("n1")!.modifiers).toEqual(["async"]);
      // Adding same modifier again is idempotent
      store.applyOperation({ type: "AddModifier", symbolId: "n1", modifier: "async" });
      expect(store.getSymbol("n1")!.modifiers).toEqual(["async"]);
    });

    test("RemoveModifier", () => {
      store.addSymbol(makeNode({ id: "n1", name: "foo", modifiers: ["async", "static"] }));
      store.applyOperation({ type: "RemoveModifier", symbolId: "n1", modifier: "async" });
      expect(store.getSymbol("n1")!.modifiers).toEqual(["static"]);
      // Removing nonexistent modifier is a no-op
      store.applyOperation({ type: "RemoveModifier", symbolId: "n1", modifier: "readonly" });
      expect(store.getSymbol("n1")!.modifiers).toEqual(["static"]);
    });

    test("operations on nonexistent symbols are no-ops", () => {
      // Should not throw
      store.applyOperation({ type: "ModifyBody", symbolId: "nope", newBody: "x" });
      store.applyOperation({
        type: "ModifySignature",
        symbolId: "nope",
        newSignature: "x",
        newTypeText: "x",
      });
      store.applyOperation({ type: "RenameSymbol", symbolId: "nope", newName: "x" });
      store.applyOperation({ type: "MoveSymbol", symbolId: "nope", newParentId: "x" });
      store.applyOperation({ type: "SetExported", symbolId: "nope", exported: true });
      store.applyOperation({ type: "AddModifier", symbolId: "nope", modifier: "x" });
      store.applyOperation({ type: "RemoveModifier", symbolId: "nope", modifier: "x" });
    });
  });

  // --- Serialization ---

  describe("serialization", () => {
    test("export/import round-trip preserves structure", () => {
      const n1 = makeNode({ id: "n1", name: "a", qualifiedName: "mod.a" });
      const n2 = makeNode({ id: "n2", name: "b", qualifiedName: "mod.b" });
      store.addSymbol(n1);
      store.addSymbol(n2);
      store.addEdge(makeEdge({ id: "e1", sourceId: "n1", targetId: "n2", kind: "calls" }));

      const serialized = store.export();
      expect(serialized.nodes).toHaveLength(2);
      expect(serialized.edges).toHaveLength(1);

      const store2 = new GraphStore();
      store2.import(serialized);
      expect(store2.nodeCount).toBe(2);
      expect(store2.edgeCount).toBe(1);
      expect(store2.getSymbol("n1")!.name).toBe("a");
      expect(store2.getEdge("e1")!.kind).toBe("calls");
      // Registry works in restored store
      expect(store2.getSymbolByQualifiedName("mod.a")!.id).toBe("n1");
      // Dependency index works in restored store
      expect(store2.getDependents("n2")).toEqual(["n1"]);
    });

    test("JSON round-trip", () => {
      store.addSymbol(makeNode({ id: "n1", name: "x", qualifiedName: "mod.x" }));
      store.addSymbol(makeNode({ id: "n2", name: "y", qualifiedName: "mod.y" }));
      store.addEdge(makeEdge({ id: "e1", sourceId: "n1", targetId: "n2", kind: "imports" }));

      const json = store.exportJSON();
      expect(typeof json).toBe("string");

      const store2 = new GraphStore();
      store2.importJSON(json);
      expect(store2.nodeCount).toBe(2);
      expect(store2.edgeCount).toBe(1);
      expect(store2.getSymbol("n1")!.name).toBe("x");
      expect(store2.getEdge("e1")!.kind).toBe("imports");
    });
  });

  // --- Stats ---

  describe("stats", () => {
    test("nodeCount and edgeCount", () => {
      expect(store.nodeCount).toBe(0);
      expect(store.edgeCount).toBe(0);

      store.addSymbol(makeNode({ id: "a", name: "a" }));
      store.addSymbol(makeNode({ id: "b", name: "b" }));
      expect(store.nodeCount).toBe(2);

      store.addEdge(makeEdge({ id: "e1", sourceId: "a", targetId: "b" }));
      expect(store.edgeCount).toBe(1);

      store.removeSymbol("a");
      expect(store.nodeCount).toBe(1);
      expect(store.edgeCount).toBe(0); // edge removed with symbol
    });
  });
});
