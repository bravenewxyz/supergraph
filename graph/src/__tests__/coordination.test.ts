import { describe, test, expect, beforeEach } from "bun:test";
import { GraphStore } from "../store/graph-store.js";
import { createSymbolNode } from "../schema/nodes.js";
import { createSymbolEdge } from "../schema/edges.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import type { GraphOperation } from "../schema/operations.js";
import { SymbolLockTable } from "../coordination/symbol-lock-table.js";
import { ContractLayer } from "../coordination/contract-layer.js";
import { ScopeGraph } from "../coordination/scope-graph.js";
import { classifyOperation, classifyBatch } from "../coordination/tier-classifier.js";
import type { TierClassification } from "../coordination/tier-classifier.js";

function makeNode(
  overrides: Partial<SymbolNode> & { id: string; name: string },
): SymbolNode {
  return createSymbolNode({
    kind: "function",
    qualifiedName: overrides.qualifiedName ?? `mod.${overrides.name}`,
    ...overrides,
  });
}

function makeEdge(
  overrides: Partial<SymbolEdge> & {
    id: string;
    sourceId: string;
    targetId: string;
  },
): SymbolEdge {
  return createSymbolEdge({
    kind: "calls",
    ...overrides,
  });
}

// ============================================================
// SymbolLockTable
// ============================================================

