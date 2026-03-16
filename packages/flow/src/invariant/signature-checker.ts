import type { ShapeType } from "../schema/shapes.js";
import { shapeToString } from "../schema/shapes.js";
import { diffTypes } from "../analysis/shape-differ.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SignatureInconsistency {
  functionName: string;
  locations: Array<{
    filePath: string;
    line: number;
    paramSignature: string; // "(name: string, age: number)"
    returnSignature: string; // "→ User"
  }>;
  kind: "different-params" | "different-return" | "different-both";
}

interface CrossBoundaryMismatch {
  producer: { name: string; filePath: string; line: number; returnType: string };
  consumer: {
    name: string;
    filePath: string;
    line: number;
    paramType: string;
    paramName: string;
  };
  issue: string; // human-readable description
}

export interface SignatureAnalysis {
  inconsistencies: SignatureInconsistency[];
  crossBoundary: CrossBoundaryMismatch[];
}

// ---------------------------------------------------------------------------
// Input shape (subset of DiscoveredFunction)
// ---------------------------------------------------------------------------

interface FunctionInput {
  name: string;
  filePath: string;
  line: number;
  exportKind: string;
  params: Array<{ name: string; type: ShapeType; optional: boolean }>;
  returnType: ShapeType;
  signatureHash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatParamSignature(
  params: Array<{ name: string; type: ShapeType; optional: boolean }>,
): string {
  const parts = params.map(
    (p) =>
      `${p.name}${p.optional ? "?" : ""}: ${shapeToString(p.type)}`,
  );
  return `(${parts.join(", ")})`;
}

function formatReturnSignature(returnType: ShapeType): string {
  return `→ ${shapeToString(returnType)}`;
}

/** Build a param-only hash by joining param type strings. */
function paramHash(
  params: Array<{ name: string; type: ShapeType; optional: boolean }>,
): string {
  return params
    .map((p) => `${p.name}:${p.optional ? "?" : ""}${shapeToString(p.type)}`)
    .join(",");
}

/** Build a return-only hash from the return type string. */
function returnHash(returnType: ShapeType): string {
  return shapeToString(returnType);
}

/**
 * Extract the top-level type name from a ShapeType.
 * Returns the ref name for refs, or null for non-named types.
 */
function extractTypeName(shape: ShapeType): string | null {
  if (shape.kind === "ref") return shape.name;
  if (shape.kind === "promise" && shape.resolved.kind === "ref") {
    return shape.resolved.name;
  }
  if (shape.kind === "array" && shape.element.kind === "ref") {
    return shape.element.name;
  }
  return null;
}

/**
 * Unwrap a ShapeType to its "core" structural type for comparison.
 * Strips promise wrappers and array wrappers, then resolves refs.
 */
function resolveForComparison(shape: ShapeType): ShapeType {
  if (shape.kind === "promise") return resolveForComparison(shape.resolved);
  if (shape.kind === "ref" && shape.resolved) return shape.resolved;
  return shape;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

export function checkSignatures(functions: FunctionInput[]): SignatureAnalysis {
  const inconsistencies = findInconsistencies(functions);
  const crossBoundary = findCrossBoundaryMismatches(functions);
  return { inconsistencies, crossBoundary };
}

// ---------------------------------------------------------------------------
// Inconsistency detection
// ---------------------------------------------------------------------------

function findInconsistencies(
  functions: FunctionInput[],
): SignatureInconsistency[] {
  // Group by function name
  const byName = new Map<string, FunctionInput[]>();
  for (const fn of functions) {
    const group = byName.get(fn.name);
    if (group) {
      group.push(fn);
    } else {
      byName.set(fn.name, [fn]);
    }
  }

  const results: SignatureInconsistency[] = [];

  for (const [name, group] of byName) {
    // Only interested in same-name functions across different files
    const uniqueFiles = new Set(group.map((f) => f.filePath));
    if (uniqueFiles.size < 2) continue;

    // Deduplicate to one entry per file (keep first occurrence)
    const perFile = new Map<string, FunctionInput>();
    for (const fn of group) {
      if (!perFile.has(fn.filePath)) {
        perFile.set(fn.filePath, fn);
      }
    }
    const entries = [...perFile.values()];

    // Only report when at least 2 functions are exported (public API collision).
    // Private helpers with generic names (parseField, ensureEntry) that happen
    // to share a name across modules are coincidental, not architectural issues.
    const exportedCount = entries.filter((e) => e.exportKind !== "internal").length;
    if (exportedCount < 2) continue;

    // Check if all hashes match
    const hashes = new Set(entries.map((e) => e.signatureHash));
    if (hashes.size <= 1) continue;

    // Classify the difference
    const paramHashes = new Set(entries.map((e) => paramHash(e.params)));
    const returnHashes = new Set(entries.map((e) => returnHash(e.returnType)));
    const paramsDiffer = paramHashes.size > 1;
    const returnDiffers = returnHashes.size > 1;

    const kind: SignatureInconsistency["kind"] =
      paramsDiffer && returnDiffers
        ? "different-both"
        : paramsDiffer
          ? "different-params"
          : "different-return";

    results.push({
      functionName: name,
      locations: entries.map((fn) => ({
        filePath: fn.filePath,
        line: fn.line,
        paramSignature: formatParamSignature(fn.params),
        returnSignature: formatReturnSignature(fn.returnType),
      })),
      kind,
    });
  }

  // Sort by function name for stable output
  results.sort((a, b) => a.functionName.localeCompare(b.functionName));
  return results;
}

// ---------------------------------------------------------------------------
// Cross-boundary type drift detection
// ---------------------------------------------------------------------------

function findCrossBoundaryMismatches(
  functions: FunctionInput[],
): CrossBoundaryMismatch[] {
  // Map: type name → producers (functions that return this type)
  const producers = new Map<
    string,
    Array<{ fn: FunctionInput; shape: ShapeType }>
  >();
  // Map: type name → consumers (functions that take this type as a param)
  const consumers = new Map<
    string,
    Array<{ fn: FunctionInput; paramName: string; shape: ShapeType }>
  >();

  for (const fn of functions) {
    // Register return type
    const retName = extractTypeName(fn.returnType);
    if (retName) {
      const list = producers.get(retName);
      const entry = { fn, shape: fn.returnType };
      if (list) {
        list.push(entry);
      } else {
        producers.set(retName, [entry]);
      }
    }

    // Register param types
    for (const param of fn.params) {
      const paramTypeName = extractTypeName(param.type);
      if (paramTypeName) {
        const list = consumers.get(paramTypeName);
        const entry = { fn, paramName: param.name, shape: param.type };
        if (list) {
          list.push(entry);
        } else {
          consumers.set(paramTypeName, [entry]);
        }
      }
    }
  }

  const results: CrossBoundaryMismatch[] = [];

  for (const [typeName, producerList] of producers) {
    const consumerList = consumers.get(typeName);
    if (!consumerList) continue;

    for (const producer of producerList) {
      for (const consumer of consumerList) {
        // Skip same-file matches — we care about cross-boundary drift
        if (producer.fn.filePath === consumer.fn.filePath) continue;

        const producerResolved = resolveForComparison(producer.shape);
        const consumerResolved = resolveForComparison(consumer.shape);

        // Compare structurally using diffTypes
        const mismatches = diffTypes(
          producerResolved,
          consumerResolved,
          typeName,
          {
            leftLabel: "producer",
            rightLabel: "consumer",
          },
        );

        if (mismatches.length === 0) continue;

        // Build a human-readable issue description
        const issueLines = mismatches.slice(0, 3).map((m) => m.message);
        if (mismatches.length > 3) {
          issueLines.push(`...and ${mismatches.length - 3} more difference(s)`);
        }

        results.push({
          producer: {
            name: producer.fn.name,
            filePath: producer.fn.filePath,
            line: producer.fn.line,
            returnType: shapeToString(producer.shape),
          },
          consumer: {
            name: consumer.fn.name,
            filePath: consumer.fn.filePath,
            line: consumer.fn.line,
            paramType: shapeToString(consumer.shape),
            paramName: consumer.paramName,
          },
          issue: issueLines.join("; "),
        });
      }
    }
  }

  // Sort for stable output
  results.sort((a, b) => {
    const cmp = a.producer.name.localeCompare(b.producer.name);
    if (cmp !== 0) return cmp;
    return a.consumer.name.localeCompare(b.consumer.name);
  });

  return results;
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

export function formatSignatureAnalysis(analysis: SignatureAnalysis): string {
  const lines: string[] = [];

  // Inconsistencies
  lines.push(
    `## Signature Inconsistencies (${analysis.inconsistencies.length})`,
  );
  if (analysis.inconsistencies.length === 0) {
    lines.push("  No inconsistencies found.");
  } else {
    for (const inc of analysis.inconsistencies) {
      lines.push(
        `  ${inc.functionName} defined in ${inc.locations.length} files with ${inc.kind === "different-params" ? "different params" : inc.kind === "different-return" ? "different return types" : "different params and return types"}:`,
      );
      for (const loc of inc.locations) {
        lines.push(
          `    ${loc.filePath}:${loc.line}   ${loc.paramSignature} ${loc.returnSignature}`,
        );
      }
    }
  }

  lines.push("");

  // Cross-boundary
  lines.push(
    `## Cross-Boundary Type Drift (${analysis.crossBoundary.length})`,
  );
  if (analysis.crossBoundary.length === 0) {
    lines.push("  No cross-boundary type drift found.");
  } else {
    for (const cb of analysis.crossBoundary) {
      lines.push(
        `  ${cb.producer.name} (${cb.producer.filePath}:${cb.producer.line}) returns ${cb.producer.returnType}`,
      );
      lines.push(
        `  ${cb.consumer.name} (${cb.consumer.filePath}:${cb.consumer.line}) takes param ${cb.consumer.paramName}: ${cb.consumer.paramType}`,
      );
      lines.push(`    → ${cb.issue}`);
    }
  }

  return lines.join("\n");
}
