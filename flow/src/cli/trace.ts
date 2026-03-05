#!/usr/bin/env bun
/**
 * Trace data flow through serialization, validation, and error boundaries.
 *
 * Usage:
 *   bun packages/flow/src/cli/trace.ts <src-dir> [options]
 *
 * Options:
 *   --type <name>          Trace a specific type
 *   --boundaries           List all boundaries only
 *   --full                 Full analysis (boundaries + pipelines + cascades)
 *   --format text|json     Output format (default: text)
 *   --out <file>           Write to file instead of stdout
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getArg, writeOutput } from "./util.js";
import { GraphStore, parseTypeScript } from "@devtools/graph";
import { collectSourceFiles, createProgram, extractTypeShape } from "../extractor/typescript.js";
import { createDefaultRegistry } from "../extractor/runtime-schema.js";
import { detectBoundaries } from "../flow/boundary-detector.js";
import { tracePipelines } from "../flow/pipeline-tracer.js";
import type { TracedPipeline } from "../flow/pipeline-tracer.js";
import { matchSchemasToTypes } from "../analysis/schema-matcher.js";
import { diffShapes } from "../analysis/shape-differ.js";
import type { DataBoundary } from "../schema/boundaries.js";
import type { ShapeMismatch } from "../schema/shapes.js";
import { shapeToString } from "../schema/shapes.js";

export interface TraceOptions {
  srcDir: string;
  targetType?: string;
  boundariesOnly?: boolean;
  full?: boolean;
  format?: "text" | "json";
  outFile?: string;
}

export async function runTrace(opts: TraceOptions): Promise<string> {
  const format = opts.format ?? "text";
  const targetType = opts.targetType;
  const boundariesOnly = opts.boundariesOnly ?? false;

  const resolvedDir = resolve(opts.srcDir);

  const registry = createDefaultRegistry();

  // Detect boundaries
  const boundaries = await detectBoundaries({
    srcDir: resolvedDir,
    extractorRegistry: registry,
  });

  if (boundariesOnly) {
    const output = format === "json"
      ? JSON.stringify({ boundaries }, null, 2)
      : formatBoundariesText(boundaries);
    if (opts.outFile) await writeOutput(output, opts.outFile);
    return output;
  }

  // Build graph for pipeline tracing
  const graphStore = new GraphStore();
  const files = await collectSourceFiles(resolvedDir);
  for (const filePath of files) {
    const source = await readFile(filePath, "utf-8");
    const result = parseTypeScript(source, filePath);
    for (const node of result.nodes) graphStore.addSymbol(node);
    for (const edge of result.edges) {
      try { graphStore.addEdge(edge); } catch { /* skip edges to external/missing nodes */ }
    }
  }

  // Extract schemas and match to types
  const allSchemas = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf-8");
    allSchemas.push(...registry.extractAll(source, filePath));
  }

  const program = createProgram(files);
  const checker = program.getTypeChecker();
  const schemaMatches = await matchSchemasToTypes(allSchemas, {
    srcDir: resolvedDir,
    program,
    checker,
  });

  // Diff matched schema-type pairs
  const allMismatches: ShapeMismatch[] = [];
  for (const match of schemaMatches) {
    const schemaShape = match.schema.shape;
    const schemaFields = schemaShape.kind === "object" ? schemaShape.fields : [];
    const mismatches = diffShapes(match.tsTypeShape, schemaFields, "", {
      leftLabel: "TypeScript",
      rightLabel: match.schema.library,
    });
    allMismatches.push(...mismatches);
  }

  // Trace pipelines
  const pipelines = tracePipelines({
    boundaries,
    graphStore,
    targetType,
  });

  const output = format === "json"
    ? JSON.stringify({ boundaries: boundaries.length, pipelines: pipelines.length, data: { boundaries, pipelines, schemaMatches: schemaMatches.length, mismatches: allMismatches } }, null, 2)
    : formatFullText(boundaries, pipelines, allMismatches, targetType);

  if (opts.outFile) await writeOutput(output, opts.outFile);
  return output;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const srcDir = args.find((a) => !a.startsWith("--"));

  if (!srcDir) {
    console.error("Usage: bun trace.ts <src-dir> [--type <name>] [--boundaries] [--full] [--format text|json] [--out <file>]");
    process.exit(1);
  }

  const format = (getArg(args, "--format") ?? "text") as "text" | "json";
  const outFile = getArg(args, "--out");
  const targetType = getArg(args, "--type");
  const boundariesOnly = args.includes("--boundaries");
  const full = args.includes("--full") || (!boundariesOnly && !targetType);

  const output = await runTrace({ srcDir, format, outFile, targetType, boundariesOnly, full });
  if (!outFile) console.log(output);
}

