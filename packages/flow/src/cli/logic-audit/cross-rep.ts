// ── 1. Cross-representation scan (schema vs type) ──────────────────

import { readFile } from "node:fs/promises";
import { createProgram } from "../../extractor/typescript.js";
import { ExtractorRegistry } from "../../extractor/runtime-schema.js";
import type { RuntimeSchemaInfo } from "../../extractor/runtime-schema.js";
import { ZodExtractor } from "../../extractor/zod.js";
import { matchSchemasToTypes } from "../../analysis/schema-matcher.js";
import { diffShapes } from "../../analysis/shape-differ.js";
import type { ShapeType, ShapeField } from "../../schema/shapes.js";
import type { CrossRepField, CrossRepMismatch } from "./types.js";

function resolveRefs(
  shape: ShapeType,
  byName: Map<string, RuntimeSchemaInfo>,
  seen: Set<string> = new Set(),
): ShapeType {
  if (shape.kind === "ref" && !shape.resolved) {
    if (seen.has(shape.name)) return shape;
    seen.add(shape.name);
    const target = byName.get(shape.name);
    if (target) return resolveRefs(target.shape, byName, seen);
  }
  if (shape.kind === "object") {
    return { ...shape, fields: shape.fields.map((f) => ({ ...f, type: resolveRefs(f.type, byName, seen) })) };
  }
  if (shape.kind === "array") return { ...shape, element: resolveRefs(shape.element, byName, seen) };
  if (shape.kind === "union") return { ...shape, members: shape.members.map((m) => resolveRefs(m, byName, seen)) };
  return shape;
}

export async function crossRepScan(
  files: string[],
  resolvedDir: string,
): Promise<CrossRepMismatch[]> {
  const registry = new ExtractorRegistry();
  registry.register(new ZodExtractor());

  const allSchemas: RuntimeSchemaInfo[] = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf-8");
    allSchemas.push(...registry.extractAll(source, filePath));
  }

  if (allSchemas.length === 0) return [];

  // Resolve inter-schema refs
  const byName = new Map(allSchemas.map((s) => [s.name, s]));
  for (const schema of allSchemas) {
    schema.shape = resolveRefs(schema.shape, byName);
  }

  const program = createProgram(files);
  const checker = program.getTypeChecker();
  const matches = await matchSchemasToTypes(allSchemas, { srcDir: resolvedDir, program, checker });

  const mismatches: CrossRepMismatch[] = [];

  for (const match of matches) {
    const schemaFields = match.schema.shape.kind === "object" ? match.schema.shape.fields : null;
    const typeFields: ShapeField[] | null =
      match.tsTypeShape.length > 0 ? match.tsTypeShape : null;

    if (!schemaFields || !typeFields) continue;

    // Delegate structural diffing to the shape-differ module
    const shapeMismatches = diffShapes(schemaFields, typeFields, "", {
      leftLabel: `schema "${match.schema.name}"`,
      rightLabel: `type "${match.typeName}"`,
    });

    for (const sm of shapeMismatches) {
      // Map shape-differ categories to CrossRepMismatch format
      const fieldName = sm.path.split(".")[0] ?? sm.path;
      const schemaField = schemaFields.find((f) => f.name === fieldName);
      const typeField = typeFields.find((f) => f.name === fieldName);

      const field: CrossRepField = {
        fieldName,
        schemaOptional: schemaField?.optional ?? false,
        typeOptional: typeField?.optional ?? true,
      };

      let mismatchKind: string;
      switch (sm.category) {
        case "optionality":
          mismatchKind = "schema-type-optionality";
          break;
        case "missing-field":
          mismatchKind = "schema-type-missing-field";
          break;
        case "extra-field":
          mismatchKind = "schema-type-extra-field";
          break;
        case "type-mismatch":
          mismatchKind = "schema-type-mismatch";
          break;
        case "union-coverage":
          mismatchKind = "schema-type-union-coverage";
          break;
        default:
          mismatchKind = `schema-type-${sm.category}`;
      }

      mismatches.push({
        schemaName: match.schema.name,
        typeName: match.typeName,
        field,
        mismatchKind,
        message: sm.message,
      });
    }
  }

  return mismatches;
}
