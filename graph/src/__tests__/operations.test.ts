import { describe, test, expect, beforeEach } from "bun:test";
import { GraphStore } from "../store/graph-store.js";
import { createSymbolNode } from "../schema/nodes.js";
import { createSymbolEdge } from "../schema/edges.js";
import type { GraphOperation, OperationEntry } from "../schema/operations.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import { OperationLog } from "../operations/op-log.js";
import {
  checkCommutativity,
  checkBatchCommutativity,
  getAffectedSymbolIds,
} from "../operations/commutativity.js";
import type { CommutativityResult } from "../operations/commutativity.js";
import { MergeEngine } from "../operations/merge-engine.js";
import { resolveLWW } from "../operations/lww-resolver.js";
import { computeInverse, rollbackAgent } from "../operations/rollback.js";
import { tmpdir } from "os";
import { join } from "path";

// --- Helpers ---

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

function makeEntry(
  partial: Partial<OperationEntry> & { op: GraphOperation },
): OperationEntry {
  return {
    id: crypto.randomUUID(),
    agentId: "agent-1",
    lamport: 1,
    timestamp: Date.now(),
    batchId: "batch-1",
    symbolIds: [],
    ...partial,
  };
}

// =====================
// OperationLog Tests
// =====================

describe("OperationLog", () => {
  let log: OperationLog;

  beforeEach(() => {
    log = new OperationLog();
  });

  test("append increments Lamport clock", () => {
    const op1: GraphOperation = {
      type: "AddSymbol",
      symbol: makeNode({ id: "s1", name: "foo" }),
    };
    const op2: GraphOperation = {
      type: "ModifyBody",
      symbolId: "s1",
      newBody: "body",
    };

    const e1 = log.append(op1, "agent-1", "batch-1", { symbolIds: ["s1"] });
    const e2 = log.append(op2, "agent-1", "batch-1", { symbolIds: ["s1"] });

    expect(e1.lamport).toBe(1);
    expect(e2.lamport).toBe(2);
    expect(log.getLamport()).toBe(2);
  });

  test("append assigns UUID and timestamp", () => {
    const op: GraphOperation = {
      type: "AddSymbol",
      symbol: makeNode({ id: "s1", name: "foo" }),
    };
    const entry = log.append(op, "agent-1", "batch-1");

    expect(entry.id).toBeTruthy();
    expect(typeof entry.id).toBe("string");
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.agentId).toBe("agent-1");
    expect(entry.batchId).toBe("batch-1");
  });

  test("size returns entry count", () => {
    expect(log.size()).toBe(0);
    log.append(
      { type: "AddSymbol", symbol: makeNode({ id: "s1", name: "a" }) },
      "agent-1",
      "batch-1",
    );
    expect(log.size()).toBe(1);
    log.append(
      { type: "RemoveSymbol", symbolId: "s1" },
      "agent-1",
      "batch-1",
    );
    expect(log.size()).toBe(2);
  });

  test("getAll returns copies of all entries", () => {
    log.append(
      { type: "AddSymbol", symbol: makeNode({ id: "s1", name: "a" }) },
      "agent-1",
      "batch-1",
    );
    log.append(
      { type: "AddSymbol", symbol: makeNode({ id: "s2", name: "b" }) },
      "agent-2",
      "batch-2",
    );

    const all = log.getAll();
    expect(all).toHaveLength(2);
  });

  describe("query by agent", () => {
    test("getByAgent returns entries for a specific agent", () => {
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s1", name: "a" }) },
        "agent-1",
        "batch-1",
        { symbolIds: ["s1"] },
      );
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s2", name: "b" }) },
        "agent-2",
        "batch-2",
        { symbolIds: ["s2"] },
      );
      log.append(
        { type: "ModifyBody", symbolId: "s1", newBody: "new" },
        "agent-1",
        "batch-1",
        { symbolIds: ["s1"] },
      );

      expect(log.getByAgent("agent-1")).toHaveLength(2);
      expect(log.getByAgent("agent-2")).toHaveLength(1);
      expect(log.getByAgent("agent-3")).toHaveLength(0);
    });
  });

  describe("query by symbol", () => {
    test("getBySymbol returns entries affecting a symbol", () => {
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s1", name: "a" }) },
        "agent-1",
        "batch-1",
        { symbolIds: ["s1"] },
      );
      log.append(
        { type: "ModifyBody", symbolId: "s1", newBody: "body" },
        "agent-1",
        "batch-1",
        { symbolIds: ["s1"] },
      );
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s2", name: "b" }) },
        "agent-2",
        "batch-2",
        { symbolIds: ["s2"] },
      );

      expect(log.getBySymbol("s1")).toHaveLength(2);
      expect(log.getBySymbol("s2")).toHaveLength(1);
      expect(log.getBySymbol("s3")).toHaveLength(0);
    });
  });

  describe("query by batch", () => {
    test("getByBatch returns entries in a batch", () => {
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s1", name: "a" }) },
        "agent-1",
        "batch-A",
      );
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s2", name: "b" }) },
        "agent-1",
        "batch-A",
      );
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s3", name: "c" }) },
        "agent-2",
        "batch-B",
      );

      expect(log.getByBatch("batch-A")).toHaveLength(2);
      expect(log.getByBatch("batch-B")).toHaveLength(1);
      expect(log.getByBatch("batch-C")).toHaveLength(0);
    });
  });

  describe("Lamport range query", () => {
    test("getByLamportRange returns entries in range", () => {
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s1", name: "a" }) },
        "agent-1",
        "b1",
      ); // lamport 1
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s2", name: "b" }) },
        "agent-1",
        "b1",
      ); // lamport 2
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s3", name: "c" }) },
        "agent-1",
        "b1",
      ); // lamport 3
      log.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s4", name: "d" }) },
        "agent-1",
        "b1",
      ); // lamport 4

      const range = log.getByLamportRange(2, 3);
      expect(range).toHaveLength(2);
      expect(range[0]!.lamport).toBe(2);
      expect(range[1]!.lamport).toBe(3);
    });
  });

  describe("flush and replay", () => {
    test("round-trip through NDJSON file", async () => {
      const filePath = join(
        tmpdir(),
        `oplog-test-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`,
      );
      const logWithFile = new OperationLog(filePath);

      logWithFile.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s1", name: "a" }) },
        "agent-1",
        "batch-1",
        { symbolIds: ["s1"] },
      );
      logWithFile.append(
        { type: "ModifyBody", symbolId: "s1", newBody: "hello" },
        "agent-2",
        "batch-2",
        { symbolIds: ["s1"] },
      );

      await logWithFile.flush();

      // Replay into a fresh log
      const replayLog = new OperationLog();
      await replayLog.replay(filePath);

      expect(replayLog.size()).toBe(2);
      expect(replayLog.getLamport()).toBe(2);
      expect(replayLog.getByAgent("agent-1")).toHaveLength(1);
      expect(replayLog.getByAgent("agent-2")).toHaveLength(1);
      expect(replayLog.getBySymbol("s1")).toHaveLength(2);
      expect(replayLog.getByBatch("batch-1")).toHaveLength(1);
      expect(replayLog.getByBatch("batch-2")).toHaveLength(1);

      // Cleanup
      const { unlink } = await import("fs/promises");
      await unlink(filePath).catch(() => {});
    });

    test("flush with no file path is a no-op", async () => {
      const memLog = new OperationLog();
      memLog.append(
        { type: "AddSymbol", symbol: makeNode({ id: "s1", name: "a" }) },
        "agent-1",
        "b1",
      );
      // Should not throw
      await memLog.flush();
    });

    test("replay nonexistent file is a no-op", async () => {
      const memLog = new OperationLog();
      await memLog.replay("/tmp/nonexistent-oplog-file.ndjson");
      expect(memLog.size()).toBe(0);
    });
  });
});

