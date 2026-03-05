import type {
  ShapeType,
  ShapeField,
  ShapeMismatch,
  MismatchCategory,
} from "../schema/shapes.js";
import { shapeToString } from "../schema/shapes.js";

export interface DiffOptions {
  /** Check JSON-roundtrip compatibility alongside structural diff. */
  jsonRoundtrip?: boolean;
  /** Label for the left side in messages (default: "expected"). */
  leftLabel?: string;
  /** Label for the right side in messages (default: "actual"). */
  rightLabel?: string;
}

const defaults: Required<DiffOptions> = {
  jsonRoundtrip: false,
  leftLabel: "expected",
  rightLabel: "actual",
};

export function diffShapes(
  left: ShapeField[],
  right: ShapeField[],
  path: string = "",
  options?: DiffOptions,
): ShapeMismatch[] {
  const opts = { ...defaults, ...options };
  const mismatches: ShapeMismatch[] = [];

  const leftMap = new Map(left.map((f) => [f.name, f]));
  const rightMap = new Map(right.map((f) => [f.name, f]));

  for (const [name, leftField] of leftMap) {
    const fieldPath = path ? `${path}.${name}` : name;

    if (!rightMap.has(name)) {
      mismatches.push({
        path: fieldPath,
        expected: leftField.type,
        actual: { kind: "primitive", value: "undefined" },
        severity: leftField.optional ? "warning" : "error",
        message: `Field "${name}" exists in ${opts.leftLabel} but not in ${opts.rightLabel}`,
        category: "missing-field",
      });
      continue;
    }

    const rightField = rightMap.get(name)!;

    if (leftField.optional !== rightField.optional) {
      mismatches.push({
        path: fieldPath,
        expected: leftField.type,
        actual: rightField.type,
        severity: "warning",
        message: `Optionality mismatch: ${opts.leftLabel} says ${leftField.optional ? "optional" : "required"}, ${opts.rightLabel} says ${rightField.optional ? "optional" : "required"}`,
        category: "optionality",
      });
    }

    mismatches.push(...diffTypes(leftField.type, rightField.type, fieldPath, opts));
  }

  for (const [name, rightField] of rightMap) {
    if (!leftMap.has(name)) {
      const fieldPath = path ? `${path}.${name}` : name;
      mismatches.push({
        path: fieldPath,
        expected: { kind: "primitive", value: "undefined" },
        actual: rightField.type,
        severity: "warning",
        message: `Field "${name}" in ${opts.rightLabel} but not in ${opts.leftLabel}`,
        category: "extra-field",
      });
    }
  }

  return mismatches;
}

export function diffTypes(
  left: ShapeType,
  right: ShapeType,
  path: string,
  options?: DiffOptions,
): ShapeMismatch[] {
  const opts = { ...defaults, ...options };
  const mismatches: ShapeMismatch[] = [];

  if (isOpaqueOrAny(left) || isOpaqueOrAny(right)) return mismatches;

  if (left.kind === right.kind) {
    return diffSameKind(left, right, path, opts);
  }

  // Ref with resolved inner type — unwrap and retry
  if (left.kind === "ref" && left.resolved) {
    return diffTypes(left.resolved, right, path, opts);
  }
  if (right.kind === "ref" && right.resolved) {
    return diffTypes(left, right.resolved, path, opts);
  }

  // Enum ↔ union of literals — structurally equivalent
  if (left.kind === "union" && right.kind === "enum") {
    const leftValues = left.members
      .filter((m): m is Extract<ShapeType, { kind: "literal" }> => m.kind === "literal")
      .map((m) => m.value);
    if (leftValues.length === left.members.length) {
      const rightSet = new Set(right.values.map(String));
      const allCovered = leftValues.every((v) => rightSet.has(String(v)));
      const reverseOk = right.values.every((v) => leftValues.some((lv) => String(lv) === String(v)));
      if (allCovered && reverseOk) return mismatches;
    }
  }
  if (left.kind === "enum" && right.kind === "union") {
    return diffTypes(right, left, path, { ...opts, leftLabel: opts.rightLabel, rightLabel: opts.leftLabel });
  }

  // Union on one side — check if the other side is a member
  if (left.kind === "union") {
    const covered = left.members.some(
      (m) => diffTypes(m, right, path, opts).length === 0,
    );
    if (covered) return mismatches;
  }
  if (right.kind === "union") {
    const covered = right.members.some(
      (m) => diffTypes(left, m, path, opts).length === 0,
    );
    if (covered) return mismatches;
  }

  mismatches.push({
    path,
    expected: left,
    actual: right,
    severity: "error",
    message: `Shape mismatch: ${opts.leftLabel} has ${left.kind} (${shapeToString(left)}), ${opts.rightLabel} has ${right.kind} (${shapeToString(right)})`,
    category: "type-mismatch",
  });

  return mismatches;
}

