/**
 * compound-analysis.ts — Cross-references analysis engines to find compound findings.
 *
 * A compound finding is a bug that spans multiple analysis layers:
 * - A taint source flowing through a function with a decision-table gap
 * - A hub function (many callers) with guard inconsistencies
 * - A function on a taint path that also has suspicious decision logic
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Types for the JSON outputs we consume
interface TaintJson {
  sources: number;
  sinks: number;
  flows: number;
  unsanitizedFlows: number;
  unsanitizedBySeverity: { critical: number; high: number; medium: number };
  details: Array<{
    severity: string;
    sinkKind: string;
    sinkFile: string;
    sinkLine: number;
    sourceKind: string;
    sourceFile: string;
    sourceLine: number;
  }>;
}

interface LogicAuditJson {
  crossRep: Array<{ schemaName: string; typeName: string; mismatchKind: string; message: string }>;
  guards: Array<{ filePath: string; line: number; message: string; confidence: string }>;
  broadGuards: Array<{ filePath: string; line: number; message: string; confidence: string }>;
  statusFunctions: Array<{ name: string; filePath: string; line: number; branchCount: number; lineCount: number }>;
  decisionTables: Array<{
    functionName: string;
    filePath: string;
    line: number;
    suspiciousCells: Array<{
      signal: string;
      outcome: string;
      line: number;
      reason: string;
      verdictNote?: string;
      gapScenario?: string;
      reachabilityNote?: string;
    }>;
  }>;
  exhaustivenessGaps: Array<{ filePath: string; line: number; message: string }>;
}

interface DiscoveryJson {
  functions: Array<{
    name: string;
    filePath: string;
    line: number;
    purityScore: number;
    branchCount: number;
  }>;
  duplicates: Array<{
    functions: Array<{ name: string; filePath: string; line: number }>;
    similarity: number;
  }>;
  callGraph: {
    hubs: number;
    hubDetails?: Array<{ name: string; filePath: string; line: number; callers: number }>;
  };
}

export interface CompoundFinding {
  readonly severity: "critical" | "high" | "medium";
  readonly category: string;
  readonly summary: string;
  readonly pkg: string;
  readonly evidence: Array<{ engine: string; detail: string; file: string; line: number }>;
}

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Normalize file paths for comparison — strip leading path segments to get
 * relative-ish paths that can be compared across analysis outputs.
 */
function normFile(filePath: string): string {
  // Extract just the filename for matching
  return filePath.split("/").pop() ?? filePath;
}

