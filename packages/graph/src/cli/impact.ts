#!/usr/bin/env bun
/**
 * Blast radius / impact analysis for a symbol in a TypeScript package.
 *
 * Given a symbol name, BFS through the call/import/extends/implements graph
 * to find everything affected (upstream) or everything it depends on (downstream).
 *
 * Usage:
 *   bun packages/graph/src/cli/impact.ts <src-dir> <symbol-name> [options]
 *
 * Options:
 *   --direction <dir>   upstream | downstream | both (default: upstream)
 *   --depth <n>         Max BFS depth (default: 3)
 *   --format <fmt>      text | json (default: text)
 *   --out <file>        Write output to file instead of stdout
 */

import { readFile, stat } from "node:fs/promises";
import { resolve, relative, join, basename, dirname } from "node:path";
import { GraphStore } from "../store/graph-store.js";
import { parseTypeScript } from "../parser/ts-structural.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import { collectTsFiles } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Direction = "upstream" | "downstream" | "both";

export interface ImpactOptions {
  srcRoot: string;
  symbolName: string;
  direction?: Direction;
  maxDepth?: number;
  format?: "text" | "json";
  outPath?: string;
}

interface ImpactedSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  module: string;
  depth: number;
  edgeKind: string;
}

interface ModuleImpact {
  module: string;
  total: number;
  direct: number;
}

type RiskLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

interface ImpactResult {
  target: { id: string; name: string; qualifiedName: string; kind: string };
  direction: Direction;
  maxDepth: number;
  risk: RiskLevel;
  directCount: number;
  totalCount: number;
  moduleCount: number;
  byDepth: Map<number, ImpactedSymbol[]>;
  byModule: ModuleImpact[];
}

// ---------------------------------------------------------------------------
// Graph building (mirrors map.ts pattern)
// ---------------------------------------------------------------------------

function resolveImportSpecifier(fromModule: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromDir = fromModule.replace(/\/[^/]+$/, "");
  const resolved = join(fromDir, specifier).replace(/\.(js|ts|tsx|jsx)$/, "");
  return resolved.replace(/\/index$/, "");
}

async function buildGraph(srcRoot: string): Promise<GraphStore> {
  const files = await collectTsFiles(srcRoot);
  const store = new GraphStore();
  const unresolvedEdges: SymbolEdge[] = [];
  const moduleIdByPath = new Map<string, string>();
  const pkgRoot = resolve(srcRoot, "..");

  for (const file of files) {
    const code = await readFile(file, "utf-8");
    const relPath = relative(pkgRoot, file);
    const result = parseTypeScript(code, relPath);

    for (const node of result.nodes) {
      store.addSymbol(node);
      if (node.kind === "module") {
        moduleIdByPath.set(node.qualifiedName, node.id);
      }
    }

    for (const edge of result.edges) {
      if (edge.metadata?.unresolved) {
        unresolvedEdges.push(edge);
      } else {
        try {
          store.addEdge(edge);
        } catch {
          /* skip edges with missing targets */
        }
      }
    }
  }

  // Resolve import edges
  for (const edge of unresolvedEdges) {
    if (edge.kind === "imports" && edge.metadata?.moduleSpecifier) {
      const sourceModule = store.getSymbol(edge.sourceId);
      if (!sourceModule) continue;
      const resolved = resolveImportSpecifier(
        sourceModule.qualifiedName,
        edge.metadata.moduleSpecifier as string,
      );
      if (!resolved) continue;
      const targetModuleId = moduleIdByPath.get(resolved);
      if (targetModuleId) {
        try {
          store.addEdge({ ...edge, targetId: targetModuleId });
        } catch {
          /* skip */
        }
      }
    }
  }

  return store;
}

// ---------------------------------------------------------------------------
// Symbol lookup (supports partial matching)
// ---------------------------------------------------------------------------

function findSymbol(store: GraphStore, name: string): SymbolNode | undefined {
  // 1. Exact qualified name match
  const byQn = store.getSymbolByQualifiedName(name);
  if (byQn) return byQn;

  // 2. Search all symbols for partial match
  const allSymbols = store.getAllSymbols();

  // Exact simple name match
  const byName = allSymbols.filter((s) => s.name === name && s.kind !== "module");
  if (byName.length === 1) return byName[0];
  // If multiple, prefer exported
  if (byName.length > 1) {
    const exported = byName.filter((s) => s.exported);
    if (exported.length === 1) return exported[0];
    if (exported.length > 1) return exported[0]; // first exported match
    return byName[0];
  }

  // 3. Qualified name ends-with match
  const byEndsWith = allSymbols.filter(
    (s) => s.qualifiedName.endsWith(`.${name}`) && s.kind !== "module",
  );
  if (byEndsWith.length === 1) return byEndsWith[0];
  if (byEndsWith.length > 1) {
    const exported = byEndsWith.filter((s) => s.exported);
    if (exported.length >= 1) return exported[0];
    return byEndsWith[0];
  }

  // 4. Case-insensitive name match
  const lower = name.toLowerCase();
  const byCaseInsensitive = allSymbols.filter(
    (s) => s.name.toLowerCase() === lower && s.kind !== "module",
  );
  if (byCaseInsensitive.length >= 1) return byCaseInsensitive[0];

  return undefined;
}

