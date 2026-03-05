import type { ShapeType, ShapeField } from "../schema/shapes.js";
import type { FunctionParam } from "./types.js";

const MAX_DEPTH = 6;

function escapeStringLiteral(s: string): string {
  return JSON.stringify(s);
}

export function shapeToArbitrary(shape: ShapeType, depth: number = 0): string {
  if (depth > MAX_DEPTH) return "fc.anything()";

  switch (shape.kind) {
    case "primitive": {
      switch (shape.value) {
        case "string":
          return "fc.string()";
        case "number":
          return "fc.integer({ min: -1000, max: 1000 })";
        case "boolean":
          return "fc.boolean()";
        case "null":
          return "fc.constant(null)";
        case "undefined":
          return "fc.constant(undefined)";
        case "void":
          return "fc.constant(undefined)";
        case "bigint":
          return "fc.bigInt()";
        case "any":
          return "fc.anything()";
        case "unknown":
          return "fc.anything()";
        case "never":
          return "fc.constant(undefined as never)";
        case "symbol":
          return "fc.constant(Symbol())";
        default:
          return "fc.anything()";
      }
    }
    case "literal":
      if (typeof shape.value === "string") {
        return `fc.constant(${escapeStringLiteral(shape.value)})`;
      }
      if (typeof shape.value === "boolean") {
        return `fc.constant(${shape.value})`;
      }
      return `fc.constant(${shape.value})`;
    case "union": {
      const arbs = shape.members.map((m) => shapeToArbitrary(m, depth + 1));
      if (arbs.length === 0) return "fc.anything()";
      if (arbs.length === 1) return arbs[0]!;
      return `fc.oneof(${arbs.join(", ")})`;
    }
    case "intersection": {
      const allObjects = shape.members.every((m) => m.kind === "object");
      if (allObjects && shape.members.length > 0) {
        const merged: ShapeField[] = [];
        for (const m of shape.members) {
          if (m.kind === "object") {
            for (const f of m.fields) {
              const existing = merged.find((x) => x.name === f.name);
              if (!existing) merged.push(f);
            }
          }
        }
        return objectFieldsToRecord(merged, depth);
      }
      const first = shape.members[0];
      if (first) return shapeToArbitrary(first, depth + 1);
      return "fc.anything()";
    }
    case "array": {
      const arb = shapeToArbitrary(shape.element, depth + 1);
      return `fc.array(${arb})`;
    }
    case "object": {
      if (shape.fields.length === 0) return "fc.constant({})";
      return objectFieldsToRecord(shape.fields, depth);
    }
    case "tuple": {
      const arbs = shape.elements.map((e) => {
        const arb = shapeToArbitrary(e.type, depth + 1);
        return e.optional ? `fc.option(${arb}, { nil: undefined })` : arb;
      });
      if (arbs.length === 0) return "fc.constant([])";
      return `fc.tuple(${arbs.join(", ")})`;
    }
    case "enum": {
      if (shape.values.length === 0) return "fc.anything()";
      const args = shape.values.map((v) =>
        typeof v === "string" ? escapeStringLiteral(v) : String(v)
      );
      return `fc.constantFrom(${args.join(", ")})`;
    }
    case "record": {
      const keyArb = shapeToArbitrary(shape.key, depth + 1);
      const valueArb = shapeToArbitrary(shape.value, depth + 1);
      return `fc.dictionary(${keyArb}, ${valueArb})`;
    }
    case "map": {
      const keyArb = shapeToArbitrary(shape.key, depth + 1);
      const valueArb = shapeToArbitrary(shape.value, depth + 1);
      return `fc.array(fc.tuple(${keyArb}, ${valueArb})).map(entries => new Map(entries))`;
    }
    case "set": {
      const arb = shapeToArbitrary(shape.element, depth + 1);
      return `fc.array(${arb}).map(items => new Set(items))`;
    }
    case "date":
      return "fc.date()";
    case "regex":
      return "fc.constant(/.+/)";
    case "function":
      return "fc.constant((() => {}) as any)";
    case "promise": {
      const arb = shapeToArbitrary(shape.resolved, depth + 1);
      return `${arb}.map(v => Promise.resolve(v))`;
    }
    case "ref":
      if (shape.resolved) {
        return shapeToArbitrary(shape.resolved, depth + 1);
      }
      return "fc.anything()";
    case "opaque":
      return "fc.anything()";
    default:
      return "fc.anything()";
  }
}

function objectFieldsToRecord(fields: ShapeField[], depth: number): string {
  const entries = fields.map((f) => {
    const arb = shapeToArbitrary(f.type, depth + 1);
    const value = f.optional ? `fc.option(${arb}, { nil: undefined })` : arb;
    return `${f.name}: ${value}`;
  });
  return `fc.record({ ${entries.join(", ")} })`;
}

export function paramsToArbitrary(params: FunctionParam[]): string {
  if (params.length === 0) return "fc.constant(undefined)";
  const first = params[0];
  if (params.length === 1 && first) return shapeToArbitrary(first.type);
  const arbs = params.map((p) => shapeToArbitrary(p.type));
  return `fc.tuple(${arbs.join(", ")})`;
}

export function generateArbitraryBlock(params: FunctionParam[]): string {
  const arb = paramsToArbitrary(params);
  return `const inputArb = ${arb};`;
}
