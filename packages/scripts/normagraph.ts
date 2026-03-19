#!/usr/bin/env bun

import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readFile } from "./utils.js";

// ── Discovery JSON types ──────────────────────────────────────────────────────
type DiscoveryFunction = {
  name: string;
  filePath: string;
  line: number;
  purityScore: number;
};
type DiscoveryDuplicate = {
  functions: { name: string; filePath: string; line: number }[];
  similarity: number;
};
type DiscoveryHub = { name: string; filePath: string; line: number; callers: number };
type DiscoveryJson = {
  functions?: DiscoveryFunction[];
  duplicates?: DiscoveryDuplicate[];
  callGraph?: { hubDetails?: DiscoveryHub[] };
};
import type {
  GraphRawSymbol as RawSymbol,
  GraphRawModule as RawModule,
  GraphRawMap as RawMap,
  GraphNode as NormaNode,
  GraphEdge as NormaEdge,
  BaseGraphOutput,
} from "./shared.js";

export type DetailLevel = "sig" | "brief" | "full";

type NormaGraph = BaseGraphOutput<NormaNode, NormaEdge, {
  totalModules: number;
  totalSymbols: number;
  totalEdges: number;
  crossEdges: number;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
}> & {
  packages: { short: string; pkgName: string; moduleCount: number }[];
  discoveryData: Map<string, DiscoveryJson>;
};

// ---------------------------------------------------------------------------
// Complexity estimation + call extraction
// ---------------------------------------------------------------------------

const BRANCH_PATTERN = /\b(if|else\s+if|case|for|while|do|catch)\b|\?\?|\|\||&&/g;

function roughCC(source: string): number {
  const matches = source.match(BRANCH_PATTERN);
  return 1 + (matches?.length ?? 0);
}