describe("SymbolLockTable", () => {
  let table: SymbolLockTable;

  beforeEach(() => {
    table = new SymbolLockTable();
  });

  describe("acquire and release", () => {
    test("acquire a single symbol", () => {
      const result = table.acquire("sym1", "agent-a", "ModifyBody");
      expect(result.status).toBe("acquired");
      expect(table.isLocked("sym1")).toBe(true);
    });

    test("release a single symbol", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      table.release("sym1", "agent-a");
      expect(table.isLocked("sym1")).toBe(false);
    });

    test("getLockedBy returns active modifications", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      const mods = table.getLockedBy("sym1");
      expect(mods).toHaveLength(1);
      expect(mods[0]!.agentId).toBe("agent-a");
      expect(mods[0]!.opType).toBe("ModifyBody");
    });

    test("getLockedBy returns empty for unlocked symbol", () => {
      expect(table.getLockedBy("sym1")).toEqual([]);
    });

    test("getAgentSymbols returns symbols held by agent", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      table.acquire("sym2", "agent-a", "AddModifier");
      const symbols = table.getAgentSymbols("agent-a");
      expect(symbols.size).toBe(2);
      expect(symbols.has("sym1")).toBe(true);
      expect(symbols.has("sym2")).toBe(true);
    });

    test("getAgentSymbols returns empty set for unknown agent", () => {
      const symbols = table.getAgentSymbols("unknown");
      expect(symbols.size).toBe(0);
    });

    test("getActiveSymbols returns all active modifications", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      table.acquire("sym2", "agent-b", "AddModifier");
      const active = table.getActiveSymbols();
      expect(active.size).toBe(2);
      expect(active.has("sym1")).toBe(true);
      expect(active.has("sym2")).toBe(true);
    });
  });

  describe("conflict detection", () => {
    test("same agent can re-acquire (re-entrant)", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      const result = table.acquire("sym1", "agent-a", "ModifySignature");
      expect(result.status).toBe("acquired");
    });

    test("conflicting ops from different agents are detected", () => {
      table.acquire("sym1", "agent-a", "RenameSymbol");
      const result = table.acquire("sym1", "agent-b", "RenameSymbol");
      expect(result.status).toBe("conflict");
      if (result.status === "conflict") {
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]!.existingAgent).toBe("agent-a");
        expect(result.conflicts[0]!.commutativity).toBe("conflict");
      }
    });

    test("ModifySignature vs ModifySignature is lww (non-conflicting)", () => {
      table.acquire("sym1", "agent-a", "ModifySignature");
      const result = table.acquire("sym1", "agent-b", "ModifySignature");
      expect(result.status).toBe("acquired");
    });

    test("RenameSymbol commutes with ModifyBody", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      const result = table.acquire("sym1", "agent-b", "RenameSymbol");
      expect(result.status).toBe("acquired");
    });

    test("MoveSymbol commutes with ModifyBody", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      const result = table.acquire("sym1", "agent-b", "MoveSymbol");
      expect(result.status).toBe("acquired");
    });

    test("RenameSymbol conflicts with ModifySignature from another agent", () => {
      table.acquire("sym1", "agent-a", "ModifySignature");
      const result = table.acquire("sym1", "agent-b", "RenameSymbol");
      expect(result.status).toBe("conflict");
    });

    test("ModifyBody vs ModifySignature is contract-dependent (conflicting)", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      const result = table.acquire("sym1", "agent-b", "ModifySignature");
      expect(result.status).toBe("conflict");
      if (result.status === "conflict") {
        expect(result.conflicts[0]!.commutativity).toBe("contract-dependent");
      }
    });

    test("RemoveSymbol conflicts with any other op", () => {
      table.acquire("sym1", "agent-a", "AddModifier");
      const result = table.acquire("sym1", "agent-b", "RemoveSymbol");
      expect(result.status).toBe("conflict");
    });
  });

  describe("commutative operations", () => {
    test("AddEdge commutes with ModifyBody", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      const result = table.acquire("sym1", "agent-b", "AddEdge");
      expect(result.status).toBe("acquired");
    });

    test("RemoveEdge commutes with ModifySignature", () => {
      table.acquire("sym1", "agent-a", "ModifySignature");
      const result = table.acquire("sym1", "agent-b", "RemoveEdge");
      expect(result.status).toBe("acquired");
    });

    test("AddModifier conflicts with RemoveModifier", () => {
      table.acquire("sym1", "agent-a", "AddModifier");
      const result = table.acquire("sym1", "agent-b", "RemoveModifier");
      expect(result.status).toBe("conflict");
    });

    test("AddModifier commutes with ModifyBody", () => {
      table.acquire("sym1", "agent-a", "AddModifier");
      const result = table.acquire("sym1", "agent-b", "ModifyBody");
      expect(result.status).toBe("acquired");
    });

    test("ModifyBody with ModifyBody gets lww (allowed)", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      const result = table.acquire("sym1", "agent-b", "ModifyBody");
      // lww is not a conflict — both can proceed
      expect(result.status).toBe("acquired");
    });

    test("SetExported commutes with ModifyBody", () => {
      table.acquire("sym1", "agent-a", "SetExported");
      const result = table.acquire("sym1", "agent-b", "ModifyBody");
      expect(result.status).toBe("acquired");
    });

    test("SetExported vs SetExported is lww (non-conflicting)", () => {
      table.acquire("sym1", "agent-a", "SetExported");
      const result = table.acquire("sym1", "agent-b", "SetExported");
      expect(result.status).toBe("acquired");
    });
  });

  describe("batch acquire", () => {
    test("batch acquire succeeds when no conflicts", () => {
      const result = table.acquireBatch(
        ["sym1", "sym2", "sym3"],
        "agent-a",
        "ModifyBody",
      );
      expect(result.status).toBe("acquired");
      expect(table.isLocked("sym1")).toBe(true);
      expect(table.isLocked("sym2")).toBe(true);
      expect(table.isLocked("sym3")).toBe(true);
    });

    test("batch acquire is atomic: all-or-nothing on conflict", () => {
      table.acquire("sym2", "agent-b", "RenameSymbol");
      const result = table.acquireBatch(
        ["sym1", "sym2", "sym3"],
        "agent-a",
        "RenameSymbol",
      );
      expect(result.status).toBe("conflict");
      // sym1 and sym3 should NOT be locked by agent-a (atomic rollback)
      expect(table.getAgentSymbols("agent-a").size).toBe(0);
    });

    test("batch acquire with multiple conflicts", () => {
      table.acquire("sym1", "agent-b", "RenameSymbol");
      table.acquire("sym3", "agent-c", "RenameSymbol");
      const result = table.acquireBatch(
        ["sym1", "sym2", "sym3"],
        "agent-a",
        "ModifySignature",
      );
      expect(result.status).toBe("conflict");
      if (result.status === "conflict") {
        expect(result.conflicts.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe("releaseAgent", () => {
    test("releases all symbols held by an agent", () => {
      table.acquire("sym1", "agent-a", "ModifyBody");
      table.acquire("sym2", "agent-a", "AddModifier");
      table.acquire("sym3", "agent-b", "ModifyBody");

      table.releaseAgent("agent-a");

      expect(table.isLocked("sym1")).toBe(false);
      expect(table.isLocked("sym2")).toBe(false);
      // agent-b's lock should still be there
      expect(table.isLocked("sym3")).toBe(true);
      expect(table.getAgentSymbols("agent-a").size).toBe(0);
    });

    test("releaseAgent for unknown agent is a no-op", () => {
      table.releaseAgent("unknown"); // should not throw
    });
  });
});

// ============================================================
// ContractLayer
// ============================================================

describe("ContractLayer", () => {
  let store: GraphStore;
  let layer: ContractLayer;

  beforeEach(() => {
    store = new GraphStore();
    layer = new ContractLayer(store);
  });

  describe("defineContract and getContract", () => {
    test("define and retrieve a contract", () => {
      const contract = {
        symbolId: "sym1",
        kind: "function" as const,
        name: "doThing",
        qualifiedName: "mod.doThing",
        signature: "(x: number) => string",
        exported: true,
        dependencies: [],
      };
      layer.defineContract(contract);
      expect(layer.getContract("sym1")).toEqual(contract);
    });

    test("getContract returns undefined for unknown symbol", () => {
      expect(layer.getContract("nope")).toBeUndefined();
    });

    test("getAllContracts returns all defined contracts", () => {
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "a",
        qualifiedName: "mod.a",
        signature: "() => void",
        exported: true,
        dependencies: [],
      });
      layer.defineContract({
        symbolId: "sym2",
        kind: "class",
        name: "B",
        qualifiedName: "mod.B",
        signature: "class B",
        exported: true,
        dependencies: [],
      });
      expect(layer.getAllContracts()).toHaveLength(2);
    });
  });

  describe("defineContractsFromGraph", () => {
    test("auto-extracts contracts from exported symbols only", () => {
      store.addSymbol(
        makeNode({
          id: "fn1",
          name: "pubFn",
          exported: true,
          signature: "(x: number) => string",
        }),
      );
      store.addSymbol(
        makeNode({
          id: "fn2",
          name: "privFn",
          exported: false,
          signature: "() => void",
        }),
      );
      store.addSymbol(
        makeNode({
          id: "fn3",
          name: "anotherPub",
          exported: true,
          signature: "(y: string) => boolean",
        }),
      );

      layer.defineContractsFromGraph();

      expect(layer.getContract("fn1")).toBeDefined();
      expect(layer.getContract("fn1")!.name).toBe("pubFn");
      expect(layer.getContract("fn1")!.signature).toBe("(x: number) => string");

      expect(layer.getContract("fn2")).toBeUndefined();

      expect(layer.getContract("fn3")).toBeDefined();
      expect(layer.getContract("fn3")!.name).toBe("anotherPub");
    });

    test("includes dependencies from graph edges", () => {
      store.addSymbol(
        makeNode({ id: "fn1", name: "pubFn", exported: true }),
      );
      store.addSymbol(
        makeNode({ id: "fn2", name: "helper", exported: false }),
      );
      store.addEdge(
        makeEdge({ id: "e1", sourceId: "fn1", targetId: "fn2", kind: "calls" }),
      );

      layer.defineContractsFromGraph();

      const contract = layer.getContract("fn1")!;
      expect(contract.dependencies).toContain("fn2");
    });
  });

  describe("assignment and agent view", () => {
    test("assign contracts to agents", () => {
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doA",
        qualifiedName: "mod.doA",
        signature: "() => void",
        exported: true,
        dependencies: ["sym2"],
      });
      layer.defineContract({
        symbolId: "sym2",
        kind: "function",
        name: "doB",
        qualifiedName: "mod.doB",
        signature: "() => string",
        exported: true,
        dependencies: [],
      });

      layer.assignContract("sym1", "agent-a");
      layer.assignContract("sym2", "agent-b");

      expect(layer.getAssignedAgent("sym1")).toBe("agent-a");
      expect(layer.getAssignedAgent("sym2")).toBe("agent-b");
    });

    test("getAssignedAgent returns undefined for unassigned symbol", () => {
      expect(layer.getAssignedAgent("nope")).toBeUndefined();
    });

    test("getAgentView returns owned and dependency contracts", () => {
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doA",
        qualifiedName: "mod.doA",
        signature: "() => void",
        exported: true,
        dependencies: ["sym2"],
      });
      layer.defineContract({
        symbolId: "sym2",
        kind: "function",
        name: "doB",
        qualifiedName: "mod.doB",
        signature: "() => string",
        exported: true,
        dependencies: [],
      });
      layer.defineContract({
        symbolId: "sym3",
        kind: "class",
        name: "Unrelated",
        qualifiedName: "mod.Unrelated",
        signature: "class Unrelated",
        exported: true,
        dependencies: [],
      });

      layer.assignContract("sym1", "agent-a");
      layer.assignContract("sym2", "agent-b");
      layer.assignContract("sym3", "agent-c");

      const view = layer.getAgentView("agent-a");
      expect(view.ownedContracts).toHaveLength(1);
      expect(view.ownedContracts[0]!.symbolId).toBe("sym1");

      // sym2 is a dependency of sym1
      expect(view.dependencyContracts).toHaveLength(1);
      expect(view.dependencyContracts[0]!.symbolId).toBe("sym2");
    });

    test("getAgentView excludes owned contracts from dependency list", () => {
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doA",
        qualifiedName: "mod.doA",
        signature: "() => void",
        exported: true,
        dependencies: ["sym1"], // self-reference
      });

      layer.assignContract("sym1", "agent-a");
      const view = layer.getAgentView("agent-a");
      expect(view.ownedContracts).toHaveLength(1);
      expect(view.dependencyContracts).toHaveLength(0);
    });
  });

  describe("validation", () => {
    test("validates matching implementation", () => {
      store.addSymbol(
        makeNode({
          id: "sym1",
          name: "doThing",
          exported: true,
          signature: "(x: number) => string",
        }),
      );
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doThing",
        qualifiedName: "mod.doThing",
        signature: "(x: number) => string",
        exported: true,
        dependencies: [],
      });

      const result = layer.validateImplementation("sym1");
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("detects name mismatch", () => {
      store.addSymbol(
        makeNode({
          id: "sym1",
          name: "renamedThing",
          exported: true,
          signature: "(x: number) => string",
        }),
      );
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doThing",
        qualifiedName: "mod.doThing",
        signature: "(x: number) => string",
        exported: true,
        dependencies: [],
      });

      const result = layer.validateImplementation("sym1");
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.contractField).toBe("name");
      expect(result.errors[0]!.expected).toBe("doThing");
      expect(result.errors[0]!.actual).toBe("renamedThing");
    });

    test("detects signature mismatch", () => {
      store.addSymbol(
        makeNode({
          id: "sym1",
          name: "doThing",
          exported: true,
          signature: "(x: string) => number",
        }),
      );
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doThing",
        qualifiedName: "mod.doThing",
        signature: "(x: number) => string",
        exported: true,
        dependencies: [],
      });

      const result = layer.validateImplementation("sym1");
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.contractField === "signature")).toBe(
        true,
      );
    });

    test("detects exported mismatch", () => {
      store.addSymbol(
        makeNode({
          id: "sym1",
          name: "doThing",
          exported: false,
          signature: "(x: number) => string",
        }),
      );
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doThing",
        qualifiedName: "mod.doThing",
        signature: "(x: number) => string",
        exported: true,
        dependencies: [],
      });

      const result = layer.validateImplementation("sym1");
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.contractField === "exported")).toBe(
        true,
      );
    });

    test("returns valid for symbol with no contract", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "noContract" }));
      const result = layer.validateImplementation("sym1");
      expect(result.valid).toBe(true);
    });

    test("detects missing symbol", () => {
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doThing",
        qualifiedName: "mod.doThing",
        signature: "() => void",
        exported: true,
        dependencies: [],
      });

      const result = layer.validateImplementation("sym1");
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.contractField).toBe("existence");
    });

    test("validateAll checks all contracts", () => {
      store.addSymbol(
        makeNode({
          id: "sym1",
          name: "ok",
          exported: true,
          signature: "() => void",
        }),
      );
      store.addSymbol(
        makeNode({
          id: "sym2",
          name: "broken",
          exported: true,
          signature: "() => number",
        }),
      );
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "ok",
        qualifiedName: "mod.ok",
        signature: "() => void",
        exported: true,
        dependencies: [],
      });
      layer.defineContract({
        symbolId: "sym2",
        kind: "function",
        name: "expected",
        qualifiedName: "mod.expected",
        signature: "() => string",
        exported: true,
        dependencies: [],
      });

      const results = layer.validateAll();
      expect(results.size).toBe(2);
      expect(results.get("sym1")!.valid).toBe(true);
      expect(results.get("sym2")!.valid).toBe(false);
    });
  });

  describe("change proposals", () => {
    test("propose a contract change", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "doThing", exported: true }));
      store.addSymbol(makeNode({ id: "dep1", name: "caller" }));
      store.addEdge(
        makeEdge({ id: "e1", sourceId: "dep1", targetId: "sym1", kind: "calls" }),
      );

      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doThing",
        qualifiedName: "mod.doThing",
        signature: "() => void",
        exported: true,
        dependencies: [],
      });

      const proposal = layer.proposeContractChange(
        "sym1",
        "(x: number) => void",
        "agent-a",
        "Need to add parameter",
      );

      expect(proposal.status).toBe("pending");
      expect(proposal.oldSignature).toBe("() => void");
      expect(proposal.newSignature).toBe("(x: number) => void");
      expect(proposal.impactedSymbols).toContain("dep1");
      expect(proposal.agentId).toBe("agent-a");
    });

    test("approve a proposal updates the contract", () => {
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doThing",
        qualifiedName: "mod.doThing",
        signature: "() => void",
        exported: true,
        dependencies: [],
      });

      const proposal = layer.proposeContractChange(
        "sym1",
        "(x: number) => void",
        "agent-a",
        "Add parameter",
      );

      layer.approveProposal(proposal.id);

      expect(layer.getContract("sym1")!.signature).toBe("(x: number) => void");
      expect(layer.getPendingProposals()).toHaveLength(0);
    });

    test("reject a proposal does not update the contract", () => {
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "doThing",
        qualifiedName: "mod.doThing",
        signature: "() => void",
        exported: true,
        dependencies: [],
      });

      const proposal = layer.proposeContractChange(
        "sym1",
        "(x: number) => void",
        "agent-a",
        "Want to change",
      );

      layer.rejectProposal(proposal.id);

      expect(layer.getContract("sym1")!.signature).toBe("() => void");
      expect(layer.getPendingProposals()).toHaveLength(0);
    });

    test("getPendingProposals returns only pending ones", () => {
      layer.defineContract({
        symbolId: "sym1",
        kind: "function",
        name: "a",
        qualifiedName: "mod.a",
        signature: "() => void",
        exported: true,
        dependencies: [],
      });

      const p1 = layer.proposeContractChange("sym1", "sig1", "a1", "r1");
      const p2 = layer.proposeContractChange("sym1", "sig2", "a2", "r2");
      layer.approveProposal(p1.id);

      const pending = layer.getPendingProposals();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe(p2.id);
    });
  });
});

