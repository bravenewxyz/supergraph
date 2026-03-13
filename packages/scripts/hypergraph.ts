#!/usr/bin/env bun

import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { loadConfig } from "../flow/src/cli/config.js";
import { readFile } from "./utils.js";

// ---------------------------------------------------------------------------
// Types — richer than supergraph.ts to capture full symbol data
// ---------------------------------------------------------------------------

type RawSymbol = {
  name: string;
  qualifiedName: string;
  kind: string;
  signature: string;
  typeText: string;
  body: string;
  exported: boolean;
  modifiers: string[];
  lines: { startLine: number; endLine: number } | null;
  children?: RawSymbol[];
};

type RawModule = {
  path: string;
  relativePath: string;
  symbols: RawSymbol[];
  imports: { module: string; raw?: string; typeOnly?: boolean }[];
  internalDeps: string[];
  externalDeps: string[];
  stats: { totalSymbols: number; exportedSymbols: number };
};

type RawMap = {
  package: string;
  srcRoot: string;
  modules: RawModule[];
  dependencyGraph: Record<string, string[]>;
};

type HyperNode = {
  idx: number;
  path: string;
  pkg: string;
  pkgName: string;
  originalPath: string;
  symbols: RawSymbol[];
  imports: RawModule["imports"];
  internalDeps: string[];
  externalDeps: string[];
  stats: { totalSymbols: number; exportedSymbols: number };
  source: string;
};

type HyperEdge = { source: number; target: number; cross: boolean };

type HyperGraph = {
  generated: string;
  nodes: HyperNode[];
  edges: HyperEdge[];
  packages: { short: string; pkgName: string; moduleCount: number }[];
  stats: {
    totalModules: number;
    totalSymbols: number;
    totalEdges: number;
    crossEdges: number;
  };
};

// ---------------------------------------------------------------------------
// Source file reading
// ---------------------------------------------------------------------------

const sourceCache = new Map<string, string>();

async function readSourceFile(root: string, srcRoot: string, modulePath: string): Promise<string> {
  const pkgRoot = dirname(srcRoot);
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const fullPath = resolve(root, pkgRoot, modulePath + ext);
    if (sourceCache.has(fullPath)) return sourceCache.get(fullPath)!;
    const content = await readFile(fullPath);
    if (content) {
      sourceCache.set(fullPath, content);
      return content;
    }
  }
  return "";
}

