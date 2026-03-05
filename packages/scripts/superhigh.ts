#!/usr/bin/env bun
/**
 * superhigh.ts — Complete unified monorepo audit with ONE shared legend.
 *
 * Contains ALL information from supergraph + superschema + superflows in one
 * pass, organized to minimize redundancy (Kolmogorov complexity):
 *
 *   PART 1  Domain blocks  (superlink-style but exhaustive)
 *             - All domain modules (not just route/ctrl/model)
 *             - Full schema field definitions (no truncation)
 *             - Integration events (I:) in endpoint detail
 *             - SQL enums co-located with their domain
 *
 *   PART 2  Packages  (all non-domain modules, supergraph format)
 *             - Every module across all packages
 *             - Symbol listing with importer-budget rule
 *
 *   PART 3  Types  (all TS types from superschema)
 *             - Controller / connector / utility types
 *             - Protocol SDK response types compressed:
 *               6 variants per operation → 1 line (200→Type err:4xx)
 *
 * ONE shared path-segment legend + ext-dep-alias table.
 * No legends / headers repeated across sections.
 *
 * Reads:
 *   audit/packages/<pkg>/json/map.json  (per-package raw module graph)
 *   audit/superflows.json               (endpoints + hooks)
 *   audit/superschema.json              (zod, sql, redis, ts types)
 *
 * Writes: audit/superhigh.txt
 * Usage:  bun superhigh.ts [--out <path>] [--fresh]
 */