// ============================================================
// ScopeGraph
// ============================================================

describe("ScopeGraph", () => {
  let store: GraphStore;
  let lockTable: SymbolLockTable;
  let scopeGraph: ScopeGraph;

  beforeEach(() => {
    store = new GraphStore();
    lockTable = new SymbolLockTable();
    scopeGraph = new ScopeGraph(store, lockTable);
  });

  describe("claimSymbols and releaseSymbols", () => {
    test("claim symbols with no conflicts", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo" }));
      store.addSymbol(makeNode({ id: "sym2", name: "bar" }));

      const conflicts = scopeGraph.claimSymbols("agent-a", ["sym1", "sym2"]);
      expect(conflicts).toHaveLength(0);
      expect(lockTable.isLocked("sym1")).toBe(true);
      expect(lockTable.isLocked("sym2")).toBe(true);
    });

    test("claim symbols with conflicts returns conflict info", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo" }));
      // Agent B claims sym1 first with a conflicting op
      lockTable.acquire("sym1", "agent-b", "RemoveSymbol");

      const conflicts = scopeGraph.claimSymbols("agent-a", ["sym1"]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.symbolId).toBe("sym1");
      expect(conflicts[0]!.symbolName).toBe("foo");
      expect(conflicts[0]!.conflictingAgentId).toBe("agent-b");
    });

    test("releaseSymbols clears all agent locks", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo" }));
      store.addSymbol(makeNode({ id: "sym2", name: "bar" }));
      scopeGraph.claimSymbols("agent-a", ["sym1", "sym2"]);

      scopeGraph.releaseSymbols("agent-a");
      expect(lockTable.isLocked("sym1")).toBe(false);
      expect(lockTable.isLocked("sym2")).toBe(false);
    });
  });

  describe("getConflicts", () => {
    test("returns conflicts for locked symbols", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo" }));
      lockTable.acquire("sym1", "agent-b", "ModifyBody");

      const conflicts = scopeGraph.getConflicts("agent-a", ["sym1"]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.conflictingAgentId).toBe("agent-b");
      expect(conflicts[0]!.conflictType).toBe("ModifyBody");
    });

    test("does not report self-conflicts", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo" }));
      lockTable.acquire("sym1", "agent-a", "ModifyBody");

      const conflicts = scopeGraph.getConflicts("agent-a", ["sym1"]);
      expect(conflicts).toHaveLength(0);
    });

    test("returns empty for unlocked symbols", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo" }));
      const conflicts = scopeGraph.getConflicts("agent-a", ["sym1"]);
      expect(conflicts).toHaveLength(0);
    });
  });

  describe("getAdvisory", () => {
    test("returns advisory info for locked symbols", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo" }));
      lockTable.acquire("sym1", "agent-b", "ModifyBody");

      const advisories = scopeGraph.getAdvisory(["sym1"]);
      expect(advisories).toHaveLength(1);
      expect(advisories[0]!.agentId).toBe("agent-b");
      expect(advisories[0]!.symbolName).toBe("foo");
    });

    test("includes sibling activity in same module", () => {
      const mod = makeNode({
        id: "mod1",
        name: "myModule",
        kind: "module",
        qualifiedName: "myModule",
      });
      const fn1 = makeNode({
        id: "fn1",
        name: "foo",
        parentId: "mod1",
        qualifiedName: "myModule.foo",
      });
      const fn2 = makeNode({
        id: "fn2",
        name: "bar",
        parentId: "mod1",
        qualifiedName: "myModule.bar",
      });
      store.addSymbol(mod);
      store.addSymbol(fn1);
      store.addSymbol(fn2);

      lockTable.acquire("fn2", "agent-c", "ModifyBody");

      // Ask about fn1, should see advisory about fn2 (sibling)
      const advisories = scopeGraph.getAdvisory(["fn1"]);
      expect(advisories.some((a) => a.symbolId === "fn2")).toBe(true);
      expect(advisories.some((a) => a.agentId === "agent-c")).toBe(true);
    });

    test("includes dependent symbol activity", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "base" }));
      store.addSymbol(makeNode({ id: "sym2", name: "caller" }));
      store.addEdge(
        makeEdge({
          id: "e1",
          sourceId: "sym2",
          targetId: "sym1",
          kind: "calls",
        }),
      );

      lockTable.acquire("sym2", "agent-d", "ModifyBody");

      // Ask about sym1, should see advisory about sym2 (dependent)
      const advisories = scopeGraph.getAdvisory(["sym1"]);
      expect(advisories.some((a) => a.symbolId === "sym2")).toBe(true);
      expect(advisories.some((a) => a.agentId === "agent-d")).toBe(true);
    });

    test("returns empty when nothing is locked nearby", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "lonely" }));
      const advisories = scopeGraph.getAdvisory(["sym1"]);
      expect(advisories).toHaveLength(0);
    });
  });

  describe("getImpactedAgents", () => {
    test("finds agents working on dependents", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "base" }));
      store.addSymbol(makeNode({ id: "sym2", name: "user1" }));
      store.addSymbol(makeNode({ id: "sym3", name: "user2" }));
      store.addEdge(
        makeEdge({
          id: "e1",
          sourceId: "sym2",
          targetId: "sym1",
          kind: "calls",
        }),
      );
      store.addEdge(
        makeEdge({
          id: "e2",
          sourceId: "sym3",
          targetId: "sym1",
          kind: "imports",
        }),
      );

      lockTable.acquire("sym2", "agent-x", "ModifyBody");
      lockTable.acquire("sym3", "agent-y", "ModifyBody");

      const agents = scopeGraph.getImpactedAgents("sym1");
      expect(agents.sort()).toEqual(["agent-x", "agent-y"]);
    });

    test("returns empty when no dependents are locked", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "base" }));
      const agents = scopeGraph.getImpactedAgents("sym1");
      expect(agents).toHaveLength(0);
    });
  });

  describe("file-path compatibility", () => {
    test("resolveFileToSymbols maps module name to symbols", () => {
      const mod = makeNode({
        id: "mod1",
        name: "helpers",
        kind: "module",
        qualifiedName: "helpers",
      });
      const fn1 = makeNode({
        id: "fn1",
        name: "doA",
        parentId: "mod1",
        qualifiedName: "helpers.doA",
      });
      const fn2 = makeNode({
        id: "fn2",
        name: "doB",
        parentId: "mod1",
        qualifiedName: "helpers.doB",
      });
      store.addSymbol(mod);
      store.addSymbol(fn1);
      store.addSymbol(fn2);

      const symbols = scopeGraph.resolveFileToSymbols("src/helpers.ts");
      expect(symbols).toContain("mod1");
      expect(symbols).toContain("fn1");
      expect(symbols).toContain("fn2");
    });

    test("resolveFileToSymbols returns empty for unknown file", () => {
      const symbols = scopeGraph.resolveFileToSymbols("src/nonexistent.ts");
      expect(symbols).toHaveLength(0);
    });

    test("claimByFilePaths resolves files and claims symbols", () => {
      const mod = makeNode({
        id: "mod1",
        name: "utils",
        kind: "module",
        qualifiedName: "utils",
      });
      const fn1 = makeNode({
        id: "fn1",
        name: "helper",
        parentId: "mod1",
        qualifiedName: "utils.helper",
      });
      store.addSymbol(mod);
      store.addSymbol(fn1);

      const conflicts = scopeGraph.claimByFilePaths("agent-a", [
        "src/utils.ts",
      ]);
      expect(conflicts).toHaveLength(0);
      expect(lockTable.isLocked("mod1")).toBe(true);
      expect(lockTable.isLocked("fn1")).toBe(true);
    });

    test("claimByFilePaths returns conflicts for already-claimed files", () => {
      const mod = makeNode({
        id: "mod1",
        name: "utils",
        kind: "module",
        qualifiedName: "utils",
      });
      store.addSymbol(mod);

      lockTable.acquire("mod1", "agent-b", "RemoveSymbol");

      const conflicts = scopeGraph.claimByFilePaths("agent-a", [
        "src/utils.ts",
      ]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.conflictingAgentId).toBe("agent-b");
    });

    test("claimByFilePaths with no matching symbols returns empty", () => {
      const conflicts = scopeGraph.claimByFilePaths("agent-a", [
        "src/unknown.ts",
      ]);
      expect(conflicts).toHaveLength(0);
    });
  });
});