export async function runCompoundAnalysis(
  pkgName: string,
  jsonDir: string,
): Promise<CompoundFinding[]> {
  const [taint, logic, discovery] = await Promise.all([
    loadJson<TaintJson>(join(jsonDir, "taint.json")),
    loadJson<LogicAuditJson>(join(jsonDir, "logic-audit.json")),
    loadJson<DiscoveryJson>(join(jsonDir, "discovery.json")),
  ]);

  const findings: CompoundFinding[] = [];

  // ── Cross 1: Taint × Decision Gaps ──────────────────────────────
  // If a function has a suspicious decision table AND is on a taint path,
  // that's a compound bug: unsanitized input affecting status logic.
  if (taint && logic) {
    const taintFiles = new Set(taint.details.map(d => normFile(d.sinkFile)));
    const taintSourceFiles = new Set(taint.details.map(d => normFile(d.sourceFile)));

    for (const table of logic.decisionTables) {
      if (table.suspiciousCells.length === 0) continue;
      const tableFile = normFile(table.filePath);

      if (taintFiles.has(tableFile) || taintSourceFiles.has(tableFile)) {
        const taintDetail = taint.details.find(
          d => normFile(d.sinkFile) === tableFile || normFile(d.sourceFile) === tableFile
        );

        for (const cell of table.suspiciousCells) {
          findings.push({
            severity: taintDetail?.severity === "critical" ? "critical" : "high",
            category: "taint-through-decision-gap",
            summary: `${table.functionName} has decision gap (${cell.signal}→${cell.outcome}) AND handles tainted ${taintDetail?.sourceKind ?? "input"}`,
            pkg: pkgName,
            evidence: [
              { engine: "logic-audit", detail: cell.reason, file: table.filePath, line: cell.line },
              { engine: "taint", detail: `${taintDetail?.sourceKind} → ${taintDetail?.sinkKind}`, file: taintDetail?.sinkFile ?? table.filePath, line: taintDetail?.sinkLine ?? 0 },
            ],
          });
        }
      }
    }
  }

  // ── Cross 2: Taint × Guard Inconsistency ────────────────────────
  // If a file has both an unsanitized taint flow AND a guard inconsistency,
  // the unguarded code path may process unsanitized data.
  if (taint && logic) {
    const highConfGuards = [...logic.guards, ...logic.broadGuards].filter(
      g => g.confidence === "high"
    );

    for (const guard of highConfGuards) {
      const guardFile = normFile(guard.filePath);
      const matchingTaint = taint.details.find(
        d => normFile(d.sinkFile) === guardFile
      );

      if (matchingTaint) {
        findings.push({
          severity: "high",
          category: "unguarded-taint-path",
          summary: `Guard inconsistency in ${guardFile}:${guard.line} — file also has unsanitized ${matchingTaint.sourceKind} → ${matchingTaint.sinkKind} flow`,
          pkg: pkgName,
          evidence: [
            { engine: "guards", detail: guard.message, file: guard.filePath, line: guard.line },
            { engine: "taint", detail: `${matchingTaint.severity}: ${matchingTaint.sourceKind} → ${matchingTaint.sinkKind}`, file: matchingTaint.sinkFile, line: matchingTaint.sinkLine },
          ],
        });
      }
    }
  }

  // ── Cross 3: Hub function × High complexity ─────────────────────
  // A hub function (many callers) that also has high complexity is a
  // reliability risk — changes to it affect many call sites, and the
  // complexity makes bugs likely.
  if (discovery) {
    const hubs = discovery.callGraph.hubDetails ?? [];
    const complexFns = discovery.functions.filter(f => f.branchCount > 10);
    const complexMap = new Map(complexFns.map(f => [f.name, f]));

    for (const hub of hubs) {
      const complexEntry = complexMap.get(hub.name);
      if (complexEntry && hub.callers >= 8) {
        findings.push({
          severity: "medium",
          category: "complex-hub-risk",
          summary: `${hub.name} has ${hub.callers} callers AND CC${complexEntry.branchCount} — high blast radius + high bug probability`,
          pkg: pkgName,
          evidence: [
            { engine: "discovery", detail: `${hub.callers} callers (hub function)`, file: hub.filePath, line: hub.line },
            { engine: "complexity", detail: `CC${complexEntry.branchCount}, ${complexEntry.purityScore < 0.5 ? "impure" : "partially pure"}`, file: complexEntry.filePath, line: complexEntry.line },
          ],
        });
      }
    }
  }

  // ── Cross 4: Exhaustiveness gap × Status function ───────────────
  // A switch with missing cases on a type used by a status-determining
  // function means some status values may fall through silently.
  if (logic) {
    const statusFiles = new Set(logic.statusFunctions.map(f => normFile(f.filePath)));

    for (const gap of logic.exhaustivenessGaps) {
      if (statusFiles.has(normFile(gap.filePath))) {
        findings.push({
          severity: "high",
          category: "status-exhaustiveness-gap",
          summary: `Exhaustiveness gap in status function at ${gap.filePath}:${gap.line} — ${gap.message}`,
          pkg: pkgName,
          evidence: [
            { engine: "exhaustiveness", detail: gap.message, file: gap.filePath, line: gap.line },
          ],
        });
      }
    }
  }

  // Sort by severity
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2 };
  findings.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  return findings;
}