function formatBoundariesText(boundaries: DataBoundary[]): string {
  const lines: string[] = [];
  lines.push("━━━ Data Flow Boundaries ━━━");
  lines.push(`Found ${boundaries.length} boundaries`);
  lines.push("");

  const byKind = new Map<string, DataBoundary[]>();
  for (const b of boundaries) {
    if (!byKind.has(b.kind)) byKind.set(b.kind, []);
    byKind.get(b.kind)!.push(b);
  }

  for (const [kind, bounds] of byKind) {
    lines.push(`── ${kind} (${bounds.length}) ──`);
    for (const b of bounds) {
      lines.push(`  ${b.filePath}:${b.line}  ${b.functionContext}()`);
      if (b.errorHandler) {
        lines.push(`    Error handler: ${b.errorHandler.kind}, fallback: ${b.errorHandler.fallbackValue ?? "none"}, log: ${b.errorHandler.logLevel}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatFullText(
  boundaries: DataBoundary[],
  pipelines: TracedPipeline[],
  mismatches: ShapeMismatch[],
  targetType?: string,
): string {
  const lines: string[] = [];
  const title = targetType ? `Data Flow Trace: ${targetType}` : "Data Flow Trace";
  lines.push(`━━━ ${title} ━━━`);
  lines.push("");
  lines.push(`Boundaries: ${boundaries.length}`);
  lines.push(`Pipelines:  ${pipelines.length}`);
  lines.push(`Mismatches: ${mismatches.length}`);
  lines.push("");

  // Boundary summary
  const byKind = new Map<string, number>();
  for (const b of boundaries) {
    byKind.set(b.kind, (byKind.get(b.kind) ?? 0) + 1);
  }
  lines.push("Boundary breakdown:");
  for (const [kind, count] of byKind) {
    lines.push(`  ${kind}: ${count}`);
  }
  lines.push("");

  // Pipelines
  for (const pipeline of pipelines) {
    lines.push(`┌─ PIPELINE: ${pipeline.name} ─────────────────────────`);
    lines.push(`│  Segments: ${pipeline.segments.length}, Validations: ${pipeline.schemaValidations.length}, Error paths: ${pipeline.errorPaths.length}`);

    lines.push(`│`);
    lines.push(`│  ORIGIN: ${pipeline.origin.functionContext}()  ${pipeline.origin.filePath}:${pipeline.origin.line}`);
    lines.push(`│    ${pipeline.origin.kind}: ${pipeline.origin.raw.slice(0, 80)}`);

    for (const validation of pipeline.schemaValidations) {
      lines.push(`│`);
      lines.push(`│  VALIDATE: ${validation.functionContext}()  ${validation.filePath}:${validation.line}`);
      if (validation.runtimeSchema) {
        lines.push(`│    Schema: ${validation.runtimeSchema.schemaName} (${validation.runtimeSchema.library})`);
      }
      if (validation.errorHandler) {
        lines.push(`│    On failure: ${validation.errorHandler.kind}, log: ${validation.errorHandler.logLevel}`);
        if (validation.errorHandler.fallbackValue) {
          lines.push(`│    Fallback: ${validation.errorHandler.fallbackValue}`);
        }
      }
    }

    for (const assertion of pipeline.typeAssertions) {
      lines.push(`│`);
      lines.push(`│  TYPE ASSERTION: ${assertion.functionContext}()  ${assertion.filePath}:${assertion.line}`);
      lines.push(`│    ${assertion.raw.slice(0, 100)}`);
    }

    lines.push(`│`);
    lines.push(`│  TERMINUS: ${pipeline.terminus.functionContext}()  ${pipeline.terminus.filePath}:${pipeline.terminus.line}`);
    lines.push(`│    ${pipeline.terminus.kind}: ${pipeline.terminus.raw.slice(0, 80)}`);

    if (pipeline.jsonRoundtripIssues.length > 0) {
      lines.push(`│`);
      lines.push(`│  JSON ROUNDTRIP ISSUES:`);
      for (const issue of pipeline.jsonRoundtripIssues) {
        const icon = issue.severity === "error" ? "✗" : "⚠";
        lines.push(`│    ${icon} ${issue.path}: ${issue.message}`);
      }
    }

    lines.push(`└──────────────────────────────────────────────────`);
    lines.push("");
  }

  // Mismatches
  if (mismatches.length > 0) {
    lines.push("━━━ Schema-Type Mismatches ━━━");
    for (const m of mismatches) {
      const icon = m.severity === "error" ? "✗ ERROR" : "⚠ WARN ";
      lines.push(`  ${icon}  ${m.path}`);
      lines.push(`    ${m.message}`);
      lines.push(`    Category: ${m.category}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
