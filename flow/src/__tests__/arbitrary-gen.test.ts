import { describe, test, expect } from "bun:test";
import { shapeToArbitrary, paramsToArbitrary, generateArbitraryBlock } from "../invariant/arbitrary-gen.js";
import type { ShapeType, ShapeField } from "../schema/shapes.js";
import type { FunctionParam } from "../invariant/types.js";

describe("shapeToArbitrary", () => {
  test("maps primitive types to correct fc arbitraries", () => {
    const cases: Array<[ShapeType, string]> = [
      [{ kind: "primitive", value: "string" }, "fc.string()"],
      [{ kind: "primitive", value: "number" }, "fc.integer({ min: -1000, max: 1000 })"],
      [{ kind: "primitive", value: "boolean" }, "fc.boolean()"],
      [{ kind: "primitive", value: "null" }, "fc.constant(null)"],
      [{ kind: "primitive", value: "undefined" }, "fc.constant(undefined)"],
      [{ kind: "primitive", value: "bigint" }, "fc.bigInt()"],
      [{ kind: "primitive", value: "any" }, "fc.anything()"],
      [{ kind: "primitive", value: "symbol" }, "fc.constant(Symbol())"],
    ];
    for (const [shape, expected] of cases) {
      expect(shapeToArbitrary(shape)).toBe(expected);
    }
  });

  test("maps literal types to fc.constant", () => {
    expect(shapeToArbitrary({ kind: "literal", value: "hello" })).toBe('fc.constant("hello")');
    expect(shapeToArbitrary({ kind: "literal", value: 42 })).toBe("fc.constant(42)");
    expect(shapeToArbitrary({ kind: "literal", value: true })).toBe("fc.constant(true)");
  });

  test("handles arrays, objects, and tuples", () => {
    const arrayShape: ShapeType = { kind: "array", element: { kind: "primitive", value: "number" } };
    expect(shapeToArbitrary(arrayShape)).toBe("fc.array(fc.integer({ min: -1000, max: 1000 }))");

    const objShape: ShapeType = {
      kind: "object",
      fields: [
        { name: "x", type: { kind: "primitive", value: "number" }, optional: false },
        { name: "y", type: { kind: "primitive", value: "string" }, optional: true },
      ],
    };
    const result = shapeToArbitrary(objShape);
    expect(result).toContain("fc.record");
    expect(result).toContain("x: fc.integer");
    expect(result).toContain("y: fc.option(fc.string()");

    const tupleShape: ShapeType = {
      kind: "tuple",
      elements: [
        { type: { kind: "primitive", value: "string" }, optional: false },
        { type: { kind: "primitive", value: "number" }, optional: true },
      ],
    };
    expect(shapeToArbitrary(tupleShape)).toContain("fc.tuple(");
  });

  test("handles union and enum types", () => {
    const union: ShapeType = {
      kind: "union",
      members: [
        { kind: "primitive", value: "string" },
        { kind: "primitive", value: "number" },
      ],
    };
    expect(shapeToArbitrary(union)).toBe("fc.oneof(fc.string(), fc.integer({ min: -1000, max: 1000 }))");

    const enumShape: ShapeType = { kind: "enum", values: ["a", "b", 3] };
    expect(shapeToArbitrary(enumShape)).toBe('fc.constantFrom("a", "b", 3)');
  });

  test("falls back to fc.anything() when depth exceeds MAX_DEPTH", () => {
    const deepShape: ShapeType = { kind: "array", element: { kind: "primitive", value: "string" } };
    expect(shapeToArbitrary(deepShape, 7)).toBe("fc.anything()");
  });
});

describe("paramsToArbitrary", () => {
  test("returns fc.constant(undefined) for empty params", () => {
    expect(paramsToArbitrary([])).toBe("fc.constant(undefined)");
  });

  test("returns single arbitrary for one param", () => {
    const params: FunctionParam[] = [
      { name: "x", type: { kind: "primitive", value: "number" }, optional: false },
    ];
    expect(paramsToArbitrary(params)).toBe("fc.integer({ min: -1000, max: 1000 })");
  });

  test("returns fc.tuple for multiple params", () => {
    const params: FunctionParam[] = [
      { name: "a", type: { kind: "primitive", value: "string" }, optional: false },
      { name: "b", type: { kind: "primitive", value: "boolean" }, optional: false },
    ];
    expect(paramsToArbitrary(params)).toBe("fc.tuple(fc.string(), fc.boolean())");
  });
});

describe("generateArbitraryBlock", () => {
  test("generates const declaration with arbitrary", () => {
    const params: FunctionParam[] = [
      { name: "n", type: { kind: "primitive", value: "number" }, optional: false },
    ];
    expect(generateArbitraryBlock(params)).toBe(
      "const inputArb = fc.integer({ min: -1000, max: 1000 });",
    );
  });
});
