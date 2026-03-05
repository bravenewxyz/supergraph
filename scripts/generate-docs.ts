#!/usr/bin/env bun

import { basename, dirname, join, relative, resolve } from "node:path";
import { loadConfig } from "../flow/src/cli/config.js";
import { findFiles, readFile } from "./utils.js";

const ROOT = resolve(import.meta.dir, "../..");

function extractBraceBlock(src: string, startIdx: number): string {
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  return src.slice(startIdx);
}

type RouteInfo = {
  method: string;
  path: string;
  tags: string;
  auth: string;
  requestSchema: string;
  responseSchema: string;
};

function parseRouteFile(src: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const createRouteRe = /createRoute\s*\(\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = createRouteRe.exec(src)) !== null) {
    const blockStart = match.index + match[0].length - 1;
    const block = extractBraceBlock(src, blockStart);

    const method =
      block.match(/method:\s*"(get|post|put|delete|patch)"/)?.[1] ?? "?";
    const path = block.match(/path:\s*"([^"]+)"/)?.[1] ?? "/";
    const tags = block.match(/tags:\s*\[\s*"([^"]+)"/)?.[1] ?? "-";

    let auth = "public";
    if (/restrictAccessTo\.superAdmin/.test(block)) auth = "superAdmin";
    else if (/restrictAccessTo\.owner/.test(block)) auth = "owner";
    else if (/restrictAccessTo\.admin/.test(block)) auth = "admin";
    else if (/restrictAccessTo\.authenticated/.test(block))
      auth = "authenticated";
    else if (/minimumAccessLevel:\s*"([^"]+)"/.test(block))
      auth = block.match(/minimumAccessLevel:\s*"([^"]+)"/)?.[1] ?? "public";
    else if (/requireAuthMiddleware/.test(block)) auth = "authenticated";

    const requestSchemas: string[] = [];
    const responseSchemas: string[] = [];
    const requestIdx = block.indexOf("request:");
    const responsesIdx = block.indexOf("responses:");

    if (requestIdx !== -1) {
      const reqSection = block.slice(
        requestIdx,
        responsesIdx !== -1 ? responsesIdx : undefined,
      );
      for (const m of reqSection.matchAll(/schema:\s*([A-Z][a-zA-Z]*Schema)/g))
        requestSchemas.push(m[1]);
      const queryMatch = reqSection.match(/query:\s*([A-Z][a-zA-Z]*Schema)/);
      if (queryMatch) requestSchemas.push(queryMatch[1]);
      const paramsMatch = reqSection.match(/params:\s*([A-Z][a-zA-Z]*Schema)/);
      if (paramsMatch) requestSchemas.push(paramsMatch[1]);
    }

    if (responsesIdx !== -1) {
      const resSection = block.slice(responsesIdx);
      const success = resSection.match(
        /(?:200|201|204):\s*\{([\s\S]*?)(?=\d{3}:\s*\{|$)/,
      );
      if (success) {
        for (const m of success[1].matchAll(
          /schema:\s*([A-Z][a-zA-Z]*Schema)/g,
        ))
          responseSchemas.push(m[1]);
      }
      if (responseSchemas.length === 0) {
        for (const m of resSection.matchAll(
          /schema:\s*([A-Z][a-zA-Z]*Schema)/g,
        )) {
          responseSchemas.push(m[1]);
          break;
        }
      }
    }

    routes.push({
      method: method.toUpperCase(),
      path,
      tags,
      auth,
      requestSchema: requestSchemas.join(", ") || "-",
      responseSchema: responseSchemas.join(", ") || "-",
    });
  }

  return routes;
}

