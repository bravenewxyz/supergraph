#!/usr/bin/env bun
/**
 * Builds a semantic graph of any TypeScript package and outputs either
 * structured JSON (for APIs/dashboards) or compact text (for LLMs).
 *
 * Usage:
 *   bun packages/graph/src/cli/map.ts <path-to-src-dir> [options]
 *
 * Options:
 *   --out <file>       Write output to file instead of stdout; also emits sibling
 *                      deps.txt (dep graph) and imports.txt (import frequency) in
 *                      the same directory when format is "text"
 *   --format <fmt>     Output format: "json" (default) or "text" (LLM-friendly)
 *   --comments         Include code comments in text output (no effect on JSON)
 *
 * Examples:
 *   bun packages/graph/src/cli/map.ts packages/orchestrator/src
 *   bun packages/graph/src/cli/map.ts packages/orchestrator/src --format text
 *   bun packages/graph/src/cli/map.ts packages/orchestrator/src --format text --comments
 *   bun packages/graph/src/cli/map.ts packages/graph/src --format json --out manifest.json
 */

import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, basename, dirname } from "node:path";
import { GraphStore } from "../store/graph-store.js";
import { parseTypeScript } from "../parser/ts-structural.js";
import { extractComments } from "../parser/comment-extractor.js";
import type { ExtractedComment } from "../parser/comment-extractor.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import type { SymbolKind } from "../schema/nodes.js";
import { collectTsFiles } from "./utils.js";

// ---------------------------------------------------------------------------
// Types for the output manifest
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
  comments?: string[];
}

interface ModuleManifest {
  path: string;
  relativePath: string;
  symbols: SymbolSummary[];
  imports: { module: string; raw?: string; typeOnly?: boolean }[];
  internalDeps: string[];
  externalDeps: string[];
  moduleComments?: string[];
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
// Helpers
// ---------------------------------------------------------------------------

function resolveImportSpecifier(fromModule: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromDir = fromModule.replace(/\/[^/]+$/, "");
  const resolved = join(fromDir, specifier).replace(/\.(js|ts|tsx|jsx)$/, "");
  return resolved.replace(/\/index$/, "");
}

/**
 * For arrow functions assigned to const, the structural parser captures params
 * in the body but not in the signature. Extract a meaningful signature from
 * the body's leading `(params) =>` or `async (params) =>` pattern.
 */
function extractArrowSignature(symbol: SymbolNode): string {
  if (!symbol.body || !symbol.modifiers.includes("const")) return symbol.signature;

  const body = symbol.body.trimStart();
  // Match: async? (params) : ReturnType => ...  or  async? (params) => ...
  const match = body.match(
    /^(async\s+)?\(([^)]*)\)\s*(?::\s*([^=>{]+?)\s*)?=>/,
  );
  if (!match) return symbol.signature;

  const params = match[2]?.trim() ?? "";
  const returnType = match[3]?.trim() ?? "";
  const ret = returnType ? `: ${returnType}` : "";
  return `${symbol.name}(${params})${ret}`;
}

function buildSymbolSummary(store: GraphStore, symbol: SymbolNode): SymbolSummary {
  const children = store.getChildSymbols(symbol.id);
  const childSummaries =
    children.length > 0 && symbol.kind !== "module"
      ? children
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => buildSymbolSummary(store, c))
      : undefined;

  const sig =
    symbol.kind === "function" ? extractArrowSignature(symbol) : symbol.signature;

  const body =
    symbol.kind === "interface" || symbol.kind === "type-alias" || symbol.kind === "enum"
      ? symbol.body
      : "";

  return {
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    signature: sig,
    typeText: symbol.typeText,
    body,
    exported: symbol.exported,
    modifiers: symbol.modifiers,
    lines: symbol.sourceRange,
    children: childSummaries,
  };
}