// =====================
// Commutativity Tests
// =====================

describe("Commutativity", () => {
  const sym1 = makeNode({ id: "s1", name: "foo" });
  const sym2 = makeNode({ id: "s2", name: "bar" });

  describe("getAffectedSymbolIds", () => {
    test("AddSymbol returns symbol id", () => {
      expect(getAffectedSymbolIds({ type: "AddSymbol", symbol: sym1 })).toEqual(
        ["s1"],
      );
    });

    test("AddEdge returns source and target", () => {
      const edge = makeEdge({ id: "e1", sourceId: "s1", targetId: "s2" });
      expect(getAffectedSymbolIds({ type: "AddEdge", edge })).toEqual([
        "s1",
        "s2",
      ]);
    });

    test("RemoveEdge returns empty (no symbol info)", () => {
      expect(
        getAffectedSymbolIds({ type: "RemoveEdge", edgeId: "e1" }),
      ).toEqual([]);
    });
  });

  describe("different symbols always commute", () => {
    test("ModifyBody on different symbols commutes", () => {
      const opA: GraphOperation = {
        type: "ModifyBody",
        symbolId: "s1",
        newBody: "a",
      };
      const opB: GraphOperation = {
        type: "ModifyBody",
        symbolId: "s2",
        newBody: "b",
      };
      expect(checkCommutativity(opA, opB)).toBe("commutes");
    });

    test("RemoveSymbol on different symbols commutes", () => {
      const opA: GraphOperation = { type: "RemoveSymbol", symbolId: "s1" };
      const opB: GraphOperation = { type: "RemoveSymbol", symbolId: "s2" };
      expect(checkCommutativity(opA, opB)).toBe("commutes");
    });

    test("AddSymbol and RemoveSymbol on different symbols commutes", () => {
      const opA: GraphOperation = { type: "AddSymbol", symbol: sym1 };
      const opB: GraphOperation = { type: "RemoveSymbol", symbolId: "s2" };
      expect(checkCommutativity(opA, opB)).toBe("commutes");
    });
  });

  describe("commutativity matrix (same symbol)", () => {
    // Encode all expected results from the matrix in the specification
    const matrixTests: Array<{
      typeA: string;
      opA: GraphOperation;
      typeB: string;
      opB: GraphOperation;
      expected: CommutativityResult;
    }> = [
      // AddSymbol row
      {
        typeA: "AddSymbol",
        opA: { type: "AddSymbol", symbol: sym1 },
        typeB: "AddSymbol",
        opB: { type: "AddSymbol", symbol: sym1 },
        expected: "conflict",
      },
      {
        typeA: "AddSymbol",
        opA: { type: "AddSymbol", symbol: sym1 },
        typeB: "RemoveSymbol",
        opB: { type: "RemoveSymbol", symbolId: "s1" },
        expected: "conflict",
      },
      {
        typeA: "AddSymbol",
        opA: { type: "AddSymbol", symbol: sym1 },
        typeB: "ModifyBody",
        opB: { type: "ModifyBody", symbolId: "s1", newBody: "x" },
        expected: "commutes",
      },
      {
        typeA: "AddSymbol",
        opA: { type: "AddSymbol", symbol: sym1 },
        typeB: "ModifySignature",
        opB: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "x",
          newTypeText: "x",
        },
        expected: "commutes",
      },
      {
        typeA: "AddSymbol",
        opA: { type: "AddSymbol", symbol: sym1 },
        typeB: "RenameSymbol",
        opB: { type: "RenameSymbol", symbolId: "s1", newName: "bar" },
        expected: "commutes",
      },
      {
        typeA: "AddSymbol",
        opA: { type: "AddSymbol", symbol: sym1 },
        typeB: "MoveSymbol",
        opB: { type: "MoveSymbol", symbolId: "s1", newParentId: "p2" },
        expected: "commutes",
      },
      {
        typeA: "AddSymbol",
        opA: { type: "AddSymbol", symbol: sym1 },
        typeB: "SetExported",
        opB: { type: "SetExported", symbolId: "s1", exported: true },
        expected: "commutes",
      },
      {
        typeA: "AddSymbol",
        opA: { type: "AddSymbol", symbol: sym1 },
        typeB: "AddModifier",
        opB: { type: "AddModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },
      {
        typeA: "AddSymbol",
        opA: { type: "AddSymbol", symbol: sym1 },
        typeB: "RemoveModifier",
        opB: { type: "RemoveModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },

      // RemoveSymbol row (unique pairs not already tested)
      {
        typeA: "RemoveSymbol",
        opA: { type: "RemoveSymbol", symbolId: "s1" },
        typeB: "RemoveSymbol",
        opB: { type: "RemoveSymbol", symbolId: "s1" },
        expected: "idempotent",
      },
      {
        typeA: "RemoveSymbol",
        opA: { type: "RemoveSymbol", symbolId: "s1" },
        typeB: "ModifyBody",
        opB: { type: "ModifyBody", symbolId: "s1", newBody: "x" },
        expected: "conflict",
      },
      {
        typeA: "RemoveSymbol",
        opA: { type: "RemoveSymbol", symbolId: "s1" },
        typeB: "ModifySignature",
        opB: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "x",
          newTypeText: "x",
        },
        expected: "conflict",
      },
      {
        typeA: "RemoveSymbol",
        opA: { type: "RemoveSymbol", symbolId: "s1" },
        typeB: "RenameSymbol",
        opB: { type: "RenameSymbol", symbolId: "s1", newName: "bar" },
        expected: "conflict",
      },
      {
        typeA: "RemoveSymbol",
        opA: { type: "RemoveSymbol", symbolId: "s1" },
        typeB: "MoveSymbol",
        opB: { type: "MoveSymbol", symbolId: "s1", newParentId: "p2" },
        expected: "conflict",
      },
      {
        typeA: "RemoveSymbol",
        opA: { type: "RemoveSymbol", symbolId: "s1" },
        typeB: "SetExported",
        opB: { type: "SetExported", symbolId: "s1", exported: true },
        expected: "conflict",
      },
      {
        typeA: "RemoveSymbol",
        opA: { type: "RemoveSymbol", symbolId: "s1" },
        typeB: "AddModifier",
        opB: { type: "AddModifier", symbolId: "s1", modifier: "async" },
        expected: "conflict",
      },
      {
        typeA: "RemoveSymbol",
        opA: { type: "RemoveSymbol", symbolId: "s1" },
        typeB: "RemoveModifier",
        opB: { type: "RemoveModifier", symbolId: "s1", modifier: "async" },
        expected: "conflict",
      },

      // ModifyBody row (unique pairs)
      {
        typeA: "ModifyBody",
        opA: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        typeB: "ModifyBody",
        opB: { type: "ModifyBody", symbolId: "s1", newBody: "b" },
        expected: "lww",
      },
      {
        typeA: "ModifyBody",
        opA: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        typeB: "ModifySignature",
        opB: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "x",
          newTypeText: "x",
        },
        expected: "contract-dependent",
      },
      {
        typeA: "ModifyBody",
        opA: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        typeB: "RenameSymbol",
        opB: { type: "RenameSymbol", symbolId: "s1", newName: "bar" },
        expected: "commutes",
      },
      {
        typeA: "ModifyBody",
        opA: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        typeB: "MoveSymbol",
        opB: { type: "MoveSymbol", symbolId: "s1", newParentId: "p2" },
        expected: "commutes",
      },
      {
        typeA: "ModifyBody",
        opA: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        typeB: "SetExported",
        opB: { type: "SetExported", symbolId: "s1", exported: true },
        expected: "commutes",
      },
      {
        typeA: "ModifyBody",
        opA: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        typeB: "AddModifier",
        opB: { type: "AddModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },
      {
        typeA: "ModifyBody",
        opA: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        typeB: "RemoveModifier",
        opB: { type: "RemoveModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },

      // ModifySignature row (unique)
      {
        typeA: "ModifySignature",
        opA: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "a",
          newTypeText: "a",
        },
        typeB: "ModifySignature",
        opB: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "b",
          newTypeText: "b",
        },
        expected: "lww",
      },
      {
        typeA: "ModifySignature",
        opA: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "a",
          newTypeText: "a",
        },
        typeB: "RenameSymbol",
        opB: { type: "RenameSymbol", symbolId: "s1", newName: "bar" },
        expected: "conflict",
      },
      {
        typeA: "ModifySignature",
        opA: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "a",
          newTypeText: "a",
        },
        typeB: "MoveSymbol",
        opB: { type: "MoveSymbol", symbolId: "s1", newParentId: "p2" },
        expected: "commutes",
      },
      {
        typeA: "ModifySignature",
        opA: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "a",
          newTypeText: "a",
        },
        typeB: "SetExported",
        opB: { type: "SetExported", symbolId: "s1", exported: true },
        expected: "commutes",
      },
      {
        typeA: "ModifySignature",
        opA: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "a",
          newTypeText: "a",
        },
        typeB: "AddModifier",
        opB: { type: "AddModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },
      {
        typeA: "ModifySignature",
        opA: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "a",
          newTypeText: "a",
        },
        typeB: "RemoveModifier",
        opB: { type: "RemoveModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },

      // RenameSymbol row (unique)
      {
        typeA: "RenameSymbol",
        opA: { type: "RenameSymbol", symbolId: "s1", newName: "a" },
        typeB: "RenameSymbol",
        opB: { type: "RenameSymbol", symbolId: "s1", newName: "b" },
        expected: "conflict",
      },
      {
        typeA: "RenameSymbol",
        opA: { type: "RenameSymbol", symbolId: "s1", newName: "a" },
        typeB: "MoveSymbol",
        opB: { type: "MoveSymbol", symbolId: "s1", newParentId: "p2" },
        expected: "commutes",
      },
      {
        typeA: "RenameSymbol",
        opA: { type: "RenameSymbol", symbolId: "s1", newName: "a" },
        typeB: "SetExported",
        opB: { type: "SetExported", symbolId: "s1", exported: true },
        expected: "commutes",
      },
      {
        typeA: "RenameSymbol",
        opA: { type: "RenameSymbol", symbolId: "s1", newName: "a" },
        typeB: "AddModifier",
        opB: { type: "AddModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },
      {
        typeA: "RenameSymbol",
        opA: { type: "RenameSymbol", symbolId: "s1", newName: "a" },
        typeB: "RemoveModifier",
        opB: { type: "RemoveModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },

      // MoveSymbol row (unique)
      {
        typeA: "MoveSymbol",
        opA: { type: "MoveSymbol", symbolId: "s1", newParentId: "p1" },
        typeB: "MoveSymbol",
        opB: { type: "MoveSymbol", symbolId: "s1", newParentId: "p2" },
        expected: "conflict",
      },
      {
        typeA: "MoveSymbol",
        opA: { type: "MoveSymbol", symbolId: "s1", newParentId: "p1" },
        typeB: "SetExported",
        opB: { type: "SetExported", symbolId: "s1", exported: true },
        expected: "commutes",
      },
      {
        typeA: "MoveSymbol",
        opA: { type: "MoveSymbol", symbolId: "s1", newParentId: "p1" },
        typeB: "AddModifier",
        opB: { type: "AddModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },
      {
        typeA: "MoveSymbol",
        opA: { type: "MoveSymbol", symbolId: "s1", newParentId: "p1" },
        typeB: "RemoveModifier",
        opB: { type: "RemoveModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },

      // SetExported
      {
        typeA: "SetExported",
        opA: { type: "SetExported", symbolId: "s1", exported: true },
        typeB: "SetExported",
        opB: { type: "SetExported", symbolId: "s1", exported: false },
        expected: "lww",
      },
      {
        typeA: "SetExported",
        opA: { type: "SetExported", symbolId: "s1", exported: true },
        typeB: "AddModifier",
        opB: { type: "AddModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },
      {
        typeA: "SetExported",
        opA: { type: "SetExported", symbolId: "s1", exported: true },
        typeB: "RemoveModifier",
        opB: { type: "RemoveModifier", symbolId: "s1", modifier: "async" },
        expected: "commutes",
      },

      // AddModifier / RemoveModifier
      {
        typeA: "AddModifier",
        opA: { type: "AddModifier", symbolId: "s1", modifier: "async" },
        typeB: "AddModifier",
        opB: { type: "AddModifier", symbolId: "s1", modifier: "async" },
        expected: "idempotent",
      },
      {
        typeA: "AddModifier",
        opA: { type: "AddModifier", symbolId: "s1", modifier: "async" },
        typeB: "RemoveModifier",
        opB: { type: "RemoveModifier", symbolId: "s1", modifier: "async" },
        expected: "conflict",
      },
      {
        typeA: "RemoveModifier",
        opA: { type: "RemoveModifier", symbolId: "s1", modifier: "async" },
        typeB: "RemoveModifier",
        opB: { type: "RemoveModifier", symbolId: "s1", modifier: "async" },
        expected: "idempotent",
      },

      // Edge operations commute with everything
      {
        typeA: "AddEdge",
        opA: {
          type: "AddEdge",
          edge: makeEdge({ id: "e1", sourceId: "s1", targetId: "s1" }),
        },
        typeB: "AddEdge",
        opB: {
          type: "AddEdge",
          edge: makeEdge({ id: "e2", sourceId: "s1", targetId: "s1" }),
        },
        expected: "commutes",
      },
      {
        typeA: "RemoveEdge",
        opA: { type: "RemoveEdge", edgeId: "e1" },
        typeB: "RemoveEdge",
        opB: { type: "RemoveEdge", edgeId: "e2" },
        expected: "commutes",
      },
      {
        typeA: "AddEdge",
        opA: {
          type: "AddEdge",
          edge: makeEdge({ id: "e1", sourceId: "s1", targetId: "s1" }),
        },
        typeB: "RemoveSymbol",
        opB: { type: "RemoveSymbol", symbolId: "s1" },
        expected: "commutes",
      },
    ];

    for (const { typeA, opA, typeB, opB, expected } of matrixTests) {
      test(`${typeA} vs ${typeB} => ${expected}`, () => {
        expect(checkCommutativity(opA, opB)).toBe(expected);
      });
    }
  });

  describe("batch commutativity", () => {
    test("disjoint batches fully commute", () => {
      const batchA: OperationEntry[] = [
        makeEntry({
          op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
          agentId: "agent-1",
          symbolIds: ["s1"],
        }),
      ];
      const batchB: OperationEntry[] = [
        makeEntry({
          op: { type: "ModifyBody", symbolId: "s2", newBody: "b" },
          agentId: "agent-2",
          symbolIds: ["s2"],
        }),
      ];

      const result = checkBatchCommutativity(batchA, batchB);
      expect(result.result).toBe("commutes");
      expect(result.conflicts).toHaveLength(0);
    });

    test("overlapping batches report contract-dependent", () => {
      const batchA: OperationEntry[] = [
        makeEntry({
          op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
          agentId: "agent-1",
          symbolIds: ["s1"],
        }),
      ];
      const batchB: OperationEntry[] = [
        makeEntry({
          op: {
            type: "ModifySignature",
            symbolId: "s1",
            newSignature: "sig",
            newTypeText: "type",
          },
          agentId: "agent-2",
          symbolIds: ["s1"],
        }),
      ];

      const result = checkBatchCommutativity(batchA, batchB);
      expect(result.result).toBe("contract-dependent");
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.result).toBe("contract-dependent");
    });

    test("lww batches report lww overall", () => {
      const batchA: OperationEntry[] = [
        makeEntry({
          op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
          agentId: "agent-1",
          symbolIds: ["s1"],
        }),
      ];
      const batchB: OperationEntry[] = [
        makeEntry({
          op: { type: "ModifyBody", symbolId: "s1", newBody: "b" },
          agentId: "agent-2",
          symbolIds: ["s1"],
        }),
      ];

      const result = checkBatchCommutativity(batchA, batchB);
      expect(result.result).toBe("lww");
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.result).toBe("lww");
    });
  });
});

// =====================
// LWW Resolver Tests
// =====================

describe("LWW Resolver", () => {
  test("higher Lamport wins", () => {
    const opA = makeEntry({
      op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
      lamport: 5,
      timestamp: 1000,
      agentId: "agent-1",
    });
    const opB = makeEntry({
      op: { type: "ModifyBody", symbolId: "s1", newBody: "b" },
      lamport: 10,
      timestamp: 1000,
      agentId: "agent-2",
    });

    const result = resolveLWW(opA, opB);
    expect(result.winner).toBe(opB);
    expect(result.loser).toBe(opA);
  });

  test("same Lamport, higher timestamp wins", () => {
    const opA = makeEntry({
      op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
      lamport: 5,
      timestamp: 2000,
      agentId: "agent-1",
    });
    const opB = makeEntry({
      op: { type: "ModifyBody", symbolId: "s1", newBody: "b" },
      lamport: 5,
      timestamp: 1000,
      agentId: "agent-2",
    });

    const result = resolveLWW(opA, opB);
    expect(result.winner).toBe(opA);
    expect(result.loser).toBe(opB);
  });

  test("same Lamport and timestamp, lexicographic agentId wins", () => {
    const opA = makeEntry({
      op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
      lamport: 5,
      timestamp: 1000,
      agentId: "agent-a",
    });
    const opB = makeEntry({
      op: { type: "ModifyBody", symbolId: "s1", newBody: "b" },
      lamport: 5,
      timestamp: 1000,
      agentId: "agent-z",
    });

    const result = resolveLWW(opA, opB);
    // "agent-z" > "agent-a" lexicographically
    expect(result.winner).toBe(opB);
    expect(result.loser).toBe(opA);
  });

  test("resolution is deterministic with same inputs", () => {
    const opA = makeEntry({
      op: { type: "SetExported", symbolId: "s1", exported: true },
      lamport: 3,
      timestamp: 500,
      agentId: "x",
    });
    const opB = makeEntry({
      op: { type: "SetExported", symbolId: "s1", exported: false },
      lamport: 3,
      timestamp: 500,
      agentId: "y",
    });

    const r1 = resolveLWW(opA, opB);
    const r2 = resolveLWW(opB, opA);
    // Both orderings should produce the same winner
    expect(r1.winner.agentId).toBe(r2.winner.agentId);
  });
});

// =====================
// MergeEngine Tests
// =====================

describe("MergeEngine", () => {
  let store: GraphStore;
  let engine: MergeEngine;

  beforeEach(() => {
    store = new GraphStore();
    engine = new MergeEngine(store);
  });

  test("disjoint ops from different agents compose cleanly", () => {
    const setA: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        agentId: "agent-1",
        lamport: 1,
        symbolIds: ["s1"],
      }),
    ];
    const setB: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s2", newBody: "b" },
        agentId: "agent-2",
        lamport: 2,
        symbolIds: ["s2"],
      }),
    ];

    const result = engine.compose([setA, setB]);
    expect(result.applied).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
    expect(result.autoResolved).toHaveLength(0);
  });

  test("same-symbol LWW ops are auto-resolved", () => {
    const setA: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        agentId: "agent-1",
        lamport: 1,
        symbolIds: ["s1"],
      }),
    ];
    const setB: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s1", newBody: "b" },
        agentId: "agent-2",
        lamport: 5,
        symbolIds: ["s1"],
      }),
    ];

    const result = engine.compose([setA, setB]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.agentId).toBe("agent-2"); // higher lamport wins
    expect(result.autoResolved).toHaveLength(1);
    expect(result.autoResolved[0]!.strategy).toBe("lww");
    expect(result.conflicts).toHaveLength(0);
  });

  test("contract-dependent ops are treated as commutes (pending contract check)", () => {
    const setA: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        agentId: "agent-1",
        lamport: 1,
        symbolIds: ["s1"],
      }),
    ];
    const setB: OperationEntry[] = [
      makeEntry({
        op: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "sig",
          newTypeText: "type",
        },
        agentId: "agent-2",
        lamport: 2,
        symbolIds: ["s1"],
      }),
    ];

    const result = engine.compose([setA, setB]);
    expect(result.applied).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
  });

  test("true conflicting ops are reported", () => {
    const setA: OperationEntry[] = [
      makeEntry({
        op: { type: "RemoveSymbol", symbolId: "s1" },
        agentId: "agent-1",
        lamport: 1,
        symbolIds: ["s1"],
      }),
    ];
    const setB: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s1", newBody: "b" },
        agentId: "agent-2",
        lamport: 2,
        symbolIds: ["s1"],
      }),
    ];

    const result = engine.compose([setA, setB]);
    expect(result.applied).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.symbolId).toBe("s1");
    expect(result.conflicts[0]!.reason).toContain("RemoveSymbol");
    expect(result.conflicts[0]!.reason).toContain("ModifyBody");
  });

  test("idempotent ops are deduplicated", () => {
    const setA: OperationEntry[] = [
      makeEntry({
        op: { type: "RemoveSymbol", symbolId: "s1" },
        agentId: "agent-1",
        lamport: 1,
        symbolIds: ["s1"],
      }),
    ];
    const setB: OperationEntry[] = [
      makeEntry({
        op: { type: "RemoveSymbol", symbolId: "s1" },
        agentId: "agent-2",
        lamport: 2,
        symbolIds: ["s1"],
      }),
    ];

    const result = engine.compose([setA, setB]);
    expect(result.applied).toHaveLength(1);
    expect(result.autoResolved).toHaveLength(1);
    expect(result.autoResolved[0]!.strategy).toBe("idempotent");
  });

  test("multiple agent batches with mixed results", () => {
    const setA: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        agentId: "agent-1",
        lamport: 1,
        symbolIds: ["s1"],
      }),
      makeEntry({
        op: {
          type: "AddEdge",
          edge: makeEdge({ id: "e1", sourceId: "s1", targetId: "s2" }),
        },
        agentId: "agent-1",
        lamport: 2,
        symbolIds: ["s1", "s2"],
      }),
    ];
    const setB: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s2", newBody: "b" },
        agentId: "agent-2",
        lamport: 3,
        symbolIds: ["s2"],
      }),
    ];
    const setC: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s1", newBody: "c" },
        agentId: "agent-3",
        lamport: 4,
        symbolIds: ["s1"],
      }),
    ];

    const result = engine.compose([setA, setB, setC]);
    // s1 body: agent-1 (lamport=1) vs agent-3 (lamport=4) => LWW, agent-3 wins
    // e1 edge: commutes with everything
    // s2 body: only agent-2 touches it, no conflict
    expect(result.autoResolved.length).toBeGreaterThanOrEqual(1);
    // agent-3's op on s1 should be in applied
    expect(result.applied.some((e) => e.agentId === "agent-3")).toBe(true);
    // agent-2's op on s2 should be in applied
    expect(result.applied.some((e) => e.agentId === "agent-2")).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  test("applied entries are sorted by Lamport", () => {
    const setA: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        agentId: "agent-1",
        lamport: 10,
        symbolIds: ["s1"],
      }),
    ];
    const setB: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s2", newBody: "b" },
        agentId: "agent-2",
        lamport: 3,
        symbolIds: ["s2"],
      }),
    ];

    const result = engine.compose([setA, setB]);
    expect(result.applied).toHaveLength(2);
    expect(result.applied[0]!.lamport).toBe(3);
    expect(result.applied[1]!.lamport).toBe(10);
  });

  test("same-agent ops are not compared against each other", () => {
    // Two ops from the same agent that would conflict if from different agents
    const set: OperationEntry[] = [
      makeEntry({
        op: { type: "ModifyBody", symbolId: "s1", newBody: "a" },
        agentId: "agent-1",
        lamport: 1,
        symbolIds: ["s1"],
      }),
      makeEntry({
        op: {
          type: "ModifySignature",
          symbolId: "s1",
          newSignature: "sig",
          newTypeText: "type",
        },
        agentId: "agent-1",
        lamport: 2,
        symbolIds: ["s1"],
      }),
    ];

    const result = engine.compose([set]);
    // Same agent, no cross-agent conflicts
    expect(result.applied).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
  });
});

