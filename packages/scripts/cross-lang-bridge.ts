#!/usr/bin/env bun
/**
 * cross-lang-bridge.ts — Detect and report Go ↔ TypeScript interface points.
 *
 * Analyses:
 *   1. Go Protocol swagger spec (Swagger 2.0) → endpoint inventory
 *   2. Orval-generated TS SDK (api.ts)         → TS function inventory
 *   3. TS model files (models/)                → type inventory
 *
 * Matches Go endpoints ↔ TS SDK functions by HTTP method + normalized path.
 * Maps Go swagger definitions (storage.Admin, client.X) → TS model files.
 *
 * Writes:
 *   audit/cross-lang-bridge.txt   (human-readable report)
 *   audit/cross-lang-bridge.json  (machine-readable data)
 *
 * Usage: bun cross-lang-bridge.ts [--out <dir>] [--help]
 */

import { mkdir, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { parseRootArg, readFile } from "./utils.js";

const ROOT = parseRootArg(resolve(import.meta.dir, "../.."));

// ─── Types ───────────────────────────────────────────────────────────────────

interface GoEndpoint {
  path: string;
  method: string;
  tags: string[];
  summary: string;
  security: string;
  requestRef: string | null;
  responseRefs: string[];
}

interface TsFunction {
  name: string;
  method: string;
  urlPath: string;
  file: string;
}

interface EndpointBridge {
  goPath: string;
  goMethod: string;
  goTags: string[];
  goSummary: string;
  goSecurity: string;
  tsFunction: string;
  tsFile: string;
}

interface TypeBridge {
  goDefinition: string;
  goPackage: string;
  goType: string;
  tsModelFile: string;
  tsTypeName: string;
}

interface BridgeReport {
  generatedAt: string;
  stats: {
    goEndpoints: number;
    tsFunctions: number;
    endpointBridges: number;
    unmatchedGoEndpoints: number;
    unmatchedTsFunctions: number;
    goDefinitions: number;
    tsModels: number;
    typeBridges: number;
    unmatchedDefinitions: number;
  };
  endpointBridges: EndpointBridge[];
  typeBridges: TypeBridge[];
  unmatchedGoEndpoints: GoEndpoint[];
  unmatchedTsFunctions: TsFunction[];
  unmatchedDefinitions: string[];
}

// ─── Parse Go swagger spec ───────────────────────────────────────────────────

async function parseSwagger(swaggerPath: string): Promise<{
  endpoints: GoEndpoint[];
  definitions: string[];
}> {
  const raw = await readFile(swaggerPath);
  if (!raw) {
    console.warn(`⚠ Swagger spec not found: ${swaggerPath}`);
    return { endpoints: [], definitions: [] };
  }

  let swagger: Record<string, unknown>;
  try {
    swagger = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.warn(`⚠ Invalid JSON in swagger spec: ${swaggerPath}`);
    return { endpoints: [], definitions: [] };
  }
  const paths = (swagger.paths ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const endpoints: GoEndpoint[] = [];

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, details] of Object.entries(methods)) {
      if (method === "parameters") continue;
      const detail = details as Record<string, unknown>;

      const tags = Array.isArray(detail.tags) ? (detail.tags as string[]) : [];
      const summary = (detail.summary as string) || "";

      let security = "public";
      if (Array.isArray(detail.security) && detail.security.length > 0) {
        const secObj = detail.security[0] as Record<string, unknown>;
        const secKey = Object.keys(secObj)[0];
        if (secKey) security = secKey;
      }

      // Extract request body $ref
      let requestRef: string | null = null;
      if (Array.isArray(detail.parameters)) {
        for (const param of detail.parameters as Record<string, unknown>[]) {
          if (param.in === "body" && param.schema) {
            const schema = param.schema as Record<string, unknown>;
            if (typeof schema.$ref === "string") {
              requestRef = schema.$ref.replace("#/definitions/", "");
            }
          }
        }
      }

      // Extract response $refs
      const responseRefs: string[] = [];
      if (detail.responses && typeof detail.responses === "object") {
        for (const resp of Object.values(
          detail.responses as Record<string, unknown>,
        )) {
          const r = resp as Record<string, unknown>;
          if (r.schema && typeof r.schema === "object") {
            const schema = r.schema as Record<string, unknown>;
            if (typeof schema.$ref === "string") {
              responseRefs.push(schema.$ref.replace("#/definitions/", ""));
            }
            // array items
            if (schema.type === "array" && schema.items) {
              const items = schema.items as Record<string, unknown>;
              if (typeof items.$ref === "string") {
                responseRefs.push(items.$ref.replace("#/definitions/", ""));
              }
            }
          }
        }
      }

      endpoints.push({
        path,
        method: method.toUpperCase(),
        tags,
        summary,
        security,
        requestRef,
        responseRefs,
      });
    }
  }

  // Collect all definition names
  const defs = (swagger.definitions ?? {}) as Record<string, unknown>;
  const definitions = Object.keys(defs);

  return { endpoints, definitions };
}

