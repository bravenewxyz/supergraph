#!/usr/bin/env bun

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseGo } from "../parser/go-structural.js";
import type { SymbolEdge } from "../schema/edges.js";
import type { SymbolKind, SymbolNode } from "../schema/nodes.js";
import { GraphStore } from "../store/graph-store.js";

// ---------------------------------------------------------------------------
// Types (mirror map.ts PackageManifest exactly)
// ---------------------------------------------------------------------------

interface SymbolSummary {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  signature: string;
  typeText: string;
  body: string;
  exported: boolean;
  modifiers: string[];
  lines: { startLine: number; endLine: number } | null;
  children?: SymbolSummary[];
}

interface ModuleManifest {
  path: string;
  relativePath: string;
  symbols: SymbolSummary[];
  imports: { module: string; raw?: string; typeOnly?: boolean }[];
  internalDeps: string[];
  externalDeps: string[];
  stats: {
    totalSymbols: number;
    exportedSymbols: number;
    functions: number;
    classes: number;
    interfaces: number;
    typeAliases: number;
    variables: number;
  };
}

interface DirectoryManifest {
  path: string;
  modules: string[];
  subdirectories: string[];
}

export interface PackageManifest {
  package: string;
  srcRoot: string;
  generatedAt: string;
  stats: {
    totalFiles: number;
    totalNodes: number;
    totalEdges: number;
    resolvedImports: number;
    unresolvedImports: number;
    nodesByKind: Record<string, number>;
    edgesByKind: Record<string, number>;
  };
  directories: DirectoryManifest[];
  modules: ModuleManifest[];
  dependencyGraph: Record<string, string[]>;
  mostImported: { module: string; importers: number }[];
  largestModules: { module: string; symbolCount: number }[];
}

type OutputFormat = "json" | "text";

// ---------------------------------------------------------------------------
// Go file collection
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "vendor",
  "testdata",
  "node_modules",
  ".git",
  "dist",
  "build",
]);