const CALL_PATTERN = /\b([a-zA-Z_$][\w$]*)\s*\(/g;
const KEYWORDS = new Set([
  "if", "for", "while", "do", "switch", "catch", "return", "throw", "typeof",
  "instanceof", "new", "await", "yield", "import", "export", "function", "class",
  "const", "let", "var", "delete", "void", "Array", "Object", "String", "Number",
  "Boolean", "Promise", "Map", "Set", "Error", "console", "Math", "JSON", "Date",
  "parseInt", "parseFloat", "require",
]);

function extractCalls(source: string): string[] {
  const calls = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(CALL_PATTERN.source, "g");
  while ((match = re.exec(source)) !== null) {
    const name = match[1]!;
    if (!KEYWORDS.has(name) && name.length > 1) calls.add(name);
  }
  return [...calls].slice(0, 12);
}

type Tier = "full" | "brief" | "sig";

const TYPE_KINDS = new Set(["interface", "type-alias", "enum"]);

function classifySymbol(sym: RawSymbol, source: string, bodyText: string): Tier {
  if (TYPE_KINDS.has(sym.kind)) return "full";
  if (sym.kind === "variable" || sym.kind === "enum-member") return "sig";
  const cc = roughCC(bodyText);
  if (cc > 5) return "full";
  if (cc >= 3) return "brief";
  return "sig";
}

// ---------------------------------------------------------------------------
// Source reading
// ---------------------------------------------------------------------------

async function readSourceFile(root: string, srcRoot: string, modulePath: string, cache: Map<string, string>): Promise<string> {
  const pkgRoot = dirname(srcRoot);
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const fullPath = resolve(root, pkgRoot, modulePath + ext);
    if (cache.has(fullPath)) return cache.get(fullPath)!;
    const content = await readFile(fullPath);
    if (content) {
      cache.set(fullPath, content);
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
// Body formatting helpers (used by --detail full)
// ---------------------------------------------------------------------------

/**
 * Strip the function/method declaration preamble from a body string.
 * The header already carries the full signature, so the body only needs
 * the implementation lines (everything after the opening `{`).
 * Also strips the final closing `}` that matches the opening brace.
 */
function stripPreambleAndClosing(body: string): string {
  const lines = body.split("\n");
  let braceIdx = -1;
  let braceDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") { braceDepth++; if (braceDepth === 1) { braceIdx = i; break; } }
    }
    if (braceIdx >= 0) break;
  }
  if (braceIdx < 0) return body;

  const inner = lines.slice(braceIdx + 1);

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

async function buildNormagraph(auditDir: string, root: string): Promise<NormaGraph> {
  let auditEntries: string[] = [];
  try {
    const entries = await readdir(auditDir, { withFileTypes: true });
    auditEntries = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {}

  const pkgMaps: { short: string; map: RawMap }[] = [];
  const discoveryData = new Map<string, DiscoveryJson>();
  for (const short of auditEntries) {
    try {
      const raw = await readFile(join(auditDir, short, "json/map.json"));
      if (!raw) continue;
      pkgMaps.push({ short, map: JSON.parse(raw) });
    } catch {}
    try {
      const raw = await readFile(join(auditDir, short, "json/discovery.json"));
      if (raw) discoveryData.set(short, JSON.parse(raw));
    } catch {}
  }

  const pkgNameToShort: Record<string, string> = {};
  for (const { short, map } of pkgMaps) pkgNameToShort[map.package] = short;
  const pkgNamesSorted = Object.keys(pkgNameToShort).sort((a, b) => b.length - a.length);

  const nodes: NormaNode[] = [];
  const pathToIdx: Record<string, number> = {};
  let totalSymbols = 0;
  const sourceCache = new Map<string, string>();

  for (const { short, map } of pkgMaps) {
    for (const mod of map.modules ?? []) {
      const prefixed = `${short}/${mod.path}`;
      if (pathToIdx[prefixed] !== undefined) continue;
      const idx = nodes.length;
      pathToIdx[prefixed] = idx;
      const source = await readSourceFile(root, map.srcRoot, mod.path, sourceCache);
      totalSymbols += mod.stats?.totalSymbols ?? 0;
      nodes.push({
        idx, path: prefixed, pkg: short, pkgName: map.package,
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

  // Edges
  const edges: NormaEdge[] = [];
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
            if (ti !== undefined && !seen.has(ti)) { seen.add(ti); addEdge(si, ti, true); }
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
    nodes, edges,
    packages: Object.entries(byPackage).sort(([a], [b]) => a.localeCompare(b))
      .map(([short, moduleCount]) => ({
        short, pkgName: pkgMaps.find((p) => p.short === short)?.map.package ?? short, moduleCount,
      })),
    stats: {
      totalModules: nodes.length, totalSymbols, totalEdges: edges.length,
      crossEdges: edges.filter((e) => e.cross).length,
      tier1Count: 0, tier2Count: 0, tier3Count: 0,
    },
    discoveryData,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const KIND_SHORT: Record<string, string> = {
  function: "fn", method: "method", class: "class", interface: "interface",
  "type-alias": "type", enum: "enum", variable: "const", property: "prop",
  namespace: "ns", "enum-member": "member", test: "test",
};

function strip(p: string): string { return p.replace(/^src\//, ""); }

function fmtSig(sym: RawSymbol): string {
  let sig = sym.signature ? sym.signature.replace(/\s*\n\s*/g, " ").trim() : sym.name;
  const kindWords: Record<string, string> = {
    interface: "interface ", "type-alias": "type ", enum: "enum ", class: "class ", namespace: "namespace ",
  };
  const prefix = kindWords[sym.kind];
  if (prefix && sig.startsWith(prefix)) sig = sig.slice(prefix.length);
  return sig;
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
  const sig = fmtSig(sym);
  return `${pad}${ex}${modStr}${kind} ${sig}${fmtLines(sym.lines)}`;
}

// ---------------------------------------------------------------------------
// Render: --detail full (symbols-full-style)
// ---------------------------------------------------------------------------

function renderFull(data: NormaGraph): string {
  const out: string[] = [];
  const bar = "═".repeat(40);

  out.push(`SYMBOLS-FULL | ${new Date().toISOString().slice(0, 10)}`);
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
      } else {
        let body = sym.lines && node.source
          ? extractLines(node.source, sym.lines)
          : sym.body || "";

        if (body) {
          if (STRIP_PREAMBLE_KINDS.has(sym.kind)) body = stripPreambleAndClosing(body);
          body = dedent(body);
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
// Render: --detail sig (signatures only, compact)
// ---------------------------------------------------------------------------

function renderSig(data: NormaGraph): string {
  const out: string[] = [];

  out.push(`SYMBOLS (sig) | ${new Date().toISOString().slice(0, 10)}`);
  out.push(""); // placeholder for stats

  // Count importers per module
  const importerCount = new Map<number, number>();
  for (const e of data.edges) {
    importerCount.set(e.target, (importerCount.get(e.target) ?? 0) + 1);
  }

  // Cross-pkg importers
  const crossImporters = new Map<number, string[]>();
  for (const e of data.edges) {
    if (!e.cross) continue;
    const src = data.nodes[e.source];
    if (!src) continue;
    const list = crossImporters.get(e.target) ?? [];
    list.push(`[${src.pkg}] ${strip(src.originalPath)}`);
    crossImporters.set(e.target, list);
  }

  // MODULE INDEX
  out.push("");
  out.push(`${"═".repeat(4)} MODULE INDEX ${"═".repeat(44)}`);

  for (const node of data.nodes) {
    const modPath = strip(node.originalPath);
    const { totalSymbols: tot, exportedSymbols: exp } = node.stats;
    const imp = importerCount.get(node.idx) ?? 0;
    const topExports = node.symbols
      .filter((s) => s.exported)
      .slice(0, 4)
      .map((s) => s.name)
      .join(",");
    const more = node.symbols.filter((s) => s.exported).length > 4 ? ",…" : "";
    const deps = node.internalDeps.map(strip).slice(0, 3).join(",");
    const depsMore = node.internalDeps.length > 3 ? ",…" : "";
    const extDeps = node.externalDeps.length > 0 ? ` | ${node.externalDeps.slice(0, 3).join(",")}` : "";

    out.push(
      `${modPath.padEnd(36)} [${exp}/${tot}]←${imp}  ${topExports}${more}${deps ? ` → ${deps}${depsMore}` : ""}${extDeps}`,
    );
  }

  // MODULES (sig only)
  out.push("");
  out.push(`${"═".repeat(4)} MODULES ${"═".repeat(49)}`);
  out.push("");

  let totalSym = 0;
  let currentPkg = "";
  for (const node of data.nodes) {
    if (node.pkg !== currentPkg) {
      currentPkg = node.pkg;
      const pkgInfo = data.packages.find((p) => p.short === currentPkg);
      out.push(`${"═".repeat(4)} [${currentPkg}] ${pkgInfo?.pkgName ?? currentPkg} ${"═".repeat(Math.max(1, 40 - currentPkg.length))}`);
      out.push("");
    }

    const modPath = strip(node.originalPath);
    const { totalSymbols: tot, exportedSymbols: exp } = node.stats;
    out.push(`── ${modPath} [${exp}/${tot}] ${"─".repeat(Math.max(1, 52 - modPath.length))}`);

    if (node.internalDeps.length > 0) {
      out.push(`← ${node.internalDeps.map(strip).join(", ")}`);
    }
    const crossDeps: string[] = [];
    for (const e of data.edges) {
      if (!e.cross || e.source !== node.idx) continue;
      const tgt = data.nodes[e.target];
      if (tgt) crossDeps.push(`[${tgt.pkg}] ${strip(tgt.originalPath)}`);
    }
    if (crossDeps.length > 0) out.push(`← ${crossDeps.join(", ")}  (cross-pkg)`);
    if (node.externalDeps.length > 0) out.push(`←ext ${node.externalDeps.join(", ")}`);

    const importers = crossImporters.get(node.idx);
    if (importers && importers.length > 0) {
      const shown = importers.slice(0, 6);
      const suffix = importers.length > 6 ? ` (+${importers.length - 6})` : "";
      out.push(`→ ${shown.join(", ")}${suffix}`);
    }

    out.push("");

    for (const sym of node.symbols) {
      totalSym++;
      const ex = sym.exported ? "+" : " ";
      const mods = (sym.modifiers ?? [])
        .filter((m) => m !== "const" && m !== "let" && m !== "export" && m !== "default")
        .join(" ");
      const modStr = mods ? `${mods} ` : "";
      const kind = KIND_SHORT[sym.kind] ?? sym.kind;
      const sig = fmtSig(sym);

      // For constants, include the value if short
      if (sym.kind === "variable") {
        const bodyText = sym.lines && node.source
          ? extractLines(node.source, sym.lines)
          : sym.body || "";
        if (bodyText.length < 80 && bodyText.length > 0) {
          const val = bodyText.replace(/^[^=]*=\s*/, "").replace(/;\s*$/, "").trim();
          if (val.length < 60) {
            out.push(`${ex}${modStr}${kind} ${sym.name} = ${val}`);
            continue;
          }
        }
      }

      out.push(`${ex}${modStr}${kind} ${sig}`);

      // Children as sig only
      if (sym.children && sym.children.length > 0) {
        for (const child of sym.children) {
          const cex = child.exported ? "+" : " ";
          const cmods = (child.modifiers ?? []).filter((m) => m !== "export" && m !== "default").join(" ");
          const cmodStr = cmods ? `${cmods} ` : "";
          const ckind = KIND_SHORT[child.kind] ?? child.kind;
          const csig = fmtSig(child);
          out.push(`  ${cex}${cmodStr}${ckind} ${csig}`);
        }
      }
    }
    out.push("");
  }

  // Cross-package edges
  out.push(`${"═".repeat(4)} CROSS-PACKAGE EDGES ${"═".repeat(38)}`);
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

  const statsLine = [
    `${data.packages.length} pkg`,
    `${data.stats.totalModules} mod`,
    `${data.stats.totalSymbols} sym`,
    `${data.stats.totalEdges} edges (${data.stats.crossEdges} cross)`,
    `detail: all sig`,
  ].join(" · ");
  out[1] = statsLine;

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Render: --detail brief (default, complexity-gated tiers)
// ---------------------------------------------------------------------------

function renderBrief(data: NormaGraph): string {
  const out: string[] = [];
  let tier1 = 0, tier2 = 0, tier3 = 0;

  // Count importers per module
  const importerCount = new Map<number, number>();
  for (const e of data.edges) {
    importerCount.set(e.target, (importerCount.get(e.target) ?? 0) + 1);
  }

  // Cross-pkg importers
  const crossImporters = new Map<number, string[]>();
  for (const e of data.edges) {
    if (!e.cross) continue;
    const src = data.nodes[e.source];
    if (!src) continue;
    const list = crossImporters.get(e.target) ?? [];
    list.push(`[${src.pkg}] ${strip(src.originalPath)}`);
    crossImporters.set(e.target, list);
  }

  // ── MODULE INDEX ──
  out.push(`SYMBOLS | ${new Date().toISOString().slice(0, 10)}`);
  out.push(""); // placeholder for stats — filled in after render

  out.push("");
  out.push(`${"═".repeat(4)} MODULE INDEX ${"═".repeat(44)}`);

  for (const node of data.nodes) {
    const modPath = strip(node.originalPath);
    const { totalSymbols: tot, exportedSymbols: exp } = node.stats;
    const imp = importerCount.get(node.idx) ?? 0;
    const topExports = node.symbols
      .filter((s) => s.exported)
      .slice(0, 4)
      .map((s) => s.name)
      .join(",");
    const more = node.symbols.filter((s) => s.exported).length > 4 ? ",…" : "";
    const deps = node.internalDeps.map(strip).slice(0, 3).join(",");
    const depsMore = node.internalDeps.length > 3 ? ",…" : "";
    const extDeps = node.externalDeps.length > 0 ? ` | ${node.externalDeps.slice(0, 3).join(",")}` : "";

    out.push(
      `${modPath.padEnd(36)} [${exp}/${tot}]←${imp}  ${topExports}${more}${deps ? ` → ${deps}${depsMore}` : ""}${extDeps}`,
    );
  }

  // ── MODULES (with tiered detail) ──
  out.push("");
  out.push(`${"═".repeat(4)} MODULES ${"═".repeat(49)}`);
  out.push("");

  let currentPkg = "";
  for (const node of data.nodes) {
    if (node.pkg !== currentPkg) {
      currentPkg = node.pkg;
      const pkgInfo = data.packages.find((p) => p.short === currentPkg);
      out.push(`${"═".repeat(4)} [${currentPkg}] ${pkgInfo?.pkgName ?? currentPkg} ${"═".repeat(Math.max(1, 40 - currentPkg.length))}`);
      out.push("");
    }

    const modPath = strip(node.originalPath);
    const { totalSymbols: tot, exportedSymbols: exp } = node.stats;
    out.push(`── ${modPath} [${exp}/${tot}] ${"─".repeat(Math.max(1, 52 - modPath.length))}`);

    if (node.internalDeps.length > 0) {
      out.push(`← ${node.internalDeps.map(strip).join(", ")}`);
    }
    const crossDeps: string[] = [];
    for (const e of data.edges) {
      if (!e.cross || e.source !== node.idx) continue;
      const tgt = data.nodes[e.target];
      if (tgt) crossDeps.push(`[${tgt.pkg}] ${strip(tgt.originalPath)}`);
    }
    if (crossDeps.length > 0) out.push(`← ${crossDeps.join(", ")}  (cross-pkg)`);
    if (node.externalDeps.length > 0) out.push(`←ext ${node.externalDeps.join(", ")}`);

    const importers = crossImporters.get(node.idx);
    if (importers && importers.length > 0) {
      const shown = importers.slice(0, 6);
      const suffix = importers.length > 6 ? ` (+${importers.length - 6})` : "";
      out.push(`→ ${shown.join(", ")}${suffix}`);
    }

    out.push("");

    for (const sym of node.symbols) {
      const ex = sym.exported ? "+" : " ";
      const mods = (sym.modifiers ?? [])
        .filter((m) => m !== "const" && m !== "let" && m !== "export" && m !== "default")
        .join(" ");
      const modStr = mods ? `${mods} ` : "";
      const kind = KIND_SHORT[sym.kind] ?? sym.kind;
      const sig = fmtSig(sym);

      const bodyText = sym.lines && node.source
        ? extractLines(node.source, sym.lines)
        : sym.body || "";
      const tier = classifySymbol(sym, node.source, bodyText);

      if (tier === "full") {
        tier1++;
        const cc = TYPE_KINDS.has(sym.kind) ? "" : `  CC${roughCC(bodyText)}`;
        const ln = sym.lines
          ? (sym.lines.startLine === sym.lines.endLine ? `  L${sym.lines.startLine}` : `  L${sym.lines.startLine}-${sym.lines.endLine}`)
          : "";
        out.push(`${ex}${modStr}${kind} ${sig}${cc}${ln}`);
        if (bodyText) {
          for (const line of bodyText.split("\n")) out.push(`  ${line}`);
        }
        if (sym.children && sym.children.length > 0) {
          for (const child of sym.children) {
            const cex = child.exported ? "+" : " ";
            const cmods = (child.modifiers ?? []).filter((m) => m !== "export" && m !== "default").join(" ");
            const cmodStr = cmods ? `${cmods} ` : "";
            const ckind = KIND_SHORT[child.kind] ?? child.kind;
            const csig = fmtSig(child);
            const childBody = child.lines && node.source ? extractLines(node.source, child.lines) : child.body || "";
            const childTier = classifySymbol(child, node.source, childBody);
            if (childTier === "full") {
              const ccc = TYPE_KINDS.has(child.kind) ? "" : `  CC${roughCC(childBody)}`;
              out.push(`  ${cex}${cmodStr}${ckind} ${csig}${ccc}`);
              if (childBody) for (const line of childBody.split("\n")) out.push(`    ${line}`);
            } else if (childTier === "brief") {
              const calls = extractCalls(childBody);
              out.push(`  ${cex}${cmodStr}${ckind} ${csig}`);
              if (calls.length > 0) out.push(`    → calls: ${calls.join(", ")}`);
            } else {
              out.push(`  ${cex}${cmodStr}${ckind} ${csig}`);
            }
          }
        }
        out.push("");
      } else if (tier === "brief") {
        tier2++;
        const calls = extractCalls(bodyText);
        out.push(`${ex}${modStr}${kind} ${sig}`);
        if (calls.length > 0) out.push(`  → calls: ${calls.join(", ")}`);
      } else {
        tier3++;
        // Sig tier: just the signature. For constants, include the value if short.
        if (sym.kind === "variable" && bodyText.length < 80 && bodyText.length > 0) {
          const val = bodyText.replace(/^[^=]*=\s*/, "").replace(/;\s*$/, "").trim();
          if (val.length < 60) {
            out.push(`${ex}${modStr}${kind} ${sym.name} = ${val}`);
            continue;
          }
        }
        out.push(`${ex}${modStr}${kind} ${sig}`);
      }
    }
    out.push("");
  }

  // Cross-package edges
  out.push(`${"═".repeat(4)} CROSS-PACKAGE EDGES ${"═".repeat(38)}`);
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

  // Invariant candidates from discovery.json
  if (data.discoveryData.size > 0) {
    const pureEntries: string[] = [];
    const hubEntries: string[] = [];
    const dupEntries: string[] = [];

    for (const [_pkg, disc] of data.discoveryData) {
      for (const fn of disc.functions ?? []) {
        if (fn.purityScore >= 0.7) {
          const sp = fn.filePath.includes("/src/") ? fn.filePath.slice(fn.filePath.indexOf("/src/") + 5) : fn.filePath;
          pureEntries.push(`Pure: ${fn.name}  ${sp}:${fn.line}  purity=${fn.purityScore.toFixed(2)}`);
        }
      }
      for (const hub of disc.callGraph?.hubDetails ?? []) {
        if (hub.callers >= 5) {
          const sp = hub.filePath.includes("/src/") ? hub.filePath.slice(hub.filePath.indexOf("/src/") + 5) : hub.filePath;
          hubEntries.push(`Hub: ${hub.name}  (${hub.callers} callers)  ${sp}:${hub.line}`);
        }
      }
      for (const dup of disc.duplicates ?? []) {
        if (dup.functions.length >= 3) {
          const names = dup.functions.map((f) => f.name).join(" \u2194 ");
          dupEntries.push(`Dup: ${names} (similarity=${Math.round(dup.similarity * 100)}%)`);
        }
      }
    }

    if (pureEntries.length > 0 || hubEntries.length > 0 || dupEntries.length > 0) {
      out.push(`${"═".repeat(4)} INVARIANT CANDIDATES ${"═".repeat(37)}`);
      for (const e of pureEntries) out.push(e);
      for (const e of hubEntries) out.push(e);
      for (const e of dupEntries) out.push(e);
      out.push("");
    }
  }

  // Backfill stats line
  data.stats.tier1Count = tier1;
  data.stats.tier2Count = tier2;
  data.stats.tier3Count = tier3;

  const statsLine = [
    `${data.packages.length} pkg`,
    `${data.stats.totalModules} mod`,
    `${data.stats.totalSymbols} sym`,
    `${data.stats.totalEdges} edges (${data.stats.crossEdges} cross)`,
    `detail: ${tier1} full, ${tier2} brief, ${tier3} sig`,
  ].join(" · ");
  out[1] = statsLine;

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Top-level render dispatcher
// ---------------------------------------------------------------------------

function renderNormagraph(data: NormaGraph, detail: DetailLevel): string {
  switch (detail) {
    case "full": return renderFull(data);
    case "sig": return renderSig(data);
    case "brief": return renderBrief(data);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface NormagraphOptions {
  root: string;
  detail?: DetailLevel;  // default: "brief"
}

export async function runNormagraph(opts: NormagraphOptions): Promise<void> {
  const root = opts.root;
  const detail: DetailLevel = opts.detail ?? "brief";
  const auditDir = resolve(root, ".supergraph/packages");

  const label = detail === "full" ? "symbols-full" : `symbols (${detail})`;
  console.log(`Building ${label}...`);
  const t0 = Date.now();
  const data = await buildNormagraph(auditDir, root);
  const text = renderNormagraph(data, detail);

  await mkdir(resolve(root, ".supergraph"), { recursive: true });
  const outFile = detail === "full" ? ".supergraph/symbols-full.txt" : ".supergraph/symbols.txt";
  const outPath = resolve(root, outFile);
  await Bun.write(outPath, text);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  if (detail === "brief") {
    const ratio = data.stats.tier1Count + data.stats.tier2Count + data.stats.tier3Count;
    console.log(
      `  ${data.stats.tier1Count} full, ${data.stats.tier2Count} brief, ${data.stats.tier3Count} sig (of ${ratio} symbols)`,
    );
  } else {
    console.log(
      `  ${data.packages.length} packages · ${data.stats.totalModules} modules · ${data.stats.totalSymbols} symbols`,
    );
  }
  console.log(`  ${(text.length / 1024).toFixed(0)} KB → ${relative(root, outPath)}`);
  console.log(`Done in ${elapsed}s`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let detail: DetailLevel = "brief";
  const detailIdx = args.indexOf("--detail");
  if (detailIdx !== -1) {
    const val = args[detailIdx + 1];
    if (val === "sig" || val === "brief" || val === "full") {
      detail = val;
    } else {
      console.error(`Invalid --detail value: ${val}. Expected: sig | brief | full`);
      process.exit(1);
    }
  }

  const root = resolve(".");
  await runNormagraph({ root, detail });
}

// Run when executed directly
const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("normagraph.ts");
if (isMain) main();
