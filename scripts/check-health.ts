#!/usr/bin/env bun

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { loadConfig, type AuditConfig } from "../flow/src/cli/config.js";
import { findFiles, readFile } from "./utils.js";

const ROOT = resolve(import.meta.dir, "../..");

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

const PASS = `${GREEN}\u2713${RESET}`;
const FAIL = `${RED}\u2717${RESET}`;

function header(title: string) {
  console.log(`\n${BOLD}${CYAN}── ${title} ──${RESET}`);
}

type CheckResult = {
  name: string;
  passed: boolean;
  details: string;
};

async function getMtime(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

async function checkSchemaExports(cfg: Required<AuditConfig>): Promise<CheckResult | null> {
  const { commonDir } = cfg.schemas;
  if (!commonDir) return null;

  header("1. Schema Export Completeness");

  const schemasDir = resolve(ROOT, commonDir);
  const indexPath = resolve(schemasDir, "index.ts");
  const indexContent = await readFile(indexPath);

  const allEntries = await readdir(schemasDir, { withFileTypes: true });
  const schemaFiles = allEntries
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && e.name !== "index.ts")
    .map((e) => e.name.replace(/\.ts$/, ""));

  const missing: string[] = [];
  for (const name of schemaFiles) {
    if (!indexContent.includes(`export * from "./${name}"`)) missing.push(name);
  }

  if (missing.length === 0) {
    console.log(`  ${PASS} All ${schemaFiles.length} schema files are exported from index.ts`);
    return {
      name: "Schema Export Completeness",
      passed: true,
      details: `${schemaFiles.length}/${schemaFiles.length} exported`,
    };
  }

  for (const name of missing) {
    console.log(`  ${FAIL} Missing export: ${RED}export * from "./${name}"${RESET}`);
  }
  console.log(`  ${DIM}${schemaFiles.length - missing.length}/${schemaFiles.length} exported${RESET}`);
  return {
    name: "Schema Export Completeness",
    passed: false,
    details: `Missing: ${missing.join(", ")}`,
  };
}

async function checkRouteRegistration(cfg: Required<AuditConfig>): Promise<CheckResult | null> {
  const { src: beSrc, routesDir, routeFileSuffix, entryPoint, routeImportPrefixes } = cfg.backend;
  if (!beSrc) return null;

  header("2. Route Registration Completeness");

  const resolvedRoutes = resolve(ROOT, beSrc, routesDir ?? "routes");
  const indexPath = resolve(ROOT, beSrc, entryPoint ?? "index.ts");
  const indexContent = await readFile(indexPath);
  const suffix = routeFileSuffix ?? ".route.ts";
  const prefixes = routeImportPrefixes ?? [];

  const allEntries = await readdir(resolvedRoutes, { withFileTypes: true });
  const routeFiles = allEntries
    .filter((e) => e.isFile() && e.name.endsWith(suffix))
    .map((e) => e.name);

  const missing: string[] = [];
  for (const file of routeFiles) {
    const base = file.replace(".ts", "");
    const found =
      prefixes.length > 0
        ? prefixes.some((p) => indexContent.includes(`${p}${base}`))
        : indexContent.includes(base);
    if (!found) missing.push(file);
  }

  if (missing.length === 0) {
    console.log(`  ${PASS} All ${routeFiles.length} route files are imported in index.ts`);
    return {
      name: "Route Registration",
      passed: true,
      details: `${routeFiles.length}/${routeFiles.length} registered`,
    };
  }

  for (const file of missing) console.log(`  ${FAIL} Unregistered route: ${RED}${file}${RESET}`);
  console.log(`  ${DIM}${routeFiles.length - missing.length}/${routeFiles.length} registered${RESET}`);
  return {
    name: "Route Registration",
    passed: false,
    details: `Unregistered: ${missing.join(", ")}`,
  };
}