// ─── Parse orval TS SDK ──────────────────────────────────────────────────────

async function parseTsSdk(sdkPath: string, root: string): Promise<TsFunction[]> {
  let src: string;
  try {
    src = await readFile(sdkPath);
  } catch {
    console.warn(`⚠ TS SDK not found: ${sdkPath}`);
    return [];
  }

  const functions: TsFunction[] = [];

  const urlGetterRe =
    /export const (get\w+Url)\s*=\s*\([^)]*\).*?return\s+(?:stringifiedParams\.length\s*>\s*0\s*\?\s*)?[`"']([^`"']+?)[`"']/gs;
  const urlMap = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = urlGetterRe.exec(src)) !== null) {
    const getterName = m[1]!;
    let urlPath = m[2]!;
    urlPath = urlPath.replace(/\$\{[^}]+\}/g, "{param}");
    urlPath = urlPath.replace(/\?.*$/, "");
    urlMap.set(getterName, urlPath);
  }

  // Pattern: export const xxx = async (...) => { ... method: 'METHOD' ... }
  // The function name maps to its URL getter as getXxxUrl (capitalize first letter)
  const funcRe =
    /export const (\w+)\s*=\s*async\s*\([^)]*\).*?method:\s*'(\w+)'/gs;
  while ((m = funcRe.exec(src)) !== null) {
    const funcName = m[1]!;
    const method = m[2]!;
    const getterName = `get${funcName.charAt(0).toUpperCase()}${funcName.slice(1)}Url`;
    const urlPath = urlMap.get(getterName) ?? "";

    functions.push({
      name: funcName,
      method: method.toUpperCase(),
      urlPath,
      file: relative(root, sdkPath),
    });
  }

  return functions;
}

// ─── Parse TS model files ────────────────────────────────────────────────────

async function parseTsModels(modelsDir: string): Promise<Map<string, string>> {
  const modelMap = new Map<string, string>(); // lowercaseName → filename
  let entries: string[];
  try {
    entries = await readdir(modelsDir);
  } catch {
    console.warn(`⚠ Models directory not found: ${modelsDir}`);
    return modelMap;
  }

  for (const entry of entries) {
    if (entry === "index.ts" || !entry.endsWith(".ts")) continue;
    const name = entry.replace(/\.ts$/, "");
    modelMap.set(name.toLowerCase(), entry);
  }

  return modelMap;
}

// ─── Matching logic ──────────────────────────────────────────────────────────

function normalizeSwaggerPath(p: string): string {
  // /admins/{adminId}/keys → /admins/{param}/keys
  return p.replace(/\{[^}]+\}/g, "{param}").toLowerCase();
}

function matchEndpoints(
  goEndpoints: GoEndpoint[],
  tsFunctions: TsFunction[],
): {
  bridges: EndpointBridge[];
  unmatchedGo: GoEndpoint[];
  unmatchedTs: TsFunction[];
} {
  const bridges: EndpointBridge[] = [];
  const matchedGoIdx = new Set<number>();
  const matchedTsIdx = new Set<number>();

  // Build lookup: method+normalizedPath → tsFunction index
  const tsLookup = new Map<string, number[]>();
  for (let i = 0; i < tsFunctions.length; i++) {
    const fn = tsFunctions[i]!;
    const key = `${fn.method}:${fn.urlPath.toLowerCase()}`;
    const existing = tsLookup.get(key) ?? [];
    existing.push(i);
    tsLookup.set(key, existing);
  }

  for (let gi = 0; gi < goEndpoints.length; gi++) {
    const ep = goEndpoints[gi]!;
    const normalizedPath = normalizeSwaggerPath(ep.path);
    const key = `${ep.method}:${normalizedPath}`;

    const tsIndices = tsLookup.get(key);
    if (tsIndices && tsIndices.length > 0) {
      // Take first unmatched TS function
      for (const ti of tsIndices) {
        if (!matchedTsIdx.has(ti)) {
          matchedGoIdx.add(gi);
          matchedTsIdx.add(ti);
          bridges.push({
            goPath: ep.path,
            goMethod: ep.method,
            goTags: ep.tags,
            goSummary: ep.summary,
            goSecurity: ep.security,
            tsFunction: tsFunctions[ti].name,
            tsFile: tsFunctions[ti].file,
          });
          break;
        }
      }
    }
  }

  const unmatchedGo = goEndpoints.filter((_, i) => !matchedGoIdx.has(i));
  const unmatchedTs = tsFunctions.filter((_, i) => !matchedTsIdx.has(i));

  return { bridges, unmatchedGo, unmatchedTs };
}

