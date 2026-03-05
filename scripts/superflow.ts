#!/usr/bin/env bun
/**
 * superflow.ts — Auto-discover and trace ALL business flows in the monorepo.
 *
 * No hardcoded flows. Scans every route file across every configured service,
 * extracts each endpoint, traces it through its handler → controller → ops,
 * and cross-references frontend mutation hooks.
 *
 * Configuration: audit/config.json → "superflows" section.
 * Portable: works on any Hono + Next.js monorepo by adjusting that config.
 *
 * Output: audit/superflows.txt  (configurable via superflows.output)
 * Usage:  bun superflow.ts [--out <path>] [--verbose]
 */

import { mkdir } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { findFiles, parseRootArg, readFile } from "./utils.js";

const ROOT = parseRootArg(resolve(import.meta.dir, "../.."));
const VERBOSE = process.argv.includes("--verbose");

// ─── Config (read from audit/config.json) ────────────────────────────────────

type ConfigRouteSource = {
  service: string;
  pkg: string;
  dir: string;
  filePattern: string; // RegExp source string (no slashes/flags)
  mountPrefix?: Record<string, string>;
};

type Config = {
  project?: string;
  supergraph?: { pathSegments?: [string, string][] };
  superflows?: {
    output?: string;
    services?: ConfigRouteSource[];
    hookDirs?: string[];
    controllerDirs?: string[];
  };
  superflow?: {
    integrationPattern?: string;
  };
};

const CONFIG_PATH = resolve(ROOT, "audit/config.json");
const cfg: Config = JSON.parse((await readFile(CONFIG_PATH)) || "{}");
const sfCfg = cfg.superflows ?? {};

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Each entry describes where a service's route files live.
 * filePattern: stored as a RegExp source string in config.json (e.g. "\\.ts$").
 * mountPrefix: maps basename → path prefix the router mounts that file at.
 *   e.g. "guilds.route.ts" → "guilds"  means paths in that file get /guilds prepended.
 */
type RouteSource = {
  service: string;
  pkg: string;
  dir: string;
  filePattern: RegExp;
  mountPrefix?: Record<string, string>;
};

const ROUTE_SOURCES: RouteSource[] = (sfCfg.services ?? []).map((s) => ({
  ...s,
  filePattern: new RegExp(s.filePattern),
}));

/** Directories to scan for frontend mutation hooks (any use*.ts(x) with useMutation). */
const HOOK_DIRS: string[] = sfCfg.hookDirs ?? [];

/** Directories to scan for controller/model/connector function bodies. */
const CTRL_DIRS: string[] = sfCfg.controllerDirs ?? [];

/** Path abbreviation pairs from config (same set used by supergraph). */
const PATH_SEGMENTS: [string, string][] = cfg.supergraph?.pathSegments ?? [];

// ─── Types ────────────────────────────────────────────────────────────────────

type Ops = {
  redis: string[];
  protocol: string[];
  pg: string[];
  analytics: string[];
  integration: string[];
  rateLimits: string[];
  otherCalls: string[]; // named function calls (controllers, models, etc.)
};

type RouteEndpoint = {
  service: string;
  pkg: string;
  file: string; // relative to ROOT
  method: string; // GET POST PUT PATCH DELETE
  path: string; // full normalized path e.g. /guilds/:guildIdLike
  tags: string[];
  summary?: string;
  auth: string; // "public" | "JWT" | "JWT+admin" | "JWT+owner" | "JWT+superAdmin" | "apiKey"
  handlerOps: Ops; // ops extracted directly from inline handler body
  ctrlOps: Ops; // ops extracted from referenced controller functions
  ctrlCalls: string[]; // controller/model function names called in handler
  idx: number; // ordinal within file (for pairing with handler)
};

type MutationHook = {
  name: string;
  file: string;
  service: string; // "backend" | "auth" | "form-service"
  method: string;
  path: string; // normalized path matching backend routes
  rawCall: string; // original honoClient chain (for debugging)
  invalidations: string[];
  setQueryDataOps: string[];
};

type FlowData = {
  generated: string;
  endpoints: RouteEndpoint[];
  hooks: MutationHook[];
  ctrlIndex: Map<string, string>; // fnName → body
};

// ─── Utility: Code Extraction ─────────────────────────────────────────────────