async function checkHookOptionsConsistency(cfg: Required<AuditConfig>): Promise<CheckResult | null> {
  const { src: feSrc, hooksDir, optionsImportPattern } = cfg.frontend;
  if (!feSrc || !optionsImportPattern) return null;

  header("3. Hook-Options Consistency");

  const resolvedHooks = resolve(ROOT, feSrc, hooksDir ?? "hooks");
  const hooksExist = await stat(resolvedHooks)
    .then(() => true)
    .catch(() => false);

  if (!hooksExist) {
    console.log(`  ${FAIL} Hooks directory not found`);
    return { name: "Hook-Options Consistency", passed: false, details: "Hooks directory not found" };
  }

  const allEntries = await readdir(resolvedHooks, { withFileTypes: true });
  const hookFiles = allEntries
    .filter((e) => e.isFile() && /^use.*\.ts$/.test(e.name))
    .map((e) => e.name);

  const queryHookPattern =
    /\b(useQuery|useSuspenseQuery|useInfiniteQuery|useSuspenseInfiniteQuery)\b/;
  const escapedPattern = optionsImportPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const optionsPattern = new RegExp(
    `from\\s+["']${escapedPattern}["']|[Oo]ptions\\s*\\(|[Oo]ptions\\s*\\)`,
  );

  const suspicious: string[] = [];
  let totalQueryHooks = 0;

  for (const file of hookFiles) {
    const src = await readFile(resolve(resolvedHooks, file));
    if (queryHookPattern.test(src)) {
      totalQueryHooks++;
      if (!optionsPattern.test(src)) suspicious.push(file);
    }
  }

  if (suspicious.length === 0) {
    console.log(`  ${PASS} All ${totalQueryHooks} query hooks reference options`);
    return {
      name: "Hook-Options Consistency",
      passed: true,
      details: `${totalQueryHooks} query hooks all use options`,
    };
  }

  for (const file of suspicious) {
    console.log(`  ${FAIL} Query hook without options reference: ${RED}${file}${RESET}`);
  }
  console.log(
    `  ${DIM}${totalQueryHooks - suspicious.length}/${totalQueryHooks} query hooks reference options${RESET}`,
  );
  return {
    name: "Hook-Options Consistency",
    passed: false,
    details: `Missing options ref: ${suspicious.join(", ")}`,
  };
}

async function checkWorkspaceConsistency(cfg: Required<AuditConfig>): Promise<CheckResult | null> {
  const { packagesDir, internalScope } = cfg.workspace;
  if (!internalScope) return null;

  header("4. Package.json Workspace Consistency");

  const pkgFiles = await findFiles(resolve(ROOT, packagesDir ?? "packages"), /^package\.json$/);

  const knownPackages = new Set<string>();
  for (const file of pkgFiles) {
    try {
      const pkg = JSON.parse(await readFile(file));
      if (pkg.name) knownPackages.add(pkg.name);
    } catch {}
  }

  const broken: { from: string; dep: string }[] = [];

  for (const file of pkgFiles) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(await readFile(file));
    } catch {
      continue;
    }
    const pkgName = (pkg.name as string) ?? basename(dirname(file));
    const allDeps: Record<string, string> = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    for (const [dep, version] of Object.entries(allDeps)) {
      if (dep.startsWith(internalScope) && String(version).includes("workspace")) {
        if (!knownPackages.has(dep)) broken.push({ from: pkgName, dep });
      }
    }
  }

  if (broken.length === 0) {
    console.log(`  ${PASS} All workspace dependencies resolve to existing packages`);
    return {
      name: "Workspace Consistency",
      passed: true,
      details: `${knownPackages.size} packages, all deps valid`,
    };
  }

  for (const { from, dep } of broken) {
    console.log(`  ${FAIL} ${RED}${from}${RESET} depends on ${RED}${dep}${RESET} which does not exist`);
  }
  return {
    name: "Workspace Consistency",
    passed: false,
    details: `${broken.length} broken dep(s): ${broken.map((b) => `${b.from}->${b.dep}`).join(", ")}`,
  };
}

async function checkClaudeMdCoverage(cfg: Required<AuditConfig>): Promise<CheckResult | null> {
  const { packagesDir } = cfg.workspace;
  const { contextFile } = cfg.docs;
  if (!contextFile) return null;

  header("5. Context File Coverage");

  const pkgFiles = await findFiles(resolve(ROOT, packagesDir ?? "packages"), /^package\.json$/);

  const packageDirs: { dir: string; name: string }[] = [];
  for (const file of pkgFiles) {
    const dir = dirname(file);
    const rel = relative(resolve(ROOT, packagesDir ?? "packages"), dir);
    if (rel.split("/").length > 3) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(await readFile(file));
    } catch {
      continue;
    }
    packageDirs.push({ dir, name: (pkg.name as string) ?? basename(dir) });
  }

  const missing: string[] = [];
  const present: string[] = [];

  for (const { dir, name } of packageDirs) {
    const hasDoc = await stat(resolve(dir, contextFile))
      .then(() => true)
      .catch(() => false);
    if (hasDoc) {
      present.push(name);
    } else {
      missing.push(name);
    }
  }

  if (missing.length === 0) {
    console.log(`  ${PASS} All ${packageDirs.length} packages have a ${contextFile}`);
    return {
      name: `${contextFile} Coverage`,
      passed: true,
      details: `${packageDirs.length}/${packageDirs.length} covered`,
    };
  }

  for (const name of present) console.log(`  ${PASS} ${name}`);
  for (const name of missing) {
    console.log(`  ${FAIL} Missing ${contextFile}: ${YELLOW}${name}${RESET}`);
  }
  console.log(`  ${DIM}${present.length}/${packageDirs.length} packages have ${contextFile}${RESET}`);
  return {
    name: `${contextFile} Coverage`,
    passed: false,
    details: `Missing: ${missing.join(", ")}`,
  };
}

