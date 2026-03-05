#!/usr/bin/env bun
/**
 * Find runtime schema ↔ TypeScript type mismatches.
 *
 * Usage:
 *   bun packages/flow/src/cli/schema-match.ts <src-dir> [options]
 *
 * Options:
 *   --format text|json     Output format (default: text)
 *   --out <file>           Write to file instead of stdout
 *   --library <name>       Only use this extractor (default: auto-detect)
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getArg, shortPath, writeOutput, escapeRegex } from "./util.js";
import { collectSourceFiles, createProgram, extractTypeShape } from "../extractor/typescript.js";
import { createDefaultRegistry } from "../extractor/runtime-schema.js";
import type { RuntimeSchemaInfo } from "../extractor/runtime-schema.js";
import { matchSchemasToTypes } from "../analysis/schema-matcher.js";
import { diffShapes } from "../analysis/shape-differ.js";
import type { ShapeMismatch, ShapeType } from "../schema/shapes.js";
import { shapeToString } from "../schema/shapes.js";

type EnforcementLevel = "hard-fail" | "warn" | "default-sub" | "silent-ignore";

interface EnforcementTrace {
  level: EnforcementLevel;
  detail: string;
}

interface MatchResult {
  schema: RuntimeSchemaInfo;
  typeName: string;
  typeFilePath: string;
  confidence: string;
  matchReason: string;
  mismatches: ShapeMismatch[];
  enforcement: Map<string, EnforcementTrace>;
}

export interface SchemaMatchOptions {
  srcDir: string;
  format?: "text" | "json";
  outFile?: string;
  library?: string;
}

export async function runSchemaMatch(opts: SchemaMatchOptions): Promise<string> {
  const format = opts.format ?? "text";
  const libraryFilter = opts.library;

  const registry = createDefaultRegistry();

  const resolvedDir = resolve(opts.srcDir);
  const files = await collectSourceFiles(resolvedDir);

  // Extract all runtime schemas
  const allSchemas: RuntimeSchemaInfo[] = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf-8");
    const extracted = libraryFilter
      ? registry
          .getAll()
          .filter((e) => e.library === libraryFilter)
          .flatMap((e) => (e.detect(source) ? e.extract(source, filePath) : []))
      : registry.extractAll(source, filePath);
    allSchemas.push(...extracted);
  }

  if (allSchemas.length === 0) {
    const output = format === "json"
      ? JSON.stringify({ schemas: 0, matches: 0, mismatches: 0, results: [] }, null, 2)
      : "No runtime schemas found.";
    if (opts.outFile) await writeOutput(output, opts.outFile);
    return output;
  }

  // Resolve cross-references between schemas (e.g. metricsSchema used inside responseSchema)
  resolveSchemaRefs(allSchemas);

  // Match schemas to types
  const program = createProgram(files);
  const checker = program.getTypeChecker();
  const matches = await matchSchemasToTypes(allSchemas, {
    srcDir: resolvedDir,
    program,
    checker,
  });

  // Diff each match and trace enforcement
  const results: MatchResult[] = [];
  for (const match of matches) {
    const schemaShape = match.schema.shape;
    const schemaFields = schemaShape.kind === "object" ? schemaShape.fields : [];
    const mismatches = diffShapes(match.tsTypeShape, schemaFields, "", {
      leftLabel: "TypeScript",
      rightLabel: match.schema.library,
    });

    const enforcement = new Map<string, EnforcementTrace>();
    for (const m of mismatches) {
      enforcement.set(m.path, await traceEnforcement(m.path, files));
    }

    results.push({
      schema: match.schema,
      typeName: match.typeName,
      typeFilePath: match.typeFilePath,
      confidence: match.confidence,
      matchReason: match.matchReason,
      mismatches,
      enforcement,
    });
  }

  const output = format === "json"
    ? formatJson(allSchemas, results)
    : formatText(allSchemas, results);

  if (opts.outFile) await writeOutput(output, opts.outFile);
  return output;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const srcDir = args.find((a) => !a.startsWith("--"));

  if (!srcDir) {
    console.error("Usage: bun schema-match.ts <src-dir> [--format text|json] [--out <file>]");
    process.exit(1);
  }

  const format = (getArg(args, "--format") ?? "text") as "text" | "json";
  const outFile = getArg(args, "--out");
  const library = getArg(args, "--library");

  const output = await runSchemaMatch({ srcDir, format, outFile, library });
  if (!outFile) console.log(output);
}

function formatText(
  allSchemas: RuntimeSchemaInfo[],
  results: MatchResult[],
): string {
  const lines: string[] = [];

  const totalErrors = results.reduce(
    (n, r) => n + r.mismatches.filter((m) => m.severity === "error").length,
    0,
  );
  const totalWarnings = results.reduce(
    (n, r) => n + r.mismatches.filter((m) => m.severity === "warning").length,
    0,
  );
  const totalGaps = results.reduce(
    (n, r) => {
      for (const e of r.enforcement.values()) {
        if (e.level === "silent-ignore") n++;
      }
      return n;
    },
    0,
  );

  lines.push(
    `## Schema-Type Analysis (${allSchemas.length} schemas, ${results.length} matched, ${totalErrors} errors, ${totalWarnings} warnings)`,
  );

  for (const r of results) {
    lines.push(
      `${r.schema.name}(${shortPath(r.schema.filePath)}:${r.schema.line}) ↔ ${r.typeName}(${shortPath(r.typeFilePath)})`,
    );
    if (r.mismatches.length === 0) {
      lines.push("  ✓ no mismatches");
    } else {
      for (const m of r.mismatches) {
        const tag = m.severity === "error" ? "ERR" : "WARN";
        const trace = r.enforcement.get(m.path);
        const enforce = trace ? `  enforce=${trace.level}(${trace.detail})` : "";
        const gap = trace?.level === "silent-ignore" ? " ⚠" : "";
        lines.push(`  ${tag} ${m.path}: ${m.message}${enforce}${gap}`);
      }
    }
  }

  const unmatched = allSchemas.filter(
    (s) => !results.some((r) => r.schema.name === s.name),
  );
  if (unmatched.length > 0) {
    lines.push(
      `Unmatched: ${unmatched.map((s) => `${s.name}(${shortPath(s.filePath)}:${s.line})`).join(", ")}`,
    );
  }

  lines.push(
    `Summary: ${allSchemas.length} schemas, ${results.length} matched, ${totalErrors} errors, ${totalWarnings} warnings, ${totalGaps} enforcement-gaps`,
  );

  return lines.join("\n");
}

function formatJson(
  allSchemas: RuntimeSchemaInfo[],
  results: MatchResult[],
): string {
  const enforcementGaps = results.reduce((n, r) => {
    for (const e of r.enforcement.values()) {
      if (e.level === "silent-ignore") n++;
    }
    return n;
  }, 0);

  return JSON.stringify(
    {
      schemas: allSchemas.length,
      matches: results.length,
      mismatches: results.reduce((n, r) => n + r.mismatches.length, 0),
      enforcementGaps,
      results: results.map((r) => ({
        schema: r.schema.name,
        library: r.schema.library,
        schemaFile: r.schema.filePath,
        schemaLine: r.schema.line,
        typeName: r.typeName,
        typeFile: r.typeFilePath,
        confidence: r.confidence,
        matchReason: r.matchReason,
        mismatches: r.mismatches.map((m) => {
          const trace = r.enforcement.get(m.path);
          return {
            ...m,
            enforcement: trace ?? null,
          };
        }),
      })),
      unmatched: allSchemas
        .filter((s) => !results.some((r) => r.schema.name === s.name))
        .map((s) => ({ name: s.name, library: s.library, file: s.filePath, line: s.line })),
    },
    null,
    2,
  );
}

function resolveSchemaRefs(schemas: RuntimeSchemaInfo[]): void {
  const byName = new Map(schemas.map((s) => [s.name, s]));

  function resolve(shape: ShapeType): ShapeType {
    if (shape.kind === "ref" && !shape.resolved) {
      const target = byName.get(shape.name);
      if (target) return resolve(target.shape);
    }
    if (shape.kind === "object") {
      return {
        ...shape,
        fields: shape.fields.map((f) => ({ ...f, type: resolve(f.type) })),
      };
    }
    if (shape.kind === "array") {
      return { ...shape, element: resolve(shape.element) };
    }
    if (shape.kind === "union") {
      return { ...shape, members: shape.members.map(resolve) };
    }
    if (shape.kind === "record") {
      return { ...shape, key: resolve(shape.key), value: resolve(shape.value) };
    }
    return shape;
  }

  for (const schema of schemas) {
    schema.shape = resolve(schema.shape);
  }
}

const SKIP_PATTERN = /\.(test|spec)\.[tj]sx?$|\.md$|\.d\.ts$|prompts?\//;

async function traceEnforcement(
  fieldName: string,
  files: string[],
): Promise<EnforcementTrace> {
  const leaf = fieldName.includes(".") ? fieldName.split(".").pop()! : fieldName;
  const fieldRe = new RegExp(`\\b${escapeRegex(leaf)}\\b`);

  for (const filePath of files) {
    if (SKIP_PATTERN.test(filePath)) continue;
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!fieldRe.test(line)) continue;
      if (/^\s*(export\s+)?(interface|type)\s/.test(line)) continue;
      if (/^\s*import\s/.test(line)) continue;

      const window = lines
        .slice(Math.max(0, i - 1), Math.min(lines.length, i + 4))
        .join("\n");

      if (/throw\b|reject\(|return\s+.*\berr(or)?\b/i.test(window)) {
        const snippet = window.match(/(throw\b.*|reject\(.*|return\s+.*\berr(or)?\b.*)/i);
        return { level: "hard-fail", detail: snippet?.[1]?.trim().slice(0, 60) ?? "throw/reject" };
      }
      if (/\b(logger|console)\.(warn|error)\b/.test(window)) {
        const snippet = window.match(/\b(logger|console)\.(warn|error)\b/);
        return { level: "warn", detail: snippet?.[0] ?? "warn" };
      }
      if (/\?\?\s|\.default\(/.test(window)) {
        const snippet = window.match(/(\?\?\s*\S+|\.default\([^)]*\))/);
        return { level: "default-sub", detail: snippet?.[1]?.trim().slice(0, 40) ?? "?? default" };
      }
    }
  }

  return { level: "silent-ignore", detail: "no checks found" };
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