import { mkdir, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { loadConfig } from "../flow/src/cli/config.js";
import { parseRootArg, readFile } from "./utils.js";

const ROOT = parseRootArg(resolve(import.meta.dir, "../.."));
const AUDIT = resolve(ROOT, "audit");
const PKGS = resolve(ROOT, "audit/packages");

// ─── Types ───────────────────────────────────────────────────────────────────

type RawModule = {
  path: string;
  symbols: { name: string; kind: string; exported: boolean }[];
  imports: { module: string; typeOnly?: boolean }[];
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

type FlowEndpoint = {
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

type FlowsJson = {
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

type ZodField = { n: string; t: string; o: number };
type ZodSchema = {
  n: string;
  f: string;
  l: number;
  fields?: ZodField[];
  body?: string;
};
type SqlTable = {
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
type SqlEnum = { n: string; f: string; vals: string[] };
type RedisKey = { p: string; ops: string[]; s?: string; files: string[] };
type TsType = {
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

type SchemaJson = {
  project: string;
  stats: { zod: number; sql: number; redis: number; ts: number };
  zod: ZodSchema[];
  sql: { enums: SqlEnum[]; tables: SqlTable[] };
  redis: { keys: RedisKey[]; idx: { n: string; prefix?: string }[] };
  ts?: TsType[];
};

// ─── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun superhigh.ts [--out <path>] [--fresh] [--full]");
  console.log("  Full unified audit: domain blocks + packages + TS types.");
  console.log("  --fresh  Re-run source scripts first.");
  console.log(
    "  --full   Full paths + auto-grouped dirs → superhigh.txt  (default)",
  );
  console.log(
    "           Omit for compressed shortcut → superhigh-shortcut.txt",
  );
  process.exit(0);
}

/** --full: uncompressed paths, all symbols, full dep names */
const FULL = args.includes("--full");

const cfg = await loadConfig(ROOT);
const shCfg = cfg.superhigh ?? {};
const CONFIGURED_DOMAIN_MAP: Record<string, string> | undefined = shCfg.domainMap;
const CONFIGURED_DOMAIN_ORDER: string[] | undefined = shCfg.domainOrder;
const EXT_ALIASES: [string, string][] = cfg.supergraph.extAliases as [
  string,
  string,
][];
const PATH_SEGS: [string, string][] = cfg.supergraph.pathSegments as [
  string,
  string,
][];

const outArg = args.indexOf("--out");
const outPath =
  outArg !== -1
    ? resolve(process.cwd(), args[outArg + 1]!)
    : FULL
      ? resolve(ROOT, "audit/superhigh.txt")
      : resolve(ROOT, "audit/superhigh-shortcut.txt");

// ─── Ensure source JSON files exist ──────────────────────────────────────────

async function runForJson(scriptPath: string): Promise<string> {
  // scriptPath may be "devtools/scripts/foo.ts" (legacy relative-to-ROOT) or
  // just a basename.  Derive the subcommand name (e.g. "superflow") for
  // compiled binary self-invocation, or the full path for bun dev mode.
  const scriptName = scriptPath.split("/").pop()!.replace(/\.[jt]s$/, "");
  const isCompiledBinary = !process.execPath.includes("bun");

  let cmd: string[];
  if (isCompiledBinary) {
    // Compiled binary: invoke self with subcommand
    cmd = [process.execPath, scriptName, "--json", "--root", ROOT];
  } else {
    const scriptAbs = resolve(import.meta.dir, `${scriptName}.ts`);
    cmd = ["bun", scriptAbs, "--json", "--root", ROOT];
  }

  console.log(`  Running ${scriptName}…`);
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  // Strip any leading progress/log lines before the JSON object or array
  const jsonStart = text.search(/^[{[]/m);
  return jsonStart >= 0 ? text.slice(jsonStart) : text;
}

console.log("Building superhigh…");
const t0 = Date.now();

// ─── Load per-package map.json files ─────────────────────────────────────────

type PkgData = { short: string; map: RawMap };

async function loadAllMaps(): Promise<Map<string, PkgData>> {
  const result = new Map<string, PkgData>();
  let entries: string[] = [];
  try {
    const de = await readdir(PKGS, { withFileTypes: true });
    entries = de
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {}
  for (const short of entries) {
    try {
      const raw = await readFile(join(PKGS, short, "json/map.json"));
      if (!raw) continue;
      result.set(short, { short, map: JSON.parse(raw) });
    } catch {}
  }
  return result;
}

// Also read superschema path abbreviations from superschema.txt
async function getSchemaPathAbbrevLine(): Promise<string> {
  try {
    const txt = await readFile(resolve(AUDIT, "superschema.txt"));
    if (!txt) return "";
    const lines = txt.split("\n");
    const idx = lines.findIndex((l) => l.startsWith("# PATH ABBREVS"));
    return idx !== -1 && lines[idx + 1] ? lines[idx + 1]! : "";
  } catch {
    return "";
  }
}

const [allMaps, flowsRaw, schemaRaw, schemaPathAbbrevLine] = await Promise.all([
  loadAllMaps(),
  runForJson("devtools/scripts/superflow.ts"),
  runForJson("devtools/scripts/superschema.ts"),
  getSchemaPathAbbrevLine(),
]);

const flows = JSON.parse(flowsRaw || "{}") as FlowsJson;
// Normalize so downstream code can always rely on arrays (repos without routes return empty)
flows.endpoints ??= [];
flows.stats ??= { byMethod: {}, byService: {}, byDomain: {} };
flows.meta ??= {
  project: "",
  totalEndpoints: 0,
  totalHooks: 0,
  domainOrder: [],
  pathSegments: [],
};
const schemaData = JSON.parse(schemaRaw || "{}") as SchemaJson;

const HAS_FLOWS = !!flows.endpoints?.length;
const HAS_SCHEMA = !!(schemaData.zod?.length || schemaData.sql?.tables?.length || schemaData.redis?.keys?.length || schemaData.ts?.length);
if (!HAS_FLOWS) {
  console.warn(
    "  Note: no route/endpoint data found (superflows empty) — endpoint sections will be skipped.",
  );
}
if (!HAS_SCHEMA) {
  console.warn(
    "  Note: no schema data found (superschema empty) — schema/table/redis/type sections will be skipped.",
  );
}

// ─── Build global module lookup ───────────────────────────────────────────────

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

// ─── Path helpers ─────────────────────────────────────────────────────────────

function endpointFileToModuleKey(file: string): string | null {
  if (!file.startsWith("packages/")) return null;
  const withoutPkgs = file.slice("packages/".length);
  for (const short of allMaps.keys()) {
    if (withoutPkgs.startsWith(`${short}/`)) {
      const key = `${short}/${withoutPkgs.slice(short.length + 1)}`;
      if (moduleByKey.has(key)) return key;
    }
    const nested = short.replace(/-/g, "/");
    if (nested !== short && withoutPkgs.startsWith(`${nested}/`)) {
      const key = `${short}/${withoutPkgs.slice(nested.length + 1)}`;
      if (moduleByKey.has(key)) return key;
    }
  }
  return null;
}

// Effective aliases — set by generateOutput() to include auto-generated ones
let activePathSegs: [string, string][] = PATH_SEGS;
let activeExtAliases: [string, string][] = EXT_ALIASES;

function compressPath(rawPath: string): string {
  if (FULL) return rawPath.replace(/^src\//, "");
  let p = rawPath.replace(/^src\//, "").replace(/\/index$/, "");
  if (p === "index") p = "idx";
  for (const [from, to] of activePathSegs) {
    const i = p.indexOf(from);
    if (i !== -1) p = p.slice(0, i) + to + p.slice(i + from.length);
  }
  return p;
}

function compressExtDep(dep: string): string {
  for (const [from, to] of activeExtAliases) {
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

// ─── Domain assignment ────────────────────────────────────────────────────────

// Use configured domain map if present, otherwise auto-infer from directory structure
const STEM_TO_DOMAIN: Record<string, string> | null = CONFIGURED_DOMAIN_MAP ?? null;
const HAS_DOMAIN_MAP = !!STEM_TO_DOMAIN;

/** Auto-infer domain from module path using first directory segment. */
function inferDomainFromDir(modPath: string): string | null {
  const p = modPath.replace(/^src\//, "");
  const segments = p.split("/");
  if (segments.length > 1) return segments[0]!;
  return null; // root-level file — handled by caller
}

function inferDomainFromModPath(modPath: string): string | null {
  if (STEM_TO_DOMAIN) {
    // Config-based: match filename stem against domain map
    const p = modPath.replace(/^src\//, "").replace(/\.(ts|tsx)$/, "");
    const base = p.split("/").pop() ?? "";
    const stem = base
      .replace(/\.route$/, "")
      .replace(/\.controller$/, "")
      .replace(/\.model$/, "")
      .replace(/\.connector$/, "")
      .replace(/\.service$/, "")
      .replace(/\.openapi$/, "")
      .replace(/\.handler$/, "");
    return STEM_TO_DOMAIN[stem] ?? STEM_TO_DOMAIN[stem.toLowerCase()] ?? null;
  }
  // Auto-infer: use first directory segment
  return inferDomainFromDir(modPath);
}

function inferDomainFromSchemaName(name: string): string | null {
  if (!STEM_TO_DOMAIN) return null;
  const stem = name
    .replace(
      /^(Create|Update|Delete|Get|List|Search|Insert|Upsert|Bulk|Request|Response|Recent)/,
      "",
    )
    .replace(/Schema$/, "");
  const lower = stem.toLowerCase();
  if (STEM_TO_DOMAIN[stem]) return STEM_TO_DOMAIN[stem];
  if (STEM_TO_DOMAIN[lower]) return STEM_TO_DOMAIN[lower];
  for (const [key, domain] of Object.entries(STEM_TO_DOMAIN)) {
    if (lower.startsWith(key.toLowerCase()) && key.length > 3) return domain;
  }
  return null;
}

function inferDomainFromTableName(name: string): string | null {
  if (!STEM_TO_DOMAIN) return null;
  const first = name.split("_")[0] ?? name;
  return STEM_TO_DOMAIN[first] ?? STEM_TO_DOMAIN[name] ?? null;
}

function inferDomainFromRedisKey(pattern: string): string | null {
  if (!STEM_TO_DOMAIN) return null;
  const parts = pattern
    .replace(/\{[^}]+\}/g, "")
    .split(":")
    .filter(Boolean);
  for (const part of parts) {
    const d = STEM_TO_DOMAIN[part];
    if (d) return d;
  }
  return null;
}

// Map superschema $BE/ file path abbreviation → domain
function inferDomainFromSchemaFilePath(f: string): string | null {
  // "$BE/ctl/guild.controller" → "guilds"
  const base = f.split("/").pop() ?? "";
  return inferDomainFromModPath(base + ".ts") ?? inferDomainFromModPath(base);
}

// ─── Domain data structure ────────────────────────────────────────────────────

type DomainBlock = {
  endpoints: FlowEndpoint[];
  moduleKeys: Set<string>;
  schemas: ZodSchema[];
  tables: SqlTable[];
  enums: SqlEnum[];
  redisKeys: RedisKey[];
  tsTypes: TsType[];
};

const domains = new Map<string, DomainBlock>();

function dom(name: string): DomainBlock {
  if (!domains.has(name)) {
    domains.set(name, {
      endpoints: [],
      moduleKeys: new Set(),
      schemas: [],
      tables: [],
      enums: [],
      redisKeys: [],
      tsTypes: [],
    });
  }
  return domains.get(name)!;
}

// ─── Step 1: Assign endpoints + trace module graph ────────────────────────────

const assignedModules = new Map<string, string>();

function assignModule(key: string, domainName: string) {
  if (!assignedModules.has(key)) {
    assignedModules.set(key, domainName);
    dom(domainName).moduleKeys.add(key);
  }
}

for (const ep of flows.endpoints) {
  const d = dom(ep.domain);
  d.endpoints.push(ep);
  const routeKey = endpointFileToModuleKey(ep.file);
  if (!routeKey) continue;
  assignModule(routeKey, ep.domain);
  const { mod: routeMod, short } = moduleByKey.get(routeKey) ?? {};
  if (!routeMod || !short) continue;
  for (const dep1 of routeMod.internalDeps ?? []) {
    const dep1Key = `${short}/${dep1}`;
    assignModule(dep1Key, ep.domain);
    const { mod: dep1Mod } = moduleByKey.get(dep1Key) ?? {};
    if (!dep1Mod) continue;
    const skip2 =
      /\/(u\/|utils\/|config\/|stable\/db\/|queues\/|workers?\/)/.test(dep1);
    if (skip2) continue;
    for (const dep2 of dep1Mod.internalDeps ?? []) {
      assignModule(`${short}/${dep2}`, ep.domain);
    }
  }
}

// ─── Step 2: Assign remaining modules by name heuristic ───────────────────────

for (const [key, { short, mod }] of moduleByKey) {
  if (assignedModules.has(key)) continue;
  const domain = inferDomainFromModPath(mod.path);
  if (domain) {
    assignModule(key, domain);
  } else if (!HAS_DOMAIN_MAP) {
    // Auto-infer: root-level files go to a domain named after the package
    const pkgData = allMaps.get(short);
    assignModule(key, pkgData?.map.package ?? short);
  }
}

// ─── Step 3: Assign schemas, tables, Redis keys, TS types ────────────────────

for (const s of schemaData.zod ?? []) {
  const d = inferDomainFromSchemaName(s.n) ?? "shared";
  dom(d).schemas.push(s);
}
for (const t of schemaData.sql?.tables ?? []) {
  const d = inferDomainFromTableName(t.n) ?? "shared";
  dom(d).tables.push(t);
}
for (const e of schemaData.sql?.enums ?? []) {
  const d = inferDomainFromTableName(e.n) ?? "shared";
  dom(d).enums.push(e);
}
for (const k of schemaData.redis?.keys ?? []) {
  const d = inferDomainFromRedisKey(k.p) ?? "shared";
  dom(d).redisKeys.push(k);
}
// Assign TS types to domains (non-private controller/connector types)
for (const t of schemaData.ts ?? []) {
  if (t.int) continue; // skip private (·) types for domain blocks
  const domain = inferDomainFromSchemaFilePath(t.f);
  if (domain) dom(domain).tsTypes.push(t);
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

/** Full schema rendering — all fields, no truncation, superschema-style.
 *  If diff is provided, renders as `=BaseName` or `=BaseName+ extraFields`. */
function renderSchemaFull(
  s: ZodSchema,
  diff?: { base: string; extra: ZodField[] },
): string {
  const compact = (t: string) =>
    t
      .replace(/string\(uuid\)/g, "uuid")
      .replace(/string\(email\)/g, "email")
      .replace(/string\(url\)/g, "url")
      .replace(/string\(datetime\)/g, "dt")
      .replace(/Date \| number \| string\(datetime\)/g, "dt")
      .replace(/number \| null/g, "num?")
      .replace(/\bstring\b/g, "str");

  if (diff) {
    if (diff.extra.length === 0) return `${s.n}(L${s.l})  =${diff.base}`;
    const ep = diff.extra.map(
      (f) => `${f.n}${f.o ? "?" : ""}:${compact(f.t).slice(0, 60)}`,
    );
    return `${s.n}(L${s.l})  =${diff.base}+  ${ep.join("  ")}`;
  }
  if (s.fields?.length) {
    const parts = s.fields.map(
      (f) => `${f.n}${f.o ? "?" : ""}:${compact(f.t).slice(0, 60)}`,
    );
    return `${s.n}(L${s.l})  ${parts.join("  ")}`;
  }
  if (s.body) return `${s.n}(L${s.l})  =${compact(s.body).slice(0, 120)}`;
  return `${s.n}(L${s.l})`;
}

/** Full table rendering. */
function renderTableFull(t: SqlTable): string {
  const pkStr = t.pk.length ? ` PK(${t.pk.join(",")})` : "";
  const fkStr = t.fk.length
    ? ` FK(${t.fk.map((f) => `${f.from.join("+")}→${f.to}`).join(",")})`
    : "";
  const colStr = t.cols
    .map((c) => {
      let s = `${c.n}:${c.t}`;
      if (c.nn) s += "!";
      if (c.fk) s += `→${c.fk}`;
      return s;
    })
    .join(" ");
  const idxStr = t.idx
    .map((i) => `·${i.uq ? "uq" : "idx"}(${i.cols.join(",")})`)
    .join(" ");
  return `${t.n}${pkStr}${fkStr}  ${colStr}${idxStr ? "  " + idxStr : ""}`;
}

/** Op flags string. */
function opFlags(ep: FlowEndpoint): string {
  const f = [
    ep.redis.length ? "R" : "",
    ep.protocol.length ? "Π" : "",
    ep.pg.length ? "P" : "",
    ep.analytics.length ? "E" : "",
    ep.integration.length ? "I" : "",
    ep.rateLimits.length ? "L" : "",
  ].filter(Boolean);
  return f.length ? `[${f.join("")}]` : "";
}

const trunc = (arr: string[], n: number) =>
  arr.length <= n
    ? arr.join(",")
    : `${arr.slice(0, n).join(",")},+${arr.length - n}`;

/** Find common prefix items present in ≥threshold fraction of non-empty arrays.
 *  At each position picks the most-common value; stops when it falls below threshold.
 *  Arrays shorter than the current position are simply excluded from that round. */
function commonPfx(arrs: string[][], threshold = 0.8): string[] {
  const nonempty = arrs.filter((a) => a.length > 0);
  if (!nonempty.length) return [];
  const pfx: string[] = [];
  for (let i = 0; ; i++) {
    const valFreq = new Map<string, number>();
    for (const a of nonempty) {
      if (i < a.length) valFreq.set(a[i]!, (valFreq.get(a[i]!) ?? 0) + 1);
    }
    if (!valFreq.size) break;
    const [topVal, topCount] = [...valFreq.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0]!;
    if (topCount / nonempty.length < threshold) break;
    pfx.push(topVal);
  }
  return pfx;
}

/** True if a TS type is purely a `z.output<typeof XSchema>` alias — zero new info. */
function isZodOutputAlias(t: TsType): boolean {
  return !!t.body?.match(/^z\.output<typeof \w+>$/);
}

/** Build schema diff map: for schemas that extend a Create* base, record the base name + extra fields. */
function buildSchemaDiffs(
  schemas: ZodSchema[],
): Map<string, { base: string; extra: ZodField[] }> {
  const byName = new Map<string, ZodSchema>(
    schemas.filter((s) => s.fields?.length).map((s) => [s.n, s]),
  );
  const result = new Map<string, { base: string; extra: ZodField[] }>();
  for (const s of schemas) {
    if (!s.fields?.length) continue;
    const stem = s.n.replace(/Schema$/, "");
    // Candidate base: same entity with "Create" prefix
    const baseName = stem.startsWith("Update")
      ? `Create${stem.slice(6)}Schema`
      : stem.startsWith("Insert")
        ? `Create${stem.slice(6)}Schema`
        : stem.startsWith("Upsert")
          ? `Create${stem.slice(6)}Schema`
          : !stem.startsWith("Create")
            ? `Create${stem}Schema`
            : null;
    if (!baseName || baseName === s.n) continue;
    const base = byName.get(baseName);
    if (!base?.fields?.length) continue;
    // s must be a strict superset: every base field present with same name, type, optionality
    const missing = base.fields.filter(
      (bf) =>
        !s.fields!.some(
          (sf) => sf.n === bf.n && sf.t === bf.t && sf.o === bf.o,
        ),
    );
    if (missing.length > 0) continue;
    const baseNames = new Set(base.fields.map((f) => f.n));
    const extra = s.fields.filter((f) => !baseNames.has(f.n));
    result.set(s.n, { base: baseName, extra });
  }
  return result;
}

/**
 * Auto-group consecutive module lines sharing the same directory prefix.
 * When ≥minRun lines in a row share the same last-dir prefix (path up to
 * and including its last /), emit a [prefix] header and strip that prefix
 * from each indented line. No aliases — names are preserved verbatim.
 */
function autoGroupLines(modLines: string[], minRun = 3): string[] {
  const result: string[] = [];
  let i = 0;

  while (i < modLines.length) {
    const line = modLines[i]!;
    // Module lines: "path[stats]..." — extract path before first [
    const bracketIdx = line.indexOf("[");
    if (bracketIdx <= 1) {
      result.push(line);
      i++;
      continue;
    }
    const path = line.slice(0, bracketIdx);
    const slashIdx = path.lastIndexOf("/");
    if (slashIdx < 1) {
      result.push(line);
      i++;
      continue;
    }
    const prefix = path.slice(0, slashIdx + 1);

    // Scan ahead: count consecutive lines sharing this exact prefix
    let j = i + 1;
    while (j < modLines.length) {
      const nb = modLines[j]!.indexOf("[");
      if (nb <= 1) break;
      if (!modLines[j]!.slice(0, nb).startsWith(prefix)) break;
      j++;
    }

    if (j - i >= minRun) {
      result.push(`[${prefix}]`);
      for (let k = i; k < j; k++)
        result.push("  " + modLines[k]!.slice(prefix.length));
      i = j;
    } else {
      result.push(line);
      i++;
    }
  }
  return result;
}

/** Render a module line in supergraph.txt style. */
function renderModLine(key: string, mod: RawModule): string {
  const compressed = compressPath(mod.path);
  const { exportedSymbols, totalSymbols } = mod.stats;
  const importedBy = globalImportedBy.get(key) ?? 0;
  const statStr =
    exportedSymbols === totalSymbols
      ? `[${exportedSymbols}]`
      : `[${exportedSymbols}/${totalSymbols}]`;
  const inbStr = importedBy >= 2 ? `←${importedBy}` : "";
  // Symbol budget: ←0→none, ←1→3, ←2..4→5, ←5+→8 (--full: show all)
  const maxSyms = FULL
    ? Infinity
    : importedBy === 0
      ? 0
      : importedBy === 1
        ? 3
        : importedBy <= 4
          ? 5
          : 8;
  const expSymbols = mod.symbols.filter((s) => s.exported).map((s) => s.name);
  const symStr =
    maxSyms > 0 && expSymbols.length > 0
      ? " " +
        (expSymbols.length <= maxSyms
          ? expSymbols.join(",")
          : `${expSymbols.slice(0, maxSyms).join(",")},+${expSymbols.length - maxSyms}`)
      : "";
  // Filter same-package @/ internal paths — they add no cross-package dependency info
  const extDeps = mod.externalDeps
    .filter((d) => !d.startsWith("@/"))
    .slice(0, FULL ? Infinity : 8)
    .map(compressExtDep);
  const extStr = extDeps.length ? ` | ${extDeps.join(",")}` : "";
  return `${compressed}${statStr}${inbStr}${symStr}${extStr}`;
}

/** Whether a module is a "key" (route/ctrl/model/connector) file. */
function isKeyMod(modPath: string): boolean {
  return (
    /\.(route|controller|model|connector|service)\.ts$/.test(modPath) ||
    /\/(routes?|controllers?|models?|connectors?)\//.test(modPath)
  );
}

/** Render a TS type entry. */
function renderTsType(t: TsType): string {
  const priv = t.int ? "·" : "";
  const kind = t.k === 1 ? "iface" : "type";
  const generic = t.g ?? "";
  const extStr = t.ext?.length ? ` ext:${t.ext.join(",")}` : "";
  const namePart = `${priv}${t.n}${generic}(L${t.l})[${kind}]${extStr}`;
  if (t.fields?.length) {
    const fields = t.fields
      .map((f) => {
        const opt = f.o ? "?" : "";
        const ro = f.ro ? "ro:" : "";
        return `${ro}${f.n}${opt}:${f.t}`;
      })
      .join("  ");
    return `${namePart}  ${fields}`;
  }
  if (t.body) return `${namePart}  =${t.body.slice(0, 200)}`;
  return namePart;
}

/**
 * Compress protocol SDK response types: 6 variants per op → 1 line.
 *   getXResponse200  data:ReturnType  status:200
 *   getXResponse400  data:HattpErrorResponse  status:400
 *   getXResponseSuccess, getXResponseError, getXResponse
 *   → getX  200→ReturnType  err:400,404
 */
function compressSdkTypes(types: TsType[]): string[] {
  type OpInfo = {
    name: string;
    success: { status: string; type: string } | null;
    errors: string[];
  };
  const ops = new Map<string, OpInfo>();
  const RESPONSE_RE =
    /^(\w+)Response(200|201|204|400|401|403|404|500|Default|Success|Error)?$/;
  const nonOp: TsType[] = [];

  for (const t of types) {
    const m = t.n.match(RESPONSE_RE);
    if (!m) {
      nonOp.push(t);
      continue;
    }
    const opName = m[1]!;
    const suffix = m[2] ?? "";
    if (!ops.has(opName))
      ops.set(opName, { name: opName, success: null, errors: [] });
    const op = ops.get(opName)!;
    const statusNum = parseInt(suffix);
    if (!isNaN(statusNum)) {
      if (statusNum < 300) {
        const dataField = t.fields?.find((f) => f.n === "data");
        if (dataField && !op.success)
          op.success = { status: suffix, type: dataField.t };
      } else if (!op.errors.includes(suffix)) {
        op.errors.push(suffix);
      }
    }
  }

  const lines: string[] = [];
  // Non-SDK types first
  for (const t of nonOp) lines.push(renderTsType(t));
  // Compressed SDK ops (only those with a success type)
  if (ops.size > 0) {
    lines.push(
      `# ${ops.size} ops (compressed: 200→ReturnType  err:statusCodes)`,
    );
    for (const [, op] of ops) {
      if (!op.success && !op.errors.length) continue;
      const suc = op.success ? `${op.success.status}→${op.success.type}` : "";
      const err = op.errors.length ? ` err:${op.errors.sort().join(",")}` : "";
      lines.push(`${op.name}  ${suc}${err}`);
    }
  }
  return lines;
}

// ─── Auto-generate helpers ────────────────────────────────────────────────────

/** Auto-generate path segment abbreviations from common module path prefixes. */
function autoGeneratePathSegs(maps: Map<string, PkgData>): [string, string][] {
  const prefixCount = new Map<string, number>();
  for (const [, { map }] of maps) {
    for (const mod of map.modules) {
      const p = mod.path.replace(/^src\//, "");
      const parts = p.split("/");
      if (parts.length > 1) {
        const prefix = parts.slice(0, -1).join("/") + "/";
        prefixCount.set(prefix, (prefixCount.get(prefix) ?? 0) + 1);
      }
    }
  }
  // Only create abbreviations for prefixes used ≥4 times
  const result: [string, string][] = [];
  const sorted = [...prefixCount.entries()]
    .filter(([, count]) => count >= 4)
    .sort((a, b) => b[0].length - a[0].length); // longest first for greedy matching
  const usedAbbrevs = new Set<string>();
  for (const [prefix] of sorted) {
    // Generate abbreviation from first letters of path segments
    const segments = prefix.replace(/\/$/, "").split("/");
    let abbr = segments.map((s) => s[0]?.toUpperCase() ?? "").join("");
    if (!abbr || usedAbbrevs.has(abbr)) {
      abbr = segments.map((s) => s.slice(0, 2)).join("").toUpperCase();
    }
    if (usedAbbrevs.has(abbr)) continue;
    usedAbbrevs.add(abbr);
    result.push([prefix, `${abbr}/`]);
  }
  return result;
}

/** Auto-generate external dependency aliases from npm scopes. */
function autoGenerateExtAliases(maps: Map<string, PkgData>): [string, string][] {
  const scopeCount = new Map<string, number>();
  for (const [, { map }] of maps) {
    for (const mod of map.modules) {
      for (const dep of mod.externalDeps ?? []) {
        if (dep.startsWith("@")) {
          const scope = dep.split("/")[0]! + "/";
          scopeCount.set(scope, (scopeCount.get(scope) ?? 0) + 1);
        }
      }
    }
  }
  const result: [string, string][] = [];
  const usedAbbrevs = new Set<string>();
  for (const [scope, count] of [...scopeCount.entries()].sort((a, b) => b[1] - a[1])) {
    if (count < 3) continue;
    // @tanstack/ → T=, @hono/ → H=, etc.
    const name = scope.slice(1, -1); // strip @ and /
    let abbr = name[0]?.toUpperCase() ?? "";
    if (usedAbbrevs.has(abbr)) abbr = name.slice(0, 2).toUpperCase();
    if (usedAbbrevs.has(abbr)) continue;
    usedAbbrevs.add(abbr);
    result.push([scope, `${abbr}/`]);
  }
  return result;
}

// ─── Generate output ──────────────────────────────────────────────────────────

function generateOutput(): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);
  const epCount = flows.endpoints.length;
  const hkCount = flows.endpoints.reduce((n, ep) => n + ep.hooks.length, 0);
  const totalMods = moduleByKey.size;
  const tsCount = schemaData.stats?.ts ?? 0;

  // ── Compute op-detail defaults (prefix items common to ≥85% of endpoints) ──
  const R_PFX = commonPfx(flows.endpoints.map((ep) => ep.redis));
  const Π_PFX = commonPfx(flows.endpoints.map((ep) => ep.protocol));
  const P_PFX = commonPfx(flows.endpoints.map((ep) => ep.pg));
  const E_PFX = commonPfx(flows.endpoints.map((ep) => ep.analytics));
  // I: default = most common integration set (compared as sorted join)
  const iFreq = new Map<string, number>();
  for (const ep of flows.endpoints) {
    const k = [...ep.integration].sort().join(",");
    iFreq.set(k, (iFreq.get(k) ?? 0) + 1);
  }
  const I_DEFAULT_STR =
    [...iFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

  // ── Header ────────────────────────────────────────────────────────────────
  const projectName = cfg.project || schemaData?.project || basename(ROOT);
  lines.push(`SUPERHIGH | ${projectName} | ${date}`);
  const statParts: string[] = [];
  if (epCount) statParts.push(`${epCount}ep`);
  const zodCount = schemaData.stats?.zod ?? 0;
  if (zodCount) statParts.push(`${zodCount}z`);
  const sqlCount = schemaData.stats?.sql ?? 0;
  if (sqlCount) statParts.push(`${sqlCount}tbl`);
  const redisCount = schemaData.stats?.redis ?? 0;
  if (redisCount) statParts.push(`${redisCount}key`);
  if (hkCount) statParts.push(`${hkCount}hk`);
  statParts.push(`${totalMods}mods`);
  if (tsCount) statParts.push(`${tsCount}ty`);
  lines.push(statParts.join(" · "));
  if (HAS_FLOWS) {
    lines.push(
      "R=Redis  Π=Protocol  P=Storage  E=Analytics  I=Integration  L=RateLimit",
    );
  }
  lines.push("");

  // Auto-generate path segments from module paths if none configured
  const effectivePathSegs = PATH_SEGS.length ? PATH_SEGS : autoGeneratePathSegs(allMaps);
  // Auto-generate ext dep aliases if none configured
  const effectiveExtAliases = EXT_ALIASES.length ? EXT_ALIASES : autoGenerateExtAliases(allMaps);
  // Set active aliases for compressPath/compressExtDep
  activePathSegs = effectivePathSegs;
  activeExtAliases = effectiveExtAliases;

  if (FULL) {
    if (effectiveExtAliases.length) {
      lines.push(
        "# EXT DEP ALIASES  (module paths are full/unabbreviated; [dir/] = auto-grouped prefix)",
      );
      lines.push(effectiveExtAliases.map(([f, t]) => `${t}=${f}`).join("  "));
      lines.push("");
    }
  } else {
    if (effectivePathSegs.length) {
      lines.push(
        "# PATH SEGS  (applied to module paths in DOMAIN and PACKAGES sections)",
      );
      lines.push(effectivePathSegs.map(([f, t]) => `${t}=${f}`).join("  "));
      lines.push("");
    }

    if (effectiveExtAliases.length) {
      lines.push("# EXT DEP ALIASES");
      lines.push(effectiveExtAliases.map(([f, t]) => `${t}=${f}`).join("  "));
      lines.push("");
    }
  }

  lines.push("# BLOCK FORMAT");
  lines.push("## domain  Nmod" + (HAS_FLOWS ? " Nep Nmut" : "") + (HAS_SCHEMA ? " Nsch Ntbl Nkey Nty" : ""));
  if (HAS_FLOWS) {
    lines.push(
      "R  METHOD /path [auth] ctrl:fns [ops]  ←hookName·inv:queryKey  {svc-if-not-backend}",
    );
    lines.push(
      "   ↳R:redis-ops  Π:proto  P:storage  E:events  I:integration-events",
    );
  }
  lines.push(
    "M  modPath[exp/tot]←importers  key=(route/ctrl/model)  other=(util/config/middleware)",
  );
  if (HAS_SCHEMA) {
    lines.push(
      "S  SchemaName(Ln)  field:type  opt?:type  =scalar  (full field definitions)",
    );
    lines.push("T  tableName PK(cols) FK(col→ref)  col:type! →fk  ·idx(col)");
    lines.push("E  ENUM name  val1|val2|...");
    lines.push("K  redis:{pattern}[ops]→schemaHint");
    lines.push(
      "Ty typeName(Ln)[type|iface]  fields or =body  (public controller/connector types)",
    );
  }
  lines.push("");

  // ── OP DEFAULTS legend (implied in ↳ lines — only deltas shown) ───────────
  {
    const defs: string[] = [];
    if (R_PFX.length) defs.push(`R0=${R_PFX.join(",")}`);
    if (Π_PFX.length) defs.push(`Π0=${Π_PFX.join(",")}`);
    if (P_PFX.length) defs.push(`P0=${P_PFX.join(",")}`);
    if (E_PFX.length) defs.push(`E0=${E_PFX.join(",")}`);
    if (I_DEFAULT_STR) defs.push(`I∀=${I_DEFAULT_STR}`);
    if (defs.length) {
      lines.push(
        "# OP DEFAULTS  (↳ omits these; only deltas printed; I∀ omitted when integration matches default)",
      );
      lines.push(defs.join("  "));
      lines.push("");
    }
  }

  // ── Domain blocks ────────────────────────────────────────────────────────
  const sortedNames = CONFIGURED_DOMAIN_ORDER
    ? [...domains.keys()].sort((a, b) => {
        const ai = CONFIGURED_DOMAIN_ORDER!.indexOf(a);
        const bi = CONFIGURED_DOMAIN_ORDER!.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })
    : [...domains.keys()].sort((a, b) => {
        // Sort by module count descending, then by aggregate import centrality
        const countDiff = (domains.get(b)?.moduleKeys.size ?? 0) - (domains.get(a)?.moduleKeys.size ?? 0);
        if (countDiff !== 0) return countDiff;
        const score = (name: string) =>
          [...(domains.get(name)?.moduleKeys ?? [])].reduce(
            (s, k) => s + (globalImportedBy.get(k) ?? 0), 0,
          );
        return score(b) - score(a) || a.localeCompare(b);
      });

  for (const domainName of sortedNames) {
    const d = domains.get(domainName)!;
    // When using configured domain map, skip empty domains (no endpoints/schemas/tables/redis)
    // When auto-inferring, show domains that have modules
    if (HAS_DOMAIN_MAP) {
      if (
        !d.endpoints.length &&
        !d.schemas.length &&
        !d.tables.length &&
        !d.redisKeys.length
      )
        continue;
    } else {
      if (!d.moduleKeys.size) continue;
    }

    const mut = d.endpoints.filter((e) => e.method !== "GET").length;
    const allDomainMods = [...d.moduleKeys];
    const keyMods = allDomainMods.filter((k) => {
      const entry = moduleByKey.get(k);
      return entry ? isKeyMod(entry.mod.path) : false;
    });
    const otherMods = allDomainMods.filter((k) => {
      const entry = moduleByKey.get(k);
      return entry ? !isKeyMod(entry.mod.path) : false;
    });

    const statParts = [
      d.endpoints.length ? `${d.endpoints.length}ep` : "",
      mut ? `${mut}mut` : "",
      allDomainMods.length ? `${allDomainMods.length}mod` : "",
      d.schemas.length ? `${d.schemas.length}sch` : "",
      d.tables.length ? `${d.tables.length}tbl` : "",
      d.enums.length ? `${d.enums.length}enum` : "",
      d.redisKeys.length ? `${d.redisKeys.length}key` : "",
      d.tsTypes.length ? `${d.tsTypes.length}ty` : "",
    ].filter(Boolean);
    lines.push(`## ${domainName}  ${statParts.join(" ")}`);

    // ── Op detail helper (returns the ↳ content string, or "" if nothing to show) ──
    const epOpDetail = (ep: FlowEndpoint): string => {
      const parts: string[] = [];
      const rDelta = ep.redis.slice(R_PFX.length);
      if (rDelta.length) parts.push(`R:${trunc(rDelta, 4)}`);
      const piDelta = ep.protocol.slice(Π_PFX.length);
      if (piDelta.length) parts.push(`Π:${trunc(piDelta, 3)}`);
      const pgDelta = ep.pg.slice(P_PFX.length);
      if (pgDelta.length) parts.push(`P:${trunc(pgDelta, 3)}`);
      const eDelta = ep.analytics.slice(E_PFX.length);
      if (eDelta.length) parts.push(`E:${trunc(eDelta, 3)}`);
      const iKey = [...ep.integration].sort().join(",");
      if (iKey !== I_DEFAULT_STR) {
        if (ep.integration.length) parts.push(`I:${trunc(ep.integration, 3)}`);
        else if (I_DEFAULT_STR) parts.push("I:∅");
      }
      if (ep.rateLimits.length) parts.push(`L:${trunc(ep.rateLimits, 2)}`);
      return parts.join("  ");
    };

    // If all endpoints in this domain share the same non-empty ↳, hoist it as ↳* (saves N-1 lines)
    const allDetails = d.endpoints.map(epOpDetail);
    const sharedDetail =
      allDetails.length >= 2 &&
      allDetails.every((s) => s === allDetails[0] && s !== "")
        ? allDetails[0]!
        : null;
    if (sharedDetail) lines.push(`   ↳*${sharedDetail}`);

    // Endpoints
    for (const ep of d.endpoints) {
      const flags = opFlags(ep);
      const auth = ep.auth !== "public" ? ` [${ep.auth}]` : "";
      const ctrl = ep.ctrl.length ? ` ctrl:${trunc(ep.ctrl, 3)}` : "";
      const svc = ep.service !== "backend" ? `  {${ep.service}}` : "";
      const seenHooks = new Set<string>();
      const hookParts = ep.hooks
        .filter((h) => {
          if (seenHooks.has(h.name)) return false;
          seenHooks.add(h.name);
          return true;
        })
        .map((h) => {
          const inv = h.inv.length ? `·inv:${trunc(h.inv, 2)}` : "";
          const set = h.set.length ? `·set:${trunc(h.set, 2)}` : "";
          return `←${h.name}${inv}${set}`;
        });
      lines.push(
        [
          `R  ${ep.method} ${ep.path}${auth}${ctrl}`,
          flags || "",
          svc,
          ...hookParts,
        ]
          .filter(Boolean)
          .join("  "),
      );

      // Per-endpoint ↳ only when it differs from the hoisted shared detail
      if (!sharedDetail) {
        const detail = epOpDetail(ep);
        if (detail) lines.push(`   ↳${detail}`);
      }
    }

    // Key modules (route/ctrl/model) — prominent display
    if (keyMods.length) {
      const modStrs = keyMods
        .sort((a, b) => (globalImportedBy.get(b) ?? 0) - (globalImportedBy.get(a) ?? 0)
          || (moduleByKey.get(a)?.mod.path ?? a).localeCompare(moduleByKey.get(b)?.mod.path ?? b))
        .map(key => {
          const { mod } = moduleByKey.get(key)!;
          const { exportedSymbols, totalSymbols } = mod.stats;
          const inb = globalImportedBy.get(key) ?? 0;
          const statStr =
            exportedSymbols === totalSymbols
              ? `[${exportedSymbols}]`
              : `[${exportedSymbols}/${totalSymbols}]`;
          const inbStr = inb >= 2 ? `←${inb}` : "";
          const extDeps = mod.externalDeps
            .filter((d) => !d.startsWith("@/"))
            .slice(0, 5)
            .map(compressExtDep);
          const extStr = extDeps.length ? ` | ${extDeps.join(",")}` : "";
          return `${compressPath(mod.path)}${statStr}${inbStr}${extStr}`;
        });
      lines.push(`M  ${modStrs.join("  ")}`);
    }

    // Other domain modules (util, config, stable, middleware, etc.)
    if (otherMods.length) {
      const otherPaths = otherMods
        .sort((a, b) => (globalImportedBy.get(b) ?? 0) - (globalImportedBy.get(a) ?? 0)
          || (moduleByKey.get(a)?.mod.path ?? a).localeCompare(moduleByKey.get(b)?.mod.path ?? b))
        .map(key => {
          const { mod } = moduleByKey.get(key)!;
          const inb = globalImportedBy.get(key) ?? 0;
          const inbStr = inb >= 2 ? `←${inb}` : "";
          return `${compressPath(mod.path)}${inbStr}`;
        });
      // Pack onto lines of ≤8 items
      for (let i = 0; i < otherPaths.length; i += 8) {
        lines.push(`M+ ${otherPaths.slice(i, i + 8).join("  ")}`);
      }
    }

    // Full schema definitions (with diff notation for CRUD schema trios)
    const schemaDiffs = buildSchemaDiffs(d.schemas);
    for (const s of d.schemas) {
      lines.push(`S  ${renderSchemaFull(s, schemaDiffs.get(s.n))}`);
    }

    // Tables
    for (const t of d.tables) {
      lines.push(`T  ${renderTableFull(t)}`);
    }
    for (const e of d.enums) {
      lines.push(`E  ENUM ${e.n}  ${e.vals.join("|")}`);
    }

    // Redis keys
    if (d.redisKeys.length) {
      const keyStrs = d.redisKeys.map((k) => {
        const ops = k.ops.join("/");
        const hint = k.s ? `→${k.s}` : "";
        const src = k.files.length ? ` (${k.files.join(",")})` : "";
        return `${k.p}[${ops}]${hint}${src}`;
      });
      for (let i = 0; i < keyStrs.length; i += 3) {
        lines.push(`K  ${keyStrs.slice(i, i + 3).join("  ")}`);
      }
    }

    // RediSearch FT indexes
    const ftIdx =
      schemaData.redis?.idx?.filter(
        (i) =>
          inferDomainFromRedisKey(i.n) === domainName ||
          (i.prefix && inferDomainFromRedisKey(i.prefix) === domainName),
      ) ?? [];
    for (const i of ftIdx) {
      const pfx = i.prefix ? ` PREFIX:"${i.prefix}"` : "";
      lines.push(`K  FT ${i.n}${pfx}`);
    }

    // Public controller/connector types — skip zero-entropy z.output<typeof XSchema> aliases
    for (const t of d.tsTypes) {
      if (isZodOutputAlias(t)) continue;
      lines.push(`Ty ${renderTsType(t)}`);
    }

    lines.push("");
  }

  // ── PACKAGES section ──────────────────────────────────────────────────────
  const pkgHdr = FULL
    ? "# PACKAGES  (all modules · format: path[exp/tot]←importers syms | extDeps · [dir/] = auto-grouped prefix)"
    : "# PACKAGES  (all modules · format: path[exp/tot]←importers syms | extDeps)";
  lines.push(pkgHdr);
  if (!FULL) lines.push("# sym budget: ←0→none  ←1→3  ←2..4→5  ←5+→8");
  lines.push("");

  for (const [short, { map }] of allMaps) {
    const unassigned = map.modules
      .filter(m => !assignedModules.has(`${short}/${m.path}`))
      .sort((a, b) => {
        const aC = globalImportedBy.get(`${short}/${a.path}`) ?? 0;
        const bC = globalImportedBy.get(`${short}/${b.path}`) ?? 0;
        return bC - aC || a.path.localeCompare(b.path);
      });
    const npmName = map.package ?? short;
    const total = map.modules.length;
    if (total === 0) continue;

    lines.push(
      `[${short}=${npmName}  ${total}m  ${unassigned.length} unassigned]`,
    );
    const pkgModLines: string[] = [];
    for (const mod of unassigned) {
      const key = `${short}/${mod.path}`;
      const importedBy = globalImportedBy.get(key) ?? 0;
      if (mod.stats.exportedSymbols === 0 && importedBy === 0) continue;
      if (!FULL && importedBy === 0) continue; // compressed: skip leaf modules nobody imports
      pkgModLines.push(renderModLine(key, mod));
    }
    for (const l of FULL ? autoGroupLines(pkgModLines) : pkgModLines)
      lines.push(l);
    lines.push("");
  }

  // ── TYPES section ─────────────────────────────────────────────────────────
  const tsTypes = schemaData.ts ?? [];
  if (tsTypes.length > 0) {
    lines.push(`# TYPES  (${tsTypes.length} from superschema)`);
    if (schemaPathAbbrevLine) {
      lines.push(
        "# PATH ABBREVS  (schema file abbreviations used in [file] section headers)",
      );
      lines.push(schemaPathAbbrevLine);
      lines.push("");
    }

    // Group by file
    const byFile = new Map<string, TsType[]>();
    for (const t of tsTypes) {
      const f = t.f ?? "unknown";
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f)!.push(t);
    }

    // SDK response types: skip verbatim (redundant with compressed form below)
    const sdkApiFile = [...byFile.keys()].find(
      (f) =>
        f.includes("protocol/generated/api") ||
        f.includes("protocol/generated/api.ts"),
    );
    const sdkTypes = sdkApiFile ? (byFile.get(sdkApiFile) ?? []) : [];

    // Render all non-SDK types: skip private (·) internal types and z.output aliases
    for (const f of [...byFile.keys()].sort()) {
      if (f === sdkApiFile) continue; // SDK file rendered compressed-only below
      const fileTypes = byFile.get(f)!.filter((t) => !isZodOutputAlias(t));
      if (!fileTypes.length) continue;
      lines.push(`[${f}]`);
      for (const t of fileTypes) {
        lines.push(renderTsType(t));
      }
    }

    // SDK compressed (replaces the ~638-line verbatim section entirely)
    if (sdkTypes.length > 0) {
      lines.push("");
      lines.push(
        `# SDK  (${sdkTypes.length} types → 1 line per op  200→ReturnType  err:codes)`,
      );
      const compressed = compressSdkTypes(sdkTypes);
      for (const l of compressed) lines.push(l);
    }
  }

  // ── Op-profile deduplication (compressed mode only) ──────────────────────
  // Replace repeated identical ↳ delta lines with @N profile references.
  // Profile definitions are inserted after the OP DEFAULTS legend.
  if (!FULL) {
    // Collect all ↳ contents (stripped, excluding ↳* domain hoists)
    const freq = new Map<string, number>();
    for (const l of lines) {
      const s = l.trimStart();
      if (s.startsWith("↳") && !s.startsWith("↳*")) {
        const delta = s.slice(1); // everything after ↳
        freq.set(delta, (freq.get(delta) ?? 0) + 1);
      }
    }

    // Build profiles for patterns that repeat
    const profiles = new Map<string, string>(); // delta → @N
    let idx = 1;
    for (const [delta, count] of [...freq.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      if (count > 1) profiles.set(delta, `@${idx++}`);
    }

    if (profiles.size > 0) {
      // Find insertion point: the empty line after the OP DEFAULTS block
      let insertAt = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.startsWith("# OP DEFAULTS")) {
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j] === "") {
              insertAt = j + 1;
              break;
            }
          }
          break;
        }
      }

      const profileBlock = [
        `# OP PROFILES  (${profiles.size} repeated ↳ patterns · ↳@N = look up profile N below)`,
        ...[...profiles.entries()].map(([delta, id]) => `${id} ${delta}`),
        "",
      ];

      const before = insertAt >= 0 ? lines.slice(0, insertAt) : lines;
      const after = insertAt >= 0 ? lines.slice(insertAt) : [];

      const deduped = [...before, ...profileBlock, ...after].map((l) => {
        const s = l.trimStart();
        if (s.startsWith("↳") && !s.startsWith("↳*")) {
          const id = profiles.get(s.slice(1));
          if (id) return `${l.slice(0, l.length - s.length)}↳${id}`;
        }
        return l;
      });

      return deduped.join("\n");
    }
  }

  return lines.join("\n");
}

await mkdir(AUDIT, { recursive: true });
const out = generateOutput();
await Bun.write(outPath, out);

const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
console.log(
  `Done in ${elapsed}s  —  ${(out.length / 1024).toFixed(0)} KB / ${out.split("\n").length} lines → ${relative(ROOT, outPath)}`,
);