// =====================
// Rollback Tests
// =====================

describe("Rollback", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore();
  });

  describe("computeInverse", () => {
    test("AddSymbol inverse is RemoveSymbol", () => {
      const node = makeNode({ id: "s1", name: "foo" });
      const op: GraphOperation = { type: "AddSymbol", symbol: node };
      const inv = computeInverse(op, store);
      expect(inv).toEqual({ type: "RemoveSymbol", symbolId: "s1" });
    });

    test("RemoveSymbol inverse is AddSymbol (when node exists)", () => {
      const node = makeNode({ id: "s1", name: "foo" });
      store.addSymbol(node);
      const op: GraphOperation = { type: "RemoveSymbol", symbolId: "s1" };
      const inv = computeInverse(op, store);
      expect(inv?.type).toBe("AddSymbol");
      if (inv?.type === "AddSymbol") {
        expect(inv.symbol.id).toBe("s1");
      }
    });

    test("RemoveSymbol inverse is null when node is already gone", () => {
      const op: GraphOperation = { type: "RemoveSymbol", symbolId: "s1" };
      const inv = computeInverse(op, store);
      expect(inv).toBeNull();
    });

    test("ModifyBody inverse restores old body", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo", body: "old body" }));
      const op: GraphOperation = {
        type: "ModifyBody",
        symbolId: "s1",
        newBody: "new body",
      };
      const inv = computeInverse(op, store);
      expect(inv).toEqual({
        type: "ModifyBody",
        symbolId: "s1",
        newBody: "old body",
      });
    });

    test("ModifySignature inverse restores old signature", () => {
      store.addSymbol(
        makeNode({
          id: "s1",
          name: "foo",
          signature: "old sig",
          typeText: "old type",
        }),
      );
      const op: GraphOperation = {
        type: "ModifySignature",
        symbolId: "s1",
        newSignature: "new sig",
        newTypeText: "new type",
      };
      const inv = computeInverse(op, store);
      expect(inv).toEqual({
        type: "ModifySignature",
        symbolId: "s1",
        newSignature: "old sig",
        newTypeText: "old type",
      });
    });

    test("RenameSymbol inverse restores old name", () => {
      store.addSymbol(
        makeNode({ id: "s1", name: "original", qualifiedName: "mod.original" }),
      );
      const op: GraphOperation = {
        type: "RenameSymbol",
        symbolId: "s1",
        newName: "renamed",
      };
      const inv = computeInverse(op, store);
      expect(inv).toEqual({
        type: "RenameSymbol",
        symbolId: "s1",
        newName: "original",
      });
    });

    test("MoveSymbol inverse restores old parent", () => {
      store.addSymbol(makeNode({ id: "p1", name: "p1", kind: "module", qualifiedName: "p1" }));
      store.addSymbol(
        makeNode({ id: "s1", name: "foo", parentId: "p1" }),
      );
      const op: GraphOperation = {
        type: "MoveSymbol",
        symbolId: "s1",
        newParentId: "p2",
      };
      const inv = computeInverse(op, store);
      expect(inv).toEqual({
        type: "MoveSymbol",
        symbolId: "s1",
        newParentId: "p1",
      });
    });

    test("AddEdge inverse is RemoveEdge", () => {
      const edge = makeEdge({ id: "e1", sourceId: "s1", targetId: "s2" });
      const op: GraphOperation = { type: "AddEdge", edge };
      const inv = computeInverse(op, store);
      expect(inv).toEqual({ type: "RemoveEdge", edgeId: "e1" });
    });

    test("RemoveEdge inverse is AddEdge (when edge exists)", () => {
      store.addSymbol(makeNode({ id: "s1", name: "a" }));
      store.addSymbol(makeNode({ id: "s2", name: "b" }));
      const edge = makeEdge({ id: "e1", sourceId: "s1", targetId: "s2" });
      store.addEdge(edge);
      const op: GraphOperation = { type: "RemoveEdge", edgeId: "e1" };
      const inv = computeInverse(op, store);
      expect(inv?.type).toBe("AddEdge");
      if (inv?.type === "AddEdge") {
        expect(inv.edge.id).toBe("e1");
      }
    });

    test("SetExported inverse restores old value", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo", exported: false }));
      const op: GraphOperation = {
        type: "SetExported",
        symbolId: "s1",
        exported: true,
      };
      const inv = computeInverse(op, store);
      expect(inv).toEqual({
        type: "SetExported",
        symbolId: "s1",
        exported: false,
      });
    });

    test("AddModifier inverse is RemoveModifier", () => {
      const op: GraphOperation = {
        type: "AddModifier",
        symbolId: "s1",
        modifier: "async",
      };
      const inv = computeInverse(op, store);
      expect(inv).toEqual({
        type: "RemoveModifier",
        symbolId: "s1",
        modifier: "async",
      });
    });

    test("RemoveModifier inverse is AddModifier", () => {
      const op: GraphOperation = {
        type: "RemoveModifier",
        symbolId: "s1",
        modifier: "static",
      };
      const inv = computeInverse(op, store);
      expect(inv).toEqual({
        type: "AddModifier",
        symbolId: "s1",
        modifier: "static",
      });
    });
  });

  describe("rollbackAgent", () => {
    test("rolls back a single AddSymbol operation", () => {
      const node = makeNode({ id: "s1", name: "foo" });
      store.addSymbol(node);

      const log = new OperationLog();
      log.append(
        { type: "AddSymbol", symbol: node },
        "agent-1",
        "batch-1",
        { symbolIds: ["s1"] },
      );

      const result = rollbackAgent("agent-1", log, store);
      expect(result.rolledBack).toHaveLength(1);
      expect(store.getSymbol("s1")).toBeUndefined();
    });

    test("rolls back multiple operations in reverse Lamport order", () => {
      const node = makeNode({ id: "s1", name: "foo", body: "original" });
      store.addSymbol(node);
      store.applyOperation({
        type: "ModifyBody",
        symbolId: "s1",
        newBody: "modified",
      });
      store.applyOperation({
        type: "SetExported",
        symbolId: "s1",
        exported: true,
      });

      const log = new OperationLog();
      log.append(
        { type: "AddSymbol", symbol: node },
        "agent-1",
        "batch-1",
        { symbolIds: ["s1"] },
      );
      log.append(
        { type: "ModifyBody", symbolId: "s1", newBody: "modified" },
        "agent-1",
        "batch-1",
        { symbolIds: ["s1"] },
      );
      log.append(
        { type: "SetExported", symbolId: "s1", exported: true },
        "agent-1",
        "batch-1",
        { symbolIds: ["s1"] },
      );

      const result = rollbackAgent("agent-1", log, store);
      // All three ops rolled back (SetExported, ModifyBody, AddSymbol in reverse)
      expect(result.rolledBack).toHaveLength(3);
      // After full rollback, symbol should be removed
      expect(store.getSymbol("s1")).toBeUndefined();
    });

    test("only rolls back the specified agent's ops", () => {
      const nodeA = makeNode({ id: "s1", name: "a" });
      const nodeB = makeNode({ id: "s2", name: "b" });
      store.addSymbol(nodeA);
      store.addSymbol(nodeB);

      const log = new OperationLog();
      log.append({ type: "AddSymbol", symbol: nodeA }, "agent-1", "batch-1", {
        symbolIds: ["s1"],
      });
      log.append({ type: "AddSymbol", symbol: nodeB }, "agent-2", "batch-2", {
        symbolIds: ["s2"],
      });

      rollbackAgent("agent-1", log, store);
      expect(store.getSymbol("s1")).toBeUndefined();
      expect(store.getSymbol("s2")).toBeDefined(); // agent-2's work untouched
    });

    test("detects cascaded edge removal and orphaned symbols", () => {
      const nodeA = makeNode({ id: "s1", name: "a" });
      const nodeB = makeNode({ id: "s2", name: "b" });
      store.addSymbol(nodeA);
      store.addSymbol(nodeB);
      const edge = makeEdge({
        id: "e1",
        sourceId: "s1",
        targetId: "s2",
        kind: "calls",
      });
      store.addEdge(edge);

      const log = new OperationLog();
      // Agent-1 added s1 and the edge
      log.append({ type: "AddSymbol", symbol: nodeA }, "agent-1", "batch-1", {
        symbolIds: ["s1"],
      });
      log.append({ type: "AddEdge", edge }, "agent-1", "batch-1", {
        symbolIds: ["s1", "s2"],
      });

      const result = rollbackAgent("agent-1", log, store);

      // The edge should be cascaded since s1 is removed
      expect(result.cascaded.length).toBeGreaterThanOrEqual(1);
      // s2 is orphaned (was referenced by the removed edge)
      expect(result.orphanedSymbols).toContain("s2");
      // s1 should be gone
      expect(store.getSymbol("s1")).toBeUndefined();
      // s2 should still exist
      expect(store.getSymbol("s2")).toBeDefined();
      // Edge should be gone
      expect(store.getEdge("e1")).toBeUndefined();
    });

    test("rolling back nonexistent agent is a no-op", () => {
      const log = new OperationLog();
      const result = rollbackAgent("ghost-agent", log, store);
      expect(result.rolledBack).toHaveLength(0);
      expect(result.cascaded).toHaveLength(0);
      expect(result.orphanedSymbols).toHaveLength(0);
    });
  });
});