async function sectionPackageRegistry(
  packagesDir: string,
  internalScope: string,
): Promise<string> {
  const pkgFiles = await findFiles(
    resolve(ROOT, packagesDir),
    /^package\.json$/,
  );
  const rows: string[] = [];

  for (const file of pkgFiles) {
    const dir = dirname(file);
    const rel = relative(resolve(ROOT, packagesDir), dir);
    if (rel.split("/").length > 3) continue;

    const pkg = JSON.parse(await readFile(file));
    const name: string = pkg.name ?? basename(dir);
    const location = relative(ROOT, dir);

    let category = "lib";
    if (
      /\b(backend|frontend|auth|analytics|protocol-event-processor|cms|form-service)\b/.test(
        rel,
      )
    )
      category = "app";
    if (/\binfrastructure\b/.test(rel)) category = "infra";
    if (/\bintegrations\b/.test(rel)) category = "integration";
    if (/\b(typescript-config|testing)\b/.test(rel)) category = "config";

    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    const wsDeps = Object.keys(allDeps)
      .filter(
        (d) =>
          internalScope &&
          d.startsWith(internalScope) &&
          String(allDeps[d]).includes("workspace"),
      )
      .map((d) => d.replace(internalScope, ""))
      .join(", ");

    const scripts = Object.keys(pkg.scripts ?? {})
      .filter((s) =>
        [
          "dev",
          "build",
          "test",
          "start",
          "lint",
          "check-types",
          "pull-env",
        ].includes(s),
      )
      .join(", ");

    rows.push(
      `| ${name} | \`${location}\` | ${category} | ${wsDeps || "-"} | ${scripts || "-"} |`,
    );
  }

  return [
    "## Package Registry",
    "",
    "| Package | Location | Category | Workspace Deps | Key Scripts |",
    "|---------|----------|----------|----------------|-------------|",
    ...rows,
    "",
  ].join("\n");
}

async function sectionBackendRouteTree(
  backendSrc: string,
  routesDir: string,
  routeFileSuffix: string,
): Promise<string> {
  const routeFilesDir = resolve(ROOT, backendSrc, routesDir);
  const suffixPattern = new RegExp(`${routeFileSuffix.replace(/\./g, "\\.")}$`);
  const routeFiles = await findFiles(routeFilesDir, suffixPattern);
  const sections: string[] = ["## Backend API -- Complete Route Tree", ""];

  for (const file of routeFiles) {
    const src = await readFile(file);
    const routes = parseRouteFile(src);
    if (routes.length === 0) continue;

    const fileName = relative(routeFilesDir, file);
    sections.push(`### ${fileName}`);
    sections.push("");
    sections.push(
      "| Method | Path | Tags | Auth | Request Schema | Response Schema |",
    );
    sections.push(
      "|--------|------|------|------|----------------|-----------------|",
    );

    for (const r of routes) {
      sections.push(
        `| ${r.method} | \`${r.path}\` | ${r.tags} | ${r.auth} | ${r.requestSchema} | ${r.responseSchema} |`,
      );
    }
    sections.push("");
  }

  return sections.join("\n");
}

async function sectionSchemaCatalog(schemasDir: string): Promise<string> {
  const indexSrc = await readFile(resolve(ROOT, schemasDir, "index.ts"));
  const moduleRe = /export \* from "\.\/([^"]+)"/g;
  const sections: string[] = ["## Zod Schema Catalog", ""];
  let m: RegExpExecArray | null;

  while ((m = moduleRe.exec(indexSrc)) !== null) {
    const moduleName = m[1];
    const src = await readFile(resolve(ROOT, schemasDir, `${moduleName}.ts`));
    if (!src) continue;

    const schemaRe = /export const ([A-Z][a-zA-Z]*Schema)\b/g;
    const schemas: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = schemaRe.exec(src)) !== null) schemas.push(sm[1]);

    if (schemas.length > 0) {
      sections.push(`### ${moduleName}`);
      for (const s of schemas) sections.push(`- \`${s}\``);
      sections.push("");
    }
  }

  const reExportRe = /export \{ ([^}]+) \}/g;
  let re: RegExpExecArray | null;
  const reExported: string[] = [];
  while ((re = reExportRe.exec(indexSrc)) !== null) {
    const names = re[1]
      .split(",")
      .map((n) => n.trim().split(" as ").pop()!.trim());
    for (const name of names) {
      if (/Schema$/.test(name)) reExported.push(name);
    }
  }
  if (reExported.length > 0) {
    sections.push("### Re-exported");
    for (const s of reExported) sections.push(`- \`${s}\``);
    sections.push("");
  }

  return sections.join("\n");
}

async function sectionFrontendHooks(
  frontendSrc: string,
  hooksDir: string,
): Promise<string> {
  const hooksPath = resolve(ROOT, frontendSrc, hooksDir);
  const hookFiles = await findFiles(hooksPath, /^use.*\.ts$/);
  const rows: string[] = [];

  for (const file of hookFiles) {
    const src = await readFile(file);
    const hookRe = /export (?:const|function) (use[A-Z][a-zA-Z]*)/g;
    let m: RegExpExecArray | null;
    while ((m = hookRe.exec(src)) !== null) {
      rows.push(
        `| \`${m[1]}\` | \`${relative(resolve(ROOT, frontendSrc), file)}\` |`,
      );
    }
  }

  return [
    "## Frontend Hooks",
    "",
    "| Hook | File |",
    "|------|------|",
    ...rows,
    "",
  ].join("\n");
}

