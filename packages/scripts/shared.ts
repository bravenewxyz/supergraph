/**
 * shared.ts — Common types, helpers, and infrastructure used across audit scripts.
 *
 * Extracted from superhigh, superlink, supergraph, superflow, and superschema
 * to eliminate duplication of:
 *   - Raw audit data types (RawModule, RawMap, FlowEndpoint, etc.)
 *   - Path compression / external dep aliasing
 *   - Per-package map.json loading
 *   - JSON sub-script execution
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFile } from "./utils.js";

// ─── Raw audit data types ─────────────────────────────────────────────────────
// These describe the JSON output of the per-package graph tool (map.json).

export type RawModule = {
  path: string;
  symbols: { name: string; kind: string; exported: boolean }[];
  imports: { module: string; typeOnly?: boolean }[];
  internalDeps: string[];
  externalDeps: string[];
  stats: { totalSymbols: number; exportedSymbols: number };
};

export type RawMap = {
  package: string;
  srcRoot: string;
  modules: RawModule[];
  dependencyGraph: Record<string, string[]>;
};

// ─── Rich graph data types ───────────────────────────────────────────────────
// Used by hypergraph.ts, normagraph.ts, and similar scripts that need full
// symbol data (richer than the compact RawModule used by supergraph/superhigh).

export type GraphRawSymbol = {
  name: string;
  qualifiedName: string;
  kind: string;
  signature: string;
  typeText: string;
  body: string;
  exported: boolean;
  modifiers: string[];
  lines: { startLine: number; endLine: number } | null;
  children?: GraphRawSymbol[];
};

export type GraphRawModule = Omit<RawModule, "symbols" | "imports"> & {
  relativePath: string;
  symbols: GraphRawSymbol[];
  imports: { module: string; raw?: string; typeOnly?: boolean }[];
};

export type GraphRawMap = Omit<RawMap, "modules"> & {
  modules: GraphRawModule[];
};

export type GraphNode = {
  idx: number;
  path: string;
  pkg: string;
  pkgName: string;
  originalPath: string;
  symbols: GraphRawSymbol[];
  imports: GraphRawModule["imports"];
  internalDeps: string[];
  externalDeps: string[];
  stats: { totalSymbols: number; exportedSymbols: number };
  source: string;
};

export type GraphEdge = { source: number; target: number; cross: boolean };

/** Base shape shared by all graph output types (hypergraph, normagraph, supergraph, pkg-graph). */
export type BaseGraphOutput<N, E, S extends Record<string, unknown>> = {
  generated: string;
  nodes: N[];
  edges: E[];
  stats: S;
};

// ─── Flow / endpoint types ────────────────────────────────────────────────────

export type FlowEndpoint = {
  id: number;
  service: string;
  method: string;
  path: string;
  domain: string;
  auth: string;
  summary?: string;
  file: string;
  ctrl: string[];
  redis: string[];
  protocol: string[];
  pg: string[];
  analytics: string[];
  integration: string[];
  rateLimits: string[];
  hooks: { name: string; inv: string[]; set: string[] }[];
};

export type FlowsJson = {
  meta: {
    generated: string;
    project: string;
    totalEndpoints: number;
    totalHooks: number;
    domainOrder: string[];
    pathSegments: [string, string][];
  };
  stats: {
    byMethod: Record<string, number>;
    byService: Record<string, number>;
    byDomain: Record<string, number>;
  };
  endpoints: FlowEndpoint[];
};

// ─── Schema types ─────────────────────────────────────────────────────────────

export type ZodField = { n: string; t: string; o: number };
export type ZodSchema = {
  n: string;
  f: string;
  l: number;
  fields?: ZodField[];
  body?: string;
};

export type SqlTable = {
  n: string;
  f: string;
  pk: string[];
  fk: { from: string[]; to: string }[];
  cols: {
    n: string;
    t: string;
    ts?: string;
    nn?: number;
    pk?: number;
    uq?: number;
    def?: string;
    fk?: string;
  }[];
  idx: { n: string; cols: string[]; uq?: number }[];
};

export type SqlEnum = { n: string; f: string; vals: string[] };
export type RedisKey = { p: string; ops: string[]; s?: string; files: string[] };

export type TsType = {
  n: string;
  k: 0 | 1;
  f: string;
  l: number;
  int?: 1;
  g?: string;
  ext?: string[];
  fields?: { n: string; t: string; o?: 1; ro?: 1 }[];
  body?: string;
};

export type SchemaJson = {
  project: string;
  stats: { zod: number; sql: number; redis: number; ts: number };
  zod: ZodSchema[];
  sql: { enums: SqlEnum[]; tables: SqlTable[] };
  redis: { keys: RedisKey[]; idx: { n: string; prefix?: string }[] };
  ts?: TsType[];
};

// ─── Package data (used by superhigh, superlink) ─────────────────────────────

