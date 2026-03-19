#!/usr/bin/env bun
/**
 * Detect changed symbols and their dependents from git diff output.
 *
 * Maps git-changed files to the GraphStore's symbol graph, finds all
 * dependents of changed symbols, and reports risk level per module.
 *
 * Usage:
 *   bun packages/graph/src/cli/detect-changes.ts [options]
 *
 * Options:
 *   --scope <scope>     staged | unstaged (default) | all | compare
 *   --compare <ref>     Git ref to compare against (requires --scope compare)
 *   --format <fmt>      text (default) | json
 *   --pkg <name>        Filter to a specific package
 */

import { execSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, basename } from "node:path";
import { GraphStore } from "../store/graph-store.js";
import { parseTypeScript } from "../parser/ts-structural.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import { collectTsFiles } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Scope = "staged" | "unstaged" | "all" | "compare";

export interface DetectChangesOptions {
  scope: Scope;
  compareRef?: string;
  format: "text" | "json";
  pkg?: string;
}

interface ChangedSymbolInfo {
  symbol: SymbolNode;
  dependents: string[];
  moduleName: string;
}

interface ModuleSummary {
  changed: number;
  dependents: number;
}

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

interface DetectChangesResult {
  scope: Scope;
  changedFiles: string[];
  changedSymbols: ChangedSymbolInfo[];
  affectedModules: Map<string, ModuleSummary>;
  totalDependents: number;
  risk: RiskLevel;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function getChangedFiles(scope: Scope, compareRef?: string): string[] {
  let cmd: string;
  switch (scope) {
    case "staged":
      cmd = "git diff --staged --name-only";
      break;
    case "unstaged":
      cmd = "git diff --name-only";
      break;
    case "all":
      cmd = "git diff HEAD --name-only";
      break;
    case "compare":
      if (!compareRef) throw new Error("--compare ref is required when scope is 'compare'");
      cmd = `git diff ${compareRef} --name-only`;
      break;
  }

  try {
    const output = execSync(cmd, { encoding: "utf-8" }).trim();
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Risk calculation
// ---------------------------------------------------------------------------

function calculateRisk(totalDependents: number): RiskLevel {
  if (totalDependents === 0) return "LOW";
  if (totalDependents <= 10) return "MEDIUM";
  if (totalDependents <= 30) return "HIGH";
  return "CRITICAL";
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

async function buildGraphForPackage(
  srcRoot: string,
): Promise<{ store: GraphStore; moduleIdByPath: Map<string, string> }> {
  const files = await collectTsFiles(srcRoot);
  const pkgRoot = resolve(srcRoot, "..");
  const store = new GraphStore();
  const moduleIdByPath = new Map<string, string>();

  for (const file of files) {
    const code = await readFile(file, "utf-8");
    const relPath = relative(pkgRoot, file);
    const result = parseTypeScript(code, relPath);

    for (const node of result.nodes) {
      store.addSymbol(node);
      if (node.kind === "module") {
        moduleIdByPath.set(relPath, node.id);
      }
    }

    // Resolve edges — add those whose source/target exist, skip the rest
    for (const edge of result.edges) {
      try {
        store.addEdge(edge);
      } catch {
        // source or target missing — skip
      }
    }
  }

  return { store, moduleIdByPath };
}

export async function detectChanges(opts: DetectChangesOptions): Promise<DetectChangesResult> {
  const { scope, compareRef, pkg } = opts;

  const changedFiles = getChangedFiles(scope, compareRef);

  // If pkg filter provided, only keep files within that package
  const filtered = pkg
    ? changedFiles.filter((f) => f.includes(pkg))
    : changedFiles;

  // Determine package src roots to analyze from changed files
  // Heuristic: look for files under packages/*/src/ or src/
  const pkgRoots = new Set<string>();
  for (const f of filtered) {
    const pkgMatch = f.match(/^(packages\/[^/]+\/src)\//);
    if (pkgMatch) {
      pkgRoots.add(resolve(pkgMatch[1]));
    } else if (f.startsWith("src/")) {
      pkgRoots.add(resolve("src"));
    }
  }

  const changedSymbols: ChangedSymbolInfo[] = [];
  const affectedModules = new Map<string, ModuleSummary>();
  let totalDependents = 0;

  for (const srcRoot of pkgRoots) {
    try {
      await stat(srcRoot);
    } catch {
      continue; // src root doesn't exist
    }

    const { store, moduleIdByPath } = await buildGraphForPackage(srcRoot);
    const pkgRoot = resolve(srcRoot, "..");

    // Map changed files to symbols
    for (const file of filtered) {
      const absFile = resolve(file);
      const relPath = relative(pkgRoot, absFile);

      // Find module by path
      const moduleId = moduleIdByPath.get(relPath);
      if (!moduleId) continue;

      // Get all symbols in this file via the module's children
      const symbols = store.getModuleSymbols(moduleId);
      const moduleName = basename(relPath).replace(/\.(ts|tsx|js|jsx)$/, "");

      // Also include the module node itself
      const moduleNode = store.getSymbol(moduleId);
      const allSymbols = moduleNode ? [moduleNode, ...symbols] : symbols;

      for (const sym of allSymbols) {
        const dependents = store.getDependents(sym.id);
        totalDependents += dependents.length;

        changedSymbols.push({
          symbol: sym,
          dependents,
          moduleName: sym.qualifiedName.split(".")[0] ?? moduleName,
        });

        // Update module summary
        const modKey = sym.qualifiedName.split(".")[0] ?? moduleName;
        const existing = affectedModules.get(modKey) ?? { changed: 0, dependents: 0 };
        existing.changed += 1;
        existing.dependents += dependents.length;
        affectedModules.set(modKey, existing);
      }
    }
  }

  // Deduplicate dependents for risk calculation
  const uniqueDependents = new Set<string>();
  for (const cs of changedSymbols) {
    for (const d of cs.dependents) uniqueDependents.add(d);
  }
  totalDependents = uniqueDependents.size;

  return {
    scope,
    changedFiles: filtered,
    changedSymbols,
    affectedModules,
    totalDependents,
    risk: calculateRisk(totalDependents),
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderText(result: DetectChangesResult): string {
  const lines: string[] = [];

  lines.push(
    `CHANGES | ${result.scope} | ${result.changedFiles.length} files, ${result.changedSymbols.length} symbols, ${result.totalDependents} dependents`,
  );
  lines.push("");
  lines.push(`Risk: ${result.risk}`);
  lines.push("");

  // Changed symbols
  lines.push(`## Changed Symbols (${result.changedSymbols.length})`);
  const sorted = [...result.changedSymbols].sort(
    (a, b) => b.dependents.length - a.dependents.length,
  );
  for (const cs of sorted) {
    if (cs.symbol.kind === "module") continue; // skip module-level nodes in listing
    lines.push(
      `  ${cs.symbol.name} [${cs.moduleName}] — ${cs.dependents.length} dependents`,
    );
  }
  lines.push("");

  // Affected modules
  lines.push("## Affected Modules");
  const modules = [...result.affectedModules.entries()].sort(
    ([, a], [, b]) => b.dependents - a.dependents,
  );
  for (const [mod, summary] of modules) {
    lines.push(
      `  ${mod}: ${summary.changed} changed, ${summary.dependents} dependents`,
    );
  }
  lines.push("");

  // Suggested re-runs
  if (modules.length > 0) {
    lines.push("## Suggested Re-runs");
    for (const [mod] of modules) {
      lines.push(`  supergraph schema-match --pkg ${mod}`);
      lines.push(`  supergraph logic-audit --pkg ${mod}`);
    }
  }

  return lines.join("\n") + "\n";
}

function renderJson(result: DetectChangesResult): string {
  return JSON.stringify(
    {
      scope: result.scope,
      risk: result.risk,
      changedFiles: result.changedFiles,
      totalDependents: result.totalDependents,
      changedSymbols: result.changedSymbols.map((cs) => ({
        name: cs.symbol.name,
        kind: cs.symbol.kind,
        qualifiedName: cs.symbol.qualifiedName,
        module: cs.moduleName,
        dependentCount: cs.dependents.length,
        dependents: cs.dependents,
      })),
      affectedModules: Object.fromEntries(result.affectedModules),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export async function runDetectChanges(opts: DetectChangesOptions): Promise<string> {
  const result = await detectChanges(opts);

  if (opts.format === "json") {
    return renderJson(result);
  }
  return renderText(result);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.error(
      "Usage: bun packages/graph/src/cli/detect-changes.ts [--scope staged|unstaged|all|compare] [--compare <ref>] [--format text|json] [--pkg <name>]",
    );
    process.exit(1);
  }

  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const scope = (getArg("--scope") as Scope) ?? "unstaged";
  const compareRef = getArg("--compare");
  const format = (getArg("--format") as "text" | "json") ?? "text";
  const pkg = getArg("--pkg");

  if (scope === "compare" && !compareRef) {
    console.error("Error: --compare <ref> is required when --scope is 'compare'");
    process.exit(1);
  }

  const output = await runDetectChanges({ scope, compareRef, format, pkg });
  process.stdout.write(output);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
