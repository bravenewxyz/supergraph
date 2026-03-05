import type { ShapeType, ShapeField, ShapeMismatch } from "../schema/shapes.js";
import { shapeToString } from "../schema/shapes.js";
import { diffShapes } from "../analysis/shape-differ.js";

/**
 * Model what JSON.stringify() → JSON.parse() does to a shape.
 * Returns the transformed shape after a full JSON roundtrip.
 */
export function jsonSerialize(shape: ShapeType): ShapeType {
  switch (shape.kind) {
    case "primitive":
      switch (shape.value) {
        case "string":
        case "number":
        case "boolean":
        case "null":
          return shape;
        case "undefined":
          return { kind: "primitive", value: "undefined" };
        case "bigint":
          // JSON.stringify throws TypeError on BigInt
          return { kind: "opaque", raw: "BigInt(throws)" };
        case "any":
        case "unknown":
          return shape;
        default:
          return { kind: "primitive", value: "unknown" };
      }

    case "literal":
      return shape;

    case "date":
      return { kind: "primitive", value: "string" };

    case "regex":
      return { kind: "object", fields: [] };

    case "map":
    case "set":
      return { kind: "object", fields: [] };

    case "function":
      return { kind: "primitive", value: "undefined" };

    case "promise":
      return { kind: "object", fields: [] };

    case "array":
      return { kind: "array", element: jsonSerialize(shape.element) };

    case "tuple": {
      const elements = shape.elements.map((e) => ({
        type: jsonSerialize(e.type),
        optional: e.optional,
      }));
      return { kind: "tuple", elements };
    }

    case "object": {
      const fields: ShapeField[] = [];
      for (const f of shape.fields) {
        const serialized = jsonSerialize(f.type);
        if (serialized.kind === "primitive" && serialized.value === "undefined") continue;
        if (serialized.kind === "function") continue;
        fields.push({ ...f, type: serialized });
      }
      return { kind: "object", fields };
    }

    case "union":
      return {
        kind: "union",
        members: shape.members.map(jsonSerialize),
      };

    case "intersection":
      return {
        kind: "intersection",
        members: shape.members.map(jsonSerialize),
      };

    case "record":
      return {
        kind: "record",
        key: shape.key,
        value: jsonSerialize(shape.value),
      };

    case "enum":
      return shape;

    case "ref":
      if (shape.resolved) {
        return { ...shape, resolved: jsonSerialize(shape.resolved) };
      }
      return shape;

    case "opaque":
      return shape;
  }
}

/**
 * Compare a type before serialization with the type expected after deserialization,
 * accounting for JSON roundtrip transformations.
 */
export function checkJsonRoundtrip(
  preSerialize: ShapeType,
  postDeserialize: ShapeType,
  path: string = "",
): ShapeMismatch[] {
  const mismatches: ShapeMismatch[] = [];
  const serialized = jsonSerialize(preSerialize);

  findJsonLosses(preSerialize, serialized, path, mismatches);

  if (postDeserialize.kind === "object" && serialized.kind === "object") {
    mismatches.push(...diffShapes(
      (serialized as Extract<ShapeType, { kind: "object" }>).fields,
      (postDeserialize as Extract<ShapeType, { kind: "object" }>).fields,
      path,
      { leftLabel: "serialized", rightLabel: "expected-by-receiver" },
    ));
  }

  return mismatches;
}

function findJsonLosses(
  original: ShapeType,
  afterJson: ShapeType,
  path: string,
  out: ShapeMismatch[],
): void {
  if (original.kind === afterJson.kind) {
    switch (original.kind) {
      case "object": {
        const afterObj = afterJson as Extract<ShapeType, { kind: "object" }>;
        const afterMap = new Map(afterObj.fields.map((f) => [f.name, f]));

        for (const field of original.fields) {
          const afterField = afterMap.get(field.name);
          const fieldPath = path ? `${path}.${field.name}` : field.name;

          if (!afterField) {
            out.push({
              path: fieldPath,
              expected: field.type,
              actual: { kind: "primitive", value: "undefined" },
              severity: "error",
              message: `Field dropped by JSON serialization (${shapeToString(field.type)} → undefined)`,
              category: "json-dropped",
            });
          } else {
            findJsonLosses(field.type, afterField.type, fieldPath, out);
          }
        }
        break;
      }

      case "array": {
        const afterArr = afterJson as Extract<ShapeType, { kind: "array" }>;
        findJsonLosses(original.element, afterArr.element, `${path}[]`, out);
        break;
      }

      case "union": {
        const afterUnion = afterJson as Extract<ShapeType, { kind: "union" }>;
        for (let i = 0; i < original.members.length; i++) {
          const afterMember = afterUnion.members[i];
          if (afterMember) {
            findJsonLosses(original.members[i]!, afterMember, path, out);
          }
        }
        break;
      }
    }
    return;
  }

  // Kind changed — this is a JSON transformation
  if (original.kind === "date" && afterJson.kind === "primitive") {
    out.push({
      path,
      expected: original,
      actual: afterJson,
      severity: "warning",
      message: "Date becomes ISO string through JSON roundtrip",
      category: "json-lossy",
    });
    return;
  }

  if (original.kind === "function" && afterJson.kind === "primitive") {
    out.push({
      path,
      expected: original,
      actual: afterJson,
      severity: "error",
      message: "Function is dropped by JSON serialization",
      category: "json-dropped",
    });
    return;
  }

  if (
    (original.kind === "map" || original.kind === "set" || original.kind === "regex") &&
    afterJson.kind === "object"
  ) {
    out.push({
      path,
      expected: original,
      actual: afterJson,
      severity: "error",
      message: `${original.kind === "map" ? "Map" : original.kind === "set" ? "Set" : "RegExp"} becomes empty object through JSON`,
      category: "json-dropped",
    });
    return;
  }

  if (original.kind === "primitive" && original.value === "bigint") {
    out.push({
      path,
      expected: original,
      actual: afterJson,
      severity: "error",
      message: "BigInt throws TypeError during JSON.stringify",
      category: "json-dropped",
    });
    return;
  }

  out.push({
    path,
    expected: original,
    actual: afterJson,
    severity: "warning",
    message: `Type changes through JSON: ${shapeToString(original)} → ${shapeToString(afterJson)}`,
    category: "json-lossy",
  });
}
