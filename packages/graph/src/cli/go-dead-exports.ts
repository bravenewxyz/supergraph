#!/usr/bin/env bun

import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { runGoMap } from "./go-map.js";

const SKIP_DIRS = new Set(["vendor", "testdata", "node_modules", ".git"]);

async function collectGoFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) results.push(...(await collectGoFiles(full)));
    } else if (e.name.endsWith(".go") && !e.name.endsWith("_test.go"))
      results.push(full);
  }
  return results.sort();
}

interface SymbolSummary {
  name: string;
  kind: string;
  exported: boolean;
  children?: SymbolSummary[];
}

interface PackageManifest {
  package: string;
  modules: { path: string; symbols: SymbolSummary[]; internalDeps: string[] }[];
  dependencyGraph: Record<string, string[]>;
}

const ENTRY_POINTS = new Set(["main", "init"]);

function isEntryPoint(modulePath: string): boolean {
  const base = basename(modulePath);
  return ENTRY_POINTS.has(base);
}

function collectExports(symbols: SymbolSummary[]): string[] {
  const names: string[] = [];
  for (const sym of symbols) {
    if (sym.exported && sym.name && sym.name !== "(anonymous)") {
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
  const importedModules = new Set<string>();
  for (const mod of manifest.modules) {
    for (const dep of mod.internalDeps) importedModules.add(dep);
  }

  const orphanModules: DeadResult["orphanModules"] = [];
  for (const mod of manifest.modules) {
    if (!importedModules.has(mod.path) && !isEntryPoint(mod.path)) {
      const exports = collectExports(mod.symbols);
      if (exports.length > 0) {
        orphanModules.push({ module: mod.path, exports });
      }
    }
  }

  const allFiles = await collectGoFiles(srcRoot);
  const fileContents = new Map<string, string>();
  await Promise.all(
    allFiles.map(async (f) => {
      fileContents.set(f, await readFile(f, "utf-8"));
    }),
  );

  const modToFile = new Map<string, string>();
  for (const f of allFiles) {
    const rel = relative(srcRoot, f).replace(/\.go$/, "");
    modToFile.set(rel, f);
  }

  const unusedSymbols: DeadResult["unusedSymbols"] = [];
  const orphanSet = new Set(orphanModules.map((o) => o.module));
  const inbound = new Map<string, number>();
  for (const mod of manifest.modules) {
    for (const dep of mod.internalDeps)
      inbound.set(dep, (inbound.get(dep) ?? 0) + 1);
  }

  for (const mod of manifest.modules) {
    if (orphanSet.has(mod.path)) continue;
    if (isEntryPoint(mod.path)) continue;
    if ((inbound.get(mod.path) ?? 0) === 0) continue;

    const importerFiles: string[] = [];
    for (const otherMod of manifest.modules) {
      if (otherMod.internalDeps.includes(mod.path)) {
        const f = modToFile.get(otherMod.path);
        if (f) importerFiles.push(f);
      }
    }
    if (importerFiles.length === 0) continue;

    const importerContent = importerFiles
      .map((f) => fileContents.get(f) ?? "")
      .join("\n");

    for (const sym of mod.symbols) {
      if (!sym.exported || !sym.name) continue;
      if (sym.name === "(anonymous)") continue;
      const re = new RegExp(`\\b${escapeRegExp(sym.name)}\\b`);
      if (!re.test(importerContent)) {
        unusedSymbols.push({
          module: mod.path,
          symbol: sym.name,
          kind: sym.kind,
        });
      }
    }
  }

  const totalExports = manifest.modules.reduce(
    (s, m) => s + collectExports(m.symbols).length,
    0,
  );
  const orphanExportCount = orphanModules.reduce(
    (s, o) => s + o.exports.length,
    0,
  );
  const totalDead = orphanExportCount + unusedSymbols.length;

  return { orphanModules, unusedSymbols, totalExports, totalDead };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderText(pkg: string, result: DeadResult): string {
  const lines: string[] = [];
  const pct =
    result.totalExports > 0
      ? ((result.totalDead / result.totalExports) * 100).toFixed(1)
      : "0.0";

  lines.push(`# ${pkg} — Dead Export Analysis (Go)`);
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
          : `${om.exports.slice(0, 4).join(", ")} … +${om.exports.length - 4}`;
      lines.push(
        `  ${om.module.padEnd(40)}  exports: ${om.exports.length}  (${exp})`,
      );
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

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export interface GoDeadExportsOptions {
  srcRoot: string;
  outPath?: string;
}

export async function runGoDeadExports(opts: GoDeadExportsOptions): Promise<string> {
  const srcRoot = opts.srcRoot;
  const outPath = opts.outPath;

  let packageName = basename(resolve(srcRoot, ".."));
  try {
    const modFile = await readFile(join(srcRoot, "go.mod"), "utf-8");
    const match = modFile.match(/^module\s+(\S+)/m);
    if (match?.[1]) packageName = match[1].split("/").pop() ?? packageName;
  } catch {
    try {
      const modFile = await readFile(join(dirname(srcRoot), "go.mod"), "utf-8");
      const match = modFile.match(/^module\s+(\S+)/m);
      if (match?.[1]) packageName = match[1].split("/").pop() ?? packageName;
    } catch {
      /* use dir name */
    }
  }

  const { manifest } = await runGoMap({ srcRoot, format: "json" });

  const result = await analyzeDeadExports(manifest, srcRoot);
  const output = renderText(packageName, result);

  if (outPath) {
    await Bun.write(outPath, output);
    process.stderr.write(
      `Output written to ${outPath} (${(output.length / 1024).toFixed(0)} KB)\n`,
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
    process.stderr.write(
      "Usage: bun devtools/graph/src/cli/go-dead-exports.ts <go-dir> [--out <file>]\n",
    );
    process.exit(1);
  }

  const arg0 = args[0];
  if (!arg0) process.exit(1);
  const srcRoot = resolve(arg0);
  const outIdx = args.indexOf("--out");
  const outPath =
    outIdx !== -1 && args[outIdx + 1]
      ? resolve(args[outIdx + 1] as string)
      : undefined;

  const output = await runGoDeadExports({ srcRoot, outPath });
  if (!outPath) process.stdout.write(output);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`${err}\n`);
    process.exit(1);
  });
}
