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
import { collectTsFiles, collectExports, strip, escapeRegex } from "./utils.js";
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
  if (ENTRY_POINTS.has(base)) return true;
  // CLI modules are standalone entry points by design
  if (modulePath.startsWith("cli/") || modulePath.startsWith("src/cli/")) return true;
  return false;
}

/**
 * Detect standalone script entry points that are meant to be run directly
 * (not imported). These have 0 inbound imports by design.
 *
 * Heuristics:
 * 1. File contains `import.meta.main` or `process.argv` (CLI entry)
 * 2. File is referenced in package.json `bin` or `scripts`
 * 3. File has a shebang line (#!/usr/bin/env)
 */
function isStandaloneScript(content: string): boolean {
  // Check first 5 lines for shebang
  const firstLines = content.slice(0, 500);
  if (firstLines.startsWith("#!")) return true;
  if (/\bimport\.meta\.main\b/.test(content)) return true;
  if (/\bprocess\.argv\b/.test(content)) return true;
  return false;
}

/**
 * Load module paths referenced by package.json exports, bin, and main fields.
 * These are package boundary entry points that should not be flagged as orphans.
 */
async function loadPackageBoundaryModules(srcRoot: string): Promise<Set<string>> {
  const result = new Set<string>();
  const pkgPath = join(srcRoot, "..", "package.json");
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    const paths: string[] = [];

    // main
    if (typeof pkg.main === "string") paths.push(pkg.main);

    // bin
    if (typeof pkg.bin === "string") paths.push(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === "object") paths.push(...Object.values(pkg.bin as Record<string, string>));

    // exports - recursively collect all string values
    function collectExportPaths(obj: unknown): void {
      if (typeof obj === "string") paths.push(obj);
      else if (obj && typeof obj === "object") {
        for (const v of Object.values(obj as Record<string, unknown>)) collectExportPaths(v);
      }
    }
    if (pkg.exports) collectExportPaths(pkg.exports);

    for (const p of paths) {
      // Normalize: strip leading ./, strip extension, strip src/ prefix
      const normalized = p.replace(/^\.\//, "").replace(/\.\w+$/, "").replace(/^src\//, "");
      result.add(normalized);
    }
  } catch { /* no package.json or parse error */ }
  return result;
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
  // Load package boundary modules (exports, bin, main from package.json)
  const boundaryModules = await loadPackageBoundaryModules(srcRoot);

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

  // Collect dynamically imported modules
  const allFiles = await collectTsFiles(srcRoot);
  const fileContents = new Map<string, string>();
  await Promise.all(
    allFiles.map(async (f) => {
      fileContents.set(f, await readFile(f, "utf-8"));
    }),
  );

  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const dynamicallyImported = new Set<string>();
  for (const [, content] of fileContents) {
    let m;
    while ((m = dynamicImportPattern.exec(content)) !== null) {
      const importPath = m[1]!;
      // Normalize: strip .js extension and resolve relative paths
      const normalized = importPath.replace(/\.js$/, "").replace(/^\.\.?\//, "");
      dynamicallyImported.add(normalized);
    }
  }

  // Build module path → absolute file path (needed by both orphan and symbol checks)
  const modToFile = new Map<string, string>();
  for (const f of allFiles) {
    const rel = relative(srcRoot, f).replace(/\.(ts|tsx)$/, "");
    const modPath = "src/" + rel;
    modToFile.set(modPath, f);
    modToFile.set(rel, f);
  }

  for (const mod of manifest.modules) {
    const key = strip(mod.path);
    if (!importedModules.has(mod.path) && !isEntryPoint(key)) {
      // Check if dynamically imported
      const modBasename = key.replace(/^src\//, "");
      const isDynamic = [...dynamicallyImported].some(d => modBasename.endsWith(d) || d.endsWith(modBasename));
      if (isDynamic) continue;

      // Check if this is a standalone script (has shebang, import.meta.main,
      // or process.argv) — these are CLI entry points by design, not orphans.
      const modFile = modToFile.get(mod.path) ?? modToFile.get(key);
      if (modFile) {
        const content = fileContents.get(modFile) ?? "";
        if (isStandaloneScript(content)) continue;
      }

      // Check if this module is a package boundary entry point (exports/bin/main)
      if (boundaryModules.has(strip(mod.path))) continue;

      const exports = collectExports(mod.symbols);
      if (exports.length > 0) {
        orphanModules.push({ module: key, exports });
      }
    }
  }

  // 2. Symbol-level: for non-orphan modules, find exports unused by importers
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
      // Skip likely parser artifacts (loop vars like i, j)
      if (sym.name.length <= 2) continue;
      // Word-boundary check: is the name used in any importing file?
      const symbolName = sym.name;
      const re = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);
      let found = re.test(importerContent);

      // Check for namespace imports: import * as NS from './module'
      // where the symbol is accessed as NS.symbolName
      if (!found) {
        const nsPattern = new RegExp(`\\w+\\.${escapeRegex(symbolName)}\\b`);
        if (nsPattern.test(importerContent)) found = true;
      }

      if (!found) {
        unusedSymbols.push({ module: key, symbol: symbolName, kind: sym.kind });
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
// Main (language-agnostic via lang driver abstraction)
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || args[0] === "--help" || args[0] === "-h") {
    console.error(
      "Usage: bun devtools/graph/src/cli/dead-exports.ts <src-dir> [--out <file>] [--lang typescript|go]",
    );
    process.exit(1);
  }

  const srcRoot = resolve(args[0]!);
  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;

  const langIdx = args.indexOf("--lang");
  const langArg = langIdx !== -1 ? args[langIdx + 1] : undefined;

  // Import lang driver system
  const { detectLanguage, getDriver } = await import("./lang/index.js");

  let driver;
  if (langArg) {
    driver = getDriver(langArg as import("./lang/types.js").LanguageId);
    if (!driver) {
      console.error(`Unknown language: ${langArg}. Supported: typescript, go`);
      process.exit(1);
    }
  } else {
    driver = await detectLanguage(srcRoot);
    if (!driver) {
      console.error(`Could not detect language for ${srcRoot}. Use --lang to specify.`);
      process.exit(1);
    }
  }

  console.error(`Detected language: ${driver.name}`);
  const output = await driver.deadExports({ srcRoot, outPath });
  if (!outPath) process.stdout.write(output);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