function diffSameKind(
  left: ShapeType,
  right: ShapeType,
  path: string,
  opts: Required<DiffOptions>,
): ShapeMismatch[] {
  const mismatches: ShapeMismatch[] = [];

  switch (left.kind) {
    case "primitive": {
      const r = right as Extract<ShapeType, { kind: "primitive" }>;
      if (left.value !== r.value) {
        mismatches.push({
          path,
          expected: left,
          actual: right,
          severity: "error",
          message: `Primitive mismatch: ${opts.leftLabel} is ${left.value}, ${opts.rightLabel} is ${r.value}`,
          category: "type-mismatch",
        });
      }
      break;
    }

    case "literal": {
      const r = right as Extract<ShapeType, { kind: "literal" }>;
      if (left.value !== r.value) {
        mismatches.push({
          path,
          expected: left,
          actual: right,
          severity: "error",
          message: `Literal mismatch: ${opts.leftLabel} is ${JSON.stringify(left.value)}, ${opts.rightLabel} is ${JSON.stringify(r.value)}`,
          category: "type-mismatch",
        });
      }
      break;
    }

    case "array": {
      const r = right as Extract<ShapeType, { kind: "array" }>;
      mismatches.push(...diffTypes(left.element, r.element, `${path}[]`, opts));
      break;
    }

    case "object": {
      const r = right as Extract<ShapeType, { kind: "object" }>;
      mismatches.push(...diffShapes(left.fields, r.fields, path, opts));
      break;
    }

    case "union": {
      const r = right as Extract<ShapeType, { kind: "union" }>;
      for (const leftMember of left.members) {
        const hasMatch = r.members.some(
          (rm) => diffTypes(leftMember, rm, path, opts).length === 0,
        );
        if (!hasMatch) {
          mismatches.push({
            path,
            expected: leftMember,
            actual: right,
            severity: "error",
            message: `Union member ${shapeToString(leftMember)} in ${opts.leftLabel} not covered by ${opts.rightLabel}`,
            category: "union-coverage",
          });
        }
      }
      break;
    }

    case "tuple": {
      const r = right as Extract<ShapeType, { kind: "tuple" }>;
      const maxLen = Math.max(left.elements.length, r.elements.length);
      for (let i = 0; i < maxLen; i++) {
        const le = left.elements[i];
        const re = r.elements[i];
        if (!le) {
          mismatches.push({
            path: `${path}[${i}]`,
            expected: { kind: "primitive", value: "undefined" },
            actual: re!.type,
            severity: "warning",
            message: `Tuple element [${i}] exists in ${opts.rightLabel} but not in ${opts.leftLabel}`,
            category: "extra-field",
          });
        } else if (!re) {
          mismatches.push({
            path: `${path}[${i}]`,
            expected: le.type,
            actual: { kind: "primitive", value: "undefined" },
            severity: le.optional ? "warning" : "error",
            message: `Tuple element [${i}] exists in ${opts.leftLabel} but not in ${opts.rightLabel}`,
            category: "missing-field",
          });
        } else {
          mismatches.push(...diffTypes(le.type, re.type, `${path}[${i}]`, opts));
        }
      }
      break;
    }

    case "record": {
      const r = right as Extract<ShapeType, { kind: "record" }>;
      mismatches.push(...diffTypes(left.key, r.key, `${path}.<key>`, opts));
      mismatches.push(...diffTypes(left.value, r.value, `${path}.<value>`, opts));
      break;
    }

    case "map": {
      const r = right as Extract<ShapeType, { kind: "map" }>;
      mismatches.push(...diffTypes(left.key, r.key, `${path}.<key>`, opts));
      mismatches.push(...diffTypes(left.value, r.value, `${path}.<value>`, opts));
      break;
    }

    case "set": {
      const r = right as Extract<ShapeType, { kind: "set" }>;
      mismatches.push(...diffTypes(left.element, r.element, `${path}.<element>`, opts));
      break;
    }

    case "function": {
      const r = right as Extract<ShapeType, { kind: "function" }>;
      mismatches.push(
        ...diffTypes(left.returnType, r.returnType, `${path}.<return>`, opts),
      );
      break;
    }

    case "promise": {
      const r = right as Extract<ShapeType, { kind: "promise" }>;
      mismatches.push(
        ...diffTypes(left.resolved, r.resolved, `${path}.<resolved>`, opts),
      );
      break;
    }

    case "enum": {
      const r = right as Extract<ShapeType, { kind: "enum" }>;
      const leftSet = new Set(left.values.map(String));
      const rightSet = new Set(r.values.map(String));
      for (const v of leftSet) {
        if (!rightSet.has(v)) {
          mismatches.push({
            path,
            expected: left,
            actual: right,
            severity: "error",
            message: `Enum value "${v}" in ${opts.leftLabel} not present in ${opts.rightLabel}`,
            category: "union-coverage",
          });
        }
      }
      break;
    }

    case "intersection": {
      const r = right as Extract<ShapeType, { kind: "intersection" }>;
      if (left.members.length !== r.members.length) {
        mismatches.push({
          path,
          expected: left,
          actual: right,
          severity: "warning",
          message: `Intersection member count differs: ${left.members.length} vs ${r.members.length}`,
          category: "type-mismatch",
        });
      }
      break;
    }

    case "ref": {
      const r = right as Extract<ShapeType, { kind: "ref" }>;
      if (left.resolved && r.resolved) {
        mismatches.push(...diffTypes(left.resolved, r.resolved, path, opts));
      } else if (left.name !== r.name) {
        mismatches.push({
          path,
          expected: left,
          actual: right,
          severity: "warning",
          message: `Different type references: ${opts.leftLabel} refs "${left.name}", ${opts.rightLabel} refs "${r.name}"`,
          category: "type-mismatch",
        });
      }
      break;
    }
  }

  return mismatches;
}

function isOpaqueOrAny(shape: ShapeType): boolean {
  if (shape.kind === "opaque") return true;
  if (
    shape.kind === "primitive" &&
    (shape.value === "any" || shape.value === "unknown")
  ) {
    return true;
  }
  return false;
}
