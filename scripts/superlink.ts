#!/usr/bin/env bun
/**
 * superlink.ts — AST-aware fusion of supergraph + superflows + superschema.
 *
 * The three existing scripts produce complementary but disconnected views:
 *   supergraph  → module dependency graph
 *   superflows  → API endpoints / ops / hooks
 *   superschema → Zod schemas / Drizzle tables / Redis keys / TS types
 *
 * superlink groups ALL of this by semantic domain (guilds, roles, rewards…)
 * so each domain block shows: endpoints → modules → schemas → tables → redis.
 *
 * The "AST connection" comes from each package's map.json internalDeps field,
 * which records actual import edges within a package:
 *   route module → controller modules → model modules
 * This lets us place every module in its true domain rather than guessing from
 * file names alone.  Schemas, tables and Redis keys are then matched to that
 * same domain via name-prefix heuristics.
 *
 * Result: 1 block per domain instead of 3 separate flat lists → lower
 * Kolmogorov complexity, better LLM context efficiency than superhigh.txt.
 *
 * Reads:
 *   audit/packages/<pkg>/json/map.json  (raw per-package module data from audit-prep)
 *   audit/superflows.json               (endpoints + hooks, from superflow.ts)
 *   audit/superschema.json              (schemas + tables + redis, from superschema.ts)
 *
 * Writes: audit/superlink.txt  (configurable via config.json → superlink.output)
 *
 * Usage: bun superlink.ts [--out <path>] [--fresh]
 *   --fresh  Re-run the three source scripts before building the fused output.
 */

import { mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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

type SchemaJson = {
  project: string;
  stats: { zod: number; sql: number; redis: number; ts: number };
  zod: ZodSchema[];
  sql: { enums: SqlEnum[]; tables: SqlTable[] };
  redis: { keys: RedisKey[]; idx: { n: string; prefix?: string }[] };
};

// ─── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun superlink.ts [--out <path>] [--fresh]");
  console.log(
    "  Fuses supergraph + superflows + superschema by semantic domain.",
  );
  console.log("  --fresh  Re-run the three source scripts first.");
  process.exit(0);
}

const cfg = await loadConfig(ROOT);
const slCfg =
  ((cfg as Record<string, unknown>).superlink as
    | { output?: string }
    | undefined) ?? {};
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
    : resolve(ROOT, slCfg.output ?? "audit/superlink.txt");

// ─── Ensure source JSON files exist ──────────────────────────────────────────