async function sectionQueryOptions(frontendSrc: string): Promise<string> {
  const src = await readFile(resolve(ROOT, frontendSrc, "lib/options.ts"));
  const optionRe = /export const ([a-zA-Z]+Options)\b/g;
  const rows: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = optionRe.exec(src)) !== null) {
    const name = m[1];
    const startIdx = m.index;
    const nextExport = src.indexOf("\nexport ", startIdx + 1);
    const fnBody = src.slice(
      startIdx,
      nextExport === -1 ? undefined : nextExport,
    );
    const keyMatch = fnBody.match(/queryKey:\s*\[([\s\S]*?)\]/);
    let queryKey = "-";
    if (keyMatch) {
      queryKey = keyMatch[1].replace(/\n/g, " ").replace(/\s+/g, " ").trim();
      if (queryKey.length > 80) queryKey = `${queryKey.slice(0, 77)}...`;
    }
    rows.push(`| \`${name}\` | \`[${queryKey}]\` |`);
  }

  return [
    "## Frontend Query Options",
    "",
    "| Option | queryKey Pattern |",
    "|--------|-----------------|",
    ...rows,
    "",
  ].join("\n");
}

async function sectionPgTables(backendSrc: string): Promise<string> {
  const src = await readFile(resolve(ROOT, backendSrc, "stable/db/schema.ts"));
  const sections: string[] = ["## PostgreSQL Tables", ""];

  const enumRe = /export const (\w+) = pgEnum\("([^"]+)",\s*\[([\s\S]*?)\]\)/g;
  const enums: { varName: string; dbName: string; values: string[] }[] = [];
  let em: RegExpExecArray | null;
  while ((em = enumRe.exec(src)) !== null) {
    const values = em[3]
      .split(",")
      .map((v) => v.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    enums.push({ varName: em[1], dbName: em[2], values });
  }

  if (enums.length > 0) {
    sections.push("### Enums");
    sections.push("");
    for (const e of enums) {
      sections.push(
        `**${e.dbName}** (\`${e.varName}\`): ${e.values.map((v) => `\`${v}\``).join(", ")}`,
      );
      sections.push("");
    }
  }

  const tableRe = /export const (\w+) = pgTable\(\s*"([^"]+)"/g;
  let tm: RegExpExecArray | null;
  while ((tm = tableRe.exec(src)) !== null) {
    const varName = tm[1];
    const tableName = tm[2];
    const afterMatch = src.indexOf("{", tm.index + tm[0].length);
    if (afterMatch === -1) continue;
    const columnsBlock = extractBraceBlock(src, afterMatch);

    const colRe =
      /(\w+):\s*(?:uuid|text|varchar|char|integer|numeric|boolean|timestamp|jsonb)/g;
    const columns: { name: string; type: string }[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = colRe.exec(columnsBlock)) !== null) {
      const typeMatch = columnsBlock
        .slice(cm.index + cm[1].length)
        .match(
          /:\s*(uuid|text|varchar|char|integer|numeric|boolean|timestamp|jsonb)/,
        );
      if (typeMatch) columns.push({ name: cm[1], type: typeMatch[1] });
    }

    if (columns.length > 0) {
      sections.push(`### ${tableName} (\`${varName}\`)`);
      sections.push("");
      sections.push("| Column | Type |");
      sections.push("|--------|------|");
      for (const col of columns) sections.push(`| ${col.name} | ${col.type} |`);
      sections.push("");
    }
  }

  return sections.join("\n");
}