function extractLines(source: string, range: { startLine: number; endLine: number } | null): string {
  if (!range || !source) return "";
  const lines = source.split("\n");
  return lines.slice(range.startLine - 1, range.endLine).join("\n");
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

async function buildHypergraph(
  auditDir: string,
  root: string,
): Promise<HyperGraph> {
  let auditEntries: string[] = [];
  try {
    const entries = await readdir(auditDir, { withFileTypes: true });
    auditEntries = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {}

  const pkgMaps: { short: string; map: RawMap }[] = [];

  for (const short of auditEntries) {
    try {
      const raw = await readFile(join(auditDir, short, "json/map.json"));
      if (!raw) continue;
      const map: RawMap = JSON.parse(raw);
      pkgMaps.push({ short, map });
    } catch {}
  }

  const pkgNameToShort: Record<string, string> = {};
  for (const { short, map } of pkgMaps) {
    pkgNameToShort[map.package] = short;
  }
  const pkgNamesSorted = Object.keys(pkgNameToShort).sort(
    (a, b) => b.length - a.length,
  );

  const nodes: HyperNode[] = [];
  const pathToIdx: Record<string, number> = {};
  let totalSymbols = 0;

  for (const { short, map } of pkgMaps) {
    for (const mod of map.modules ?? []) {
      const prefixed = `${short}/${mod.path}`;
      if (pathToIdx[prefixed] !== undefined) continue;
      const idx = nodes.length;
      pathToIdx[prefixed] = idx;

      const source = await readSourceFile(root, map.srcRoot, mod.path);
      totalSymbols += mod.stats?.totalSymbols ?? 0;

      nodes.push({
        idx,
        path: prefixed,
        pkg: short,
        pkgName: map.package,
        originalPath: mod.path,
        symbols: mod.symbols ?? [],
        imports: mod.imports ?? [],
        internalDeps: mod.internalDeps ?? [],
        externalDeps: (mod.externalDeps ?? []).filter((d) => !d.startsWith("@/")),
        stats: mod.stats ?? { totalSymbols: 0, exportedSymbols: 0 },
        source,
      });
    }
  }

  // Internal edges (within package)
  const edges: HyperEdge[] = [];
  const edgeSet = new Set<string>();
  function addEdge(si: number, ti: number, cross: boolean) {
    if (si === ti || si === undefined || ti === undefined) return;
    const key = `${si}:${ti}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ source: si, target: ti, cross });
  }

  for (const { short, map } of pkgMaps) {
    for (const [src, targets] of Object.entries(map.dependencyGraph ?? {})) {
      const si = pathToIdx[`${short}/${src}`];
      if (si === undefined) continue;
      for (const tgt of targets) {
        const ti = pathToIdx[`${short}/${tgt}`];
        if (ti !== undefined) addEdge(si, ti, false);
      }
    }
  }

  // Cross-package edges
  for (const { short, map } of pkgMaps) {
    for (const mod of map.modules ?? []) {
      const si = pathToIdx[`${short}/${mod.path}`];
      if (si === undefined) continue;
      const seen = new Set<number>();
      for (const imp of mod.imports ?? []) {
        for (const pkgName of pkgNamesSorted) {
          if (!imp.module.startsWith(pkgName)) continue;
          const targetShort = pkgNameToShort[pkgName];
          if (!targetShort || targetShort === short) break;
          const subpath = imp.module.slice(pkgName.length).replace(/^\//, "");
          let targetPath: string | null = null;
          if (!subpath) {
            for (const c of [`${targetShort}/src/index`, `${targetShort}/src/main`]) {
              if (pathToIdx[c] !== undefined) { targetPath = c; break; }
            }
          } else {
            for (const c of [`${targetShort}/src/${subpath}`, `${targetShort}/src/${subpath}/index`]) {
              if (pathToIdx[c] !== undefined) { targetPath = c; break; }
            }
            if (!targetPath) {
              const fb = `${targetShort}/src/index`;
              if (pathToIdx[fb] !== undefined) targetPath = fb;
            }
          }
          if (targetPath !== null) {
            const ti = pathToIdx[targetPath];
            if (ti !== undefined && !seen.has(ti)) {
              seen.add(ti);
              addEdge(si, ti, true);
            }
          }
          break;
        }
      }
    }
  }

  const byPackage: Record<string, number> = {};
  for (const n of nodes) byPackage[n.pkg] = (byPackage[n.pkg] ?? 0) + 1;

  return {
    generated: new Date().toISOString(),
    nodes,
    edges,
    packages: Object.entries(byPackage)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([short, moduleCount]) => ({
        short,
        pkgName: pkgMaps.find((p) => p.short === short)?.map.package ?? short,
        moduleCount,
      })),
    stats: {
      totalModules: nodes.length,
      totalSymbols,
      totalEdges: edges.length,
      crossEdges: edges.filter((e) => e.cross).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

const KIND_SHORT: Record<string, string> = {
  function: "fn",
  method: "method",
  class: "class",
  interface: "interface",
  "type-alias": "type",
  enum: "enum",
  variable: "const",
  property: "prop",
  namespace: "ns",
  "enum-member": "member",
  test: "test",
};

function strip(p: string): string {
  return p.replace(/^src\//, "");
}

function fmtLines(lines: { startLine: number; endLine: number } | null): string {
  if (!lines) return "";
  return lines.startLine === lines.endLine
    ? `  L${lines.startLine}`
    : `  L${lines.startLine}-${lines.endLine}`;
}

function renderSymbolHeader(sym: RawSymbol, indent = 0): string {
  const pad = "  ".repeat(indent);
  const ex = sym.exported ? "+" : " ";
  const mods = (sym.modifiers ?? [])
    .filter((m) => m !== "const" && m !== "let" && m !== "export" && m !== "default")
    .join(" ");
  const modStr = mods ? `${mods} ` : "";
  const kind = KIND_SHORT[sym.kind] ?? sym.kind;
  const sig = sym.signature ? sym.signature.replace(/\s*\n\s*/g, " ").trim() : sym.name;
  return `${pad}${ex}${modStr}${kind} ${sig}${fmtLines(sym.lines)}`;
}

function renderHypergraph(data: HyperGraph): string {
  const out: string[] = [];
  const bar = "═".repeat(72);

  out.push(`HYPERGRAPH | ${new Date().toISOString().slice(0, 10)}`);
  out.push(
    `${data.packages.length} packages · ${data.stats.totalModules} modules · ${data.stats.totalSymbols} symbols · ${data.stats.totalEdges} edges (${data.stats.crossEdges} cross-pkg)`,
  );
  out.push("");

  // Build reverse-edge index: node idx → list of cross-pkg importer paths
  const crossImporters = new Map<number, string[]>();
  for (const e of data.edges) {
    if (!e.cross) continue;
    const src = data.nodes[e.source];
    if (!src) continue;
    const list = crossImporters.get(e.target) ?? [];
    list.push(`[${src.pkg}] ${strip(src.originalPath)}`);
    crossImporters.set(e.target, list);
  }

  // Render by package
  let currentPkg = "";
  for (const node of data.nodes) {
    if (node.pkg !== currentPkg) {
      currentPkg = node.pkg;
      out.push(bar);
      const pkgInfo = data.packages.find((p) => p.short === currentPkg);
      out.push(
        `[${currentPkg}]  ${pkgInfo?.pkgName ?? currentPkg} — ${pkgInfo?.moduleCount ?? "?"} modules`,
      );
      out.push(bar);
      out.push("");
    }

    const modPath = strip(node.originalPath);
    const { totalSymbols: tot, exportedSymbols: exp } = node.stats;
    out.push(`── ${modPath}  (${exp}/${tot}) ${"─".repeat(Math.max(1, 60 - modPath.length))}`);

    // Internal deps
    if (node.internalDeps.length > 0) {
      out.push(`← ${node.internalDeps.map(strip).join(", ")}`);
    }

    // Cross-package deps (from this module's imports)
    const crossDeps: string[] = [];
    for (const e of data.edges) {
      if (!e.cross || e.source !== node.idx) continue;
      const tgt = data.nodes[e.target];
      if (tgt) crossDeps.push(`[${tgt.pkg}] ${strip(tgt.originalPath)}`);
    }
    if (crossDeps.length > 0) {
      out.push(`← ${crossDeps.join(", ")}  (cross-pkg)`);
    }

    // External deps
    if (node.externalDeps.length > 0) {
      out.push(`←ext ${node.externalDeps.join(", ")}`);
    }

    // Cross-package importers
    const importers = crossImporters.get(node.idx);
    if (importers && importers.length > 0) {
      const shown = importers.slice(0, 8);
      const suffix = importers.length > 8 ? ` (+${importers.length - 8} more)` : "";
      out.push(`→ ${shown.join(", ")}${suffix}`);
    }

    out.push("");

    // Symbol index with full bodies
    for (const sym of node.symbols) {
      out.push(renderSymbolHeader(sym));

      // Full body: extract from source file using line range
      const body = sym.lines && node.source
        ? extractLines(node.source, sym.lines)
        : sym.body || "";

      if (body) {
        for (const line of body.split("\n")) {
          out.push(`  ${line}`);
        }
      }

      // Render children (class methods, enum members, etc.)
      if (sym.children && sym.children.length > 0) {
        for (const child of sym.children) {
          out.push(renderSymbolHeader(child, 1));
          const childBody = child.lines && node.source
            ? extractLines(node.source, child.lines)
            : child.body || "";
          if (childBody) {
            for (const line of childBody.split("\n")) {
              out.push(`    ${line}`);
            }
          }
        }
      }
      out.push("");
    }
  }

  // Cross-package edges summary
  out.push(bar);
  out.push("CROSS-PACKAGE EDGES");
  out.push(bar);
  out.push("");

  const crossBySource = new Map<string, string[]>();
  for (const e of data.edges) {
    if (!e.cross) continue;
    const src = data.nodes[e.source];
    const tgt = data.nodes[e.target];
    if (!src || !tgt) continue;
    const key = `${src.pkg}/${strip(src.originalPath)}`;
    const list = crossBySource.get(key) ?? [];
    list.push(`${tgt.pkg}/${strip(tgt.originalPath)}`);
    crossBySource.set(key, list);
  }

  for (const [src, targets] of [...crossBySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`${src} → ${targets.join(" ")}`);
  }

  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HypergraphOptions {
  root: string;
}

export async function runHypergraph(opts: HypergraphOptions): Promise<void> {
  const root = opts.root;
  const auditDir = resolve(root, "audit/packages");

  console.log("Building hypergraph from audit data + source files...");
  const t0 = Date.now();
  const data = await buildHypergraph(auditDir, root);

  const text = renderHypergraph(data);

  await mkdir(resolve(root, "audit"), { recursive: true });
  const outPath = resolve(root, "audit/hypergraph.txt");
  await Bun.write(outPath, text);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(
    `  ${data.packages.length} packages · ${data.stats.totalModules} modules · ${data.stats.totalSymbols} symbols`,
  );
  console.log(`  ${(text.length / 1024).toFixed(0)} KB → ${relative(root, outPath)}`);
  console.log(`Done in ${elapsed}s`);
}
