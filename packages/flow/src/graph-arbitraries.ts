import fc from "fast-check";
import type {
  SymbolKind,
  SymbolNode,
  EdgeKind,
  SymbolEdge,
  GraphOperation,
  OperationEntry,
} from "@supergraph/graph";

export const arbSymbolKind: fc.Arbitrary<SymbolKind> = fc.constantFrom(
  "module" as const,
  "function" as const,
  "method" as const,
  "class" as const,
  "interface" as const,
  "type-alias" as const,
  "enum" as const,
  "enum-member" as const,
  "variable" as const,
  "parameter" as const,
  "property" as const,
  "test" as const,
  "namespace" as const,
);

export const arbEdgeKind: fc.Arbitrary<EdgeKind> = fc.constantFrom(
  "contains" as const,
  "calls" as const,
  "imports" as const,
  "extends" as const,
  "implements" as const,
  "references" as const,
  "tests" as const,
  "depends-on" as const,
);

const arbIdentifier = fc.string({
  unit: fc.constantFrom(
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  ),
  minLength: 1,
  maxLength: 15,
});

const arbModulePath = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz/".split("")),
  minLength: 3,
  maxLength: 20,
});

export const arbSymbolId = fc
  .tuple(arbModulePath, arbIdentifier)
  .map(([mod, name]) => `${mod}::${name}`);

export const arbSymbolNode: fc.Arbitrary<SymbolNode> = fc.record({
  id: arbSymbolId,
  kind: arbSymbolKind,
  name: arbIdentifier,
  qualifiedName: fc
    .tuple(arbModulePath, arbIdentifier)
    .map(([m, n]) => `${m}.${n}`),
  parentId: fc.option(arbSymbolId, { nil: null }),
  signature: fc.string({ minLength: 0, maxLength: 100 }),
  typeText: fc.string({ minLength: 0, maxLength: 50 }),
  exported: fc.boolean(),
  body: fc.string({ minLength: 0, maxLength: 200 }),
  decorators: fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }),
  modifiers: fc.array(
    fc.constantFrom(
      "export",
      "async",
      "static",
      "readonly",
      "abstract",
      "private",
      "protected",
      "public",
    ),
    { maxLength: 3 },
  ),
  sourceRange: fc.option(
    fc
      .record({
        startLine: fc.nat({ max: 1000 }),
        endLine: fc.nat({ max: 1000 }),
      })
      .map((r) => ({
        startLine: Math.min(r.startLine, r.endLine),
        endLine: Math.max(r.startLine, r.endLine),
      })),
    { nil: null },
  ),
  createdBy: fc.string({ minLength: 1, maxLength: 10 }),
  lastModifiedBy: fc.string({ minLength: 1, maxLength: 10 }),
  version: fc.nat({ max: 100 }),
  createdAt: fc.nat(),
  updatedAt: fc.nat(),
});

export function arbSymbolEdge(
  sourceId: string,
  targetId: string,
): fc.Arbitrary<SymbolEdge> {
  return fc.record({
    id: fc.uuid(),
    kind: arbEdgeKind,
    sourceId: fc.constant(sourceId),
    targetId: fc.constant(targetId),
    metadata: fc.constant(undefined),
  });
}

/** All operations targeting a specific symbol by ID. */
export function arbOperationForSymbol(
  symbolId: string,
): fc.Arbitrary<GraphOperation> {
  return fc.oneof(
    fc.record({
      type: fc.constant("ModifyBody" as const),
      symbolId: fc.constant(symbolId),
      newBody: fc.string({ maxLength: 200 }),
    }),
    fc.record({
      type: fc.constant("ModifySignature" as const),
      symbolId: fc.constant(symbolId),
      newSignature: fc.string({ maxLength: 100 }),
      newTypeText: fc.string({ maxLength: 50 }),
    }),
    fc.record({
      type: fc.constant("SetExported" as const),
      symbolId: fc.constant(symbolId),
      exported: fc.boolean(),
    }),
    fc.record({
      type: fc.constant("AddModifier" as const),
      symbolId: fc.constant(symbolId),
      modifier: fc.constantFrom("async", "static", "readonly", "abstract"),
    }),
    fc.record({
      type: fc.constant("RemoveModifier" as const),
      symbolId: fc.constant(symbolId),
      modifier: fc.constantFrom("async", "static", "readonly", "abstract"),
    }),
    fc.record({
      type: fc.constant("RenameSymbol" as const),
      symbolId: fc.constant(symbolId),
      newName: arbIdentifier,
    }),
    fc.record({
      type: fc.constant("MoveSymbol" as const),
      symbolId: fc.constant(symbolId),
      newParentId: arbSymbolId,
    }),
    fc.record({
      type: fc.constant("ModifyDecorators" as const),
      symbolId: fc.constant(symbolId),
      newDecorators: fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }),
    }),
  );
}

/** Structural operations that add/remove symbols or edges. */
export function arbStructuralOperation(): fc.Arbitrary<GraphOperation> {
  return fc.oneof(
    arbSymbolNode.map(
      (node): GraphOperation => ({ type: "AddSymbol" as const, symbol: node }),
    ),
    arbSymbolId.map(
      (id): GraphOperation => ({ type: "RemoveSymbol" as const, symbolId: id }),
    ),
    fc
      .tuple(fc.uuid(), arbEdgeKind, arbSymbolId, arbSymbolId)
      .map(
        ([id, kind, sourceId, targetId]): GraphOperation => ({
          type: "AddEdge" as const,
          edge: { id, kind, sourceId, targetId },
        }),
      ),
    fc.uuid().map(
      (id): GraphOperation => ({ type: "RemoveEdge" as const, edgeId: id }),
    ),
  );
}

export function arbOperationEntry(
  symbolId: string,
  agentId?: string,
): fc.Arbitrary<OperationEntry> {
  return fc.record({
    id: fc.uuid(),
    op: arbOperationForSymbol(symbolId),
    agentId: agentId
      ? fc.constant(agentId)
      : fc.string({
          unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
          minLength: 3,
          maxLength: 10,
        }),
    lamport: fc.nat({ max: 10000 }),
    timestamp: fc.nat(),
    batchId: fc.uuid(),
    symbolIds: fc.constant([symbolId]),
    contractId: fc.option(fc.uuid(), { nil: undefined }),
  });
}

export function arbOperationBatch(
  symbolIds: string[],
): fc.Arbitrary<GraphOperation[]> {
  if (symbolIds.length === 0) return fc.constant([]);
  return fc.array(
    fc.oneof(...symbolIds.map((id) => arbOperationForSymbol(id))),
    { minLength: 1, maxLength: 10 },
  );
}
