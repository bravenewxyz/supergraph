#!/usr/bin/env bun
import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getArg, writeOutput } from "./util.js";
import { loadConfig } from "./config.js";

interface RpcCall {
  method: string;
  path: string;
  client: "honoClient" | "authHonoClient";
  file: string;
  line: number;
}

interface BackendRoute {
  method: string;
  path: string;
  fullPath: string;
  file: string;
  isV1: boolean;
}

interface ContractResult {
  method: string;
  frontendPath: string;
  backendPath: string | null;
  matched: boolean;
  file: string;
  line: number;
}

async function collectFiles(dir: string, exts: string[]): Promise<string[]> {
  const results: string[] = [];
  async function walk(d: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git" || name.startsWith(".")) continue;
      const full = join(d, name);
      if (!exts.some((x) => name.endsWith(x))) {
        await walk(full);
      } else {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

function extractRpcCalls(source: string, filePath: string, rpcClients: string[]): RpcCall[] {
  const results: RpcCall[] = [];
  const clientAlt = rpcClients.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const clientPattern = new RegExp(`\\b(${clientAlt})\\s*[.[\\[]`, "g");
  let m: RegExpExecArray | null;

  while ((m = clientPattern.exec(source)) !== null) {
    const start = m.index;
    const prefix = source.slice(Math.max(0, start - 40), start);
    if (/typeof\s*$/.test(prefix) || /InferResponseType\s*<\s*typeof\s*$/.test(prefix)) {
      continue;
    }

    const client = m[1] as "honoClient" | "authHonoClient";
    const chunk = source.slice(start, start + 600);
    const methodMatch = /\.\$(get|post|put|delete|patch)\s*\(/i.exec(chunk);
    if (!methodMatch) continue;

    const chainPart = chunk.slice(0, methodMatch.index);
    const httpMethod = (methodMatch[1] as string).toUpperCase();

    const withoutClient = chainPart.replace(/^(honoClient|authHonoClient)/, "");
    const segmentRegex = /\.([a-zA-Z_$][\w$-]*)|(?:\["([^"]+)"\])/g;
    const segments: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = segmentRegex.exec(withoutClient)) !== null) {
      const seg = (sm[1] ?? sm[2]) as string | undefined;
      if (seg) segments.push(seg);
    }

    const path = "/" + segments.join("/");
    const lineNum = source.slice(0, start).split("\n").length;
    if (!results.some((r) => r.method === httpMethod && r.path === path && r.client === client)) {
      results.push({ method: httpMethod, path, client, file: filePath, line: lineNum });
    }
  }

  return results;
}

function extractBalancedBlock(source: string, startIdx: number): string {
  let depth = 0;
  let i = startIdx;
  while (i < source.length) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(startIdx, i + 1);
    }
    i++;
  }
  return source.slice(startIdx);
}

function extractStringValue(block: string, key: string): string | null {
  const re = new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`);
  const result = re.exec(block);
  return result ? (result[1] as string) : null;
}

function extractBackendRoutes(
  source: string,
  filePath: string,
  prefixMap: Map<string, string>,
  isV1: boolean,
): BackendRoute[] {
  const results: BackendRoute[] = [];
  const re = /createRoute\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(source)) !== null) {
    const openBrace = source.indexOf("{", m.index + m[0].length);
    if (openBrace === -1) continue;
    const block = extractBalancedBlock(source, openBrace);
    const method = extractStringValue(block, "method");
    const path = extractStringValue(block, "path");
    if (!method || !path) continue;

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    let fullPath = normalizedPath;

    if (!isV1) {
      const fileBase = (filePath.split("/").pop() ?? "").replace(".route.ts", "");
      for (const [varName, prefix] of prefixMap) {
        const varLower = varName.toLowerCase().replace(/routes?$/i, "");
        const fileLower = fileBase.replace(/-/g, "").replace(/_/g, "");
        if (fileLower === varLower) {
          fullPath = `/${prefix}${normalizedPath === "/" ? "" : normalizedPath}`;
          break;
        }
      }
    }

    results.push({ method: method.toUpperCase(), path, fullPath, file: filePath, isV1 });
  }

  return results;
}

async function extractPrefixMap(indexPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let source: string;
  try {
    source = await readFile(indexPath, "utf-8");
  } catch {
    return map;
  }

  const re = /\.route\(\s*["'`]([^"'`]+)["'`]\s*,\s*([a-zA-Z_$][\w$]*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const prefix = m[1] as string;
    const varName = m[2] as string;
    if (prefix !== "/") {
      map.set(varName, prefix);
    }
  }
  return map;
}