// ============================================================
// TierClassifier
// ============================================================

describe("TierClassifier", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore();
  });

  describe("classifyOperation", () => {
    test("AddSymbol (non-exported) is FREE", () => {
      const op: GraphOperation = {
        type: "AddSymbol",
        symbol: makeNode({ id: "new1", name: "newFn", exported: false }),
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("FREE");
      expect(result.requiresApproval).toBe(false);
    });

    test("AddSymbol (exported) is CONTRACT", () => {
      const op: GraphOperation = {
        type: "AddSymbol",
        symbol: makeNode({ id: "new1", name: "newPubFn", exported: true }),
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("CONTRACT");
      expect(result.requiresApproval).toBe(true);
    });

    test("AddEdge is FREE", () => {
      const op: GraphOperation = {
        type: "AddEdge",
        edge: makeEdge({ id: "e1", sourceId: "a", targetId: "b" }),
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("FREE");
    });

    test("RemoveEdge is FREE", () => {
      const op: GraphOperation = { type: "RemoveEdge", edgeId: "e1" };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("FREE");
    });

    test("AddModifier on non-exported symbol is FREE", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo", exported: false }));
      const op: GraphOperation = {
        type: "AddModifier",
        symbolId: "sym1",
        modifier: "async",
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("FREE");
    });

    test("AddModifier on exported symbol is CONTRACT", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo", exported: true }));
      const op: GraphOperation = {
        type: "AddModifier",
        symbolId: "sym1",
        modifier: "async",
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("CONTRACT");
    });

    test("RemoveModifier on non-exported symbol is FREE", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo", exported: false }));
      const op: GraphOperation = {
        type: "RemoveModifier",
        symbolId: "sym1",
        modifier: "static",
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("FREE");
    });

    test("ModifyBody on non-exported symbol is ADVISORY", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo", exported: false }));
      const op: GraphOperation = {
        type: "ModifyBody",
        symbolId: "sym1",
        newBody: "new code",
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("ADVISORY");
    });

    test("ModifyBody on exported symbol is CONTRACT", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo", exported: true }));
      const op: GraphOperation = {
        type: "ModifyBody",
        symbolId: "sym1",
        newBody: "new code",
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("CONTRACT");
    });

    test("SetExported (to true) is CONTRACT", () => {
      const op: GraphOperation = {
        type: "SetExported",
        symbolId: "sym1",
        exported: true,
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("CONTRACT");
      expect(result.requiresApproval).toBe(true);
    });

    test("SetExported (to false) is ADVISORY", () => {
      const op: GraphOperation = {
        type: "SetExported",
        symbolId: "sym1",
        exported: false,
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("ADVISORY");
      expect(result.requiresApproval).toBe(false);
    });

    test("ModifySignature is CONTRACT", () => {
      const op: GraphOperation = {
        type: "ModifySignature",
        symbolId: "sym1",
        newSignature: "(x: number) => void",
        newTypeText: "...",
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("CONTRACT");
      expect(result.requiresApproval).toBe(true);
    });

    test("RenameSymbol is CONTRACT", () => {
      const op: GraphOperation = {
        type: "RenameSymbol",
        symbolId: "sym1",
        newName: "newName",
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("CONTRACT");
    });

    test("MoveSymbol is ARCHITECTURE", () => {
      const op: GraphOperation = {
        type: "MoveSymbol",
        symbolId: "sym1",
        newParentId: "mod2",
      };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("ARCHITECTURE");
      expect(result.requiresApproval).toBe(true);
      expect(result.impactScope).toBe("cross-module");
    });

    test("RemoveSymbol with dependents is ARCHITECTURE", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "base" }));
      store.addSymbol(makeNode({ id: "sym2", name: "caller" }));
      store.addEdge(
        makeEdge({
          id: "e1",
          sourceId: "sym2",
          targetId: "sym1",
          kind: "calls",
        }),
      );

      const op: GraphOperation = { type: "RemoveSymbol", symbolId: "sym1" };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("ARCHITECTURE");
      expect(result.requiresApproval).toBe(true);
    });

    test("RemoveSymbol without dependents and non-exported is ADVISORY", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "unused", exported: false }));
      const op: GraphOperation = { type: "RemoveSymbol", symbolId: "sym1" };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("ADVISORY");
    });

    test("RemoveSymbol without dependents but exported is CONTRACT", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "pubUnused", exported: true }));
      const op: GraphOperation = { type: "RemoveSymbol", symbolId: "sym1" };
      const result = classifyOperation(op, store);
      expect(result.tier).toBe("CONTRACT");
    });
  });

  describe("classifyBatch", () => {
    test("empty batch is FREE", () => {
      const result = classifyBatch([], store);
      expect(result.tier).toBe("FREE");
    });

    test("batch uses highest tier", () => {
      store.addSymbol(makeNode({ id: "sym1", name: "foo", exported: false }));

      const ops: GraphOperation[] = [
        { type: "AddEdge", edge: makeEdge({ id: "e1", sourceId: "a", targetId: "b" }) }, // FREE
        { type: "ModifyBody", symbolId: "sym1", newBody: "x" }, // ADVISORY
        {
          type: "ModifySignature",
          symbolId: "sym1",
          newSignature: "new",
          newTypeText: "new",
        }, // CONTRACT
      ];

      const result = classifyBatch(ops, store);
      expect(result.tier).toBe("CONTRACT");
    });

    test("batch with MoveSymbol is ARCHITECTURE", () => {
      const ops: GraphOperation[] = [
        { type: "AddEdge", edge: makeEdge({ id: "e1", sourceId: "a", targetId: "b" }) },
        { type: "MoveSymbol", symbolId: "sym1", newParentId: "mod2" },
      ];

      const result = classifyBatch(ops, store);
      expect(result.tier).toBe("ARCHITECTURE");
    });

    test("batch of only FREE ops is FREE", () => {
      const ops: GraphOperation[] = [
        { type: "AddEdge", edge: makeEdge({ id: "e1", sourceId: "a", targetId: "b" }) },
        { type: "RemoveEdge", edgeId: "e2" },
        {
          type: "AddSymbol",
          symbol: makeNode({ id: "new1", name: "newFn", exported: false }),
        },
      ];

      const result = classifyBatch(ops, store);
      expect(result.tier).toBe("FREE");
    });
  });
});