export type PkgData = { short: string; map: RawMap };

// ─── Path compression ─────────────────────────────────────────────────────────

/**
 * Compress a module's raw path for display using path segment abbreviations.
 *
 * Strips `src/` prefix, collapses `/index` → nothing, then applies
 * each [from, to] pair from `pathSegs` via first-match substring replacement.
 */
export function compressPath(
  rawPath: string,
  pathSegs: [string, string][],
): string {
  let p = rawPath.replace(/^src\//, "").replace(/\/index$/, "");
  if (p === "index") p = "idx";
  for (const [from, to] of pathSegs) {
    const i = p.indexOf(from);
    if (i !== -1) p = p.slice(0, i) + to + p.slice(i + from.length);
  }
  return p;
}

/**
 * Compress an external dependency name using alias table.
 *
 * Matches exact, prefix (trailing `/`, `:`, `-`), or `dep/` prefix.
 */
export function compressExtDep(
  dep: string,
  extAliases: [string, string][],
): string {
  for (const [from, to] of extAliases) {
    if (dep === from) return to;
    const last = from[from.length - 1];
    if (last === "/" || last === ":" || last === "-") {
      if (dep.startsWith(from)) return to + dep.slice(from.length);
    } else if (dep.startsWith(`${from}/`)) {
      return to + dep.slice(from.length);
    }
  }
  return dep;
}

// ─── Load per-package map.json files ──────────────────────────────────────────

/**
 * Reads all `audit/packages/<pkg>/json/map.json` files into a Map keyed by
 * package short name.
 */
export async function loadAllMaps(
  pkgsDir: string,
): Promise<Map<string, PkgData>> {
  const result = new Map<string, PkgData>();
  let entries: string[] = [];
  try {
    const de = await readdir(pkgsDir, { withFileTypes: true });
    entries = de
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch { /* packages dir unreadable */ }
  for (const short of entries) {
    try {
      const raw = await readFile(join(pkgsDir, short, "json/map.json"));
      if (!raw) continue;
      result.set(short, { short, map: JSON.parse(raw) });
    } catch { /* map.json unreadable or malformed — skip package */ }
  }
  return result;
}

// ─── Run a sibling script for JSON output ─────────────────────────────────────

/**
 * Execute a sibling script (by name, e.g. "superflow") with `--json --root`
 * flags and return its stdout. Handles both compiled-binary and bun-dev modes.
 */
export async function runForJson(
  scriptName: string,
  root: string,
): Promise<string> {
  const isCompiledBinary = !process.execPath.includes("bun");

  let cmd: string[];
  if (isCompiledBinary) {
    cmd = [process.execPath, scriptName, "--json", "--root", root];
  } else {
    const scriptAbs = resolve(import.meta.dir, `${scriptName}.ts`);
    cmd = ["bun", scriptAbs, "--json", "--root", root];
  }

  console.log(`  Running ${scriptName}…`);
  const proc = Bun.spawn(cmd, {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  // Strip any leading progress/log lines before the JSON object or array
  const jsonStart = text.search(/^[{[]/m);
  return jsonStart >= 0 ? text.slice(jsonStart) : text;
}

// ─── Build global module lookup ───────────────────────────────────────────────

/**
 * Build a Map from "short/mod.path" → { short, mod } across all packages,
 * and a parallel importedBy count map.
 */
export function buildModuleLookup(allMaps: Map<string, PkgData>): {
  moduleByKey: Map<string, { short: string; mod: RawModule }>;
  globalImportedBy: Map<string, number>;
} {
  const moduleByKey = new Map<string, { short: string; mod: RawModule }>();
  for (const [short, { map }] of allMaps) {
    for (const mod of map.modules) {
      moduleByKey.set(`${short}/${mod.path}`, { short, mod });
    }
  }

  const globalImportedBy = new Map<string, number>();
  for (const [short, { map }] of allMaps) {
    for (const mod of map.modules) {
      for (const dep of mod.internalDeps ?? []) {
        const key = `${short}/${dep}`;
        globalImportedBy.set(key, (globalImportedBy.get(key) ?? 0) + 1);
      }
    }
  }

  return { moduleByKey, globalImportedBy };
}

// ─── Output helper ────────────────────────────────────────────────────────────

/** Truncate list to n items + "+rest" */
export const trunc = (arr: string[], n: number): string =>
  arr.length <= n
    ? arr.join(",")
    : `${arr.slice(0, n).join(",")},+${arr.length - n}`;

// ─── Resolve --out argument ───────────────────────────────────────────────────

/**
 * Parse the `--out <path>` CLI argument; fall back to `defaultPath`.
 */
export function resolveOutPath(
  args: string[],
  defaultPath: string,
): string {
  const outArg = args.indexOf("--out");
  return outArg !== -1
    ? resolve(process.cwd(), args[outArg + 1]!)
    : defaultPath;
}