function collectDirectories(modules: ModuleManifest[]): DirectoryManifest[] {
  const dirMap = new Map<string, { modules: Set<string>; subdirs: Set<string> }>();

  for (const mod of modules) {
    const dir = dirname(mod.relativePath);
    if (!dirMap.has(dir)) {
      dirMap.set(dir, { modules: new Set(), subdirs: new Set() });
    }
    dirMap.get(dir)!.modules.add(mod.relativePath);

    let parent = dirname(dir);
    let child = dir;
    while (parent !== child) {
      if (!dirMap.has(parent)) {
        dirMap.set(parent, { modules: new Set(), subdirs: new Set() });
      }
      dirMap.get(parent)!.subdirs.add(child);
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
// Text renderer (LLM-friendly compact notation)
// ---------------------------------------------------------------------------

/** Collapse a multiline string to one line. */
function singleLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Render one comment block as a single `// …` line.
 * Strips decorative separator chars (── --- === ***), collapses internal
 * newlines, and caps at maxLen characters. Returns "" for pure-decoration
 * comments (caller should skip pushing those).
 */
function commentLine(text: string, pad = "", maxLen = 120): string {
  let s = text.replace(/\s*\n\s*/g, " ").trim();
  // Remove box-drawing runs (─ ━ ═) and runs of 3+ ASCII decoration chars
  s = s
    .replace(/[─━═]+/g, " ")
    .replace(/[-=*#]{3,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!s) return ""; // pure decoration — caller filters empty strings
  const body = s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  return `${pad}// ${body}`;
}

/**
 * Collapse a function signature's parameter list to `(…)` when the params
 * exceed `maxParamLen` characters. Return-type annotation is preserved.
 * Only `()` depth is tracked — sufficient for TypeScript signatures.
 */
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
  // Handle truncated signatures where the parser cut off before the closing paren.
  const params = close !== -1 ? sig.slice(open + 1, close) : sig.slice(open + 1);
  if (params.length <= maxParamLen) return sig;

  if (close !== -1) {
    return `${sig.slice(0, open)}(…)${sig.slice(close + 1)}`;
  }
  // Incomplete signature — keep only name + (…)
  return `${sig.slice(0, open)}(…)`;
}

/**
 * Extract field/member names from an interface or enum body.
 * Returns a compact inline `{field1 field2 ...}` string, or "" if nothing found.
 */
function compactBody(body: string): string {
  if (!body) return "";
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    // Match: optional whitespace, then a word, then optional ?, then : or ( or =
    const m = line.match(/^\s*(\w+)\??(?:\s*[:=(])/);
    if (
      m &&
      m[1] &&
      m[1] !== "export" &&
      m[1] !== "type" &&
      m[1] !== "interface" &&
      m[1] !== "enum"
    ) {
      fields.push(m[1]);
    }
  }
  if (fields.length === 0) return "";
  return `{${fields.join(" ")}}`;
}

function renderText(manifest: PackageManifest): string {
  const lines: string[] = [];
  const p = manifest.package;
  const s = manifest.stats;

  lines.push(`# ${p}`);
  lines.push(
    `${s.totalFiles} files | ${s.totalNodes} nodes | ${s.totalEdges} edges | ${s.resolvedImports}/${s.resolvedImports + s.unresolvedImports} imports resolved`,
  );
  lines.push(
    `Nodes: ${Object.entries(s.nodesByKind).map(([k, v]) => `${v} ${k}`).join(", ")}`,
  );
  lines.push("");

  // Modules
  lines.push("## Modules");
  lines.push("");
  for (const mod of manifest.modules) {
    lines.push(
      `━━━ ${strip(mod.path)}  (${mod.stats.totalSymbols}/${mod.stats.exportedSymbols}) ━━━`,
    );

    if (mod.moduleComments && mod.moduleComments.length > 0) {
      const MAX_MODULE_COMMENTS = 6;
      const clines = mod.moduleComments.map((c) => commentLine(c)).filter(Boolean);
      lines.push(...clines.slice(0, MAX_MODULE_COMMENTS));
      if (clines.length > MAX_MODULE_COMMENTS) {
        lines.push(`// … (+${clines.length - MAX_MODULE_COMMENTS} more)`);
      }
    }

    const intDeps = mod.internalDeps.map(strip).join(", ");
    // Strip "node:" prefix — understood to be Node builtins
    const extDeps = mod.externalDeps.map((d) => d.replace(/^node:/, "")).join(", ");
    if (intDeps) lines.push(`← ${intDeps}`);
    if (extDeps) lines.push(`←ext ${extDeps}`);

    // Pre-deduplicate nested closures: for each unique function line range keep
    // only the "best" representative. Priority: exported > unexported, then
    // letter-start name > punctuation-start name (parser artifacts like
    // `{ handlers: foo }` start with `{`), then alphabetical.
    const bestFuncByRange = new Map<string, SymbolSummary>();
    for (const sym of mod.symbols) {
      if (sym.kind !== "function" || !sym.lines) continue;
      const key = `${sym.lines.startLine}-${sym.lines.endLine}`;
      const existing = bestFuncByRange.get(key);
      if (!existing) {
        bestFuncByRange.set(key, sym);
      } else {
        const symIsWordStart = /^\w/.test(sym.name);
        const exIsWordStart = /^\w/.test(existing.name);
        const symSigLen = sym.signature?.length ?? 0;
        const exSigLen = existing.signature?.length ?? 0;
        // Priority: exported > unexported; letter-start > punctuation-start name;
        // longer signature > shorter (outer function has params, closures often don't);
        // then alphabetical.
        const better =
          (!existing.exported && sym.exported) ||
          (existing.exported === sym.exported && !exIsWordStart && symIsWordStart) ||
          (existing.exported === sym.exported &&
            exIsWordStart === symIsWordStart &&
            symSigLen > exSigLen) ||
          (existing.exported === sym.exported &&
            exIsWordStart === symIsWordStart &&
            symSigLen === exSigLen &&
            sym.name.localeCompare(existing.name) < 0);
        if (better) bestFuncByRange.set(key, sym);
      }
    }
    const dedupedSymbols = mod.symbols.filter(
      (sym) =>
        sym.kind !== "function" ||
        !sym.lines ||
        bestFuncByRange.get(`${sym.lines.startLine}-${sym.lines.endLine}`) === sym,
    );

    // Build function line ranges (from deduped set) for variable-locality checks.
    const funcRanges = dedupedSymbols
      .filter((s) => s.kind === "function" && s.lines !== null)
      .map((s) => s.lines!);

    for (const sym of dedupedSymbols) {
      lines.push(...renderSymbol(sym, 0, funcRanges));
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** DFS cycle detection. Returns each cycle as a path of node names. */
function findCycles(graph: Record<string, string[]>): string[][] {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  const allNodes = new Set([
    ...Object.keys(graph),
    ...Object.values(graph).flat(),
  ]);
  for (const n of allNodes) color.set(n, WHITE);

  const cycles: string[][] = [];
  const seen = new Set<string>(); // canonical cycle keys, for dedup

  function dfs(node: string, path: string[]): void {
    color.set(node, GRAY);
    path.push(node);
    for (const nb of graph[node] ?? []) {
      if (color.get(nb) === GRAY) {
        const start = path.indexOf(nb);
        const cycle = path.slice(start);
        // Canonicalize: rotate to smallest node so duplicates collapse
        const minIdx = cycle.indexOf([...cycle].sort()[0]!);
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

  // Cycle detection
  const strippedGraph: Record<string, string[]> = {};
  for (const [k, vs] of Object.entries(manifest.dependencyGraph)) {
    strippedGraph[strip(k)] = (vs as string[]).map(strip);
  }
  const cycles = findCycles(strippedGraph);
  lines.push("");
  lines.push("## Circular Dependencies");
  lines.push("");
  if (cycles.length === 0) {
    lines.push("none");
  } else {
    for (const cycle of cycles) {
      lines.push(`cycle: ${cycle.join(" → ")} → ${cycle[0]}`);
    }
    lines.push(`\n${cycles.length} cycle(s) found`);
  }

  return lines.join("\n") + "\n";
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
  return lines.join("\n") + "\n";
}

function renderSymbol(
  sym: SymbolSummary,
  indent: number,
  funcRanges?: Array<{ startLine: number; endLine: number }>,
): string[] {
  if (sym.kind === "variable") {
    // Skip only parser-hoisted function locals — variables whose line range
    // falls inside a function's range (the TS parser incorrectly surfaces them
    // at module level with the enclosing function's start line).
    // Module-level unexported variables (consts, schema defs, config flags) are
    // kept: they're needed for dead-code and duplication analysis.
    if (funcRanges && sym.lines) {
      const { startLine, endLine } = sym.lines;
      const isLocal = funcRanges.some(
        (fr) => startLine >= fr.startLine && endLine <= fr.endLine,
      );
      if (isLocal) return [];
    }
  }

  const pad = "  ".repeat(indent);
  const ex = sym.exported ? "+" : " ";
  const mods = sym.modifiers.filter((m) => m !== "const" && m !== "let");
  const modStr = mods.length ? mods.join(" ") + " " : "";
  const ln = formatLineRange(sym.lines);
  const result: string[] = [];

  if (sym.comments && sym.comments.length > 0) {
    for (const c of sym.comments) {
      const cl = commentLine(c, pad);
      if (cl) result.push(cl);
    }
  }

  switch (sym.kind) {
    case "interface":
    case "enum": {
      // Compact body to "{field1 field2 ...}" inline — preserves field names
      // for cross-rep analysis without repeating every field type verbatim.
      const compact = compactBody(sym.body);
      result.push(`${pad}${ex}${modStr}${singleLine(sym.signature)}${compact}${ln}`);
      break;
    }
    case "type-alias": {
      // Body already present in the signature; skip repetition.
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
        for (const child of sym.children) {
          result.push(...renderSymbol(child, indent + 1, funcRanges));
        }
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
      // Only exported variables reach here (unexported filtered above).
      // Avoid prepending const/let if the signature already starts with it.
      const sig = singleLine(sym.signature);
      const declKind = sym.modifiers.includes("const") ? "const" : "let";
      const fullSig =
        sig.startsWith("const ") || sig.startsWith("let ") ? sig : `${declKind} ${sig}`;
      result.push(`${pad}${ex}${modStr}${fullSig}${ln}`);
      break;
    }
    default: {
      result.push(`${pad}${ex}${modStr}${sym.kind} ${singleLine(sym.signature)}${ln}`);
      break;
    }
  }

  return result;
}

function formatLineRange(lines: { startLine: number; endLine: number } | null): string {
  if (!lines) return "";
  return lines.startLine === lines.endLine
    ? `  L${lines.startLine}`
    : `  L${lines.startLine}-${lines.endLine}`;
}

function strip(modulePath: string): string {
  return modulePath.replace(/^src\//, "");
}

// ---------------------------------------------------------------------------
// Comment attachment
// ---------------------------------------------------------------------------

function attachCommentsToSymbols(
  comments: ExtractedComment[],
  symbols: SymbolSummary[],
): void {
  for (const comment of comments) {
    if (comment.attachedToLine === null) continue;
    const target = findSymbolAtLine(comment.attachedToLine, symbols);
    if (target) {
      if (!target.comments) target.comments = [];
      target.comments.push(formatCommentText(comment.text));
    }
  }
}

function findSymbolAtLine(
  line: number,
  symbols: SymbolSummary[],
): SymbolSummary | null {
  for (const sym of symbols) {
    if (sym.lines && sym.lines.startLine === line) return sym;
    if (sym.children) {
      const found = findSymbolAtLine(line, sym.children);
      if (found) return found;
    }
  }
  return null;
}

function isAttachedToAnySymbol(
  comment: ExtractedComment,
  symbols: SymbolSummary[],
): boolean {
  if (comment.attachedToLine === null) return false;
  return findSymbolAtLine(comment.attachedToLine, symbols) !== null;
}

function formatCommentText(raw: string): string {
  if (raw.startsWith("/**")) {
    return raw
      .replace(/^\/\*\*\s*/, "")
      .replace(/\s*\*\/\s*$/, "")
      .replace(/^\s*\*\s?/gm, "")
      .trim();
  }
  if (raw.startsWith("/*")) {
    return raw
      .replace(/^\/\*\s*/, "")
      .replace(/\s*\*\/\s*$/, "")
      .replace(/^\s*\*\s?/gm, "")
      .trim();
  }
  return raw.replace(/^\/\/\s?/, "").trim();
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export interface MapOptions {
  srcRoot: string;
  format?: "json" | "text";
  comments?: boolean;
  outPath?: string;
}

export interface MapResult {
  manifest: PackageManifest;
  output: string;
}

export async function runMap(opts: MapOptions): Promise<MapResult> {
  const srcRoot = opts.srcRoot;
  const format: OutputFormat = opts.format ?? "json";
  const commentsEnabled = opts.comments ?? false;
  const outPath = opts.outPath;

  try {
    await stat(srcRoot);
  } catch {
    throw new Error(`Source directory not found: ${srcRoot}`);
  }


  const pkgRoot = resolve(srcRoot, "..");
  let packageName = basename(pkgRoot);
  try {
    const pkgJson = JSON.parse(
      await readFile(join(pkgRoot, "package.json"), "utf-8"),
    );
    packageName = pkgJson.name ?? packageName;
  } catch {
    // no package.json, use directory name
  }

  console.error(`Analyzing ${packageName} at ${srcRoot}...`);

  const files = await collectTsFiles(srcRoot);
  console.error(`Found ${files.length} TypeScript source files`);

  const store = new GraphStore();
  const unresolvedEdges: SymbolEdge[] = [];
  const moduleIdByPath = new Map<string, string>();
  const commentsByModule = new Map<string, ExtractedComment[]>();

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

    if (commentsEnabled) {
      const qualifiedName = relPath.replace(/\.(ts|tsx)$/, "");
      const comments = extractComments(code, relPath);
      if (comments.length > 0) {
        commentsByModule.set(qualifiedName, comments);
      }
    }
  }

  let resolvedCount = 0;
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
          resolvedCount++;
        } catch {
          /* skip */
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
            typeOnly: ie.metadata?.typeOnly as boolean | undefined,
          });
        }
      }

      for (const ue of unresolvedEdges) {
        if (ue.sourceId === mod.id && ue.metadata?.moduleSpecifier) {
          const spec = ue.metadata.moduleSpecifier as string;
          if (!spec.startsWith(".")) {
            externalDeps.push(spec);
            imports.push({
              module: spec,
              raw: ue.metadata?.raw as string | undefined,
              typeOnly: ue.metadata?.typeOnly as boolean | undefined,
            });
          }
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

      const fileComments = commentsByModule.get(mod.qualifiedName);
      let moduleComments: string[] | undefined;
      if (fileComments && fileComments.length > 0) {
        attachCommentsToSymbols(fileComments, symbolSummaries);
        const firstSymbolLine = symbolSummaries[0]?.lines?.startLine ?? Infinity;
        moduleComments = fileComments
          .filter(
            (c) =>
              c.attachedToLine === null ||
              c.line < firstSymbolLine,
          )
          .filter((c) => !isAttachedToAnySymbol(c, symbolSummaries))
          .map((c) => formatCommentText(c.text));
        if (moduleComments.length === 0) moduleComments = undefined;
      }

      return {
        path: mod.qualifiedName,
        relativePath: mod.qualifiedName,
        symbols: symbolSummaries,
        imports,
        internalDeps: [...new Set(internalDeps)].sort(),
        externalDeps: [...new Set(externalDeps)].sort(),
        moduleComments,
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
    if (mod.internalDeps.length > 0) {
      depGraph[mod.path] = mod.internalDeps;
    }
  }

  const inboundCounts = new Map<string, number>();
  for (const mod of moduleManifests) {
    for (const dep of mod.internalDeps) {
      inboundCounts.set(dep, (inboundCounts.get(dep) ?? 0) + 1);
    }
  }
  const mostImported = [...inboundCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([module, importers]) => ({ module, importers }));

  const largestModules = moduleManifests
    .map((m) => ({ module: m.path, symbolCount: m.stats.totalSymbols }))
    .sort((a, b) => b.symbolCount - a.symbolCount)
    .slice(0, 25);

  const nodesByKind: Record<string, number> = {};
  for (const s of allSymbols) {
    nodesByKind[s.kind] = (nodesByKind[s.kind] ?? 0) + 1;
  }
  const edgesByKind: Record<string, number> = {};
  for (const e of allEdges) {
    edgesByKind[e.kind] = (edgesByKind[e.kind] ?? 0) + 1;
  }

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
    console.error(
      `Output written to ${outPath} (${(output.length / 1024).toFixed(0)} KB, format: ${format})`,
    );
    if (format === "text") {
      const outDir = dirname(outPath);
      const depsPath = join(outDir, "deps.txt");
      const importsPath = join(outDir, "imports.txt");
      const depsOutput = renderDepsText(manifest);
      const importsOutput = renderImportsText(manifest);
      await Promise.all([
        Bun.write(depsPath, depsOutput),
        Bun.write(importsPath, importsOutput),
      ]);
      console.error(
        `Deps written to ${depsPath} (${(depsOutput.length / 1024).toFixed(0)} KB)`,
      );
      console.error(
        `Imports written to ${importsPath} (${(importsOutput.length / 1024).toFixed(0)} KB)`,
      );
    }
  }

  console.error(
    `\nDone: ${store.nodeCount} nodes, ${store.edgeCount} edges, ${resolvedCount} resolved imports`,
  );

  return { manifest, output };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.error("Usage: bun map.ts <path-to-src-dir> [--format json|text] [--comments] [--out <file>]");
    process.exit(1);
  }
  const srcRoot = resolve(args[0]!);
  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;
  const fmtIdx = args.indexOf("--format");
  const format = fmtIdx !== -1 && args[fmtIdx + 1] === "text" ? "text" as const : "json" as const;
  const comments = args.includes("--comments");

  const { output } = await runMap({ srcRoot, format, comments, outPath });
  if (!outPath) process.stdout.write(output);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
