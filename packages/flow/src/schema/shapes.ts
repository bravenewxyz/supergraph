export interface ShapeField {
  name: string;
  type: ShapeType;
  optional: boolean;
}

export type ShapeType =
  | { kind: "primitive"; value: PrimitiveType }
  | { kind: "array"; element: ShapeType }
  | { kind: "object"; fields: ShapeField[] }
  | { kind: "union"; members: ShapeType[] }
  | { kind: "intersection"; members: ShapeType[] }
  | { kind: "tuple"; elements: Array<{ type: ShapeType; optional: boolean }> }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "enum"; values: Array<string | number> }
  | { kind: "record"; key: ShapeType; value: ShapeType }
  | { kind: "map"; key: ShapeType; value: ShapeType }
  | { kind: "set"; element: ShapeType }
  | { kind: "date" }
  | { kind: "regex" }
  | { kind: "function"; params: ShapeType[]; returnType: ShapeType }
  | { kind: "promise"; resolved: ShapeType }
  | { kind: "ref"; name: string; resolved?: ShapeType }
  | { kind: "opaque"; raw: string };

export type PrimitiveType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "unknown"
  | "any"
  | "void"
  | "never"
  | "bigint"
  | "symbol";

export interface ShapeMismatch {
  path: string;
  expected: ShapeType;
  actual: ShapeType;
  severity: "error" | "warning";
  message: string;
  category: MismatchCategory;
}

export type MismatchCategory =
  | "type-mismatch"
  | "json-lossy"
  | "json-dropped"
  | "optionality"
  | "missing-field"
  | "union-coverage"
  | "extra-field";

export function shapeToString(shape: ShapeType, depth: number = 0): string {
  if (depth > 8) return "...";
  switch (shape.kind) {
    case "primitive":
      return shape.value;
    case "literal":
      return typeof shape.value === "string" ? `"${shape.value}"` : String(shape.value);
    case "array":
      return `${shapeToString(shape.element, depth + 1)}[]`;
    case "tuple":
      return `[${shape.elements.map((e) => `${shapeToString(e.type, depth + 1)}${e.optional ? "?" : ""}`).join(", ")}]`;
    case "object": {
      if (shape.fields.length === 0) return "{}";
      const inner = shape.fields
        .map((f) => `${f.name}${f.optional ? "?" : ""}: ${shapeToString(f.type, depth + 1)}`)
        .join("; ");
      return `{ ${inner} }`;
    }
    case "union":
      return shape.members.map((m) => shapeToString(m, depth + 1)).join(" | ");
    case "intersection":
      return shape.members.map((m) => shapeToString(m, depth + 1)).join(" & ");
    case "enum":
      return shape.values.map((v) => (typeof v === "string" ? `"${v}"` : String(v))).join(" | ");
    case "record":
      return `Record<${shapeToString(shape.key, depth + 1)}, ${shapeToString(shape.value, depth + 1)}>`;
    case "map":
      return `Map<${shapeToString(shape.key, depth + 1)}, ${shapeToString(shape.value, depth + 1)}>`;
    case "set":
      return `Set<${shapeToString(shape.element, depth + 1)}>`;
    case "date":
      return "Date";
    case "regex":
      return "RegExp";
    case "function":
      return `(${shape.params.map((p) => shapeToString(p, depth + 1)).join(", ")}) => ${shapeToString(shape.returnType, depth + 1)}`;
    case "promise":
      return `Promise<${shapeToString(shape.resolved, depth + 1)}>`;
    case "ref":
      return shape.name;
    case "opaque":
      return shape.raw;
  }
}