/** Extract balanced-brace block starting at the first `{` after `startIdx`. */
function extractBlock(
  content: string,
  startIdx: number,
  maxLines = 200,
): string {
  const braceIdx = content.indexOf("{", startIdx);
  if (braceIdx === -1) return "";
  let depth = 0;
  let i = braceIdx;
  for (; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const raw = content.slice(braceIdx, i + 1);
  const lines = raw.split("\n");
  return lines.length > maxLines
    ? lines.slice(0, maxLines).join("\n") +
        `\n  … +${lines.length - maxLines} lines`
    : raw;
}

/**
 * Skip over a balanced `(...)` paren group and return index after the closing `)`.
 * Used to skip function parameter lists before finding the function body `{`.
 */
function skipParens(content: string, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < content.length; i++) {
    if (content[i] === "(") depth++;
    else if (content[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return content.length;
}

/**
 * Extract a function body `{...}` robustly, handling destructured params.
 * Finds the opening `(` at or after `startIdx`, skips the param list,
 * then returns the next balanced `{...}` block (the function body).
 */
function extractFunctionBodyAt(
  content: string,
  startIdx: number,
  maxLines = 150,
): string {
  // Find the opening paren of the parameter list
  const openParen = content.indexOf("(", startIdx);
  if (openParen === -1) return extractBlock(content, startIdx, maxLines);
  // Skip the entire param list, including nested parens (destructured defaults etc.)
  const afterParams = skipParens(content, openParen);
  // Skip optional return-type annotation `: ReturnType`
  // Extract the body block (first `{` after the param list closing `)`)
  return extractBlock(content, afterParams, maxLines);
}

/** Extract function body by name (supports function decl and arrow const). */
function extractFnBody(
  content: string,
  fnName: string,
  maxLines = 150,
): string | null {
  const pats = [
    new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`,
      "m",
    ),
    new RegExp(
      `(?:export\\s+)?const\\s+${fnName}\\s*=\\s*(?:async\\s*)?\\(`,
      "m",
    ),
  ];
  for (const pat of pats) {
    const m = pat.exec(content);
    if (m) {
      const body = extractFunctionBodyAt(content, m.index, maxLines);
      if (body) return body;
    }
  }
  // Fallback: object literal assignment (const X = { ... })
  const objPat = new RegExp(
    `(?:export\\s+)?const\\s+${fnName}\\s*=\\s*\\{`,
    "m",
  );
  const objM = objPat.exec(content);
  if (objM) return extractBlock(content, objM.index, maxLines);
  return null;
}

// ─── Utility: Op Extraction ───────────────────────────────────────────────────

function extractOps(body: string): Ops {
  const seen = (set: Set<string>, val: string) => {
    set.add(val);
    return set;
  };
  const redis = new Set<string>();
  const protocol = new Set<string>();
  const pg = new Set<string>();
  const analytics = new Set<string>();
  const integration = new Set<string>();
  const rateLimits = new Set<string>();
  const otherCalls = new Set<string>();

  // Redis ops
  for (const m of body.matchAll(
    /\bredis\w*\.(json\.\w+|ft\.\w+|set|get|del|multi|pipeline|exists|expire)\s*\(/g,
  ))
    seen(redis, `redis.${m[1]}(…)`);
  for (const m of body.matchAll(/cachedSimple\([^,]+,[^,]+,\s*[`'"]([^`'"]+)/g))
    seen(redis, `cache("${m[1]}")`);
  for (const m of body.matchAll(/`([a-zA-Z][\w-]+:\$\{[^}]+\}[^`\n]{0,30})`/g))
    seen(redis, `key:"${m[1].slice(0, 60)}"`);

  // Protocol calls
  for (const m of body.matchAll(
    /\bprotocol\.(api\.\w+|tryOrThrow\.\w+|tryUpdateDataPoint|addRuleToGroup|getIntegration|tryOrSkip\.\w+)\s*\(/g,
  ))
    seen(protocol, `protocol.${m[1]}(…)`);
  for (const m of body.matchAll(/\beventsClient\b/g))
    seen(protocol, "EventsClient.subscribe");

  // PG / storage
  for (const m of body.matchAll(/\b(\w+[Ss]torage)\.(\w+)\s*\(/g))
    seen(pg, `${m[1]}.${m[2]}(…)`);
  for (const m of body.matchAll(/\bdb\.(insert|update|delete|select)\s*\(/g))
    seen(pg, `db.${m[1]}(…)`);

  // Analytics
  for (const m of body.matchAll(/event_type:\s*["']([^"']+)["']/g))
    seen(analytics, m[1]);

  // Integration events (configurable pattern or default)
  const integrationPattern = cfg.superflow?.integrationPattern;
  if (integrationPattern) {
    for (const m of body.matchAll(new RegExp(integrationPattern, "g")))
      if (m[1]) seen(integration, m[1]);
  } else {
    for (const m of body.matchAll(
      /handleGuildIntegrationEvents\s*\([^,]+,\s*["']([^"']+)["']/g,
    ))
      seen(integration, `GUILD_${m[1]}`);
  }

  // Rate limits
  for (const m of body.matchAll(/new\s+RedisLimiter\s*\([^)]+\)/g))
    seen(rateLimits, "RedisLimiter");
  for (const m of body.matchAll(/\b(TWITTER_LIMITER|EXTERNAL_API_LIMITER)\b/g))
    seen(rateLimits, m[1]);

  // Named function calls (controllers, models) — exclude low-level built-ins
  const SKIP = new Set([
    "Promise",
    "Object",
    "Array",
    "JSON",
    "Math",
    "String",
    "Number",
    "console",
    "logger",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "parseInt",
    "parseFloat",
    "Boolean",
    "Error",
    "Date",
    "Map",
    "Set",
    "fetch",
    "require",
    "import",
    "export",
    "return",
    "throw",
    "typeof",
    "instanceof",
    "await",
    "async",
    "try",
    "catch",
    "finally",
    "if",
    "else",
    "for",
    "while",
    "switch",
    "case",
    "new",
    "delete",
    "void",
    "null",
    "undefined",
    "true",
    "false",
    "super",
    "this",
    "class",
    "extends",
  ]);
  for (const m of body.matchAll(/\b([a-z][a-zA-Z]{2,})\s*\(/g)) {
    const fn = m[1];
    if (
      !SKIP.has(fn) &&
      fn.length < 50 &&
      !fn.startsWith("handle") && // handled by integration already
      !/^(use|get|is|has|can|to|from|parse|format|create|build|make|init|run|start|stop)$/.test(
        fn,
      )
    ) {
      seen(otherCalls, fn);
    }
  }

  return {
    redis: [...redis],
    protocol: [...protocol],
    pg: [...pg],
    analytics: [...analytics],
    integration: [...integration],
    rateLimits: [...rateLimits],
    otherCalls: [...otherCalls].slice(0, 15),
  };
}

function mergeOps(a: Ops, b: Ops): Ops {
  const uniq = (arr: string[]) => [...new Set(arr)];
  return {
    redis: uniq([...a.redis, ...b.redis]),
    protocol: uniq([...a.protocol, ...b.protocol]),
    pg: uniq([...a.pg, ...b.pg]),
    analytics: uniq([...a.analytics, ...b.analytics]),
    integration: uniq([...a.integration, ...b.integration]),
    rateLimits: uniq([...a.rateLimits, ...b.rateLimits]),
    otherCalls: uniq([...a.otherCalls, ...b.otherCalls]).slice(0, 20),
  };
}

const EMPTY_OPS: Ops = {
  redis: [],
  protocol: [],
  pg: [],
  analytics: [],
  integration: [],
  rateLimits: [],
  otherCalls: [],
};

// ─── Phase 1: Route Discovery ─────────────────────────────────────────────────

/** Extract middleware array contents from createRoute({middleware:[...]}) */
function parseAuth(createRouteBlock: string): string {
  const mw =
    createRouteBlock.match(/middleware\s*:\s*\[([^\]]{0,300})/)?.[1] ?? "";
  if (!mw) return "public";
  if (/superAdmin/.test(mw)) return "JWT+superAdmin";
  if (/owner/.test(mw)) return "JWT+owner";
  if (/\.admin/.test(mw)) return "JWT+admin";
  if (/authenticated|requireAuth/.test(mw)) return "JWT";
  if (/\.public/.test(mw)) return "public";
  if (/authorizer/.test(mw)) return "JWT";
  if (/apiKey|api_key/.test(mw)) return "apiKey";
  return "public";
}

function normalizePath(p: string): string {
  // Normalize {param} → :param (form-service uses OpenAPI-style braces)
  // Deduplicate // and ensure leading /
  const n = p.replace(/\{(\w+)\}/g, ":$1").replace(/\/\//g, "/");
  return n.startsWith("/") ? n : `/${n}`;
}

/** Build a lookup map for spread-style route definitions like RATE_LIMITED_ROUTES.KEY */
async function buildSpreadLookup(
  content: string,
  fileAbsPath: string,
  pkgSrcDir: string,
): Promise<Map<string, { path: string; method: string }>> {
  const lookup = new Map<string, { path: string; method: string }>();
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(content)) !== null) {
    const names = im[1].split(",").map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)[0]
        .trim(),
    );
    const importPath = im[2];
    if (!importPath.startsWith("@/") && !importPath.startsWith(".")) continue;
    const resolved = importPath.startsWith("@/")
      ? resolve(pkgSrcDir, importPath.slice(2)) + ".ts"
      : resolve(dirname(fileAbsPath), importPath).replace(/\.ts$/, "") + ".ts";
    const importContent = await readFile(resolved).catch(() => "");
    if (!importContent) continue;
    for (const name of names) {
      // Find const NAME = { KEY: { path: "...", method: "..." } }
      const objRe = new RegExp(
        `(?:export\\s+)?const\\s+${name}\\s*=\\s*\\{`,
        "m",
      );
      const objM = objRe.exec(importContent);
      if (!objM) continue;
      const objBody = extractBlock(importContent, objM.index, 200);
      // Each nested key with path/method
      const entryRe = /(\w+)\s*:\s*\{([^}]+)\}/g;
      let em: RegExpExecArray | null;
      while ((em = entryRe.exec(objBody)) !== null) {
        const key = em[1];
        const entry = em[2];
        const path = entry.match(/path\s*:\s*["']([^"']+)["']/)?.[1];
        const method = entry.match(/method\s*:\s*["'](\w+)["']/)?.[1];
        if (path && method) lookup.set(`${name}.${key}`, { path, method });
      }
    }
  }
  return lookup;
}

type RouteMeta = {
  method: string;
  path: string;
  tags: string[];
  summary?: string;
  auth: string;
};

/** Extract method/path/tags/summary/auth from a createRoute({...}) block string. */
function extractRouteMeta(
  block: string,
  mountPrefix: string,
  spreadLookup?: Map<string, { path: string; method: string }>,
): RouteMeta {
  let method = block.match(/method\s*:\s*["'](\w+)["']/)?.[1]?.toUpperCase();
  let rawPath = block.match(/path\s*:\s*["']([^"']+)["']/)?.[1] ?? "";
  // Resolve spread-defined path/method (e.g. ...RATE_LIMITED_ROUTES.GET_ROLE_MEMBERS)
  if ((!rawPath || !method) && spreadLookup) {
    const sm = block.match(/\.\.\.([\w]+\.[\w]+)/);
    if (sm) {
      const resolved = spreadLookup.get(sm[1]);
      if (resolved) {
        rawPath = rawPath || resolved.path;
        method = method || resolved.method.toUpperCase();
      }
    }
  }
  method = method ?? "GET";
  const path = normalizePath(
    mountPrefix ? `/${mountPrefix}${rawPath}` : rawPath,
  );
  const tags = (block.match(/tags\s*:\s*\[([^\]]+)\]/)?.[1] ?? "")
    .split(",")
    .map((t) => t.replace(/["'\s]/g, ""))
    .filter(Boolean);
  const summary = block.match(/summary\s*:\s*["']([^"']+)["']/)?.[1];
  const auth = parseAuth(block);
  return { method, path, tags, summary, auth };
}

/**
 * Build a package-level registry of all createRoute definitions.
 * Scans all .ts files in the package and indexes by every resolvable name:
 *   - `const joinGuildRoute = createRoute({...})`         → key "joinGuildRoute"
 *   - `const crud = { create: createRoute({...}) }`       → key "crud.create"
 *   - `export const loginOpenapi = { loginInit: ... }`    → key "loginOpenapi.loginInit"
 *
 * This enables cross-file resolution when handler files import route defs.
 */
async function buildRouteDefRegistry(
  pkgDir: string,
  mountPrefix: string,
  spreadLookup: Map<string, { path: string; method: string }>,
): Promise<Map<string, RouteMeta>> {
  const registry = new Map<string, RouteMeta>();
  let allFiles: string[];
  try {
    allFiles = await findFiles(resolve(ROOT, pkgDir), /\.ts$/);
  } catch {
    return registry;
  }

  for (const f of allFiles) {
    const content = await readFile(f);
    if (!content || !content.includes("createRoute")) continue;

    // Pattern 1: const X = createRoute({...})
    for (const m of content.matchAll(
      /(?:export\s+)?const\s+(\w+)\s*=\s*createRoute\s*\(\s*\{/g,
    )) {
      const key = m[1];
      if (!registry.has(key)) {
        const block = extractBlock(content, m.index);
        const meta = extractRouteMeta(block, mountPrefix, spreadLookup);
        if (meta.path) registry.set(key, meta);
      }
    }

    // Pattern 2: const OBJ = { KEY: createRoute({...}), ... }
    for (const m of content.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*\{/g)) {
      const objName = m[1];
      const objBlock = extractBlock(content, m.index, 500);
      for (const km of objBlock.matchAll(
        /\b(\w+)\s*:\s*createRoute\s*\(\s*\{/g,
      )) {
        const propName = km[1];
        const fullKey = `${objName}.${propName}`;
        if (!registry.has(fullKey)) {
          const block = extractBlock(objBlock, km.index);
          const meta = extractRouteMeta(block, mountPrefix, spreadLookup);
          if (meta.path) registry.set(fullKey, meta);
        }
      }
    }
  }
  return registry;
}

/**
 * Parse a route file and return matched (route-def + handler-body) pairs.
 * Uses name-based matching via .openapi(routeRef, handler).
 * Falls back to a nearby block when refs can't be resolved.
 */
function parseRoutesWithHandlers(
  content: string,
  routeDefRegistry: Map<string, RouteMeta>,
  mountPrefix: string,
  spreadLookup?: Map<string, { path: string; method: string }>,
): Array<RouteMeta & { handlerBody: string; ctrlCalls: string[] }> {
  const results: Array<
    RouteMeta & { handlerBody: string; ctrlCalls: string[] }
  > = [];

  // Extract all .openapi(REF, async (c) => {...}) calls
  const openApiRe = /\.openapi\s*\(\s*([\w.]+)\s*,\s*async\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = openApiRe.exec(content)) !== null) {
    const routeRef = m[1];
    const arrowIdx = content.indexOf("=>", m.index + m[0].length);
    if (arrowIdx === -1) continue;
    const handlerBody = extractBlock(content, arrowIdx);
    const ctrlCalls = extractCtrlCalls(handlerBody);

    // 1. Try local file lookup first (avoids cross-file name collisions, e.g. multiple "crud.create")
    const localBlock = findCreateRouteBlockLocal(content, routeRef);
    let meta = localBlock
      ? extractRouteMeta(localBlock, mountPrefix, spreadLookup)
      : undefined;

    // 2. Fall back to global registry (handles cross-file imports, e.g. loginOpenapi.loginInit)
    if (!meta || !meta.path) {
      const registryMeta = routeDefRegistry.get(routeRef);
      if (registryMeta?.path)
        meta = { ...registryMeta, auth: registryMeta.auth };
    }

    if (meta) {
      results.push({ ...meta, handlerBody, ctrlCalls });
    }
  }

  return results;
}

/** Look up a createRoute block within a single file by route reference name. */
function findCreateRouteBlockLocal(
  content: string,
  routeRef: string,
): string | null {
  if (routeRef === "createRoute") return null; // inline, skip
  if (routeRef.includes(".")) {
    const [, propName] = routeRef.split(".");
    const re = new RegExp(
      `\\b${propName}\\s*:\\s*createRoute\\s*\\(\\s*\\{`,
      "m",
    );
    const m = re.exec(content);
    if (m) return extractBlock(content, m.index);
  } else {
    const re = new RegExp(
      `\\b${routeRef}\\s*=\\s*createRoute\\s*\\(\\s*\\{`,
      "m",
    );
    const m = re.exec(content);
    if (m) return extractBlock(content, m.index);
  }
  return null;
}

/** Extract named function calls from a handler body that look like controller/model calls. */
function extractCtrlCalls(body: string): string[] {
  const calls: string[] = [];
  const seen = new Set<string>();
  // Pattern: await someFunction( or return someFunction(
  for (const m of body.matchAll(/(?:await|return)\s+([a-z][a-zA-Z]+)\s*\(/g)) {
    const fn = m[1];
    if (fn.length > 3 && fn.length < 50 && !seen.has(fn)) {
      seen.add(fn);
      calls.push(fn);
    }
  }
  return calls;
}

async function discoverEndpoints(
  source: RouteSource,
): Promise<RouteEndpoint[]> {
  const absDir = resolve(ROOT, source.dir);
  let files: string[];
  try {
    files = await findFiles(absDir, source.filePattern);
  } catch {
    return [];
  }

  // Infer the package src dir for import resolution (e.g. "@/" alias)
  const pkgSrcDir = resolve(ROOT, source.dir.split("/src/")[0], "src");

  // Build a per-package spread lookup from the first file that imports spread objects
  // (In practice, spread objects like RATE_LIMITED_ROUTES appear in a handful of files)
  // Build once for the source dir; spreadLookup is reused per-file below

  // Build cross-file route def registry for this source package
  // This allows handler files to reference route defs from .openapi.ts companion files
  const basePrefix = ""; // registry always uses empty prefix; actual prefix applied per-file
  const dummySpread = new Map<string, { path: string; method: string }>();
  const routeDefRegistry = await buildRouteDefRegistry(
    source.dir,
    basePrefix,
    dummySpread,
  );

  const endpoints: RouteEndpoint[] = [];

  for (const absFile of files) {
    const content = await readFile(absFile);
    // Handler files need .openapi() calls; skip files that only define routes
    if (!content || !content.includes(".openapi(")) continue;

    const fileBase = basename(absFile);
    const prefix = source.mountPrefix?.[fileBase] ?? "";
    const relFile = relative(ROOT, absFile);

    // Build spread lookup for this file's imports (handles ...RATE_LIMITED_ROUTES.X patterns)
    const spreadLookup = await buildSpreadLookup(content, absFile, pkgSrcDir);

    const pairs = parseRoutesWithHandlers(
      content,
      routeDefRegistry,
      prefix,
      spreadLookup,
    );

    for (let i = 0; i < pairs.length; i++) {
      const { handlerBody, ctrlCalls, ...meta } = pairs[i];
      endpoints.push({
        service: source.service,
        pkg: source.pkg,
        file: relFile,
        method: meta.method,
        path: meta.path,
        tags: meta.tags,
        summary: meta.summary,
        auth: meta.auth,
        handlerOps: extractOps(handlerBody),
        ctrlOps: EMPTY_OPS, // filled in Phase 2
        ctrlCalls,
        idx: i,
      });
    }
  }

  return endpoints;
}

// ─── Phase 2: Controller Enrichment ──────────────────────────────────────────

async function buildCtrlIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const dir of CTRL_DIRS) {
    const absDir = resolve(ROOT, dir);
    let files: string[];
    try {
      files = await findFiles(absDir, /\.ts$/);
    } catch {
      continue;
    }

    for (const f of files) {
      const content = await readFile(f);
      if (!content) continue;
      // Export function declarations: export async function joinGuild({...}) { ... }
      for (const m of content.matchAll(
        /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g,
      )) {
        const fnName = m[1];
        if (!index.has(fnName)) {
          // Use extractFunctionBodyAt to skip past params (handles destructured params)
          const body = extractFunctionBodyAt(content, m.index);
          if (body) index.set(fnName, body);
        }
      }
      // Export arrow functions: export const fnName = async (...) => { ... }
      for (const m of content.matchAll(
        /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
      )) {
        const fnName = m[1];
        if (!index.has(fnName)) {
          const body = extractFunctionBodyAt(content, m.index);
          if (body) index.set(fnName, body);
        }
      }
    }
  }
  return index;
}

function enrichEndpoint(
  ep: RouteEndpoint,
  ctrlIndex: Map<string, string>,
): RouteEndpoint {
  const ops: Ops = { ...EMPTY_OPS };
  for (const fn of ep.ctrlCalls) {
    const body = ctrlIndex.get(fn);
    if (body) {
      const extracted = extractOps(body);
      // Merge into ops
      for (const k of Object.keys(ops) as (keyof Ops)[]) {
        (ops[k] as string[]).push(...(extracted[k] as string[]));
      }
    }
  }
  // Deduplicate
  const result: Ops = {} as Ops;
  for (const k of Object.keys(ops) as (keyof Ops)[]) {
    result[k] = [...new Set(ops[k] as string[])] as never;
  }
  return { ...ep, ctrlOps: result };
}

// ─── Phase 3: Hook Discovery ──────────────────────────────────────────────────

/**
 * Decode a honoClient property-chain call to {service, method, path}.
 *
 * Examples:
 *   honoClient.join.$post                                   → POST /join
 *   honoClient.guilds[":guildIdLike"]["claim-roles"].$post  → POST /guilds/:guildIdLike/claim-roles
 *   authHonoClient.login.$post                              → POST /login  (auth)
 *   honoClient.v2.billing["checkout-session"].$post         → POST /v2/billing/checkout-session
 */
function decodeHonoPath(
  chain: string,
): { service: string; method: string; path: string } | null {
  const clientMatch = chain.match(/^(authHonoClient|honoClient)/);
  if (!clientMatch) return null;
  const service = clientMatch[1] === "authHonoClient" ? "auth" : "backend";

  const withoutClient = chain.slice(clientMatch[1].length);
  const methodMatch = withoutClient.match(/\.\$(\w+)\s*\(?/);
  if (!methodMatch) return null;
  const method = methodMatch[1].toUpperCase();

  const chainPart = withoutClient.slice(
    0,
    withoutClient.lastIndexOf(`.$${methodMatch[1]}`),
  );
  const segments: string[] = [];

  // Parse .identifier or ["string"] access — NOTE: bracket keys may contain : e.g. [":guildIdLike"]
  const segRe = /\.(\w[\w-]*)|\["([^"]+)"\]/g;
  let sm: RegExpExecArray | null;
  while ((sm = segRe.exec(chainPart)) !== null) {
    segments.push(sm[1] ?? sm[2]);
  }

  if (segments.length === 0) return null;
  const path = "/" + segments.join("/");
  return { service, method, path };
}

/**
 * Normalize honoClient call chains that span multiple lines.
 * Collapses:  ["  \n  claim-roles\n  "]  →  ["claim-roles"]
 *             .guilds[":x"]\n    .$post   →  .guilds[":x"].$post
 */
function linearizeHonoChains(content: string): string {
  return (
    content
      // Normalize whitespace inside bracket strings: [  "key"  ] → ["key"]
      .replace(/\[\s*"([^"]+)"\s*\]/g, '["$1"]')
      // Join chain split at newline before .$method: ]\n  .$post → ].$post
      .replace(
        /((?:authHonoClient|honoClient)[\w."[\]:]*)\s*\n\s*(\.\$\w+)/g,
        "$1$2",
      )
  );
}

async function discoverHooks(): Promise<MutationHook[]> {
  const hooks: MutationHook[] = [];

  for (const dir of HOOK_DIRS) {
    const absDir = resolve(ROOT, dir);
    let files: string[];
    try {
      files = await findFiles(absDir, /use[A-Z][^.]*\.(ts|tsx)$/);
    } catch {
      continue;
    }

    for (const f of files) {
      const rawContent = await readFile(f);
      if (!rawContent || !rawContent.includes("useMutation")) continue;

      // Normalize multi-line chains before matching
      const content = linearizeHonoChains(rawContent);
      const hookName = basename(f).replace(/\.(ts|tsx)$/, "");
      const relFile = relative(ROOT, f);

      // Match honoClient chains — bracket keys may start with : (route params like ":guildIdLike")
      // Pattern: honoClient(.prop | ["key"])+.$method(
      const callRe =
        /((?:authHonoClient|honoClient)(?:\.\w+|\["[^"]*"\])+\.\$\w+)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(content)) !== null) {
        const rawCall = cm[1];
        const decoded = decodeHonoPath(rawCall);
        if (!decoded) continue;

        // Extract invalidateQueries keys (both array and options-function form)
        const invalidations: string[] = [];
        for (const m of rawContent.matchAll(
          /invalidateQueries\s*\(\s*(?:\{[^}]*queryKey[^}]*\}|\[([^\]]+)\])/g,
        )) {
          const key = m[1]?.replace(/["'\s]/g, "").slice(0, 40);
          if (key) invalidations.push(key);
        }
        for (const m of rawContent.matchAll(
          /invalidateQueries\s*\(\s*(\w+Options)\s*\(/g,
        ))
          invalidations.push(m[1]);

        // Extract setQueryData patterns
        const setQueryData: string[] = [];
        for (const m of rawContent.matchAll(
          /setQueryData\s*\(\s*(\w+Options)\s*\(/g,
        ))
          setQueryData.push(m[1]);

        hooks.push({
          name: hookName,
          file: relFile,
          service: decoded.service,
          method: decoded.method,
          path: decoded.path,
          rawCall,
          invalidations: [...new Set(invalidations)],
          setQueryDataOps: [...new Set(setQueryData)],
        });
      }
    }
  }

  return hooks;
}

// ─── Phase 4: Build FlowData ──────────────────────────────────────────────────

async function buildFlowData(): Promise<FlowData> {
  // Discover endpoints from all services
  const allEndpoints: RouteEndpoint[] = [];
  for (const src of ROUTE_SOURCES) {
    const eps = await discoverEndpoints(src);
    allEndpoints.push(...eps);
  }

  // Build controller index
  const ctrlIndex = await buildCtrlIndex();

  // Enrich endpoints with controller ops
  const enriched = allEndpoints.map((ep) => enrichEndpoint(ep, ctrlIndex));

  // Discover hooks
  const hooks = await discoverHooks();

  return {
    generated: new Date().toISOString(),
    endpoints: enriched,
    hooks,
    ctrlIndex,
  };
}

// ─── Phase 5: Output Generation ───────────────────────────────────────────────

function compressPath(p: string, stripExt = false): string {
  // Strip common package root prefixes first
  let s = p
    .replace("packages/frontend/app/src/app/(global)/(admin)/", "FE/adm/")
    .replace("packages/frontend/app/src/app/(global)/(public)/", "FE/pub/")
    .replace("packages/frontend/app/src/app/(global)/", "FE/g/")
    .replace("packages/frontend/app/src/", "FE/")
    .replace("packages/backend/src/", "BE/")
    .replace("packages/auth/src/", "AU/")
    .replace("packages/form-service/src/", "FS/");
  // Apply path segment abbreviations from config (same as supergraph)
  for (const [from, to] of PATH_SEGMENTS) {
    s = s.split(from).join(to);
  }
  if (stripExt) s = s.replace(/\.(ts|tsx)$/, "");
  return s;
}

function formatOp(label: string, items: string[], maxItems = 5): string {
  if (!items.length) return "";
  const shown = items.slice(0, maxItems).join("  ");
  const extra =
    items.length > maxItems ? `  +${items.length - maxItems}more` : "";
  return `   ${label.padEnd(8)}: ${shown}${extra}`;
}

function matchHooks(ep: RouteEndpoint, hooks: MutationHook[]): MutationHook[] {
  const normalizeForMatch = (p: string) =>
    p
      .replace(/:[^/]+/g, ":x")
      .replace(/\{[^}]+\}/g, ":x")
      .toLowerCase();

  const epNorm = normalizeForMatch(ep.path);
  return hooks.filter(
    (h) =>
      h.method === ep.method &&
      h.service === ep.service &&
      normalizeForMatch(h.path) === epNorm,
  );
}

function getDomain(ep: RouteEndpoint): string {
  if (ep.tags.length) return ep.tags[0].toLowerCase();
  // Fall back to route file name
  return basename(ep.file).replace(/\.route\.ts$|\.ts$/, "");
}

function methodColor(m: string): string {
  // No ANSI — keep plain text for file output
  return m;
}

function generateFlowsTxt(data: FlowData): string {
  const { endpoints, hooks } = data;
  const lines: string[] = [];

  // ── Helpers ────────────────────────────────────────────────────────────────

  const normPath = (p: string) => p.replace(/:[^/]+/g, ":x").toLowerCase();

  const isMatched = (h: MutationHook) =>
    endpoints.some(
      (ep) =>
        ep.method === h.method &&
        ep.service === h.service &&
        normPath(ep.path) === normPath(h.path),
    );

  // Op presence flags: compact string like "RΠ EI"
  const opFlags = (ops: ReturnType<typeof mergeOps>): string => {
    const f = [
      ops.redis.length ? "R" : "",
      ops.protocol.length ? "Π" : "",
      ops.pg.length ? "P" : "",
      ops.analytics.length ? "E" : "",
      ops.integration.length ? "I" : "",
      ops.rateLimits.length ? "L" : "",
    ].filter(Boolean);
    return f.length ? `[${f.join("")}]` : "";
  };

  // Truncate list to N items + "+rest"
  const trunc = (arr: string[], n: number) =>
    arr.length <= n
      ? arr.join(",")
      : `${arr.slice(0, n).join(",")}+${arr.length - n}`;

  // ── Group & sort domains ───────────────────────────────────────────────────

  const byDomain = new Map<string, RouteEndpoint[]>();
  for (const ep of endpoints) {
    const domain = getDomain(ep);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain)!.push(ep);
  }

  // Sort domains: by endpoint count descending (no hardcoded order)
  const sortedDomains = [...byDomain.keys()].sort((a, b) => {
    return (byDomain.get(b)?.length ?? 0) - (byDomain.get(a)?.length ?? 0) || a.localeCompare(b);
  });

  // ── Header ─────────────────────────────────────────────────────────────────

  const byMethod = new Map<string, number>();
  for (const ep of endpoints)
    byMethod.set(ep.method, (byMethod.get(ep.method) ?? 0) + 1);
  const methodStat = [...byMethod.entries()]
    .sort()
    .map(([m, n]) => `${m}:${n}`)
    .join(" ");

  const bySvc = new Map<string, number>();
  for (const ep of endpoints)
    bySvc.set(ep.service, (bySvc.get(ep.service) ?? 0) + 1);
  const svcStat = [...bySvc.entries()].map(([s, n]) => `${s}:${n}`).join(" ");

  const unmatched = hooks.filter((h) => !isMatched(h));
  const covStr = `${hooks.length - unmatched.length}/${hooks.length}hk-matched`;

  const projectName = (cfg.project || basename(ROOT)).toUpperCase();
  lines.push(
    `${projectName} SUPERFLOWS | ${data.generated.slice(0, 10)} | ${endpoints.length}ep · ${methodStat} · ${svcStat} · ${covStr}`,
  );
  lines.push("R=Redis  Π=Protocol  P=Storage  E=Event  I=Integration  L=Limit");
  lines.push(
    "METHOD /path [auth] file  ctrl:fns  [ops]  ←hook·inv:key1,key2  {svc-if-not-backend}",
  );
  lines.push(
    "  ↳R:redis-ops  Π:proto-calls  P:storage-calls  E:events  I:int-events  L:limiters",
  );
  lines.push("");

  // ── Endpoints by domain ────────────────────────────────────────────────────

  for (const domain of sortedDomains) {
    const eps = byDomain.get(domain)!;
    const mut = eps.filter((e) => e.method !== "GET").length;
    lines.push(`# ${domain} (${eps.length}ep${mut > 0 ? ` ${mut}mut` : ""})`);

    for (const ep of eps) {
      const allOps = mergeOps(ep.handlerOps, ep.ctrlOps);
      const matched = matchHooks(ep, hooks);
      const seenHooks = new Set<string>();
      const uniqueHooks = matched.filter((h) => {
        if (seenHooks.has(h.name)) return false;
        seenHooks.add(h.name);
        return true;
      });

      // ── Line 1 ──
      const parts: string[] = [];
      parts.push(`${ep.method} ${ep.path}`);
      if (ep.auth !== "public") parts.push(`[${ep.auth}]`);
      parts.push(compressPath(ep.file, true));
      if (ep.ctrlCalls.length > 0) parts.push(`ctrl:${trunc(ep.ctrlCalls, 3)}`);
      const flags = opFlags(allOps);
      if (flags) parts.push(flags);
      if (ep.service !== "backend") parts.push(`{${ep.service}}`);
      if (uniqueHooks.length > 0) {
        for (const h of uniqueHooks) {
          const inv = h.invalidations.length
            ? `·inv:${trunc(h.invalidations, 3)}`
            : "";
          const set = h.setQueryDataOps.length
            ? `·set:${trunc(h.setQueryDataOps, 2)}`
            : "";
          parts.push(`←${h.name}${inv}${set}`);
        }
      }
      lines.push(parts.join("  "));

      // ── Line 2 (ops detail, only when present) ──
      const opParts: string[] = [];
      if (allOps.redis.length) opParts.push(`R:${trunc(allOps.redis, 4)}`);
      if (allOps.protocol.length)
        opParts.push(`Π:${trunc(allOps.protocol, 3)}`);
      if (allOps.pg.length) opParts.push(`P:${trunc(allOps.pg, 3)}`);
      if (allOps.analytics.length)
        opParts.push(`E:${trunc(allOps.analytics, 4)}`);
      if (allOps.integration.length)
        opParts.push(`I:${trunc(allOps.integration, 3)}`);
      if (allOps.rateLimits.length)
        opParts.push(`L:${trunc(allOps.rateLimits, 3)}`);
      if (opParts.length) lines.push(`  ↳${opParts.join("  ")}`);
    }

    lines.push("");
  }

  // ── Hook index ─────────────────────────────────────────────────────────────

  lines.push("# hooks");
  const hooksSeen = new Set<string>();
  for (const h of hooks) {
    const key = `${h.name}|${h.method}|${h.path}`;
    if (hooksSeen.has(key)) continue;
    hooksSeen.add(key);
    const matched = isMatched(h);
    const inv = h.invalidations.length
      ? `  inv:${trunc(h.invalidations, 4)}`
      : "";
    const set = h.setQueryDataOps.length
      ? `  set:${trunc(h.setQueryDataOps, 3)}`
      : "";
    lines.push(
      `${matched ? "✓" : "?"} ${h.method} ${h.path}  ←${h.name}  ${compressPath(h.file, true)}${inv}${set}`,
    );
  }

  if (unmatched.length) {
    lines.push("");
    lines.push(`# unmatched-hooks (${unmatched.length})`);
    for (const h of unmatched) {
      lines.push(
        `? ${h.method} ${h.path}  ←${h.name}  ${compressPath(h.file, true)}  raw:${h.rawCall.slice(0, 80)}`,
      );
    }
  }

  return lines.join("\n");
}

// ─── JSON Export ─────────────────────────────────────────────────────────────

function buildExportJSON(data: FlowData) {
  const { endpoints, hooks } = data;
  const norm = (p: string) => p.replace(/:[^/]+/g, ":x").toLowerCase();

  const exported = endpoints.map((ep, i) => {
    const allOps = mergeOps(ep.handlerOps, ep.ctrlOps);
    const matched = matchHooks(ep, hooks);
    const seen = new Set<string>();
    const uniqueHooks = matched.filter((h) => {
      if (seen.has(h.name)) return false;
      seen.add(h.name);
      return true;
    });
    return {
      id: i,
      service: ep.service,
      method: ep.method,
      path: ep.path,
      domain: getDomain(ep),
      auth: ep.auth,
      summary: ep.summary ?? "",
      file: ep.file,
      ctrl: ep.ctrlCalls.slice(0, 6),
      redis: allOps.redis,
      protocol: allOps.protocol,
      pg: allOps.pg,
      analytics: allOps.analytics,
      integration: allOps.integration,
      rateLimits: allOps.rateLimits,
      hooks: uniqueHooks.map((h) => ({
        name: h.name,
        file: h.file,
        inv: h.invalidations,
        set: h.setQueryDataOps,
      })),
    };
  });

  const byMethod: Record<string, number> = {};
  for (const ep of endpoints)
    byMethod[ep.method] = (byMethod[ep.method] ?? 0) + 1;

  const byService: Record<string, number> = {};
  for (const ep of endpoints)
    byService[ep.service] = (byService[ep.service] ?? 0) + 1;

  const byDomain: Record<string, number> = {};
  for (const ep of endpoints) {
    const d = getDomain(ep);
    byDomain[d] = (byDomain[d] ?? 0) + 1;
  }

  const unmatchedCount = hooks.filter(
    (h) =>
      !endpoints.some(
        (ep) =>
          ep.method === h.method &&
          ep.service === h.service &&
          norm(ep.path) === norm(h.path),
      ),
  ).length;

  // Compute domain order from endpoint counts (descending)
  const computedDomainOrder = Object.entries(byDomain)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([d]) => d);

  return {
    meta: {
      generated: data.generated,
      project: cfg.project ?? "unknown",
      totalEndpoints: endpoints.length,
      totalHooks: hooks.length,
      hookCoverage:
        hooks.length > 0
          ? Math.round(((hooks.length - unmatchedCount) / hooks.length) * 100)
          : 100,
      pathSegments: PATH_SEGMENTS,
      domainOrder: computedDomainOrder,
    },
    stats: { byMethod, byService, byDomain },
    endpoints: exported,
  };
}

// ─── HTML Generator ───────────────────────────────────────────────────────────

function generateFlowsHTML(json: ReturnType<typeof buildExportJSON>): string {
  const data = JSON.stringify(json);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Superflows · ${json.meta.project}</title>
<style>
*,::before,::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--bg4:#2d333b;
  --border:#30363d;--border2:#444c56;
  --text:#cdd9e5;--text2:#768390;--text3:#444c56;
  --accent:#539bf5;
  --get:#3fb950;--post:#d29922;--put:#539bf5;--delete:#e5534b;--patch:#986ee2;
  --redis:#3ea8d8;--proto:#986ee2;--pg:#3fb950;
  --event:#d29922;--integ:#e07c6e;--limit:#d18616;
  --font-mono:'Cascadia Code','Fira Code','JetBrains Mono',ui-monospace,monospace;
  --font-sans:system-ui,-apple-system,sans-serif;
  --r:6px;--r-sm:3px;
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:14px}

/* Layout */
#app{display:flex;flex-direction:column;height:100%}
#topbar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
#layout{display:flex;flex:1;overflow:hidden;min-height:0}
#sidebar{width:196px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--border);background:var(--bg2);display:flex;flex-direction:column}
#main{flex:1;overflow-y:auto;padding:12px 16px}

/* Topbar */
.logo{font-weight:700;font-size:13px;color:var(--text);letter-spacing:.04em;white-space:nowrap}
.logo span{color:var(--text2);font-weight:400}
#search{flex:1;min-width:160px;max-width:340px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:5px 10px;color:var(--text);font-size:13px;outline:none}
#search:focus{border-color:var(--accent)}
#search::placeholder{color:var(--text3)}
.method-filters{display:flex;gap:4px}
.mf-btn{font-size:11px;font-family:var(--font-mono);font-weight:600;padding:3px 7px;border-radius:var(--r-sm);border:1px solid transparent;cursor:pointer;background:transparent;transition:all .12s}
.mf-btn[data-m=GET]{color:var(--get);border-color:color-mix(in srgb,var(--get)40%,transparent)}
.mf-btn[data-m=POST]{color:var(--post);border-color:color-mix(in srgb,var(--post)40%,transparent)}
.mf-btn[data-m=PUT]{color:var(--put);border-color:color-mix(in srgb,var(--put)40%,transparent)}
.mf-btn[data-m=DELETE]{color:var(--delete);border-color:color-mix(in srgb,var(--delete)40%,transparent)}
.mf-btn[data-m=PATCH]{color:var(--patch);border-color:color-mix(in srgb,var(--patch)40%,transparent)}
.mf-btn.active[data-m=GET]{background:color-mix(in srgb,var(--get)20%,transparent)}
.mf-btn.active[data-m=POST]{background:color-mix(in srgb,var(--post)20%,transparent)}
.mf-btn.active[data-m=PUT]{background:color-mix(in srgb,var(--put)20%,transparent)}
.mf-btn.active[data-m=DELETE]{background:color-mix(in srgb,var(--delete)20%,transparent)}
.mf-btn.active[data-m=PATCH]{background:color-mix(in srgb,var(--patch)20%,transparent)}
#svc-filter{font-size:12px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r-sm);padding:3px 7px;color:var(--text);cursor:pointer;outline:none}
.ep-count{font-size:12px;color:var(--text2);white-space:nowrap;margin-left:auto}

/* Sidebar */
.sb-section{padding:10px 0 4px;border-bottom:1px solid var(--border)}
.sb-section:last-child{border-bottom:none}
.sb-label{font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);padding:0 12px 6px}
.domain-btn{display:flex;align-items:center;justify-content:space-between;width:100%;padding:4px 12px;font-size:12px;color:var(--text2);background:none;border:none;cursor:pointer;text-align:left;transition:background .1s}
.domain-btn:hover{background:var(--bg3);color:var(--text)}
.domain-btn.active{color:var(--accent);background:color-mix(in srgb,var(--accent)12%,transparent)}
.domain-cnt{font-size:11px;color:var(--text3)}
.sb-stat{display:flex;align-items:center;justify-content:space-between;padding:3px 12px;font-size:12px}
.sb-stat-label{font-family:var(--font-mono);font-weight:600;font-size:11px}
.sb-stat-n{font-size:11px;color:var(--text2)}

/* Endpoint groups */
.domain-group{margin-bottom:16px}
.domain-hdr{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text3);padding:0 2px 6px;display:flex;align-items:center;gap:6px}
.domain-hdr-cnt{font-weight:400;color:var(--text3)}

/* Endpoint card */
.ep-card{border:1px solid var(--border);border-radius:var(--r);margin-bottom:3px;background:var(--bg2);overflow:hidden;transition:border-color .1s}
.ep-card:hover{border-color:var(--border2)}
.ep-card.open{border-color:var(--border2)}
.ep-row{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;user-select:none;font-family:var(--font-mono);font-size:12.5px;flex-wrap:nowrap;min-height:36px}
.ep-row:hover{background:var(--bg3)}
.ep-card.open .ep-row{background:var(--bg3)}
.ep-path{color:var(--text);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ep-path .param{color:var(--text2)}
.ep-right{display:flex;align-items:center;gap:6px;flex-shrink:0}

/* Method badge */
.method{font-size:10px;font-weight:700;padding:2px 6px;border-radius:var(--r-sm);width:52px;text-align:center;flex-shrink:0}
.method.GET{background:color-mix(in srgb,var(--get)16%,transparent);color:var(--get)}
.method.POST{background:color-mix(in srgb,var(--post)16%,transparent);color:var(--post)}
.method.PUT{background:color-mix(in srgb,var(--put)16%,transparent);color:var(--put)}
.method.DELETE{background:color-mix(in srgb,var(--delete)16%,transparent);color:var(--delete)}
.method.PATCH{background:color-mix(in srgb,var(--patch)16%,transparent);color:var(--patch)}

/* Op badges (compact indicator dots on row) */
.op-dots{display:flex;gap:3px;align-items:center}
.op-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.op-dot.r{background:var(--redis)}
.op-dot.pi{background:var(--proto)}
.op-dot.p{background:var(--pg)}
.op-dot.e{background:var(--event)}
.op-dot.i{background:var(--integ)}
.op-dot.l{background:var(--limit)}

/* Auth tag */
.auth-tag{font-size:10px;padding:2px 6px;border-radius:var(--r-sm);white-space:nowrap;flex-shrink:0}
.auth-pub{color:var(--text3);background:var(--bg4)}
.auth-jwt{color:var(--get);background:color-mix(in srgb,var(--get)14%,transparent)}
.auth-admin{color:var(--put);background:color-mix(in srgb,var(--put)14%,transparent)}
.auth-owner{color:var(--patch);background:color-mix(in srgb,var(--patch)14%,transparent)}
.auth-super{color:var(--delete);background:color-mix(in srgb,var(--delete)14%,transparent)}
.auth-key{color:var(--post);background:color-mix(in srgb,var(--post)14%,transparent)}

/* Service tag */
.svc-tag{font-size:10px;color:var(--text3);background:var(--bg4);padding:2px 5px;border-radius:var(--r-sm);flex-shrink:0}

/* Hook chips on row */
.hook-chips{display:flex;gap:3px;flex-shrink:0}
.hook-chip{font-size:10px;color:var(--accent);background:color-mix(in srgb,var(--accent)12%,transparent);padding:1px 5px;border-radius:10px;white-space:nowrap}
.hook-more{font-size:10px;color:var(--text3);padding:1px 4px}

/* Expanded detail */
.ep-detail{padding:10px 12px 12px;border-top:1px solid var(--border);font-size:12px;display:flex;flex-direction:column;gap:6px}
.det-file{font-family:var(--font-mono);color:var(--text3);font-size:11px}
.det-summary{color:var(--text2);font-style:italic}
.det-ctrl{display:flex;align-items:baseline;gap:8px}
.det-ctrl-label{font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;flex-shrink:0;width:40px}
.det-ctrl-chain{font-family:var(--font-mono);color:var(--text);font-size:11.5px}
.det-ctrl-chain span{color:var(--text2)}

/* Op rows in detail */
.det-op-row{display:flex;align-items:baseline;gap:8px}
.op-badge{font-size:10px;font-weight:700;padding:1px 5px;border-radius:var(--r-sm);flex-shrink:0;width:26px;text-align:center}
.op-badge.r{background:color-mix(in srgb,var(--redis)18%,transparent);color:var(--redis)}
.op-badge.pi{background:color-mix(in srgb,var(--proto)18%,transparent);color:var(--proto)}
.op-badge.p{background:color-mix(in srgb,var(--pg)18%,transparent);color:var(--pg)}
.op-badge.e{background:color-mix(in srgb,var(--event)18%,transparent);color:var(--event)}
.op-badge.i{background:color-mix(in srgb,var(--integ)18%,transparent);color:var(--integ)}
.op-badge.l{background:color-mix(in srgb,var(--limit)18%,transparent);color:var(--limit)}
.op-items{font-family:var(--font-mono);color:var(--text2);font-size:11.5px;line-height:1.5;flex:1;min-width:0}

/* Hook detail rows */
.det-hook-row{display:flex;align-items:flex-start;gap:8px;padding:4px 0;border-top:1px solid var(--border)}
.det-hook-row:first-child{border-top:none}
.hooks-section{border-top:1px solid var(--border);padding-top:6px;display:flex;flex-direction:column;gap:2px}
.hook-detail-name{font-family:var(--font-mono);font-weight:600;color:var(--accent);font-size:12px;flex-shrink:0;min-width:200px}
.hook-detail-meta{display:flex;flex-direction:column;gap:2px}
.hook-inv{font-size:11px;font-family:var(--font-mono)}
.hook-inv .inv-label{color:var(--text3)}
.hook-inv .inv-keys{color:var(--text2)}
.hook-file{font-size:10px;font-family:var(--font-mono);color:var(--text3)}

.empty{color:var(--text3);text-align:center;padding:48px;font-size:13px}
.expand-icon{font-size:10px;color:var(--text3);flex-shrink:0;transition:transform .15s}
.ep-card.open .expand-icon{transform:rotate(90deg)}
</style>
</head>
<body>
<div id="app">
  <header id="topbar">
    <div class="logo">SUPERFLOWS <span>· ${json.meta.project}</span></div>
    <input id="search" type="text" placeholder="search paths, controllers, hooks…" autocomplete="off" spellcheck="false">
    <div class="method-filters" id="method-filters"></div>
    <select id="svc-filter"></select>
    <div class="ep-count"><span id="ep-count">–</span> endpoints</div>
  </header>
  <div id="layout">
    <aside id="sidebar"></aside>
    <main id="main"></main>
  </div>
</div>
<script id="__FLOW_DATA__" type="application/json">${data}</script>
<script>
const D = JSON.parse(document.getElementById('__FLOW_DATA__').textContent);

// ── Path compression (mirrors superflow.ts compressPath) ──────────────────────
function shortenPath(p) {
  let s = p
    .replace('packages/frontend/app/src/app/(global)/(admin)/','FE/adm/')
    .replace('packages/frontend/app/src/app/(global)/(public)/','FE/pub/')
    .replace('packages/frontend/app/src/app/(global)/','FE/g/')
    .replace('packages/frontend/app/src/','FE/')
    .replace('packages/backend/src/','BE/')
    .replace('packages/auth/src/','AU/')
    .replace('packages/form-service/src/','FS/');
  for (const [from, to] of D.meta.pathSegments) s = s.split(from).join(to);
  return s;
}

// ── Format path with colored params ──────────────────────────────────────────
function fmtPath(p) {
  return p.replace(/(:[^/]+)/g, '<span class="param">$1</span>');
}

// ── Auth class ────────────────────────────────────────────────────────────────
function authCls(a) {
  if (a==='public') return 'auth-pub';
  if (a==='apiKey') return 'auth-key';
  if (a.includes('superAdmin')) return 'auth-super';
  if (a.includes('owner')) return 'auth-owner';
  if (a.includes('admin')) return 'auth-admin';
  return 'auth-jwt';
}

// ── Op definitions ────────────────────────────────────────────────────────────
const OPS = [
  {key:'redis', sym:'R', cls:'r', label:'Redis'},
  {key:'protocol', sym:'Π', cls:'pi', label:'Protocol'},
  {key:'pg', sym:'P', cls:'p', label:'Storage'},
  {key:'analytics', sym:'E', cls:'e', label:'Analytics'},
  {key:'integration', sym:'I', cls:'i', label:'Integration'},
  {key:'rateLimits', sym:'L', cls:'l', label:'Rate limit'},
];

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  domain: 'all',
  search: '',
  methods: new Set(),
  service: 'all',
  expanded: new Set(),
};

// ── Filtering ─────────────────────────────────────────────────────────────────
function getFiltered() {
  const q = S.search.toLowerCase();
  return D.endpoints.filter(ep => {
    if (S.domain !== 'all' && ep.domain !== S.domain) return false;
    if (S.methods.size > 0 && !S.methods.has(ep.method)) return false;
    if (S.service !== 'all' && ep.service !== S.service) return false;
    if (!q) return true;
    return ep.path.toLowerCase().includes(q)
      || ep.ctrl.some(c => c.toLowerCase().includes(q))
      || ep.hooks.some(h => h.name.toLowerCase().includes(q))
      || (ep.summary||'').toLowerCase().includes(q)
      || ep.domain.toLowerCase().includes(q);
  });
}

// ── Render helpers ────────────────────────────────────────────────────────────
function renderOpDots(ep) {
  const dots = OPS
    .filter(o => ep[o.key].length > 0)
    .map(o => \`<span class="op-dot \${o.cls}" title="\${o.label}"></span>\`)
    .join('');
  return dots ? \`<span class="op-dots">\${dots}</span>\` : '';
}

function renderHookChips(ep) {
  if (!ep.hooks.length) return '';
  const first = ep.hooks[0];
  const more = ep.hooks.length > 1 ? \`<span class="hook-more">+\${ep.hooks.length-1}</span>\` : '';
  return \`<span class="hook-chip">⚑ \${first.name}</span>\${more}\`;
}

function renderDetailOps(ep) {
  return OPS
    .filter(o => ep[o.key].length > 0)
    .map(o => {
      const items = ep[o.key].slice(0,10).join('  ·  ');
      const more = ep[o.key].length > 10 ? \`  <span style="color:var(--text3)">+\${ep[o.key].length-10}</span>\` : '';
      return \`<div class="det-op-row"><span class="op-badge \${o.cls}">\${o.sym}</span><span class="op-items">\${items}\${more}</span></div>\`;
    }).join('');
}

function renderDetailHooks(ep) {
  if (!ep.hooks.length) return '';
  const rows = ep.hooks.map(h => {
    const invLine = h.inv.length
      ? \`<div class="hook-inv"><span class="inv-label">inv: </span><span class="inv-keys">\${h.inv.slice(0,4).join(', ')}\${h.inv.length>4?' +more':''}</span></div>\`
      : '';
    const setLine = h.set.length
      ? \`<div class="hook-inv"><span class="inv-label">set: </span><span class="inv-keys">\${h.set.slice(0,3).join(', ')}\${h.set.length>3?' +more':''}</span></div>\`
      : '';
    const fileLine = \`<div class="hook-file">\${shortenPath(h.file)}</div>\`;
    return \`<div class="det-hook-row">
      <span class="hook-detail-name">⚑ \${h.name}</span>
      <span class="hook-detail-meta">\${invLine}\${setLine}\${fileLine}</span>
    </div>\`;
  }).join('');
  return \`<div class="hooks-section">\${rows}</div>\`;
}

function renderCard(ep) {
  const isOpen = S.expanded.has(ep.id);
  const opDots = renderOpDots(ep);
  const hookChips = renderHookChips(ep);
  const svcTag = ep.service !== 'backend' ? \`<span class="svc-tag">\${ep.service}</span>\` : '';

  let detail = '';
  if (isOpen) {
    const fileRow = \`<div class="det-file">\${ep.file}</div>\`;
    const summaryRow = ep.summary ? \`<div class="det-summary">\${ep.summary}</div>\` : '';
    const ctrlRow = ep.ctrl.length
      ? \`<div class="det-ctrl"><span class="det-ctrl-label">ctrl</span><span class="det-ctrl-chain">\${
          ep.ctrl.map((c,i) => i===0 ? c : \`<span> → </span>\${c}\`).join('')
        }</span></div>\`
      : '';
    const opRows = renderDetailOps(ep);
    const hookRows = renderDetailHooks(ep);
    detail = \`<div class="ep-detail">\${summaryRow}\${fileRow}\${ctrlRow}\${opRows}\${hookRows}</div>\`;
  }

  return \`<div class="ep-card\${isOpen?' open':''}" data-id="\${ep.id}">
  <div class="ep-row" onclick="toggle(\${ep.id})">
    <span class="expand-icon">▶</span>
    <span class="method \${ep.method}">\${ep.method}</span>
    <span class="ep-path">\${fmtPath(ep.path)}</span>
    <span class="ep-right">
      \${opDots}
      <span class="auth-tag \${authCls(ep.auth)}">\${ep.auth}</span>
      \${svcTag}
      <span class="hook-chips">\${hookChips}</span>
    </span>
  </div>
  \${detail}
</div>\`;
}

// ── Main render ───────────────────────────────────────────────────────────────
function render() {
  const filtered = getFiltered();
  document.getElementById('ep-count').textContent = filtered.length;

  // Group by domain preserving configured order
  const order = D.meta.domainOrder;
  const groups = new Map();
  for (const ep of filtered) {
    if (!groups.has(ep.domain)) groups.set(ep.domain, []);
    groups.get(ep.domain).push(ep);
  }
  const sorted = [...groups.entries()].sort(([a],[b]) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    return (ai===-1?999:ai) - (bi===-1?999:bi);
  });

  const main = document.getElementById('main');
  if (filtered.length === 0) {
    main.innerHTML = '<div class="empty">No endpoints match the current filters.</div>';
    return;
  }
  main.innerHTML = sorted.map(([domain, eps]) =>
    \`<div class="domain-group">
      <div class="domain-hdr">\${domain}<span class="domain-hdr-cnt">\${eps.length}</span></div>
      \${eps.map(renderCard).join('')}
    </div>\`
  ).join('');
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function buildSidebar() {
  const order = D.meta.domainOrder;
  const domains = Object.entries(D.stats.byDomain)
    .sort(([a],[b]) => (order.indexOf(a)===-1?999:order.indexOf(a)) - (order.indexOf(b)===-1?999:order.indexOf(b)));

  const domainList = [['all', D.meta.totalEndpoints], ...domains]
    .map(([d, n]) =>
      \`<button class="domain-btn\${S.domain===d?' active':''}" onclick="setDomain('\${d}')">\${d}<span class="domain-cnt">\${n}</span></button>\`
    ).join('');

  const methodStats = Object.entries(D.stats.byMethod)
    .sort()
    .map(([m, n]) =>
      \`<div class="sb-stat"><span class="sb-stat-label" style="color:var(--\${m.toLowerCase()})">\${m}</span><span class="sb-stat-n">\${n}</span></div>\`
    ).join('');

  document.getElementById('sidebar').innerHTML =
    \`<div class="sb-section"><div class="sb-label">Domains</div>\${domainList}</div>
     <div class="sb-section"><div class="sb-label">Methods</div>\${methodStats}</div>\`;
}

// ── Method filter buttons ─────────────────────────────────────────────────────
function buildMethodFilters() {
  const methods = Object.keys(D.stats.byMethod).sort();
  document.getElementById('method-filters').innerHTML = methods.map(m =>
    \`<button class="mf-btn\${S.methods.has(m)?' active':''}" data-m="\${m}" onclick="toggleMethod('\${m}')">\${m}</button>\`
  ).join('');
}

// ── Service dropdown ──────────────────────────────────────────────────────────
function buildServiceFilter() {
  const services = Object.keys(D.stats.byService);
  document.getElementById('svc-filter').innerHTML =
    \`<option value="all">All services</option>\` +
    services.map(s => \`<option value="\${s}">\${s} (\${D.stats.byService[s]})</option>\`).join('');
}

// ── Event handlers ────────────────────────────────────────────────────────────
function toggle(id) {
  if (S.expanded.has(id)) S.expanded.delete(id);
  else S.expanded.add(id);
  render();
}
function setDomain(d) { S.domain = d; render(); buildSidebar(); }
function toggleMethod(m) {
  if (S.methods.has(m)) S.methods.delete(m);
  else S.methods.add(m);
  render(); buildMethodFilters();
}

document.getElementById('search').addEventListener('input', e => { S.search = e.target.value; render(); });
document.getElementById('svc-filter').addEventListener('change', e => { S.service = e.target.value; render(); });

// Keyboard shortcut: / to focus search
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== document.getElementById('search')) {
    e.preventDefault();
    document.getElementById('search').focus();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
buildMethodFilters();
buildServiceFilter();
buildSidebar();
render();
</script>
</body>
</html>`;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun superflow.ts [--out <path>] [--verbose]");
  console.log(
    `  Generates ${sfCfg.output ?? "audit/superflows.txt"} by auto-discovering all endpoints and hooks.`,
  );
  console.log("  Configuration: audit/config.json → superflows section");
  console.log("  --verbose  also dumps extracted controller function bodies");
  process.exit(0);
}

const outArg = args.indexOf("--out");
const outPath =
  outArg !== -1
    ? resolve(process.cwd(), args[outArg + 1])
    : resolve(ROOT, sfCfg.output ?? "audit/superflows.txt");

console.log("Discovering flows...");
const t0 = Date.now();

const data = await buildFlowData();
const exportJSON = buildExportJSON(data);

if (args.includes("--json")) {
  process.stdout.write(JSON.stringify(exportJSON));
} else {
  await mkdir(resolve(ROOT, "audit"), { recursive: true });
  const txt = generateFlowsTxt(data);
  const htmlPath = outPath.replace(/\.txt$/, ".html");
  const html = generateFlowsHTML(exportJSON);
  await Promise.all([Bun.write(outPath, txt), Bun.write(htmlPath, html)]);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`Done in ${elapsed}s`);
  console.log(
    `  ${data.endpoints.length} endpoints across ${ROUTE_SOURCES.length} services`,
  );
  console.log(`  ${data.hooks.length} mutation hooks discovered`);
  console.log(`  ${data.ctrlIndex.size} controller functions indexed`);
  console.log(
    `  ${(txt.length / 1024).toFixed(0)} KB → ${relative(ROOT, outPath)}`,
  );
  console.log(
    `  ${(html.length / 1024).toFixed(0)} KB → ${relative(ROOT, htmlPath)}`,
  );
}