function normalizePath(p: string): string {
  return p.replace(/\{[^}]+\}/g, ":param").replace(/:[\w]+/g, ":param");
}

async function collectCommonSchemas(
  monorepoRoot: string,
  commonDir: string,
  extraKnown: string[],
): Promise<Set<string>> {
  const schemas = new Set<string>();
  if (!commonDir) return schemas;

  const schemaDir = join(monorepoRoot, commonDir);
  const indexPath = join(schemaDir, "index.ts");
  let source: string;
  try {
    source = await readFile(indexPath, "utf-8");
  } catch {
    return schemas;
  }

  const moduleRe = /export\s+\*\s+from\s+["'`]\.\/([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  const subModules: string[] = [];
  while ((m = moduleRe.exec(source)) !== null) {
    subModules.push(m[1] as string);
  }

  const directRe = /export\s*\{([^}]+)\}/g;
  while ((m = directRe.exec(source)) !== null) {
    const names = (m[1] as string)
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/).pop()?.trim() ?? "");
    for (const n of names) {
      if (n.endsWith("Schema") || n.endsWith("schema")) schemas.add(n);
    }
  }

  for (const mod of subModules) {
    const filePath = join(schemaDir, mod.endsWith(".ts") ? mod : `${mod}.ts`);
    let modSource: string;
    try {
      modSource = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const exportRe = /export\s+(?:const|type|interface|function|class)\s+([A-Z][a-zA-Z]*Schema)\b/g;
    let em: RegExpExecArray | null;
    while ((em = exportRe.exec(modSource)) !== null) {
      schemas.add(em[1] as string);
    }
    const reExportRe = /export\s*\{([^}]+)\}/g;
    while ((em = reExportRe.exec(modSource)) !== null) {
      const names = (em[1] as string)
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/).pop()?.trim() ?? "");
      for (const n of names) {
        if (n.endsWith("Schema")) schemas.add(n);
      }
    }
  }

  for (const name of extraKnown) schemas.add(name);
  return schemas;
}

function extractSchemaNamesFromRoutes(
  _routes: BackendRoute[],
  allRouteSources: Map<string, string>,
): Set<string> {
  const schemas = new Set<string>();
  for (const [, source] of allRouteSources) {
    const re = /schema\s*:\s*([A-Z][a-zA-Z]*Schema)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      schemas.add(m[1] as string);
    }
  }
  return schemas;
}

