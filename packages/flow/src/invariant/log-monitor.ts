import { readFile } from "node:fs/promises";
import type { LogInvariant } from "./types.js";

export interface LogCheckResult {
  invariant: string;
  severity: "critical" | "high" | "medium";
  violations: Array<{ line: number; event: unknown }>;
  totalChecked: number;
}

const FILTER_EQ = /^\.(\w+)\s*==\s*["']([^"']*)["']$/;
const FILTER_NE = /^\.(\w+)\s*!=\s*["']([^"']*)["']$/;
const FILTER_TRUTHY = /^\.(\w+)$/;

function getProp(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

export function matchesFilter(event: unknown, filter: string): boolean {
  const trimmed = filter.trim();
  let m = trimmed.match(FILTER_EQ);
  if (m) {
    const val = getProp(event, m[1]!);
    return val === m[2]!;
  }
  m = trimmed.match(FILTER_NE);
  if (m) {
    const val = getProp(event, m[1]!);
    return val !== m[2]!;
  }
  m = trimmed.match(FILTER_TRUTHY);
  if (m) {
    return Boolean(getProp(event, m[1]!));
  }
  return false;
}

export function evaluateCondition(data: unknown, condition: string): boolean {
  try {
    if (/[;{}]|\bfunction\b|\bimport\b|\brequire\b|\beval\b|\bnew\b/.test(condition)) {
      return false;
    }
    const fn = new Function("data", `"use strict"; return (${condition})`);
    return Boolean(fn(data));
  } catch {
    return false;
  }
}

export async function checkLogInvariants(
  logFile: string,
  invariants: LogInvariant[]
): Promise<LogCheckResult[]> {
  const content = await readFile(logFile, "utf-8");
  const lines = content.split(/\r?\n/).filter((line) => line.trim());

  const resultMap = new Map<string, LogCheckResult>();
  for (const inv of invariants) {
    resultMap.set(inv.name, {
      invariant: inv.name,
      severity: inv.severity,
      violations: [],
      totalChecked: 0,
    });
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineNum = lineIdx + 1;
    let event: unknown;
    try {
      event = JSON.parse(lines[lineIdx]!) as Record<string, unknown>;
    } catch {
      continue;
    }

    for (const inv of invariants) {
      if (!matchesFilter(event, inv.eventFilter)) continue;

      const result = resultMap.get(inv.name)!;
      result.totalChecked++;

      const data = (event as Record<string, unknown>).data;
      if (!evaluateCondition(data, inv.condition)) {
        result.violations.push({ line: lineNum, event });
      }
    }
  }

  return Array.from(resultMap.values());
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2 };

export function formatLogReport(results: LogCheckResult[]): string {
  const sorted = [...results]
    .filter((r) => r.violations.length > 0)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  if (sorted.length === 0) return "No invariant violations found.\n";

  const parts: string[] = [];
  for (const r of sorted) {
    parts.push(`[${r.severity.toUpperCase()}] ${r.invariant}`);
    parts.push(`  Violations: ${r.violations.length} / ${r.totalChecked} checked`);
    for (const v of r.violations) {
      parts.push(`    Line ${v.line}`);
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd() + "\n";
}