function matchTypes(
  goDefinitions: string[],
  tsModels: Map<string, string>,
): { bridges: TypeBridge[]; unmatched: string[] } {
  const bridges: TypeBridge[] = [];
  const unmatched: string[] = [];

  for (const def of goDefinitions) {
    // storage.Admin → storageAdmin → storageadmin (lowercased for lookup)
    const parts = def.split(".");
    if (parts.length !== 2) {
      unmatched.push(def);
      continue;
    }
    const [pkg, typeName] = parts;
    const camelName = `${pkg}${typeName}`;
    const lookupKey = camelName.toLowerCase();

    const tsFile = tsModels.get(lookupKey);
    if (tsFile) {
      // TS type name: capitalize first letter of each part → StorageAdmin
      const tsTypeName = `${pkg.charAt(0).toUpperCase()}${pkg.slice(1)}${typeName}`;
      bridges.push({
        goDefinition: def,
        goPackage: pkg,
        goType: typeName,
        tsModelFile: tsFile,
        tsTypeName,
      });
    } else {
      unmatched.push(def);
    }
  }

  return { bridges, unmatched };
}

// ─── Output formatting ──────────────────────────────────────────────────────

function formatText(report: BridgeReport): string {
  const lines: string[] = [];
  const { stats } = report;

  lines.push(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  lines.push("║         CROSS-LANGUAGE BRIDGE: Go ↔ TypeScript             ║");
  lines.push(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("# STATS");
  lines.push(`Go endpoints:          ${stats.goEndpoints}`);
  lines.push(`TS SDK functions:      ${stats.tsFunctions}`);
  lines.push(`Endpoint bridges:      ${stats.endpointBridges}`);
  lines.push(`Unmatched Go endpoints: ${stats.unmatchedGoEndpoints}`);
  lines.push(`Unmatched TS functions: ${stats.unmatchedTsFunctions}`);
  lines.push(`Go definitions:        ${stats.goDefinitions}`);
  lines.push(`TS model files:        ${stats.tsModels}`);
  lines.push(`Type bridges:          ${stats.typeBridges}`);
  lines.push(`Unmatched definitions: ${stats.unmatchedDefinitions}`);
  lines.push("");

  // ── Endpoint bridges
  lines.push("═".repeat(64));
  lines.push("# ENDPOINT BRIDGES");
  lines.push("═".repeat(64));
  lines.push("");

  if (report.endpointBridges.length === 0) {
    lines.push("(none)");
  } else {
    const pad = (s: string, n: number) => s.padEnd(n);
    lines.push(
      `${pad("METHOD", 8)} ${pad("GO PATH", 45)} ${pad("TS FUNCTION", 40)} ${pad("AUTH", 12)} TAGS`,
    );
    lines.push("-".repeat(120));
    for (const b of report.endpointBridges) {
      lines.push(
        `${pad(b.goMethod, 8)} ${pad(b.goPath, 45)} ${pad(b.tsFunction, 40)} ${pad(b.goSecurity, 12)} ${b.goTags.join(", ")}`,
      );
    }
  }
  lines.push("");

  // ── Type bridges
  lines.push("═".repeat(64));
  lines.push("# TYPE BRIDGES");
  lines.push("═".repeat(64));
  lines.push("");

  if (report.typeBridges.length === 0) {
    lines.push("(none)");
  } else {
    const pad = (s: string, n: number) => s.padEnd(n);
    lines.push(
      `${pad("GO DEFINITION", 40)} ${pad("TS MODEL FILE", 45)} TS TYPE`,
    );
    lines.push("-".repeat(120));
    for (const b of report.typeBridges) {
      lines.push(
        `${pad(b.goDefinition, 40)} ${pad(b.tsModelFile, 45)} ${b.tsTypeName}`,
      );
    }
  }
  lines.push("");

  // ── Unmatched
  lines.push("═".repeat(64));
  lines.push("# UNMATCHED");
  lines.push("═".repeat(64));
  lines.push("");

  if (report.unmatchedGoEndpoints.length > 0) {
    lines.push("## Go endpoints without TS SDK match:");
    for (const ep of report.unmatchedGoEndpoints) {
      lines.push(
        `  ${ep.method.padEnd(8)} ${ep.path.padEnd(45)} [${ep.tags.join(", ")}]`,
      );
    }
    lines.push("");
  }

  if (report.unmatchedTsFunctions.length > 0) {
    lines.push("## TS functions without Go endpoint match:");
    for (const fn of report.unmatchedTsFunctions) {
      lines.push(
        `  ${fn.method.padEnd(8)} ${fn.urlPath.padEnd(45)} ${fn.name}`,
      );
    }
    lines.push("");
  }

  if (report.unmatchedDefinitions.length > 0) {
    lines.push("## Go definitions without TS model match:");
    for (const def of report.unmatchedDefinitions) {
      lines.push(`  ${def}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Exported entry point ─────────────────────────────────────────────────────

export interface CrossLangBridgeOptions {
  root: string;
  outDir?: string;
}

export async function runCrossLangBridge(opts: CrossLangBridgeOptions): Promise<void> {
  const t0 = Date.now();
  const outDir = opts.outDir ?? resolve(opts.root, "audit");

  const swaggerPath = resolve(opts.root, "go-packages/protocol/docs/swagger.json");
  const sdkPath = resolve(opts.root, "packages/internal/protocol/generated/api.ts");
  const modelsDir = resolve(opts.root, "packages/internal/protocol/generated/models");

  // Skip entirely if none of the expected paths exist (not a Go ↔ TS bridge repo)
  const { existsSync } = await import("node:fs");
  if (!existsSync(swaggerPath) && !existsSync(sdkPath) && !existsSync(modelsDir)) {
    return;
  }

  console.log("Detecting Go ↔ TypeScript cross-language bridges...\n");

  const [
    { endpoints: goEndpoints, definitions: goDefinitions },
    tsFunctions,
    tsModels,
  ] = await Promise.all([
    parseSwagger(swaggerPath),
    parseTsSdk(sdkPath, opts.root),
    parseTsModels(modelsDir),
  ]);

  console.log(`  Go endpoints:     ${goEndpoints.length}`);
  console.log(`  Go definitions:   ${goDefinitions.length}`);
  console.log(`  TS SDK functions: ${tsFunctions.length}`);
  console.log(`  TS model files:   ${tsModels.size}`);

  // Match endpoints
  const {
    bridges: endpointBridges,
    unmatchedGo,
    unmatchedTs,
  } = matchEndpoints(goEndpoints, tsFunctions);

  // Match types
  const { bridges: typeBridges, unmatched: unmatchedDefs } = matchTypes(
    goDefinitions,
    tsModels,
  );

  const report: BridgeReport = {
    generatedAt: new Date().toISOString(),
    stats: {
      goEndpoints: goEndpoints.length,
      tsFunctions: tsFunctions.length,
      endpointBridges: endpointBridges.length,
      unmatchedGoEndpoints: unmatchedGo.length,
      unmatchedTsFunctions: unmatchedTs.length,
      goDefinitions: goDefinitions.length,
      tsModels: tsModels.size,
      typeBridges: typeBridges.length,
      unmatchedDefinitions: unmatchedDefs.length,
    },
    endpointBridges,
    typeBridges,
    unmatchedGoEndpoints: unmatchedGo,
    unmatchedTsFunctions: unmatchedTs,
    unmatchedDefinitions: unmatchedDefs,
  };

  // Write output
  await mkdir(outDir, { recursive: true });

  const textOut = formatText(report);
  const textPath = join(outDir, "cross-lang-bridge.txt");
  await Bun.write(textPath, textOut);

  const jsonPath = join(outDir, "cross-lang-bridge.json");
  await Bun.write(jsonPath, JSON.stringify(report, null, 2));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(
    `\nDone in ${elapsed}s  —  ${(textOut.length / 1024).toFixed(0)} KB / ${textOut.split("\n").length} lines → ${relative(opts.root, textPath)}`,
  );
  console.log(`  JSON → ${relative(opts.root, jsonPath)}`);
}

// ─── Standalone execution ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: bun cross-lang-bridge.ts [--out <dir>] [--help]\n\n" +
        "Detects Go ↔ TypeScript interface points.\n" +
        "  --out <dir>   Output directory (default: audit/)\n",
    );
    process.exit(0);
  }

  const outIdx = args.indexOf("--out");
  const outDir =
    outIdx >= 0 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;

  await runCrossLangBridge({ root: ROOT, outDir });
}

// No auto-run — use the exported runCrossLangBridge function