function formatText(
  feSrcDir: string,
  beSrcDir: string,
  beRoutes: BackendRoute[],
  results: ContractResult[],
  orphanedRoutes: BackendRoute[],
  commonSchemas: Set<string>,
  usedSchemas: Set<string>,
): string {
  const lines: string[] = [];
  lines.push("━━━ FE↔BE Contract Verification ━━━");
  lines.push("");

  lines.push(`Frontend: ${results.length} unique RPC paths  (${feSrcDir})`);
  lines.push(`Backend:  ${beRoutes.filter((r) => !r.isV1).length} routes  (${beSrcDir})`);
  lines.push("");

  const matched = results.filter((r) => r.matched);
  const unmatched = results.filter((r) => !r.matched);

  lines.push(`── Matched (${matched.length}) ──`);
  for (const r of matched) {
    lines.push(`  ✓  ${r.method.padEnd(7)} ${r.frontendPath}`);
  }
  lines.push("");

  lines.push(`── Unmatched FE calls (${unmatched.length}) ──`);
  for (const r of unmatched) {
    const shortFile = r.file.split("/").slice(-4).join("/");
    lines.push(`  ✗  ${r.method.padEnd(7)} ${r.frontendPath.padEnd(50)} ${shortFile}:${r.line}`);
  }
  lines.push("");

  lines.push(`── Orphaned BE routes (${orphanedRoutes.length}) ──`);
  for (const r of orphanedRoutes) {
    lines.push(`  ○  ${r.method.padEnd(7)} ${r.fullPath}  (may be used by external clients or v1 API)`);
  }
  lines.push("");

  lines.push("── Schema Coverage ──");
  if (commonSchemas.size > 0) {
    const localSchemas = [...usedSchemas].filter((s) => !commonSchemas.has(s));
    lines.push(`  ✓ ${commonSchemas.size} schemas exported from @guildxyz/common/schemas`);
    lines.push(`  ○ ${localSchemas.length} backend-local schemas (not shared)`);
    if (localSchemas.length > 0) {
      for (const s of localSchemas.slice(0, 10)) {
        lines.push(`    - ${s}`);
      }
      if (localSchemas.length > 10) {
        lines.push(`    ... and ${localSchemas.length - 10} more`);
      }
    }
  }
  lines.push("");

  lines.push(
    `Summary: ${matched.length}/${results.length} matched, ${unmatched.length} unmatched, ${orphanedRoutes.length} orphaned BE routes`,
  );

  return lines.join("\n");
}

export interface ContractsOptions {
  srcDir: string;
  feSrcDir?: string;
  format?: "text" | "json";
  outFile?: string;
  cwd?: string;
}