async function sectionErrorCodes(constantsIndexPath: string): Promise<string> {
  const src = await readFile(constantsIndexPath);
  const sections: string[] = ["## Error Codes", ""];

  const ecStart = src.indexOf("export const ERROR_CODES");
  if (ecStart === -1) return sections.join("\n");

  const braceStart = src.indexOf("{", ecStart);
  const block = extractBraceBlock(src, braceStart);

  const topLevelRe = /^\s+([A-Z_]+):\s*"([^"]+)"/gm;
  const topLevel: string[] = [];
  let tlm: RegExpExecArray | null;
  while ((tlm = topLevelRe.exec(block)) !== null) {
    const before = block.slice(0, tlm.index);
    const opens = (before.match(/\{/g) || []).length;
    const closes = (before.match(/\}/g) || []).length;
    if (opens - closes === 1) topLevel.push(tlm[1]);
  }

  if (topLevel.length > 0) {
    sections.push("### Top-Level");
    for (const code of topLevel) sections.push(`- \`${code}\``);
    sections.push("");
  }

  const categoryRe = /(\w+):\s*\{/g;
  let catM: RegExpExecArray | null;
  while ((catM = categoryRe.exec(block)) !== null) {
    const catName = catM[1];
    const innerStart = catM.index + catM[0].length - 1;
    const innerBlock = extractBraceBlock(block, innerStart);

    const codeRe2 = /([A-Z][A-Z_0-9]+):\s*(?:\n\s*)?"[^"]+"/g;
    const codes: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = codeRe2.exec(innerBlock)) !== null) codes.push(cm[1]);

    if (codes.length > 0 && /^[A-Z]/.test(catName)) {
      sections.push(`### ${catName}`);
      for (const c of codes) sections.push(`- \`${c}\``);
      sections.push("");
    }
  }

  return sections.join("\n");
}