async function collectGoFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        results.push(...(await collectGoFiles(full)));
    } else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) {
      results.push(full);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Go module name detection
// ---------------------------------------------------------------------------

async function detectGoModulePath(pkgRoot: string): Promise<string | null> {
  let dir = pkgRoot;
  for (let i = 0; i < 5; i++) {
    try {
      const modFile = await readFile(join(dir, "go.mod"), "utf-8");
      const match = modFile.match(/^module\s+(\S+)/m);
      return match?.[1] ?? null;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Go import resolution
// ---------------------------------------------------------------------------

function resolveGoImport(
  importPath: string,
  goModulePath: string | null,
  moduleIdByPath: Map<string, string>,
): string | null {
  if (!goModulePath) return null;
  if (!importPath.startsWith(goModulePath)) return null;

  for (const [modPath, _id] of moduleIdByPath) {
    const modDir = dirname(modPath);
    if (importPath.endsWith(modDir) || importPath === modDir) {
      return modPath;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSymbolSummary(
  store: GraphStore,
  symbol: SymbolNode,
): SymbolSummary {
  const children = store.getChildSymbols(symbol.id);
  const childSummaries =
    children.length > 0 && symbol.kind !== "module"
      ? children
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => buildSymbolSummary(store, c))
      : undefined;

  const body =
    symbol.kind === "interface" ||
    symbol.kind === "type-alias" ||
    symbol.kind === "enum"
      ? symbol.body
      : "";

  return {
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    signature: symbol.signature,
    typeText: symbol.typeText,
    body,
    exported: symbol.exported,
    modifiers: symbol.modifiers,
    lines: symbol.sourceRange,
    children: childSummaries,
  };
}

function collectDirectories(modules: ModuleManifest[]): DirectoryManifest[] {
  const dirMap = new Map<
    string,
    { modules: Set<string>; subdirs: Set<string> }
  >();

  for (const mod of modules) {
    const dir = dirname(mod.relativePath);
    if (!dirMap.has(dir)) {
      dirMap.set(dir, { modules: new Set(), subdirs: new Set() });
    }
    dirMap.get(dir)?.modules.add(mod.relativePath);

    let parent = dirname(dir);
    let child = dir;
    while (parent !== child) {
      if (!dirMap.has(parent)) {
        dirMap.set(parent, { modules: new Set(), subdirs: new Set() });
      }
      dirMap.get(parent)?.subdirs.add(child);
      child = parent;
      parent = dirname(parent);
    }
  }

  return [...dirMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, data]) => ({
      path,
      modules: [...data.modules].sort(),
      subdirectories: [...data.subdirs].sort(),
    }));
}

// ---------------------------------------------------------------------------
// Text renderer (identical notation to map.ts)
// ---------------------------------------------------------------------------

function singleLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

function truncateParams(sig: string, maxParamLen = 60): string {
  const open = sig.indexOf("(");
  if (open === -1) return sig;

  let depth = 0;
  let close = -1;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === "(") depth++;
    else if (sig[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const params =
    close !== -1 ? sig.slice(open + 1, close) : sig.slice(open + 1);
  if (params.length <= maxParamLen) return sig;
  if (close !== -1) return `${sig.slice(0, open)}(…)${sig.slice(close + 1)}`;
  return `${sig.slice(0, open)}(…)`;
}

function compactBody(body: string): string {
  if (!body) return "";
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(\w+)\??(?:\s*[:=(])/);
    if (
      m?.[1] &&
      m[1] !== "type" &&
      m[1] !== "interface" &&
      m[1] !== "struct"
    ) {
      fields.push(m[1]);
    }
  }
  if (fields.length === 0) return "";
  return `{${fields.join(" ")}}`;
}

function formatLineRange(
  lines: { startLine: number; endLine: number } | null,
): string {
  if (!lines) return "";
  return lines.startLine === lines.endLine
    ? `  L${lines.startLine}`
    : `  L${lines.startLine}-${lines.endLine}`;
}

function strip(modulePath: string): string {
  return modulePath;
}

function renderSymbol(sym: SymbolSummary, indent: number): string[] {
  const pad = "  ".repeat(indent);
  const ex = sym.exported ? "+" : " ";
  const mods = sym.modifiers.filter(
    (m) => m !== "const" && m !== "var" && !m.startsWith("receiver:"),
  );
  const modStr = mods.length ? `${mods.join(" ")} ` : "";
  const ln = formatLineRange(sym.lines);
  const result: string[] = [];

  switch (sym.kind) {
    case "interface": {
      const compact = compactBody(sym.body);
      result.push(
        `${pad}${ex}${modStr}${singleLine(sym.signature)}${compact}${ln}`,
      );
      if (sym.children) {
        for (const child of sym.children)
          result.push(...renderSymbol(child, indent + 1));
      }
      break;
    }
    case "type-alias": {
      result.push(`${pad}${ex}${modStr}${singleLine(sym.signature)}${ln}`);
      break;
    }
    case "function": {
      const sig = truncateParams(singleLine(sym.signature));
      result.push(`${pad}${ex}${modStr}fn ${sig}${ln}`);
      break;
    }
    case "class": {
      result.push(`${pad}${ex}${modStr}${singleLine(sym.signature)}${ln}`);
      if (sym.children) {
        for (const child of sym.children)
          result.push(...renderSymbol(child, indent + 1));
      }
      break;
    }
    case "method": {
      const sig = truncateParams(singleLine(sym.signature));
      result.push(`${pad}${ex}${modStr}method ${sig}${ln}`);
      break;
    }
    case "property": {
      result.push(`${pad}${ex}${modStr}prop ${singleLine(sym.signature)}${ln}`);
      break;
    }
    case "variable": {
      const sig = singleLine(sym.signature);
      const declKind = sym.modifiers.includes("const") ? "const" : "var";
      const fullSig =
        sig.startsWith("const ") || sig.startsWith("var ")
          ? sig
          : `${declKind} ${sig}`;
      result.push(`${pad}${ex}${modStr}${fullSig}${ln}`);
      break;
    }
    default: {
      result.push(
        `${pad}${ex}${modStr}${sym.kind} ${singleLine(sym.signature)}${ln}`,
      );
      break;
    }
  }

  return result;
}

function renderText(manifest: PackageManifest): string {
  const lines: string[] = [];
  const s = manifest.stats;

  lines.push(`# ${manifest.package}`);
  lines.push(
    `${s.totalFiles} files | ${s.totalNodes} nodes | ${s.totalEdges} edges | ${s.resolvedImports}/${s.resolvedImports + s.unresolvedImports} imports resolved`,
  );
  lines.push(
    `Nodes: ${Object.entries(s.nodesByKind)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}`,
  );
  lines.push("");
  lines.push("## Modules");
  lines.push("");

  for (const mod of manifest.modules) {
    lines.push(
      `━━━ ${strip(mod.path)}  (${mod.stats.totalSymbols}/${mod.stats.exportedSymbols}) ━━━`,
    );

    const intDeps = mod.internalDeps.map(strip).join(", ");
    const extDeps = mod.externalDeps.join(", ");
    if (intDeps) lines.push(`← ${intDeps}`);
    if (extDeps) lines.push(`←ext ${extDeps}`);

    for (const sym of mod.symbols) {
      lines.push(...renderSymbol(sym, 0));
    }
    lines.push("");
  }

  return lines.join("\n");
}

function findCycles(graph: Record<string, string[]>): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  const allNodes = new Set([
    ...Object.keys(graph),
    ...Object.values(graph).flat(),
  ]);
  for (const n of allNodes) color.set(n, WHITE);

  const cycles: string[][] = [];
  const seen = new Set<string>();

  function dfs(node: string, path: string[]): void {
    color.set(node, GRAY);
    path.push(node);
    for (const nb of graph[node] ?? []) {
      if (color.get(nb) === GRAY) {
        const start = path.indexOf(nb);
        const cycle = path.slice(start);
        const minIdx = cycle.indexOf([...cycle].sort()[0] ?? "");
        const canonical = [
          ...cycle.slice(minIdx),
          ...cycle.slice(0, minIdx),
        ].join("→");
        if (!seen.has(canonical)) {
          seen.add(canonical);
          cycles.push(cycle);
        }
      } else if (color.get(nb) === WHITE) {
        dfs(nb, path);
      }
    }
    path.pop();
    color.set(node, BLACK);
  }

  for (const node of allNodes) {
    if (color.get(node) === WHITE) dfs(node, []);
  }
  return cycles;
}

function renderDepsText(manifest: PackageManifest): string {
  const lines: string[] = [];
  lines.push(`# ${manifest.package} — Dependency Graph`);
  lines.push(`${manifest.stats.totalFiles} modules`);
  lines.push("");
  for (const [from, tos] of Object.entries(manifest.dependencyGraph)) {
    lines.push(`${strip(from)} → ${(tos as string[]).map(strip).join(", ")}`);
  }
  const cycles = findCycles(manifest.dependencyGraph);
  lines.push("");
  lines.push("## Circular Dependencies");
  lines.push("");
  if (cycles.length === 0) {
    lines.push("none");
  } else {
    for (const cycle of cycles)
      lines.push(`cycle: ${cycle.join(" → ")} → ${cycle[0]}`);
    lines.push(`\n${cycles.length} cycle(s) found`);
  }
  return `${lines.join("\n")}\n`;
}

function renderImportsText(manifest: PackageManifest): string {
  const lines: string[] = [];
  lines.push(`# ${manifest.package} — Import Frequency`);
  lines.push(
    `${manifest.mostImported.length} modules sorted by number of internal importers`,
  );
  lines.push("");
  for (const mi of manifest.mostImported) {
    lines.push(`${mi.importers}× ${strip(mi.module)}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export interface GoMapOptions {
  srcRoot: string;
  format?: "json" | "text";
  outPath?: string;
}

export async function runGoMap(opts: GoMapOptions): Promise<{ manifest: PackageManifest; output: string }> {
  const srcRoot = opts.srcRoot;
  const format: OutputFormat = opts.format ?? "json";
  const outPath = opts.outPath;

  try {
    await stat(srcRoot);
  } catch {
    throw new Error(`Directory not found: ${srcRoot}`);
  }

  const goModulePath = await detectGoModulePath(srcRoot);
  const packageName = goModulePath
    ? (goModulePath.split("/").pop() ?? basename(srcRoot))
    : basename(srcRoot);

  process.stderr.write(
    `Analyzing Go package ${packageName} at ${srcRoot}...\n`,
  );
  if (goModulePath) process.stderr.write(`Go module: ${goModulePath}\n`);

  const files = await collectGoFiles(srcRoot);
  process.stderr.write(`Found ${files.length} Go source files\n`);

  if (files.length === 0) {
    throw new Error("No Go files found.");
  }

  const store = new GraphStore();
  const unresolvedEdges: SymbolEdge[] = [];
  const moduleIdByPath = new Map<string, string>();

  for (const file of files) {
    const code = await readFile(file, "utf-8");
    const relPath = relative(srcRoot, file);
    const result = parseGo(code, relPath);

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

  // Resolve Go imports: match import paths to local modules
  let resolvedCount = 0;
  for (const edge of unresolvedEdges) {
    if (edge.kind === "imports" && edge.metadata?.moduleSpecifier) {
      const importPath = edge.metadata.moduleSpecifier as string;
      // Try direct match by last path segments
      const resolved = resolveGoImport(
        importPath,
        goModulePath,
        moduleIdByPath,
      );
      if (resolved) {
        const targetId = moduleIdByPath.get(resolved);
        if (targetId) {
          try {
            store.addEdge({ ...edge, targetId });
            resolvedCount++;
          } catch {
            /* skip */
          }
        }
      }
    }
  }

  const allSymbols = store.getAllSymbols();
  const allEdges = store.getAllEdges();
  const modules = allSymbols.filter((s) => s.kind === "module");

  const moduleManifests: ModuleManifest[] = modules
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))
    .map((mod) => {
      const children = store.getChildSymbols(mod.id);
      const outEdges = store.getEdgesFrom(mod.id);
      const importEdges = outEdges.filter((e) => e.kind === "imports");

      const internalDeps: string[] = [];
      const externalDeps: string[] = [];
      const imports: ModuleManifest["imports"] = [];

      for (const ie of importEdges) {
        const target = store.getSymbol(ie.targetId);
        if (target && target.kind === "module") {
          internalDeps.push(target.qualifiedName);
          imports.push({
            module: target.qualifiedName,
            raw: ie.metadata?.raw as string | undefined,
          });
        }
      }

      for (const ue of unresolvedEdges) {
        if (ue.sourceId === mod.id && ue.metadata?.moduleSpecifier) {
          const spec = ue.metadata.moduleSpecifier as string;
          externalDeps.push(spec);
          imports.push({
            module: spec,
            raw: ue.metadata?.raw as string | undefined,
          });
        }
      }

      const topLevel = children.filter((c) => c.parentId === mod.id);
      const symbolSummaries = topLevel
        .sort((a, b) => {
          const kindOrder: Record<string, number> = {
            interface: 0,
            "type-alias": 1,
            class: 2,
            function: 3,
            variable: 4,
            enum: 5,
          };
          const ka = kindOrder[a.kind] ?? 9;
          const kb = kindOrder[b.kind] ?? 9;
          return ka !== kb ? ka - kb : a.name.localeCompare(b.name);
        })
        .map((s) => buildSymbolSummary(store, s));

      return {
        path: mod.qualifiedName,
        relativePath: mod.qualifiedName,
        symbols: symbolSummaries,
        imports,
        internalDeps: [...new Set(internalDeps)].sort(),
        externalDeps: [...new Set(externalDeps)].sort(),
        stats: {
          totalSymbols: children.length,
          exportedSymbols: children.filter((c) => c.exported).length,
          functions: children.filter((c) => c.kind === "function").length,
          classes: children.filter((c) => c.kind === "class").length,
          interfaces: children.filter((c) => c.kind === "interface").length,
          typeAliases: children.filter((c) => c.kind === "type-alias").length,
          variables: children.filter(
            (c) => c.kind === "variable" || c.kind === "property",
          ).length,
        },
      };
    });

  const depGraph: Record<string, string[]> = {};
  for (const mod of moduleManifests) {
    if (mod.internalDeps.length > 0) depGraph[mod.path] = mod.internalDeps;
  }

  const inboundCounts = new Map<string, number>();
  for (const mod of moduleManifests) {
    for (const dep of mod.internalDeps)
      inboundCounts.set(dep, (inboundCounts.get(dep) ?? 0) + 1);
  }
  const mostImported = [...inboundCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([module, importers]) => ({ module, importers }));

  const largestModules = moduleManifests
    .map((m) => ({ module: m.path, symbolCount: m.stats.totalSymbols }))
    .sort((a, b) => b.symbolCount - a.symbolCount)
    .slice(0, 25);

  const nodesByKind: Record<string, number> = {};
  for (const s of allSymbols)
    nodesByKind[s.kind] = (nodesByKind[s.kind] ?? 0) + 1;
  const edgesByKind: Record<string, number> = {};
  for (const e of allEdges)
    edgesByKind[e.kind] = (edgesByKind[e.kind] ?? 0) + 1;

  const manifest: PackageManifest = {
    package: packageName,
    srcRoot: relative(process.cwd(), srcRoot),
    generatedAt: new Date().toISOString(),
    stats: {
      totalFiles: files.length,
      totalNodes: store.nodeCount,
      totalEdges: store.edgeCount,
      resolvedImports: resolvedCount,
      unresolvedImports: unresolvedEdges.length - resolvedCount,
      nodesByKind,
      edgesByKind,
    },
    directories: collectDirectories(moduleManifests),
    modules: moduleManifests,
    dependencyGraph: depGraph,
    mostImported,
    largestModules,
  };

  let output: string;
  if (format === "text") {
    output = renderText(manifest);
  } else {
    output = JSON.stringify(manifest, null, 2);
  }

  if (outPath) {
    await Bun.write(outPath, output);
    process.stderr.write(
      `Output written to ${outPath} (${(output.length / 1024).toFixed(0)} KB, format: ${format})\n`,
    );
    if (format === "text") {
      const outDir = dirname(outPath);
      const depsOutput = renderDepsText(manifest);
      const importsOutput = renderImportsText(manifest);
      await Promise.all([
        Bun.write(join(outDir, "deps.txt"), depsOutput),
        Bun.write(join(outDir, "imports.txt"), importsOutput),
      ]);
    }
  }

  process.stderr.write(
    `\nDone: ${store.nodeCount} nodes, ${store.edgeCount} edges, ${resolvedCount} resolved imports\n`,
  );

  return { manifest, output };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stderr.write(
      "Usage: bun devtools/graph/src/cli/go-map.ts <go-package-dir> [--format json|text] [--out <file>]\n",
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
  const fmtIdx = args.indexOf("--format");
  const format = fmtIdx !== -1 && args[fmtIdx + 1] === "text" ? "text" as const : "json" as const;

  const { output } = await runGoMap({ srcRoot, format, outPath });
  if (!outPath) process.stdout.write(output);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`${err}\n`);
    process.exit(1);
  });
}