export async function runContracts(opts: ContractsOptions): Promise<string> {
  const format = opts.format ?? "text";

  const config = await loadConfig(opts.cwd);
  const beConf = config.backend;
  const feConf = config.frontend;
  const schConf = config.schemas;

  const feSrcDir = opts.feSrcDir ?? feConf.src;
  const beSrcDir = opts.srcDir;

  if (!feSrcDir) {
    throw new Error("Frontend src dir is required: pass feSrcDir option or set frontend.src in audit/config.json");
  }

  const resolvedFe = resolve(feSrcDir);
  const resolvedBe = resolve(beSrcDir);
  const rpcClients = feConf.rpcClients.length > 0 ? feConf.rpcClients : ["honoClient"];
  const primaryClient = rpcClients[0] as string;

  const feFiles = await collectFiles(resolvedFe, [".ts", ".tsx"]);
  const feFilesWithClient = await Promise.all(
    feFiles.map(async (f) => {
      const src = await readFile(f, "utf-8");
      return rpcClients.some((c) => src.includes(c)) ? { f, src } : null;
    }),
  );

  const allRpcCalls: RpcCall[] = [];
  for (const item of feFilesWithClient) {
    if (!item) continue;
    allRpcCalls.push(...extractRpcCalls(item.src, item.f, rpcClients));
  }

  const indexPath = join(resolvedBe, beConf.entryPoint ?? "index.ts");
  const prefixMap = await extractPrefixMap(indexPath);

  const routesSub = beConf.routesDir ?? "routes";
  const routesSuffix = beConf.routeFileSuffix ?? ".route.ts";
  const v1Sub = beConf.v1Dir ?? "v1";

  const routesDir = join(resolvedBe, routesSub);
  let routeFiles: string[] = [];
  try {
    routeFiles = (await readdir(routesDir))
      .filter((n) => n.endsWith(routesSuffix))
      .map((n) => join(routesDir, n));
  } catch {
    // ignore
  }

  const v1Dir = join(routesDir, v1Sub);
  let v1Files: string[] = [];
  try {
    v1Files = (await readdir(v1Dir))
      .filter((n) => n.endsWith(routesSuffix))
      .map((n) => join(v1Dir, n));
  } catch {
    // ignore
  }

  const allRouteSources = new Map<string, string>();
  const allBeRoutes: BackendRoute[] = [];

  for (const f of routeFiles) {
    const src = await readFile(f, "utf-8");
    allRouteSources.set(f, src);
    allBeRoutes.push(...extractBackendRoutes(src, f, prefixMap, false));
  }
  for (const f of v1Files) {
    const src = await readFile(f, "utf-8");
    allRouteSources.set(f, src);
    allBeRoutes.push(...extractBackendRoutes(src, f, prefixMap, true));
  }

  const nonV1Routes = allBeRoutes.filter((r) => !r.isV1);
  const beRouteMap = new Map<string, BackendRoute[]>();
  for (const r of nonV1Routes) {
    const key = `${r.method} ${normalizePath(r.fullPath)}`;
    const existing = beRouteMap.get(key) ?? [];
    existing.push(r);
    beRouteMap.set(key, existing);
  }

  const primaryClientCalls = allRpcCalls.filter((c) => c.client === primaryClient);

  const contractResults: ContractResult[] = [];
  const matchedBePaths = new Set<string>();

  for (const call of primaryClientCalls) {
    const normalizedFe = normalizePath(call.path);
    const key = `${call.method} ${normalizedFe}`;

    if (contractResults.some((r) => r.method === call.method && r.frontendPath === call.path)) {
      continue;
    }

    const beMatches = beRouteMap.get(key);
    const matched = (beMatches?.length ?? 0) > 0;
    if (matched && beMatches) {
      for (const be of beMatches) {
        matchedBePaths.add(`${be.method} ${normalizePath(be.fullPath)}`);
      }
    }

    contractResults.push({
      method: call.method,
      frontendPath: call.path,
      backendPath: beMatches?.[0]?.fullPath ?? null,
      matched,
      file: call.file,
      line: call.line,
    });
  }

  const orphanedRoutes = nonV1Routes.filter(
    (r) => !matchedBePaths.has(`${r.method} ${normalizePath(r.fullPath)}`),
  );

  const monorepoRoot = resolve(opts.cwd ?? process.cwd());
  const commonSchemas = await collectCommonSchemas(
    monorepoRoot,
    schConf.commonDir ?? "",
    schConf.extraKnown ?? [],
  );
  const usedSchemas = extractSchemaNamesFromRoutes(allBeRoutes, allRouteSources);

  let output: string;
  if (format === "json") {
    output = JSON.stringify(
      {
        frontend: { dir: feSrcDir, uniquePaths: contractResults.length },
        backend: { dir: beSrcDir, routes: nonV1Routes.length },
        matched: contractResults.filter((r) => r.matched),
        unmatched: contractResults.filter((r) => !r.matched),
        orphaned: orphanedRoutes,
        schemaCoverage: {
          commonCount: commonSchemas.size,
          usedInRoutes: [...usedSchemas],
          localOnly: [...usedSchemas].filter((s) => !commonSchemas.has(s)),
        },
      },
      null,
      2,
    );
  } else {
    output = formatText(
      feSrcDir,
      beSrcDir,
      allBeRoutes,
      contractResults,
      orphanedRoutes,
      commonSchemas,
      usedSchemas,
    );
  }

  if (opts.outFile) await writeOutput(output, opts.outFile);
  return output;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const format = (getArg(args, "--format") ?? "text") as "text" | "json";
  const outFile = getArg(args, "--out");
  const positionals = args.filter((_, i, a) => {
    if (a[i]!.startsWith("--")) return false;
    if (i > 0 && a[i - 1]!.startsWith("--")) return false;
    return true;
  });

  let feSrcDir: string | undefined;
  let srcDir: string;

  if (positionals.length >= 2) {
    feSrcDir = positionals[0] as string;
    srcDir = positionals[1] as string;
  } else if (positionals.length === 1) {
    srcDir = positionals[0] as string;
  } else {
    console.error(
      "Usage: bun contracts.ts [<fe-src-dir>] <be-src-dir> [--format text|json] [--out <file>]",
    );
    console.error("       fe-src-dir can be omitted if frontend.src is set in audit/config.json");
    process.exit(1);
  }

  const output = await runContracts({ srcDir, feSrcDir, format, outFile });
  if (!outFile) console.log(output);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