// ---------------------------------------------------------------------------
// BFS impact analysis
// ---------------------------------------------------------------------------

const TRAVERSAL_EDGE_KINDS = new Set([
  "calls",
  "imports",
  "extends",
  "implements",
  "references",
  "depends-on",
]);

function analyzeImpact(
  store: GraphStore,
  target: SymbolNode,
  direction: Direction,
  maxDepth: number,
): ImpactResult {
  const visited = new Set<string>();
  visited.add(target.id);

  const byDepth = new Map<number, ImpactedSymbol[]>();
  let totalCount = 0;

  const queue: Array<{ id: string; depth: number }> = [{ id: target.id, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const nextDepth = current.depth + 1;
    const neighbors: Array<{ id: string; edgeKind: string }> = [];

    if (direction === "upstream" || direction === "both") {
      // Upstream: who depends on this? Follow edges TO this node (inbound edges).
      const inEdges = store.getEdgesTo(current.id);
      for (const edge of inEdges) {
        if (TRAVERSAL_EDGE_KINDS.has(edge.kind)) {
          neighbors.push({ id: edge.sourceId, edgeKind: edge.kind });
        }
      }
    }

    if (direction === "downstream" || direction === "both") {
      // Downstream: what does this depend on? Follow edges FROM this node.
      const outEdges = store.getEdgesFrom(current.id);
      for (const edge of outEdges) {
        if (TRAVERSAL_EDGE_KINDS.has(edge.kind)) {
          neighbors.push({ id: edge.targetId, edgeKind: edge.kind });
        }
      }
    }

    for (const neighbor of neighbors) {
      if (visited.has(neighbor.id)) continue;
      visited.add(neighbor.id);

      const node = store.getSymbol(neighbor.id);
      if (!node) continue;

      const module = node.qualifiedName.split(".")[0] ?? node.qualifiedName;

      const impacted: ImpactedSymbol = {
        id: node.id,
        name: node.name,
        qualifiedName: node.qualifiedName,
        kind: node.kind,
        module,
        depth: nextDepth,
        edgeKind: neighbor.edgeKind,
      };

      if (!byDepth.has(nextDepth)) byDepth.set(nextDepth, []);
      byDepth.get(nextDepth)!.push(impacted);
      totalCount++;

      queue.push({ id: neighbor.id, depth: nextDepth });
    }
  }

  // Count direct dependents (depth 1)
  const directCount = byDepth.get(1)?.length ?? 0;

  // Group by module
  const moduleMap = new Map<string, { total: number; direct: number }>();
  for (const [depth, symbols] of byDepth) {
    for (const sym of symbols) {
      const entry = moduleMap.get(sym.module) ?? { total: 0, direct: 0 };
      entry.total++;
      if (depth === 1) entry.direct++;
      moduleMap.set(sym.module, entry);
    }
  }

  const byModule: ModuleImpact[] = [...moduleMap.entries()]
    .map(([module, counts]) => ({ module, ...counts }))
    .sort((a, b) => b.total - a.total);

  // Risk scoring
  const risk = scoreRisk(directCount, totalCount);

  return {
    target: {
      id: target.id,
      name: target.name,
      qualifiedName: target.qualifiedName,
      kind: target.kind,
    },
    direction,
    maxDepth,
    risk,
    directCount,
    totalCount,
    moduleCount: byModule.length,
    byDepth,
    byModule,
  };
}

function scoreRisk(directCount: number, totalCount: number): RiskLevel {
  if (directCount >= 30 || totalCount >= 200) return "CRITICAL";
  if (directCount >= 15 || totalCount >= 100) return "HIGH";
  if (directCount >= 5 || totalCount >= 30) return "MEDIUM";
  return "LOW";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderText(result: ImpactResult): string {
  const lines: string[] = [];

  lines.push(
    `IMPACT | ${result.target.qualifiedName} | ${result.direction} | depth=${result.maxDepth}`,
  );
  lines.push("");
  lines.push(
    `Risk: ${result.risk} (${result.directCount} direct, ${result.totalCount} total, ${result.moduleCount} modules)`,
  );
  lines.push("");

  // By depth
  const depths = [...result.byDepth.keys()].sort((a, b) => a - b);
  for (const depth of depths) {
    const symbols = result.byDepth.get(depth)!;
    const label = depth === 1 ? `Depth 1 (direct)` : `Depth ${depth}`;
    lines.push(`## ${label} — ${symbols.length} symbols`);

    const sorted = [...symbols].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
    for (const sym of sorted) {
      const arrow = result.direction === "downstream" ? "→" : "←";
      const modulePart = sym.module ? ` [${sym.module}]` : "";
      lines.push(`  ${sym.name} ${arrow} ${sym.edgeKind}${modulePart}`);
    }
    lines.push("");
  }

  // By module
  if (result.byModule.length > 0) {
    lines.push("## Affected Modules");
    for (const mod of result.byModule) {
      lines.push(`  ${mod.module}: ${mod.total} symbols (${mod.direct} direct)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderJson(result: ImpactResult): string {
  const byDepthObj: Record<number, ImpactedSymbol[]> = {};
  for (const [depth, symbols] of result.byDepth) {
    byDepthObj[depth] = symbols;
  }

  return JSON.stringify(
    {
      target: result.target,
      direction: result.direction,
      maxDepth: result.maxDepth,
      risk: result.risk,
      directCount: result.directCount,
      totalCount: result.totalCount,
      moduleCount: result.moduleCount,
      byDepth: byDepthObj,
      byModule: result.byModule,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export async function runImpact(opts: ImpactOptions): Promise<string> {
  const srcRoot = opts.srcRoot;
  const symbolName = opts.symbolName;
  const direction: Direction = opts.direction ?? "upstream";
  const maxDepth = opts.maxDepth ?? 3;
  const format = opts.format ?? "text";
  const outPath = opts.outPath;

  try {
    await stat(srcRoot);
  } catch {
    throw new Error(`Source directory not found: ${srcRoot}`);
  }

  console.error(`Building graph for ${srcRoot}...`);
  const store = await buildGraph(srcRoot);
  console.error(`Graph built: ${store.nodeCount} nodes, ${store.edgeCount} edges`);

  console.error(`Looking up symbol: ${symbolName}`);
  const target = findSymbol(store, symbolName);
  if (!target) {
    const allSymbols = store.getAllSymbols().filter((s) => s.kind !== "module");
    const suggestions = allSymbols
      .filter((s) => s.name.toLowerCase().includes(symbolName.toLowerCase()))
      .slice(0, 5)
      .map((s) => `  ${s.qualifiedName} (${s.kind})`);

    let msg = `Symbol not found: ${symbolName}`;
    if (suggestions.length > 0) {
      msg += `\n\nDid you mean:\n${suggestions.join("\n")}`;
    }
    throw new Error(msg);
  }

  console.error(`Found: ${target.qualifiedName} (${target.kind})`);
  console.error(`Analyzing ${direction} impact with depth=${maxDepth}...`);

  const result = analyzeImpact(store, target, direction, maxDepth);

  const output = format === "json" ? renderJson(result) : renderText(result);

  if (outPath) {
    await Bun.write(outPath, output);
    console.error(`Output written to ${outPath} (${(output.length / 1024).toFixed(0)} KB)`);
  }

  console.error(
    `\nDone: Risk=${result.risk}, ${result.directCount} direct, ${result.totalCount} total, ${result.moduleCount} modules`,
  );

  return output;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] === "--help" || args[0] === "-h") {
    console.error(
      "Usage: bun packages/graph/src/cli/impact.ts <src-dir> <symbol-name> [--direction upstream|downstream|both] [--depth <n>] [--format text|json] [--out <file>]",
    );
    process.exit(1);
  }

  const srcRoot = resolve(args[0]!);
  const symbolName = args[1]!;

  const dirIdx = args.indexOf("--direction");
  const direction = (dirIdx !== -1 && args[dirIdx + 1]) ? args[dirIdx + 1] as Direction : "upstream";

  const depthIdx = args.indexOf("--depth");
  const maxDepth = depthIdx !== -1 && args[depthIdx + 1] ? parseInt(args[depthIdx + 1]!, 10) : 3;

  const fmtIdx = args.indexOf("--format");
  const format = fmtIdx !== -1 && args[fmtIdx + 1] === "json" ? "json" as const : "text" as const;

  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;

  const output = await runImpact({ srcRoot, symbolName, direction, maxDepth, format, outPath });
  if (!outPath) process.stdout.write(output);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
