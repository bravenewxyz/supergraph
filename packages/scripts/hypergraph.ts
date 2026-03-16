#!/usr/bin/env bun

import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { loadConfig } from "../flow/src/cli/config.js";
import { readFile } from "./utils.js";
import type {
  GraphRawSymbol as RawSymbol,
  GraphRawModule as RawModule,
  GraphRawMap as RawMap,
  GraphNode as HyperNode,
  GraphEdge as HyperEdge,
} from "./shared.js";

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

/**
 * Strip the function/method declaration preamble from a body string.
 * The header already carries the full signature, so the body only needs
 * the implementation lines (everything after the opening `{`).
 * Also strips the final closing `}` that matches the opening brace.
 */
function stripPreambleAndClosing(body: string): string {
  const lines = body.split("\n");
  // Find the first line containing the opening brace of the function body
  let braceIdx = -1;
  let braceDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") { braceDepth++; if (braceDepth === 1) { braceIdx = i; break; } }
    }
    if (braceIdx >= 0) break;
  }
  if (braceIdx < 0) return body; // no brace found — return as-is (arrow expression, etc.)

  // Take everything after the opening-brace line
  const inner = lines.slice(braceIdx + 1);

  // Strip the final closing brace (last non-empty line that is just `}` or `};`)
  for (let i = inner.length - 1; i >= 0; i--) {
    const trimmed = inner[i]!.trim();
    if (!trimmed) continue;
    if (trimmed === "}" || trimmed === "};") inner.splice(i, 1);
    break;
  }

  return inner.join("\n");
}

/**
 * Dedent a block of code: find the minimum leading whitespace across all
 * non-empty lines and remove that many characters from each line.
 */
function dedent(text: string): string {
  const lines = text.split("\n");
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === 0 || minIndent === Infinity) return text;
  return lines
    .map((line) => (line.trim() ? line.slice(minIndent) : ""))
    .join("\n");
}

/** Should we strip the preamble for this symbol kind? */
const STRIP_PREAMBLE_KINDS = new Set(["function", "method", "class", "interface", "type-alias", "enum"]);

/** Should we skip the full body and only render children? */
function shouldSkipBody(sym: RawSymbol): boolean {
  return (
    (sym.kind === "class" || sym.kind === "interface") &&
    sym.children !== undefined &&
    sym.children.length > 0
  );
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
  let sig = sym.signature ? sym.signature.replace(/\s*\n\s*/g, " ").trim() : sym.name;
  // Strip leading keyword from signature when it duplicates the kind label
  // e.g. "interface Foo" → "Foo" when kind is already "interface"
  const kindWords: Record<string, string> = {
    interface: "interface ", "type-alias": "type ", enum: "enum ", class: "class ", namespace: "namespace ",
  };
  const prefix = kindWords[sym.kind];
  if (prefix && sig.startsWith(prefix)) sig = sig.slice(prefix.length);
  return `${pad}${ex}${modStr}${kind} ${sig}${fmtLines(sym.lines)}`;
}

function renderHypergraph(data: HyperGraph): string {
  const out: string[] = [];
  const bar = "═".repeat(40);

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
    out.push(`── ${modPath}  (${exp}/${tot}) ──`);

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

    // Symbol index with compact bodies
    for (const sym of node.symbols) {
      out.push(renderSymbolHeader(sym));

      if (shouldSkipBody(sym)) {
        // Class/interface with children: skip full body, render children only
        // (children already contain all methods/properties — no duplication)
      } else {
        let body = sym.lines && node.source
          ? extractLines(node.source, sym.lines)
          : sym.body || "";

        if (body) {
          // Strip declaration preamble + closing brace for known kinds
          if (STRIP_PREAMBLE_KINDS.has(sym.kind)) body = stripPreambleAndClosing(body);
          body = dedent(body);
          // Emit body lines, trimming trailing whitespace
          for (const line of body.split("\n")) {
            const trimmed = line.trimEnd();
            if (trimmed) out.push(`  ${trimmed}`);
          }
        }
      }

      // Render children (class methods, enum members, etc.)
      if (sym.children && sym.children.length > 0) {
        for (const child of sym.children) {
          out.push(renderSymbolHeader(child, 1));
          let childBody = child.lines && node.source
            ? extractLines(node.source, child.lines)
            : child.body || "";
          if (childBody) {
            if (STRIP_PREAMBLE_KINDS.has(child.kind)) childBody = stripPreambleAndClosing(childBody);
            childBody = dedent(childBody);
            for (const line of childBody.split("\n")) {
              const trimmed = line.trimEnd();
              if (trimmed) out.push(`    ${trimmed}`);
            }
          }
        }
      }
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