async function checkArchitectureDrift(cfg: Required<AuditConfig>): Promise<CheckResult | null> {
  const { architectureFile, generateCommand, driftKeyFiles } = cfg.docs;
  if (!architectureFile || !driftKeyFiles?.length) return null;

  header("6. Architecture Reference Drift");

  const archPath = resolve(ROOT, architectureFile);
  const archExists = await stat(archPath)
    .then(() => true)
    .catch(() => false);

  if (!archExists) {
    console.log(`  ${FAIL} ${RED}${architectureFile}${RESET} does not exist`);
    if (generateCommand) console.log(`  ${DIM}Run: ${generateCommand}${RESET}`);
    return {
      name: "Architecture Reference Drift",
      passed: false,
      details: "File does not exist",
    };
  }

  const archContent = await readFile(archPath);
  const archMtime = await getMtime(archPath);
  const timestampMatch = archContent.match(/Generated:\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/);
  const generatedAt = timestampMatch ? timestampMatch[1] : null;

  const drifted: { file: string; fileMtime: Date }[] = [];
  for (const relPath of driftKeyFiles) {
    const fileMtime = await getMtime(resolve(ROOT, relPath));
    if (fileMtime > 0 && fileMtime > archMtime) {
      drifted.push({ file: relPath, fileMtime: new Date(fileMtime) });
    }
  }

  if (drifted.length === 0) {
    const info = generatedAt ? `generated ${generatedAt}` : "up to date";
    console.log(`  ${PASS} ${architectureFile} is up to date (${info})`);
    return { name: "Architecture Reference Drift", passed: true, details: info };
  }

  console.log(
    `  ${FAIL} ${architectureFile} is ${RED}stale${RESET}${generatedAt ? ` (generated ${generatedAt})` : ""}`,
  );
  for (const { file, fileMtime } of drifted) {
    console.log(`  ${DIM}  newer: ${file} (${fileMtime.toISOString()})${RESET}`);
  }
  if (generateCommand) console.log(`  ${DIM}Run: ${generateCommand}${RESET}`);
  return {
    name: "Architecture Reference Drift",
    passed: false,
    details: `${drifted.length} source file(s) newer than reference`,
  };
}

function printSummary(results: CheckResult[]): boolean {
  console.log(`\n${BOLD}${CYAN}${"═".repeat(60)}${RESET}`);
  console.log(`${BOLD}  Summary${RESET}`);
  console.log(`${CYAN}${"═".repeat(60)}${RESET}\n`);

  const nameWidth = 32;
  const statusWidth = 8;

  console.log(`  ${BOLD}${"Check".padEnd(nameWidth)}${"Status".padEnd(statusWidth)}Details${RESET}`);
  console.log(`  ${"─".repeat(nameWidth + statusWidth + 30)}`);

  for (const r of results) {
    const status = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const details = r.details.length > 50 ? `${r.details.slice(0, 47)}...` : r.details;
    console.log(
      `  ${r.name.padEnd(nameWidth)}${status}${"".padEnd(statusWidth - 4)}${DIM}${details}${RESET}`,
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(
    `\n  ${GREEN}${passed} passed${RESET}, ${failed > 0 ? `${RED}${failed} failed${RESET}` : `${GREEN}${failed} failed${RESET}`}`,
  );
  console.log("");
  return failed === 0;
}

async function main() {
  const config = await loadConfig(ROOT);

  console.log(`${BOLD}${CYAN}${config.project || "Project"} Health Checks${RESET}`);
  console.log(`${DIM}${new Date().toISOString()}${RESET}`);

  const maybeResults = await Promise.all([
    checkSchemaExports(config),
    checkRouteRegistration(config),
    checkHookOptionsConsistency(config),
    checkWorkspaceConsistency(config),
    checkClaudeMdCoverage(config),
    checkArchitectureDrift(config),
  ]);

  const results = maybeResults.filter((r): r is CheckResult => r !== null);
  const allPassed = printSummary(results);
  process.exit(allPassed ? 0 : 1);
}

main();