async function runForJson(scriptPath: string): Promise<string> {
  const scriptAbs = resolve(import.meta.dir, scriptPath.split("/").pop()!);
  console.log(`  Running ${scriptPath}…`);
  const proc = Bun.spawn(["bun", scriptAbs, "--json", "--root", ROOT], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

console.log("Building superlink…");
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

const [allMaps, flowsRaw, schemaRaw] = await Promise.all([
  loadAllMaps(),
  runForJson("devtools/scripts/superflow.ts"),
  runForJson("devtools/scripts/superschema.ts"),
]);

const flows = JSON.parse(flowsRaw || "{}") as FlowsJson;
const schemaData = JSON.parse(schemaRaw || "{}") as SchemaJson;

if (!flows.endpoints?.length) {
  console.error("ERROR: superflows data is empty. Run bun superflow.ts first.");
  process.exit(1);
}

// ─── Build global module lookup ───────────────────────────────────────────────
// Key format: "{short}/{mod.path}", e.g. "backend/src/routes/guilds.route.ts"

const moduleByKey = new Map<string, { short: string; mod: RawModule }>();
for (const [short, { map }] of allMaps) {
  for (const mod of map.modules) {
    moduleByKey.set(`${short}/${mod.path}`, { short, mod });
  }
}

// Count how many times each module is imported (within its package)
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

/**
 * Convert endpoint.file (e.g. "packages/backend/src/routes/guilds.route.ts")
 * to a module key (e.g. "backend/src/routes/guilds.route.ts").
 */
function endpointFileToModuleKey(file: string): string | null {
  if (!file.startsWith("packages/")) return null;
  const withoutPkgs = file.slice("packages/".length); // e.g. "backend/src/..." or "frontend/app/src/..."

  for (const short of allMaps.keys()) {
    // Try direct: short === first segment (e.g. "backend" → "backend/src/...")
    if (withoutPkgs.startsWith(`${short}/`)) {
      const key = `${short}/${withoutPkgs.slice(short.length + 1)}`;
      if (moduleByKey.has(key)) return key;
    }
    // Try nested (e.g. "frontend-app" → "frontend/app/src/...")
    const nested = short.replace(/-/g, "/");
    if (nested !== short && withoutPkgs.startsWith(`${nested}/`)) {
      const key = `${short}/${withoutPkgs.slice(nested.length + 1)}`;
      if (moduleByKey.has(key)) return key;
    }
  }
  return null;
}

/** Compress a module's raw path (src/routes/guilds.route.ts) for display. */
function compressPath(rawPath: string): string {
  let p = rawPath.replace(/^src\//, "").replace(/\/index$/, "");
  if (p === "index") p = "idx";
  for (const [from, to] of PATH_SEGS) {
    const i = p.indexOf(from);
    if (i !== -1) p = p.slice(0, i) + to + p.slice(i + from.length);
  }
  return p;
}

/** Compress an external dep alias for display. */
function compressExtDep(dep: string): string {
  for (const [from, to] of EXT_ALIASES) {
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

/**
 * Canonical stem → domain name mapping.
 * The stem is the file basename stripped of .route/.controller/.model suffixes
 * (or the schema name stripped of Schema prefix/suffix, or the table/key prefix).
 */
const STEM_TO_DOMAIN: Record<string, string> = {
  // guilds
  guild: "guilds",
  guilds: "guilds",
  membership: "guilds",
  memberships: "guilds",
  guildMembership: "guilds",
  guildmembership: "guilds",
  // roles
  role: "roles",
  roles: "roles",
  roleProgress: "roles",
  roleprogress: "roles",
  roleClaimProgress: "roles",
  // requirements
  requirement: "requirements",
  requirements: "requirements",
  // rewards
  reward: "rewards",
  rewards: "rewards",
  userReward: "rewards",
  userreward: "rewards",
  userrewards: "rewards",
  pointReward: "rewards",
  pointreward: "rewards",
  // platforms
  platform: "platforms",
  platforms: "platforms",
  // pages
  page: "pages",
  pages: "pages",
  // forms
  form: "forms",
  forms: "forms",
  formPage: "forms",
  formpage: "forms",
  formField: "forms",
  formfield: "forms",
  formSubmission: "forms",
  formsubmission: "forms",
  formAnswer: "forms",
  formanswer: "forms",
  // users / identity
  user: "users",
  users: "users",
  identity: "users",
  identities: "users",
  // direct domain names
  access: "access",
  crm: "crm",
  profile: "profile",
  analytics: "analytics",
  billing: "billing",
  pin: "pin",
  integrations: "integrations",
  upload: "upload",
  chain: "chain",
  status: "status",
  "third-party": "third-party",
  thirdParty: "third-party",
};

function inferDomainFromModPath(modPath: string): string | null {
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

function inferDomainFromSchemaName(name: string): string | null {
  // Strip known prefixes and "Schema" suffix: CreateGuildSchema → guild → guilds
  const stem = name
    .replace(
      /^(Create|Update|Delete|Get|List|Search|Insert|Upsert|Bulk|Request|Response|Recent)/,
      "",
    )
    .replace(/Schema$/, "");
  const lower = stem.toLowerCase();
  if (STEM_TO_DOMAIN[stem]) return STEM_TO_DOMAIN[stem];
  if (STEM_TO_DOMAIN[lower]) return STEM_TO_DOMAIN[lower];
  // Prefix match (e.g. GuildMembership → guilds)
  for (const [key, domain] of Object.entries(STEM_TO_DOMAIN)) {
    if (lower.startsWith(key.toLowerCase()) && key.length > 3) return domain;
  }
  return null;
}

function inferDomainFromTableName(name: string): string | null {
  // "guild_membership" → "guild" → guilds
  const first = name.split("_")[0] ?? name;
  return STEM_TO_DOMAIN[first] ?? STEM_TO_DOMAIN[name] ?? null;
}

function inferDomainFromRedisKey(pattern: string): string | null {
  // "guild:{id}" → "guild", "cache:guild:{id}" → "guild"
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

// ─── Domain data structure ────────────────────────────────────────────────────

type DomainBlock = {
  endpoints: FlowEndpoint[];
  moduleKeys: Set<string>; // "short/src/path.ts"
  schemas: ZodSchema[];
  tables: SqlTable[];
  enums: SqlEnum[];
  redisKeys: RedisKey[];
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
    });
  }
  return domains.get(name)!;
}

// ─── Step 1: Assign endpoints + trace module graph ────────────────────────────

// modules already assigned to a domain (to avoid duplicates)
const assignedModules = new Map<string, string>(); // key → domainName

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

  // Traverse internalDeps up to 2 levels (route → ctrl, ctrl → model)
  const { mod: routeMod, short } = moduleByKey.get(routeKey) ?? {};
  if (!routeMod || !short) continue;

  for (const dep1 of routeMod.internalDeps ?? []) {
    const dep1Key = `${short}/${dep1}`;
    assignModule(dep1Key, ep.domain);

    const { mod: dep1Mod } = moduleByKey.get(dep1Key) ?? {};
    if (!dep1Mod) continue;
    // Only follow 2nd level if it's a controller/model/connector (not util/config/stable)
    const skip2 =
      /\/(u\/|utils\/|config\/|stable\/db\/|queues\/|workers?\/)/.test(dep1);
    if (skip2) continue;

    for (const dep2 of dep1Mod.internalDeps ?? []) {
      assignModule(`${short}/${dep2}`, ep.domain);
    }
  }
}

// ─── Step 2: Assign remaining modules by name heuristic ───────────────────────

for (const [key, { mod }] of moduleByKey) {
  if (assignedModules.has(key)) continue;
  const domain = inferDomainFromModPath(mod.path);
  if (domain) assignModule(key, domain);
}

// ─── Step 3: Assign schemas, tables, Redis keys ───────────────────────────────

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

// ─── Step 4: Generate output ───────────────────────────────────────────────────

/** Compact schema field rendering. */
function renderSchema(s: ZodSchema, maxFields = 10): string {
  const compact = (t: string) =>
    t
      .replace(/string\(uuid\)/g, "uuid")
      .replace(/string\(email\)/g, "email")
      .replace(/string\(url\)/g, "url")
      .replace(/string\(datetime\)/g, "dt")
      .replace(/Date \| number \| string\(datetime\)/g, "dt")
      .replace(/number \| null/g, "num?")
      .replace(/\bstring\b/g, "str");

  if (s.fields?.length) {
    const shown = s.fields.slice(0, maxFields);
    const extra =
      s.fields.length > maxFields ? ` +${s.fields.length - maxFields}` : "";
    const parts = shown.map(
      (f) => `${f.n}${f.o ? "?" : ""}:${compact(f.t).slice(0, 35)}`,
    );
    return `${s.n}{${parts.join(" ")}${extra}}`;
  }
  if (s.body) return `${s.n}=${compact(s.body).slice(0, 80)}`;
  return s.n;
}

/** Compact table column rendering. */
function renderTable(t: SqlTable, maxCols = 8): string {
  const pkStr = t.pk.length ? ` PK(${t.pk.join(",")})` : "";
  const fkStr = t.fk.length
    ? ` FK(${t.fk.map((f) => `${f.from.join("+")}→${f.to}`).join(",")})`
    : "";
  const shown = t.cols.slice(0, maxCols);
  const extra = t.cols.length > maxCols ? ` +${t.cols.length - maxCols}` : "";
  const colStr = shown
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
  return `${t.n}${pkStr}${fkStr}  ${colStr}${extra}${idxStr ? "  " + idxStr : ""}`;
}

/** Op flags string, e.g. [RΠP] */
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

/** Truncate list to n items + "+rest" */
const trunc = (arr: string[], n: number) =>
  arr.length <= n
    ? arr.join(",")
    : `${arr.slice(0, n).join(",")},+${arr.length - n}`;

function generateOutput(): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);

  const epCount = flows.endpoints.length;
  const hkCount = flows.endpoints.reduce((n, ep) => n + ep.hooks.length, 0);
  const matchedMods = assignedModules.size;

  lines.push(`SUPERLINK | ${schemaData.project ?? "guild-v3"} | ${date}`);
  lines.push(
    `${epCount}ep · ${schemaData.stats?.zod ?? 0}z · ${schemaData.stats?.sql ?? 0}tbl · ` +
      `${schemaData.stats?.redis ?? 0}key · ${hkCount}hk · ${matchedMods}mods`,
  );
  lines.push(
    "R=Redis  Π=Protocol  P=Storage  E=Analytics  I=Integration  L=RateLimit",
  );
  lines.push("");

  // Legend for path segments (once, not repeated per section)
  lines.push(
    "# PATH SEGS  (same as supergraph — applied to module paths below)",
  );
  lines.push(PATH_SEGS.map(([f, t]) => `${t}=${f}`).join("  "));
  lines.push("");

  // Legend for reading domain blocks
  lines.push("# BLOCK FORMAT");
  lines.push("## domain  Nep Nmut Nmod Nsch Ntbl Nkey");
  lines.push(
    "R  METHOD /path [auth] ctrl:fns [ops]  ←hookName·inv:queryKey  {svc-if-not-backend}",
  );
  lines.push("   ↳R:redis-ops  Π:proto  P:storage  E:events");
  lines.push(
    "M  modPath[exp/tot]←importers  ... (route/ctrl/model files only)",
  );
  lines.push("S  SchemaName{field:type ...}  or  SchemaName=scalar-type");
  lines.push("T  tableName PK(cols) FK(col→ref)  col:type! →fk  ·idx(col)");
  lines.push("E  ENUM name  val1|val2|...");
  lines.push("K  redis:{pattern}[ops]→schemaHint");
  lines.push("");

  // Sort domains by the configured domain order, then alphabetically
  const DOMAIN_ORDER = flows.meta?.domainOrder ?? [];
  const sortedNames = [...domains.keys()].sort((a, b) => {
    const ai = DOMAIN_ORDER.indexOf(a);
    const bi = DOMAIN_ORDER.indexOf(b);
    return ai === -1 && bi === -1
      ? a.localeCompare(b)
      : ai === -1
        ? 1
        : bi === -1
          ? -1
          : ai - bi;
  });

  for (const domainName of sortedNames) {
    const d = domains.get(domainName)!;

    // Skip trivially empty domains
    if (
      !d.endpoints.length &&
      !d.schemas.length &&
      !d.tables.length &&
      !d.redisKeys.length
    )
      continue;

    const mut = d.endpoints.filter((e) => e.method !== "GET").length;
    const keyMods = [...d.moduleKeys].filter((key) => {
      const entry = moduleByKey.get(key);
      if (!entry) return false;
      const p = entry.mod.path;
      // Only route/ctrl/model/connector files — skip util, config, stable/db, queues
      return (
        /\.(route|controller|model|connector|service)\.ts$/.test(p) ||
        /\/(routes?|controllers?|models?|connectors?)\//.test(p)
      );
    });

    const statParts = [
      d.endpoints.length ? `${d.endpoints.length}ep` : "",
      mut ? `${mut}mut` : "",
      keyMods.length ? `${keyMods.length}mod` : "",
      d.schemas.length ? `${d.schemas.length}sch` : "",
      d.tables.length ? `${d.tables.length}tbl` : "",
      d.enums.length ? `${d.enums.length}enum` : "",
      d.redisKeys.length ? `${d.redisKeys.length}key` : "",
    ].filter(Boolean);

    lines.push(`## ${domainName}  ${statParts.join(" ")}`);

    // ── Endpoints ──────────────────────────────────────────────────────────
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

      const lineParts = [
        `R  ${ep.method} ${ep.path}${auth}${ctrl}`,
        flags || "",
        svc,
        ...hookParts,
      ].filter(Boolean);
      lines.push(lineParts.join("  "));

      // Op detail line
      const opParts: string[] = [];
      if (ep.redis.length) opParts.push(`R:${trunc(ep.redis, 4)}`);
      if (ep.protocol.length) opParts.push(`Π:${trunc(ep.protocol, 3)}`);
      if (ep.pg.length) opParts.push(`P:${trunc(ep.pg, 3)}`);
      if (ep.analytics.length) opParts.push(`E:${trunc(ep.analytics, 3)}`);
      if (opParts.length) lines.push(`   ↳${opParts.join("  ")}`);
    }

    // ── Key modules (route/ctrl/model — sorted by package/path) ────────────
    if (keyMods.length) {
      const modStrs = keyMods
        .sort((a, b) => {
          const pa = moduleByKey.get(a)?.mod.path ?? a;
          const pb = moduleByKey.get(b)?.mod.path ?? b;
          // Routes first, then controllers, then models, then connectors
          const order = (p: string) =>
            p.includes("/routes/")
              ? 0
              : p.includes("/controllers/")
                ? 1
                : p.includes("/models/")
                  ? 2
                  : p.includes("/connectors/")
                    ? 3
                    : 4;
          return order(pa) - order(pb) || pa.localeCompare(pb);
        })
        .map((key) => {
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

    // ── Schemas ────────────────────────────────────────────────────────────
    for (const s of d.schemas) {
      lines.push(`S  ${renderSchema(s)}`);
    }

    // ── Tables ─────────────────────────────────────────────────────────────
    for (const t of d.tables) {
      lines.push(`T  ${renderTable(t)}`);
    }
    for (const e of d.enums) {
      lines.push(`E  ENUM ${e.n}  ${e.vals.join("|")}`);
    }

    // ── Redis keys ─────────────────────────────────────────────────────────
    if (d.redisKeys.length) {
      const keyStrs = d.redisKeys.map((k) => {
        const ops = k.ops.join("/");
        const hint = k.s ? `→${k.s}` : "";
        const src = k.files.length ? ` (${k.files.join(",")})` : "";
        return `${k.p}[${ops}]${hint}${src}`;
      });
      // Group onto fewer lines (up to 3 per line)
      for (let i = 0; i < keyStrs.length; i += 3) {
        lines.push(`K  ${keyStrs.slice(i, i + 3).join("  ")}`);
      }
    }

    // ── RediSearch FT indexes for this domain ──────────────────────────────
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

    lines.push("");
  }

  // ── Module summary (modules assigned to domain but not route/ctrl/model) ──
  lines.push("# MODULE COVERAGE");
  lines.push(
    `${assignedModules.size} modules assigned to domains via AST import traversal`,
  );
  const byDomain = new Map<string, number>();
  for (const [, d] of assignedModules)
    byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
  const coverage = [...byDomain.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d}:${n}`)
    .join("  ");
  lines.push(coverage);

  return lines.join("\n");
}

await mkdir(AUDIT, { recursive: true });
const out = generateOutput();
await Bun.write(outPath, out);

const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
console.log(
  `Done in ${elapsed}s  —  ${(out.length / 1024).toFixed(0)} KB / ${out.split("\n").length} lines → ${relative(ROOT, outPath)}`,
);
