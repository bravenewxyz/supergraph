import { describe, test, expect, beforeEach } from "bun:test";
import { GraphStore } from "../store/graph-store.js";
import { createSymbolNode } from "../schema/nodes.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { GraphOperation, OperationResult } from "../schema/operations.js";

function makeNode(
  overrides: Partial<SymbolNode> & { id: string; name: string },
): SymbolNode {
  return createSymbolNode({
    kind: "function",
    qualifiedName: overrides.qualifiedName ?? `mod.${overrides.name}`,
    ...overrides,
  });
}

describe("applyOperation returns OperationResult", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore();
  });

  // --- Missing symbol cases (all 7 operation types) ---

  describe("missing symbol → applied: false", () => {
    test("ModifyBody on non-existent symbol", () => {
      const result = store.applyOperation({
        type: "ModifyBody",
        symbolId: "missing",
        newBody: "x",
      });
      expect(result).toEqual({
        applied: false,
        operationType: "ModifyBody",
        symbolId: "missing",
        reason: "symbol not found",
      });
    });

    test("ModifySignature on non-existent symbol", () => {
      const result = store.applyOperation({
        type: "ModifySignature",
        symbolId: "missing",
        newSignature: "x",
        newTypeText: "x",
      });
      expect(result).toEqual({
        applied: false,
        operationType: "ModifySignature",
        symbolId: "missing",
        reason: "symbol not found",
      });
    });

    test("RenameSymbol on non-existent symbol", () => {
      const result = store.applyOperation({
        type: "RenameSymbol",
        symbolId: "missing",
        newName: "x",
      });
      expect(result).toEqual({
        applied: false,
        operationType: "RenameSymbol",
        symbolId: "missing",
        reason: "symbol not found",
      });
    });

    test("MoveSymbol on non-existent symbol", () => {
      const result = store.applyOperation({
        type: "MoveSymbol",
        symbolId: "missing",
        newParentId: "x",
      });
      expect(result).toEqual({
        applied: false,
        operationType: "MoveSymbol",
        symbolId: "missing",
        reason: "symbol not found",
      });
    });

    test("SetExported on non-existent symbol", () => {
      const result = store.applyOperation({
        type: "SetExported",
        symbolId: "missing",
        exported: true,
      });
      expect(result).toEqual({
        applied: false,
        operationType: "SetExported",
        symbolId: "missing",
        reason: "symbol not found",
      });
    });

    test("AddModifier on non-existent symbol", () => {
      const result = store.applyOperation({
        type: "AddModifier",
        symbolId: "missing",
        modifier: "async",
      });
      expect(result).toEqual({
        applied: false,
        operationType: "AddModifier",
        symbolId: "missing",
        reason: "symbol not found",
      });
    });

    test("RemoveModifier on non-existent symbol", () => {
      const result = store.applyOperation({
        type: "RemoveModifier",
        symbolId: "missing",
        modifier: "async",
      });
      expect(result).toEqual({
        applied: false,
        operationType: "RemoveModifier",
        symbolId: "missing",
        reason: "symbol not found",
      });
    });
  });

  // --- Successful operations ---

  describe("successful operations → applied: true", () => {
    test("ModifyBody on existing symbol", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo", body: "old" }));
      const result = store.applyOperation({
        type: "ModifyBody",
        symbolId: "s1",
        newBody: "new",
      });
      expect(result).toEqual({
        applied: true,
        operationType: "ModifyBody",
        symbolId: "s1",
      });
      expect(store.getSymbol("s1")!.body).toBe("new");
    });

    test("ModifySignature on existing symbol", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo" }));
      const result = store.applyOperation({
        type: "ModifySignature",
        symbolId: "s1",
        newSignature: "sig",
        newTypeText: "type",
      });
      expect(result).toEqual({
        applied: true,
        operationType: "ModifySignature",
        symbolId: "s1",
      });
    });

    test("RenameSymbol on existing symbol", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo" }));
      const result = store.applyOperation({
        type: "RenameSymbol",
        symbolId: "s1",
        newName: "bar",
      });
      expect(result).toEqual({
        applied: true,
        operationType: "RenameSymbol",
        symbolId: "s1",
      });
    });

    test("MoveSymbol on existing symbol", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo", parentId: "p1" }));
      const result = store.applyOperation({
        type: "MoveSymbol",
        symbolId: "s1",
        newParentId: "p2",
      });
      expect(result).toEqual({
        applied: true,
        operationType: "MoveSymbol",
        symbolId: "s1",
      });
    });

    test("SetExported on existing symbol", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo" }));
      const result = store.applyOperation({
        type: "SetExported",
        symbolId: "s1",
        exported: true,
      });
      expect(result).toEqual({
        applied: true,
        operationType: "SetExported",
        symbolId: "s1",
      });
    });

    test("AddSymbol", () => {
      const node = makeNode({ id: "s1", name: "foo" });
      const result = store.applyOperation({ type: "AddSymbol", symbol: node });
      expect(result).toEqual({
        applied: true,
        operationType: "AddSymbol",
        symbolId: "s1",
      });
    });

    test("RemoveSymbol", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo" }));
      const result = store.applyOperation({ type: "RemoveSymbol", symbolId: "s1" });
      expect(result).toEqual({
        applied: true,
        operationType: "RemoveSymbol",
        symbolId: "s1",
      });
    });
  });

  // --- Modifier edge cases ---

  describe("modifier edge cases", () => {
    test("AddModifier succeeds when modifier not present", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo" }));
      const result = store.applyOperation({
        type: "AddModifier",
        symbolId: "s1",
        modifier: "async",
      });
      expect(result).toEqual({
        applied: true,
        operationType: "AddModifier",
        symbolId: "s1",
      });
      expect(store.getSymbol("s1")!.modifiers).toEqual(["async"]);
    });

    test("AddModifier when modifier already present → applied: false", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo", modifiers: ["async"] }));
      const result = store.applyOperation({
        type: "AddModifier",
        symbolId: "s1",
        modifier: "async",
      });
      expect(result).toEqual({
        applied: false,
        operationType: "AddModifier",
        symbolId: "s1",
        reason: "modifier already present",
      });
    });

    test("RemoveModifier succeeds when modifier is present", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo", modifiers: ["async", "static"] }));
      const result = store.applyOperation({
        type: "RemoveModifier",
        symbolId: "s1",
        modifier: "async",
      });
      expect(result).toEqual({
        applied: true,
        operationType: "RemoveModifier",
        symbolId: "s1",
      });
      expect(store.getSymbol("s1")!.modifiers).toEqual(["static"]);
    });

    test("RemoveModifier when modifier not present → applied: false", () => {
      store.addSymbol(makeNode({ id: "s1", name: "foo", modifiers: ["static"] }));
      const result = store.applyOperation({
        type: "RemoveModifier",
        symbolId: "s1",
        modifier: "readonly",
      });
      expect(result).toEqual({
        applied: false,
        operationType: "RemoveModifier",
        symbolId: "s1",
        reason: "modifier not present",
      });
    });
  });
});
