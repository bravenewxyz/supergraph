#!/usr/bin/env bun
/**
 * Dead export detector for a TypeScript package.
 *
 * Two-pass approach:
 *  1. Module-level  — modules with 0 inbound imports (from the dep graph).
 *     All their exports are unreachable unless the module is an entry point.
 *  2. Symbol-level  — for modules that ARE imported, find exported symbols
 *     whose names never appear in any importing file (text search).
 *     Approximate: matches are text-based, not semantic. Type-only re-exports
 *     and namespace imports may cause false positives.
 *
 * Entry-point heuristics (excluded from orphan detection):
 *   index, main, cli, server, app, run, start
 *
 * Usage:
 *   bun packages/graph/src/cli/dead-exports.ts <src-dir> [--out <file>]
 */

import { readFile } from "node:fs/promises";
import { join, relative, resolve, basename, dirname } from "node:path";
import { collectTsFiles } from "./utils.js";
import { runMap } from "./map.js";
import type { PackageManifest } from "./map.js";

// ---------------------------------------------------------------------------
// Local subset types (for analysis functions)
// ---------------------------------------------------------------------------

interface SymbolSummary {
  name: string;
  kind: string;
  exported: boolean;
  children?: SymbolSummary[];
}

interface ModuleManifest {
  path: string; // e.g. "src/task/store"
  symbols: SymbolSummary[];
  internalDeps: string[];
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const ENTRY_POINTS = new Set(["index", "main", "cli", "server", "app", "run", "start"]);

function isEntryPoint(modulePath: string): boolean {
  const base = basename(modulePath);
  return ENTRY_POINTS.has(base);
}

function strip(p: string): string {
  return p.replace(/^src\//, "");
}

/** Collect all exported symbol names from a module (recurse into children). */
function collectExports(symbols: SymbolSummary[]): string[] {
  const names: string[] = [];
  for (const sym of symbols) {
    if (sym.exported && sym.name && sym.name !== "(anonymous)") {
      // Skip import/re-export stubs (kind === "import")
      if (sym.kind !== "import") names.push(sym.name);
    }
    if (sym.children) names.push(...collectExports(sym.children));
  }
  return names;
}

interface DeadResult {
  orphanModules: Array<{ module: string; exports: string[] }>;
  unusedSymbols: Array<{ module: string; symbol: string; kind: string }>;
  totalExports: number;
  totalDead: number;
}

async function analyzeDeadExports(
  manifest: PackageManifest,
  srcRoot: string,
): Promise<DeadResult> {
  // Build inbound-count map
  const inbound = new Map<string, number>();
  for (const mod of manifest.modules) {
    for (const dep of mod.internalDeps) {
      inbound.set(dep, (inbound.get(dep) ?? 0) + 1);
    }
  }

  // 1. Orphan modules
  const orphanModules: DeadResult["orphanModules"] = [];
  const importedModules = new Set<string>();
  for (const mod of manifest.modules) {
    for (const dep of mod.internalDeps) importedModules.add(dep);
  }

  for (const mod of manifest.modules) {
    const key = strip(mod.path);
    if (!importedModules.has(mod.path) && !isEntryPoint(key)) {
      const exports = collectExports(mod.symbols);
      if (exports.length > 0) {
        orphanModules.push({ module: key, exports });
      }
    }
  }

  // 2. Symbol-level: for non-orphan modules, find exports unused by importers
  // Load all source files into memory (for text search)
  const allFiles = await collectTsFiles(srcRoot);
  const fileContents = new Map<string, string>();
  await Promise.all(
    allFiles.map(async (f) => {
      fileContents.set(f, await readFile(f, "utf-8"));
    }),
  );

  // Build: module path → absolute file path
  const modToFile = new Map<string, string>();
  for (const f of allFiles) {
    const rel = relative(srcRoot, f).replace(/\.(ts|tsx)$/, "");
    const modPath = "src/" + rel;
    modToFile.set(modPath, f);
    modToFile.set(rel, f);
  }

  const unusedSymbols: DeadResult["unusedSymbols"] = [];
  const orphanSet = new Set(orphanModules.map((o) => o.module));

  for (const mod of manifest.modules) {
    const key = strip(mod.path);
    if (orphanSet.has(key)) continue; // already flagged at module level
    if (isEntryPoint(key)) continue;

    const importers = inbound.get(mod.path) ?? 0;
    if (importers === 0) continue; // handled above

    // Find which files import this module
    const importerFiles: string[] = [];
    for (const otherMod of manifest.modules) {
      if (otherMod.internalDeps.includes(mod.path)) {
        const f = modToFile.get(otherMod.path) ?? modToFile.get(strip(otherMod.path));
        if (f) importerFiles.push(f);
      }
    }
    if (importerFiles.length === 0) continue;

    const importerContent = importerFiles
      .map((f) => fileContents.get(f) ?? "")
      .join("\n");

    for (const sym of mod.symbols) {
      if (!sym.exported || sym.kind === "import" || !sym.name) continue;
      // Skip re-export groups and anonymous
      if (sym.name === "(anonymous)" || sym.name.startsWith("{")) continue;
      // Word-boundary check: is the name used in any importing file?
      const re = new RegExp(`\\b${escapeRegExp(sym.name)}\\b`);
      if (!re.test(importerContent)) {
        unusedSymbols.push({ module: key, symbol: sym.name, kind: sym.kind });
      }
    }
  }

  const totalExports = manifest.modules.reduce(
    (s, m) => s + collectExports(m.symbols).length,
    0,
  );
  const orphanExportCount = orphanModules.reduce((s, o) => s + o.exports.length, 0);
  const totalDead = orphanExportCount + unusedSymbols.length;

  return { orphanModules, unusedSymbols, totalExports, totalDead };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderText(pkg: string, result: DeadResult): string {
  const lines: string[] = [];
  const pct =
    result.totalExports > 0
      ? ((result.totalDead / result.totalExports) * 100).toFixed(1)
      : "0.0";

  lines.push(`# ${pkg} — Dead Export Analysis`);
  lines.push(
    `${result.totalExports} exports | ${result.totalDead} potentially dead (${pct}%)`,
  );
  lines.push(
    "note: symbol-level detection is text-based — verify before removing",
  );
  lines.push("");

  lines.push("## Orphan Modules");
  lines.push(
    "(0 inbound imports from within this package, not a known entry point)",
  );
  lines.push("");
  if (result.orphanModules.length === 0) {
    lines.push("  none");
  } else {
    for (const om of result.orphanModules.sort((a, b) =>
      a.module.localeCompare(b.module),
    )) {
      const exp =
        om.exports.length <= 4
          ? om.exports.join(", ")
          : om.exports.slice(0, 4).join(", ") + ` … +${om.exports.length - 4}`;
      lines.push(`  ${om.module.padEnd(40)}  exports: ${om.exports.length}  (${exp})`);
    }
  }
  lines.push("");

  lines.push("## Exports Not Found in Importers");
  lines.push(
    "(exported symbol name absent in all files that import its module)",
  );
  lines.push("");
  if (result.unusedSymbols.length === 0) {
    lines.push("  none");
  } else {
    // Group by module
    const byModule = new Map<string, typeof result.unusedSymbols>();
    for (const s of result.unusedSymbols) {
      const g = byModule.get(s.module) ?? [];
      g.push(s);
      byModule.set(s.module, g);
    }
    for (const [mod, syms] of [...byModule.entries()].sort()) {
      lines.push(`  ${mod}`);
      for (const s of syms) {
        lines.push(`    ${s.kind.padEnd(12)}  ${s.symbol}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export interface DeadExportsOptions {
  srcRoot: string;
  outPath?: string;
}

export async function runDeadExports(opts: DeadExportsOptions): Promise<string> {
  const srcRoot = opts.srcRoot;
  const outPath = opts.outPath;

  const pkgRoot = resolve(srcRoot, "..");
  let packageName = basename(pkgRoot);
  try {
    const pkgJson = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf-8"));
    packageName = pkgJson.name ?? packageName;
  } catch {
    /* use dir name */
  }

  const { manifest } = await runMap({ srcRoot, format: "json" });

  const result = await analyzeDeadExports(manifest, srcRoot);
  const output = renderText(packageName, result);

  if (outPath) {
    await Bun.write(outPath, output);
    console.error(
      `Output written to ${outPath} (${(output.length / 1024).toFixed(0)} KB)`,
    );
  }

  return output;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || args[0] === "--help" || args[0] === "-h") {
    console.error(
      "Usage: bun devtools/graph/src/cli/dead-exports.ts <src-dir> [--out <file>]",
    );
    process.exit(1);
  }

  const srcRoot = resolve(args[0]!);
  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;

  const output = await runDeadExports({ srcRoot, outPath });
  if (!outPath) process.stdout.write(output);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
