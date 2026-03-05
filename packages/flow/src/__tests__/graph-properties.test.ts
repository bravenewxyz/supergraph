import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  GraphStore,
  checkCommutativity,
  MergeEngine,
  SymbolLockTable,
  createSymbolNode,
} from "@supergraph/graph";
import type { GraphOperation } from "@supergraph/graph";
import {
  arbSymbolNode,
  arbSymbolId,
  arbOperationForSymbol,
  arbOperationEntry,
} from "../graph-arbitraries.js";

const FC_PARAMS = { numRuns: 200 };

describe("graph property-based tests", () => {
  // ── Property 1: Commutativity check is total (never throws) ────────────
  test("commutativity is reflexive — op with itself yields a valid result", () => {
    const symbolId = "test/mod::Foo";
    fc.assert(
      fc.property(arbOperationForSymbol(symbolId), (op) => {
        const result = checkCommutativity(op, op);
        expect([
          "commutes",
          "conflict",
          "lww",
          "idempotent",
          "contract-dependent",
        ]).toContain(result);
      }),
      FC_PARAMS,
    );
  });

  // ── Property 2: Commutativity is symmetric ─────────────────────────────
  test("commutativity is symmetric — checkCommutativity(a, b) === checkCommutativity(b, a)", () => {
    const symbolId = "test/mod::Bar";
    fc.assert(
      fc.property(
        arbOperationForSymbol(symbolId),
        arbOperationForSymbol(symbolId),
        (opA, opB) => {
          const ab = checkCommutativity(opA, opB);
          const ba = checkCommutativity(opB, opA);
          expect(ab).toBe(ba);
        },
      ),
      FC_PARAMS,
    );
  });

  // ── Property 3: Operations on existing symbols return valid results ────
  test("operations on existing symbols produce valid OperationResult", () => {
    fc.assert(
      fc.property(arbSymbolNode, (node) => {
        const store = new GraphStore();
        store.applyOperation({ type: "AddSymbol", symbol: node });

        const opsAlwaysApplied: GraphOperation[] = [
          { type: "ModifyBody", symbolId: node.id, newBody: "x = 1" },
          {
            type: "ModifySignature",
            symbolId: node.id,
            newSignature: "(a: number)",
            newTypeText: "number",
          },
          { type: "SetExported", symbolId: node.id, exported: true },
          {
            type: "ModifyDecorators",
            symbolId: node.id,
            newDecorators: ["@test"],
          },
          {
            type: "RenameSymbol",
            symbolId: node.id,
            newName: "Renamed",
          },
        ];

        for (const op of opsAlwaysApplied) {
          const result = store.applyOperation(op);
          expect(result.applied).toBe(true);
          expect(result.operationType).toBe(op.type);
        }
      }),
      FC_PARAMS,
    );
  });

  // ── Property 4: Operations on missing symbols return applied: false ────
  test("operations on missing symbols return applied: false", () => {
    fc.assert(
      fc.property(arbOperationForSymbol("nonexistent::symbol"), (op) => {
        const store = new GraphStore();
        const result = store.applyOperation(op);
        expect(result.applied).toBe(false);
        expect(result.reason).toBe("symbol not found");
      }),
      FC_PARAMS,
    );
  });

  // ── Property 5: Non-overlapping scope claims are conflict-free ─────────
  test("disjoint symbol claims never conflict", () => {
    const opTypes: GraphOperation["type"][] = [
      "ModifyBody",
      "ModifySignature",
      "SetExported",
      "AddModifier",
      "RemoveModifier",
      "RenameSymbol",
      "MoveSymbol",
    ];

    fc.assert(
      fc.property(
        arbSymbolId,
        arbSymbolId,
        fc.constantFrom(...opTypes),
        fc.constantFrom(...opTypes),
        (sym1, sym2, opType1, opType2) => {
          fc.pre(sym1 !== sym2);
          const table = new SymbolLockTable();
          const r1 = table.acquire(sym1, "agent-A", opType1);
          const r2 = table.acquire(sym2, "agent-B", opType2);
          expect(r1.status).toBe("acquired");
          expect(r2.status).toBe("acquired");
        },
      ),
      FC_PARAMS,
    );
  });

  // ── Property 6: MergeEngine.compose always returns valid structure ─────
  test("MergeEngine.compose produces valid output for any operation batches", () => {
    const sharedSymbol = "test/shared::Target";

    fc.assert(
      fc.property(
        fc.array(arbOperationEntry(sharedSymbol, "agent-A"), {
          minLength: 0,
          maxLength: 5,
        }),
        fc.array(arbOperationEntry(sharedSymbol, "agent-B"), {
          minLength: 0,
          maxLength: 5,
        }),
        (batchA, batchB) => {
          const allEntries = [...batchA, ...batchB];
          const allInputIds = new Set(allEntries.map((e) => e.id));
          // MergeEngine uses a Map keyed by entry.id; skip if fast-check generated dupes
          fc.pre(allInputIds.size === allEntries.length);

          const store = new GraphStore();
          const engine = new MergeEngine(store);
          const result = engine.compose([batchA, batchB]);

          // Output arrays are always defined
          expect(Array.isArray(result.applied)).toBe(true);
          expect(Array.isArray(result.conflicts)).toBe(true);
          expect(Array.isArray(result.autoResolved)).toBe(true);

          const totalInput = allInputIds.size;

          // Collect all entry IDs that appear in some output bucket
          const accountedIds = new Set<string>();
          for (const entry of result.applied) accountedIds.add(entry.id);
          for (const c of result.conflicts) {
            accountedIds.add(c.opA.id);
            accountedIds.add(c.opB.id);
          }
          for (const ar of result.autoResolved) {
            accountedIds.add(ar.winner.id);
            accountedIds.add(ar.loser.id);
          }

          // Every input entry must appear in at least one output bucket
          for (const id of allInputIds) {
            expect(accountedIds.has(id)).toBe(true);
          }

          // Applied entries must not also be losers or conflict participants
          const excludedIds = new Set<string>();
          for (const c of result.conflicts) {
            excludedIds.add(c.opA.id);
            excludedIds.add(c.opB.id);
          }
          for (const ar of result.autoResolved) {
            excludedIds.add(ar.loser.id);
          }
          for (const entry of result.applied) {
            expect(excludedIds.has(entry.id)).toBe(false);
          }

          // Applied entries should be sorted by Lamport
          for (let i = 1; i < result.applied.length; i++) {
            expect(result.applied[i]!.lamport).toBeGreaterThanOrEqual(
              result.applied[i - 1]!.lamport,
            );
          }
        },
      ),
      FC_PARAMS,
    );
  });

  // ── Property 7: AddSymbol then RemoveSymbol is a round-trip ────────────
  test("AddSymbol then RemoveSymbol restores original graph state", () => {
    fc.assert(
      fc.property(arbSymbolNode, (node) => {
        const store = new GraphStore();
        const countBefore = store.nodeCount;

        const addResult = store.applyOperation({
          type: "AddSymbol",
          symbol: node,
        });
        expect(addResult.applied).toBe(true);
        expect(store.nodeCount).toBe(countBefore + 1);
        expect(store.getSymbol(node.id)).toBeDefined();

        const removeResult = store.applyOperation({
          type: "RemoveSymbol",
          symbolId: node.id,
        });
        expect(removeResult.applied).toBe(true);
        expect(store.nodeCount).toBe(countBefore);
        expect(store.getSymbol(node.id)).toBeUndefined();
      }),
      FC_PARAMS,
    );
  });
});