async function sectionFeatureFlags(commonDir: string): Promise<string> {
  const schemasSrc = await readFile(
    join(commonDir, "schemas/featuresFlags.ts"),
  );
  const constantsSrc = await readFile(
    join(commonDir, "constants/featuresFlags.ts"),
  );
  const sections: string[] = ["## Feature Flags", ""];

  const flagsMatch = schemasSrc.match(
    /const FEATURE_FLAGS\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  if (flagsMatch) {
    const flags = flagsMatch[1]
      .split(",")
      .map((f) => f.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    sections.push("### Available Flags");
    sections.push("");
    for (const flag of flags) sections.push(`- \`${flag}\``);
    sections.push("");
  }

  const planMatch = constantsSrc.match(
    /PLAN_FEATURES\s*=\s*\{([\s\S]*?)\}\s*as const/,
  );
  if (planMatch) {
    sections.push("### Plan Features Mapping");
    sections.push("");

    const planEntryRe = /(\w+):\s*(\w+)/g;
    let pm: RegExpExecArray | null;
    while ((pm = planEntryRe.exec(planMatch[1])) !== null) {
      const plan = pm[1];
      const varName = pm[2];
      const varMatch = constantsSrc.match(
        new RegExp(`const ${varName}[^=]*=\\s*\\[([\\s\\S]*?)\\]`, "m"),
      );
      if (varMatch) {
        const features = varMatch[1]
          .replace(/\.\.\.(\w+)/g, (_, ref) => {
            const refMatch = constantsSrc.match(
              new RegExp(`const ${ref}[^=]*=\\s*\\[([\\s\\S]*?)\\]`, "m"),
            );
            return refMatch ? refMatch[1] : "";
          })
          .split(",")
          .map((f) => f.trim().replace(/^["']|["']$/g, ""))
          .filter((f) => f && !f.startsWith("..."));
        sections.push(
          `**${plan}**: ${features.length > 0 ? features.map((f) => `\`${f}\``).join(", ") : "(none)"}`,
        );
      } else {
        sections.push(`**${plan}**: \`${varName}\``);
      }
    }
    sections.push("");
  }

  return sections.join("\n");
}

async function sectionConstants(constantsIndexPath: string): Promise<string> {
  const src = await readFile(constantsIndexPath);
  const sections: string[] = ["## Constants", ""];

  const arrays = [
    { label: "Identity Types", varName: "IDENTITY_TYPES" },
    { label: "Platform Types", varName: "PLATFORM_TYPES" },
    { label: "Reward Types", varName: "REWARD_TYPES" },
    { label: "Entities", varName: "ENTITIES" },
    { label: "Guild Plans", varName: "GUILD_PLANS" },
    { label: "Billing Periods", varName: "BILLING_PERIODS" },
    { label: "Payment Statuses", varName: "PAYMENT_STATUSES" },
  ];

  for (const { label, varName } of arrays) {
    const re = new RegExp(
      `export const ${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`,
    );
    const match = src.match(re);
    if (match) {
      const values = match[1]
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      sections.push(`### ${label}`);
      sections.push("");
      sections.push(values.map((v) => `\`${v}\``).join(", "));
      sections.push("");
    }
  }

  return sections.join("\n");
}

async function sectionGoApiRoutes(swaggerPath: string): Promise<string> {
  try {
    const swaggerSrc = await readFile(swaggerPath);
    const swagger = JSON.parse(swaggerSrc);
    const paths = swagger.paths || {};
    const sections: string[] = ["## Go Protocol API Routes", ""];
    const rows: string[] = [];

    for (const [path, methods] of Object.entries(paths)) {
      const methodObj = methods as Record<string, unknown>;
      for (const [method, details] of Object.entries(methodObj)) {
        if (method === "parameters") continue;
        const detail = details as Record<string, unknown>;
        const summary = (detail.summary as string) || "-";
        const tags = Array.isArray(detail.tags) ? detail.tags.join(", ") : "-";
        let auth = "public";
        if (Array.isArray(detail.security) && detail.security.length > 0) {
          const secObj = detail.security[0] as Record<string, unknown>;
          const secKey = Object.keys(secObj)[0];
          if (secKey) auth = secKey;
        }
        rows.push(
          `| ${method.toUpperCase()} | \`${path}\` | ${tags} | ${auth} | ${summary} |`,
        );
      }
    }

    if (rows.length === 0) return "";

    sections.push("| Method | Path | Tags | Auth | Summary |");
    sections.push("|--------|------|------|------|---------|");
    sections.push(...rows);
    sections.push("");

    return sections.join("\n");
  } catch (error) {
    return "";
  }
}

async function main() {
  const cfg = await loadConfig(ROOT);
  const outputPath = resolve(
    ROOT,
    cfg.docs.architectureFile ?? "ARCHITECTURE_REFERENCE.md",
  );
  const generateCommand =
    cfg.docs.generateCommand || "bun devtools/scripts/generate-docs.ts";

  console.log("Generating ARCHITECTURE_REFERENCE.md...\n");
  const start = Date.now();

  const schemasDir = cfg.schemas.commonDir ?? "packages/common/schemas";
  const commonDir = resolve(ROOT, dirname(schemasDir));
  const constantsIndexPath = join(commonDir, "constants/index.ts");
  const backendSrc = cfg.backend.src ?? "packages/backend/src";
  const frontendSrc = cfg.frontend.src ?? "packages/frontend/app/src";

  const goPackagesConfig = (cfg as Record<string, unknown>).goPackages as
    | Record<string, unknown>
    | undefined;
  const swaggerPath = resolve(
    ROOT,
    (goPackagesConfig?.swaggerSpec as string) ??
      "go-packages/protocol/docs/swagger.json",
  );

  const [
    packageRegistry,
    routeTree,
    schemaCatalog,
    frontendHooks,
    queryOptions,
    pgTables,
    errorCodes,
    featureFlags,
    constants,
    goApiRoutes,
  ] = await Promise.all([
    sectionPackageRegistry(
      cfg.workspace.packagesDir ?? "packages",
      cfg.workspace.internalScope ?? "",
    ),
    sectionBackendRouteTree(
      backendSrc,
      cfg.backend.routesDir ?? "routes",
      cfg.backend.routeFileSuffix ?? ".route.ts",
    ),
    sectionSchemaCatalog(schemasDir),
    sectionFrontendHooks(frontendSrc, cfg.frontend.hooksDir ?? "hooks"),
    sectionQueryOptions(frontendSrc),
    sectionPgTables(backendSrc),
    sectionErrorCodes(constantsIndexPath),
    sectionFeatureFlags(commonDir),
    sectionConstants(constantsIndexPath),
    sectionGoApiRoutes(swaggerPath),
  ]);

  const output = [
    "# Architecture Reference (Auto-Generated)",
    "",
    `> Generated: ${new Date().toISOString()} | Refresh with \`${generateCommand}\``,
    "",
    "---",
    "",
    packageRegistry,
    routeTree,
    schemaCatalog,
    frontendHooks,
    queryOptions,
    pgTables,
    errorCodes,
    featureFlags,
    constants,
    goApiRoutes,
  ].join("\n");

  await Bun.write(outputPath, output);

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  const lineCount = output.split("\n").length;
  console.log(
    `Done in ${elapsed}s -- ${lineCount} lines written to ${relative(ROOT, outputPath)}`,
  );
}

main();
