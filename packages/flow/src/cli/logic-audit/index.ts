#!/usr/bin/env bun
/**
 * Logic audit CLI — mechanically detect decision-logic bugs.
 *
 * Runs three targeted analyses:
 *   1. Cross-representation: Zod schema vs TS type field-level comparison
 *   2. Guard consistency: parallel collection pushes with mismatched guards
 *   3. Decision tables: status-determining functions with suspicious gaps
 *
 * Usage:
 *   bun packages/flow/src/cli/logic-audit/index.ts <src-dir> [--format text|json] [--out <file>]
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { collectSourceFiles, createProgram } from "../../extractor/typescript.js";
import { getArg, shortPath } from "../util.js";
import { crossRepScan } from "./cross-rep.js";
import { scanGuardConsistency, scanBroadGuardConsistency } from "./guards.js";
import { scanStatusFunctions } from "./status.js";
import { scanDecisionTables } from "./decisions.js";
import { scanExhaustivenessGaps } from "./exhaustiveness.js";
import type { LogicAuditOptions, LogicAuditResult, GuardInconsistency } from "./types.js";

export type { LogicAuditOptions } from "./types.js";

// ── formatting ──────────────────────────────────────────────────────

export function formatText(result: LogicAuditResult, resolvedDir: string, minConfidence: "high" | "med" | "low"): string {
  const o: string[] = [];
  const sp = (p: string) => shortPath(p, resolvedDir);

  // Cross-representation — 1 line per mismatch
  o.push(`## Cross-Rep Mismatches (${result.crossRep.length})`);
  for (const m of result.crossRep) {
    const s = m.field.schemaOptional ? "opt" : "req";
    const t = m.field.typeOptional ? "opt" : "req";
    o.push(`[${m.mismatchKind}] ${m.schemaName}.${m.field.fieldName} schema=${s} type=${t}`);
  }

  // Decision tables — compact rows
  const suspectCount = result.decisionTables.reduce((n, t) => n + t.suspiciousCells.length, 0);
  o.push(`## Decision Tables (${result.decisionTables.length} fn, ${suspectCount} suspect)`);
  for (const dt of result.decisionTables) {
    o.push(`${dt.functionName} ${sp(dt.filePath)}:${dt.line}`);
    if (dt.signals.length > 0) o.push(`  signals: ${dt.signals.join(",")}`);
    for (const [name, def] of Object.entries(dt.definitions)) {
      o.push(`  ${name} = ${def}`);
    }
    for (const row of dt.rows) {
      const conds = Object.entries(row.conditions)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      const suspects = dt.suspiciousCells.filter(s => s.line === row.line);
      if (suspects.length > 0) {
        o.push(`  ${conds || "(default)"} → ${row.outcome}`);
        for (const s of suspects) {
          o.push(`    ⚠ ${s.reason}`);
          if (s.gapScenario) o.push(`      → ${s.gapScenario}`);
          if (s.reachabilityNote) o.push(`      → ${s.reachabilityNote}`);
          if (s.contrastNote) o.push(`      → ${s.contrastNote}`);
          if (s.verdictNote) o.push(`      → ${s.verdictNote}`);
        }
      } else {
        o.push(`  ${conds || "(default)"} → ${row.outcome}`);
      }
    }
  }

  // Guard consistency — sorted by confidence, filtered
  const confOrder = { high: 0, med: 1, low: 2 };
  const confThreshold = confOrder[minConfidence];
  const filtered = result.guards.filter(g => confOrder[g.confidence] <= confThreshold);
  const highCount = result.guards.filter(g => g.confidence === "high").length;
  o.push(`## Guard Consistency (${filtered.length} warnings, ${highCount} high)`);
  const sorted = [...filtered].sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence]);
  for (const g of sorted) {
    const marker = g.confidence === "high" ? "⚠high" : ` ${g.confidence} `;
    o.push(`${marker} ${sp(g.filePath)}:${g.line} loop(${g.loopVariable}) ${g.unguardedPush.collection}.push unguarded, ${g.guardedPush.collection}.push guarded(${g.guardedPush.guard})`);
  }

  // Broad guard consistency
  const broadFiltered = result.broadGuards.filter(g => confOrder[g.confidence] <= confThreshold);
  const broadHighCount = result.broadGuards.filter(g => g.confidence === "high").length;
  o.push(`## Broad Guard Consistency (${broadFiltered.length} warnings, ${broadHighCount} high)`);
  const broadSorted = [...broadFiltered].sort((a, b) => confOrder[a.confidence] - confOrder[b.confidence]);
  for (const g of broadSorted) {
    const marker = g.confidence === "high" ? "⚠high" : ` ${g.confidence} `;
    o.push(`${marker} ${sp(g.filePath)}:${g.line} ${g.message}`);
  }

  // Exhaustiveness gaps
  o.push(`## Exhaustiveness Gaps (${result.exhaustivenessGaps.length})`);
  for (const gap of result.exhaustivenessGaps) {
    o.push(`${sp(gap.filePath)}:${gap.line} switch(${gap.switchExpression}) missing: ${gap.missingMembers.join(", ")} (handled ${gap.handledMembers.length}/${gap.knownMembers.length})`);
  }

  // Status functions — 1 line each, return type truncated
  o.push(`## Status Functions (${result.statusFunctions.length})`);
  for (const fn of result.statusFunctions) {
    const ret = fn.returnType.length > 80 ? fn.returnType.slice(0, 77) + "..." : fn.returnType;
    o.push(`${fn.name} ${fn.filePath}:${fn.line} branches=${fn.branchCount} lines=${fn.lineCount} returns:${ret}`);
  }

  // Summary line
  const total = result.crossRep.length + filtered.length + broadFiltered.length + suspectCount + result.exhaustivenessGaps.length;
  o.push(`## Summary: crossRep=${result.crossRep.length} guards=${filtered.length} broadGuards=${broadFiltered.length} statusFn=${result.statusFunctions.length} decisionTables=${result.decisionTables.length} suspect=${suspectCount} exhaustiveness=${result.exhaustivenessGaps.length} total=${total}`);

  return o.join("\n");
}

export function formatJson(result: LogicAuditResult): string {
  return JSON.stringify(result, null, 2);
}

// ── exported function ───────────────────────────────────────────────

export async function runLogicAudit(opts: LogicAuditOptions): Promise<string> {
  const format = opts.format ?? "text";
  const minConfidence = opts.minConfidence ?? "med";
  const resolvedDir = resolve(opts.srcDir);
  const files = await collectSourceFiles(resolvedDir);

  const crossRep = await crossRepScan(files, resolvedDir);

  const guards: GuardInconsistency[] = [];
  const broadGuards: GuardInconsistency[] = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf-8");
    guards.push(...scanGuardConsistency(source, filePath));
    broadGuards.push(...scanBroadGuardConsistency(source, filePath));
  }

  const nonTestFiles = files.filter(
    (f) => !f.includes("__tests__") && !f.includes(".test.") && !f.includes(".spec."),
  );
  const program = createProgram(nonTestFiles);
  const checker = program.getTypeChecker();

  const statusFunctions = scanStatusFunctions(program, checker, nonTestFiles, resolvedDir);

  const decisionTables = scanDecisionTables(program, nonTestFiles, resolvedDir, statusFunctions);

  const exhaustivenessGaps = scanExhaustivenessGaps(program, checker, nonTestFiles, resolvedDir);

  const result: LogicAuditResult = {
    crossRep,
    guards,
    broadGuards,
    statusFunctions,
    decisionTables,
    exhaustivenessGaps,
  };

  const output = format === "json" ? formatJson(result) : formatText(result, resolvedDir, minConfidence);

  if (opts.outFile) {
    await writeFile(opts.outFile, output, "utf-8");
  }
  return output;
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const srcDir = args.find((a) => !a.startsWith("--"));

  if (!srcDir) {
    console.error("Usage: bun logic-audit.ts <src-dir> [--format text|json] [--out <file>] [--min-confidence high|med|low]");
    process.exit(1);
  }

  const format = (getArg(args, "--format") ?? "text") as "text" | "json";
  const outFile = getArg(args, "--out");
  const minConfidence = (getArg(args, "--min-confidence") ?? "med") as "high" | "med" | "low";

  console.error(`Scanning in ${shortPath(resolve(srcDir))}...`);

  const output = await runLogicAudit({ srcDir, format, outFile, minConfidence });
  if (!outFile) console.log(output);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
