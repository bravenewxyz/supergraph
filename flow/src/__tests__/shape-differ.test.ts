import { describe, test, expect } from "bun:test";
import { diffShapes, diffTypes } from "../analysis/shape-differ.js";
import type { ShapeType, ShapeField } from "../schema/shapes.js";

const field = (name: string, type: ShapeType, optional = false): ShapeField => ({
  name,
  type,
  optional,
});

const str: ShapeType = { kind: "primitive", value: "string" };
const num: ShapeType = { kind: "primitive", value: "number" };
const bool: ShapeType = { kind: "primitive", value: "boolean" };

describe("diffShapes", () => {
  test("returns empty array for identical shapes", () => {
    const fields = [field("a", str), field("b", num)];
    expect(diffShapes(fields, fields)).toEqual([]);
  });

  test("detects missing fields as errors", () => {
    const left = [field("a", str), field("b", num)];
    const right = [field("a", str)];
    const result = diffShapes(left, right);
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("missing-field");
    expect(result[0]!.severity).toBe("error");
    expect(result[0]!.path).toBe("b");
  });

  test("detects missing optional fields as warnings", () => {
    const left = [field("a", str, true)];
    const right: ShapeField[] = [];
    const result = diffShapes(left, right);
    expect(result).toHaveLength(1);
    expect(result[0]!.severity).toBe("warning");
  });

  test("detects extra fields in right", () => {
    const left = [field("a", str)];
    const right = [field("a", str), field("extra", num)];
    const result = diffShapes(left, right);
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("extra-field");
  });

  test("detects type mismatches in matching fields", () => {
    const left = [field("x", str)];
    const right = [field("x", num)];
    const result = diffShapes(left, right);
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("type-mismatch");
    expect(result[0]!.path).toBe("x");
  });
});

describe("diffTypes", () => {
  test("returns empty for identical primitives", () => {
    expect(diffTypes(str, str, "root")).toEqual([]);
  });

  test("detects primitive mismatch", () => {
    const result = diffTypes(str, num, "val");
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe("type-mismatch");
  });

  test("recurses into arrays", () => {
    const leftArr: ShapeType = { kind: "array", element: str };
    const rightArr: ShapeType = { kind: "array", element: num };
    const result = diffTypes(leftArr, rightArr, "arr");
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("arr[]");
  });

  test("skips opaque and any types", () => {
    const opaque: ShapeType = { kind: "opaque", raw: "SomeExternalType" };
    expect(diffTypes(opaque, str, "x")).toEqual([]);
    expect(diffTypes(str, { kind: "primitive", value: "any" }, "x")).toEqual([]);
  });

  test("handles union coverage check", () => {
    const leftUnion: ShapeType = { kind: "union", members: [str, num, bool] };
    const rightUnion: ShapeType = { kind: "union", members: [str, num] };
    const result = diffTypes(leftUnion, rightUnion, "u");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.category).toBe("union-coverage");
  });
});
