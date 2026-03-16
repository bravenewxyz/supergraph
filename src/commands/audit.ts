import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, relative } from "node:path";
import { Glob } from "bun";

import { discoverPackages, findMonorepoRoot } from "../monorepo.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  accent: "\x1b[38;2;201;240;107m",
};

// Embed dashboard templates so they're available in compiled binaries
import DASHBOARD_INDEX_HTML from "../../packages/dashboard/index.html" with { type: "text" };
import DASHBOARD_GRAPH_HTML from "../../packages/dashboard/graph.html" with { type: "text" };

// Language driver abstraction
import { detectLanguage } from "../../packages/graph/src/cli/lang/index.js";
import type { LanguageDriver } from "../../packages/graph/src/cli/lang/index.js";

// TS-only flow tools (imported lazily via direct imports since they're always TS)
import { runSchemaMatch } from "../../packages/flow/src/cli/schema-match.js";
import { runTrace } from "../../packages/flow/src/cli/trace.js";
import { runLogicAudit } from "../../packages/flow/src/cli/logic-audit/index.js";
import { runContracts } from "../../packages/flow/src/cli/contracts.js";
import { runInvariantDiscover } from "../../packages/flow/src/cli/invariant.js";

// Cross-package tools
import { runAggregate } from "../../packages/scripts/supergraph.js";
import { runPkgGraph } from "../../packages/scripts/pkg-graph.js";
import { runCrossLangBridge } from "../../packages/scripts/cross-lang-bridge.js";
import { runNormagraph } from "../../packages/scripts/normagraph.js";

// UI
import { startAnimation } from "../ui/graph-animation.js";
import type { AnimationHandle } from "../ui/graph-animation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolRun = {
  label: string;
  phase: string;
  run: () => Promise<void>;
  checkFile: string;
  extraFiles?: string[];
  json?: boolean;
};

type RunResult = {
  tool: ToolRun;
  ok: boolean;
  elapsed: string;
  size?: string;
  error?: string;
};

type PkgTarget = {
  srcDir: string;
  pkgName: string;
  outDir: string;
  invDir: string;
  jsonDir: string;
  driver: LanguageDriver;
};

// ---------------------------------------------------------------------------
// Gitignore helper
// ---------------------------------------------------------------------------

async function ensureGitignore(root: string): Promise<void> {
  const gitignorePath = join(root, ".gitignore");
  try {
    const content = await readFile(gitignorePath, "utf-8");
    const lines = content.split("\n");
    if (lines.some(l => l.trim() === "audit/" || l.trim() === "audit")) return;
    await appendFile(gitignorePath, `${content.endsWith("\n") ? "" : "\n"}audit/\n`);
  } catch {
    // No .gitignore exists — create one
    await writeFile(gitignorePath, "audit/\n");
  }
}

// ---------------------------------------------------------------------------
// Name derivation
// ---------------------------------------------------------------------------

function derivePkgName(p: string, driver: LanguageDriver): string {
  const normalized = p.replace(/\/+$/, "");
  const parts = normalized.split("/");

  if (driver.id === "go") {
    const last = parts[parts.length - 1]!;
    const secondLast = parts.length >= 2 ? parts[parts.length - 2] : null;
    if (secondLast && secondLast !== "go-packages")
      return `go-${secondLast}-${last}`;
    return `go-${last}`;
  }

  const srcIdx = parts.lastIndexOf("src");
  if (srcIdx <= 0) {
    const last = parts[parts.length - 1]!;
    const secondLast = parts.length >= 2 ? parts[parts.length - 2] : null;
    if (secondLast && secondLast !== "packages") return `${secondLast}-${last}`;
    return last;
  }
  const parent = parts[srcIdx - 1]!;
  const grandparent = srcIdx >= 2 ? parts[srcIdx - 2] : null;
  if (grandparent && grandparent !== "packages") {
    return `${grandparent}-${parent}`;
  }
  return parent;
}

// Package discovery moved to ../monorepo.ts — see discoverPackages, findMonorepoRoot

async function discoverGoPackages(goPackagesDir: string): Promise<string[]> {
  const goDirs: string[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 2) return;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasGoMod = entries.some((e) => e.isFile() && e.name === "go.mod");
    if (hasGoMod) {
      goDirs.push(dir);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (
        e.name === "vendor" ||
        e.name === "testdata" ||
        e.name === "node_modules"
      )
        continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }

  await walk(goPackagesDir, 0);
  return goDirs.sort();
}

async function isGoPackage(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, "go.mod"));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Job builders
// ---------------------------------------------------------------------------

function buildCoreTools(t: PkgTarget): ToolRun[] {
  const { srcDir, outDir, jsonDir, driver } = t;
  const suffix = driver.id === "typescript" ? "" : ` (${driver.name})`;
  return [
    {
      label: `structural map${suffix}`,
      phase: "1",
      run: () => driver.map({ srcRoot: srcDir, format: "text", comments: driver.id === "typescript", outPath: `${outDir}/map.txt` }).then(() => {}),
      checkFile: `${outDir}/map.txt`,
      extraFiles: [`${outDir}/deps.txt`, `${outDir}/imports.txt`],
    },
    {
      label: `structural map${suffix}`,
      phase: "1",
      run: () => driver.map({ srcRoot: srcDir, format: "json", outPath: `${jsonDir}/map.json` }).then(() => {}),
      checkFile: `${jsonDir}/map.json`,
      json: true,
    },
    {
      label: `complexity${suffix}`,
      phase: "2",
      run: () => driver.complexity({ srcRoot: srcDir, outPath: `${outDir}/complexity.txt` }).then(() => {}),
      checkFile: `${outDir}/complexity.txt`,
    },
    {
      label: `dead export detection${suffix}`,
      phase: "2",
      run: () => driver.deadExports({ srcRoot: srcDir, outPath: `${outDir}/dead.txt` }).then(() => {}),
      checkFile: `${outDir}/dead.txt`,
    },
  ];
}

function buildTsOnlyTools(t: PkgTarget): ToolRun[] {
  const { srcDir, outDir, invDir, jsonDir } = t;
  return [
    {
      label: "schema ↔ type mismatches",
      phase: "5",
      run: () => runSchemaMatch({ srcDir, format: "text", outFile: `${outDir}/schema-match.txt` }).then(() => {}),
      checkFile: `${outDir}/schema-match.txt`,
    },
    {
      label: "schema ↔ type mismatches",
      phase: "5",
      run: () => runSchemaMatch({ srcDir, format: "json", outFile: `${jsonDir}/schema-match.json` }).then(() => {}),
      checkFile: `${jsonDir}/schema-match.json`,
      json: true,
    },
    {
      label: "FE↔BE contracts",
      phase: "5",
      run: () => runContracts({ srcDir, format: "text", outFile: `${outDir}/contracts.txt` }).then(() => {}),
      checkFile: `${outDir}/contracts.txt`,
    },
    {
      label: "FE↔BE contracts",
      phase: "5",
      run: () => runContracts({ srcDir, format: "json", outFile: `${jsonDir}/contracts.json` }).then(() => {}),
      checkFile: `${jsonDir}/contracts.json`,
      json: true,
    },
    {
      label: "serialization boundaries",
      phase: "5",
      run: () => runTrace({ srcDir, boundariesOnly: true, format: "text", outFile: `${outDir}/trace-boundaries.txt` }).then(() => {}),
      checkFile: `${outDir}/trace-boundaries.txt`,
    },
    {
      label: "serialization boundaries",
      phase: "5",
      run: () => runTrace({ srcDir, boundariesOnly: true, format: "json", outFile: `${jsonDir}/trace-boundaries.json` }).then(() => {}),
      checkFile: `${jsonDir}/trace-boundaries.json`,
      json: true,
    },
    {
      label: "logic audit",
      phase: "6",
      run: () => runLogicAudit({ srcDir, format: "text", outFile: `${outDir}/logic-audit.txt` }).then(() => {}),
      checkFile: `${outDir}/logic-audit.txt`,
    },
    {
      label: "logic audit",
      phase: "6",
      run: () => runLogicAudit({ srcDir, format: "json", outFile: `${jsonDir}/logic-audit.json` }).then(() => {}),
      checkFile: `${jsonDir}/logic-audit.json`,
      json: true,
    },
    {
      label: "invariant discovery",
      phase: "7",
      run: () => runInvariantDiscover({ srcDir, format: "compact", suggestExtractions: true, outFile: `${invDir}/discovery.txt` }).then(() => {}),
      checkFile: `${invDir}/discovery.txt`,
    },
    {
      label: "invariant discovery",
      phase: "7",
      run: () => runInvariantDiscover({ srcDir, format: "json", suggestExtractions: true, outFile: `${jsonDir}/discovery.json` }).then(() => {}),
      checkFile: `${jsonDir}/discovery.json`,
      json: true,
    },
  ];
}

function buildTools(t: PkgTarget): ToolRun[] {
  const tools = buildCoreTools(t);
  if (t.driver.id === "typescript") {
    tools.push(...buildTsOnlyTools(t));
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Runner + reporting
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${(ms / 1000).toFixed(0)}s`)), ms),
    ),
  ]);
}

/** Suppress all console/stderr output from tools while animation is active */
function muteConsole(): () => void {
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const origStderrWrite = process.stderr.write;
  const noop = () => {};
  console.log = noop;
  console.error = noop;
  console.warn = noop;
  process.stderr.write = () => true;
  return () => {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    process.stderr.write = origStderrWrite;
  };
}

/** Read a single keypress from the TTY. Returns the key character. */
function waitForKeypress(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
      // Non-interactive — don't block
      resolve("\n");
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.ref();
    const onData = (key: Buffer) => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.unref();
      if (key[0] === 0x03) { resolve("q"); return; } // Ctrl+C
      resolve(String.fromCharCode(key[0]!));
    };
    process.stdin.on("data", onData);
  });
}

async function fileSizeKB(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${(s.size / 1024).toFixed(0)} KB`;
  } catch {
    return "? KB";
  }
}

async function runTools(tools: ToolRun[], muted: boolean, concurrency = 3): Promise<RunResult[]> {
  const unmute = muted ? muteConsole() : undefined;
  try {
    const results: RunResult[] = new Array(tools.length);
    let nextIdx = 0;

    async function worker() {
      while (nextIdx < tools.length) {
        const idx = nextIdx++;
        const tool = tools[idx]!;
        const t0 = Date.now();
        const TOOL_TIMEOUT = 600_000;
        try {
          await withTimeout(tool.run(), TOOL_TIMEOUT, tool.label);
          const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
          const size = await fileSizeKB(tool.checkFile);
          results[idx] = { tool, ok: true, elapsed, size };
        } catch (err) {
          const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
          const msg = err instanceof Error ? err.message : String(err);
          results[idx] = { tool, ok: false, elapsed, error: msg };
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, tools.length) }, () => worker());
    await Promise.all(workers);
    return results;
  } finally {
    unmute?.();
  }
}

/** Collect all results across packages for the final summary */
const allResults: { pkgName: string; results: RunResult[] }[] = [];

function reportResults(results: RunResult[], pkgName: string, anim?: AnimationHandle): number {
  let failures = 0;

  if (anim) {
    for (const r of results) {
      const kind = r.tool.json ? " (json)" : "";
      if (r.ok) {
        anim.log(`  ✓  ${pkgName}  ${r.tool.label}${kind}  ${r.size ?? ""}  (${r.elapsed})`);
      } else {
        failures++;
        anim.log(`  ✗  ${pkgName}  ${r.tool.label}${kind}  FAILED  (${r.elapsed})`);
      }
    }
    const ok = results.filter((r) => r.ok).length;
    anim.update(`${pkgName}: ${ok}/${results.length} tools${failures > 0 ? `, ${failures} failed` : ""}`);
    return failures;
  }

  // --no-anim: merge text+json results by label, colorize
  const merged = new Map<string, { text?: RunResult; json?: RunResult }>();
  for (const r of results) {
    const key = r.tool.label;
    const entry = merged.get(key) ?? {};
    if (r.tool.json) entry.json = r; else entry.text = r;
    merged.set(key, entry);
  }

  for (const [label, { text, json }] of merged) {
    const primary = text ?? json!;
    const ok = (text?.ok ?? true) && (json?.ok ?? true);
    const time = text?.elapsed ?? json?.elapsed ?? "";
    const extras = text?.tool.extraFiles?.map((f) => basename(f)).join(", ");

    if (ok) {
      let sizeStr = text?.size ?? "";
      if (json?.size && json.size !== "0 KB") sizeStr += `${C.dim} + ${json.size} json${C.reset}`;
      const note = extras ? `  ${C.dim}→ ${extras}${C.reset}` : "";
      console.log(
        `  ${C.green}✓${C.reset}  ${label.padEnd(28)} ${sizeStr.padStart(8)}  ${C.dim}${time}${C.reset}${note}`,
      );
    } else {
      failures++;
      const failedPart = !text?.ok ? text : json;
      console.log(
        `  ${C.red}✗${C.reset}  ${label.padEnd(28)} ${C.red}FAILED${C.reset}  ${C.dim}${time}${C.reset}`,
      );
      if (failedPart?.error) {
        const preview = failedPart.error.split("\n").slice(0, 2).join(`\n     `);
        console.log(`     ${C.dim}${preview}${C.reset}`);
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Dashboard generation
// ---------------------------------------------------------------------------

const JSON_KEYS = [
  { key: "map", file: "map.json" },
  { key: "contracts", file: "contracts.json" },
  { key: "schema-match", file: "schema-match.json" },
  { key: "logic-audit", file: "logic-audit.json" },
  { key: "trace-boundaries", file: "trace-boundaries.json" },
  { key: "discovery", file: "discovery.json" },
];

async function loadPayload(jsonDir: string): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {};
  for (const { key, file } of JSON_KEYS) {
    try {
      payload[key] = JSON.parse(await readFile(`${jsonDir}/${file}`, "utf-8"));
    } catch {
      payload[key] = null;
    }
  }
  return payload;
}

const DASHBOARD_TEMPLATES: Record<string, string> = {
  "index.html": DASHBOARD_INDEX_HTML,
  "graph.html": DASHBOARD_GRAPH_HTML,
};

async function injectTemplate(
  templateFile: string,
  payload: Record<string, unknown>,
  outPath: string,
): Promise<boolean> {
  try {
    const template = DASHBOARD_TEMPLATES[templateFile];
    if (!template) throw new Error(`Unknown template: ${templateFile}`);
    const injected = template.replace(
      '<script id="__AUDIT_DATA__" type="application/json">null</script>',
      `<script id="__AUDIT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`,
    );
    await writeFile(outPath, injected);
    return true;
  } catch (err) {
    console.error(`  ✗  ${templateFile} generation failed: ${err}`);
    return false;
  }
}

async function buildDashboards(
  t: PkgTarget,
): Promise<{ dash: boolean; graph: boolean }> {
  const payload = await loadPayload(t.jsonDir);
  const [dash, graph] = await Promise.all([
    injectTemplate("index.html", payload, `${t.outDir}/dashboard.html`),
    injectTemplate("graph.html", payload, `${t.outDir}/graph.html`),
  ]);
  return { dash, graph };
}

// ---------------------------------------------------------------------------
// Collision check
// ---------------------------------------------------------------------------

function checkCollisions(targets: PkgTarget[]): void {
  const seen = new Map<string, string>();
  for (const t of targets) {
    const existing = seen.get(t.pkgName);
    if (existing) {
      console.error(`Name collision: "${t.pkgName}" derived from both:`);
      console.error(`  1. ${existing}`);
      console.error(`  2. ${t.srcDir}`);
      console.error(`\nFix: rename one package or pass explicit paths.`);
      process.exit(1);
    }
    seen.set(t.pkgName, t.srcDir);
  }
}

// ---------------------------------------------------------------------------
// Per-package audit (unified)
// ---------------------------------------------------------------------------

async function auditPackage(t: PkgTarget, anim?: AnimationHandle): Promise<number> {
  const langLabel = t.driver.id === "typescript" ? "" : `  (${t.driver.name})`;
  if (anim) {
    anim.update(`auditing ${t.pkgName}...`);
  } else {
    const bar = "━".repeat(56);
    console.log(`\n${C.dim}━━${C.reset} ${C.bold}${t.pkgName}${C.reset}${langLabel} ${C.dim}${bar.slice(0, Math.max(1, 56 - t.pkgName.length))}${C.reset}`);
  }

  // Clean previous outputs so stale artifacts don't persist across runs
  await rm(t.outDir, { recursive: true, force: true });
  await mkdir(t.outDir, { recursive: true });
  await mkdir(t.invDir, { recursive: true });
  await mkdir(t.jsonDir, { recursive: true });

  const tools = buildTools(t);
  if (anim) {
    anim.update(`${t.pkgName}: ${tools.length} tools running...`);
  }
  const results = await runTools(tools, true);
  allResults.push({ pkgName: t.pkgName, results });
  const failures = reportResults(results, t.pkgName, anim);

  // Dashboards only for TS packages (they use flow-tool JSON)
  if (t.driver.id === "typescript") {
    anim?.update(`${t.pkgName}: building dashboards...`);
    const { dash, graph } = await buildDashboards(t);
    if (!anim) {
      const outputs = [`${C.dim}→ ${t.outDir}/${C.reset}`];
      if (dash) outputs.push(`${C.cyan}dashboard.html${C.reset}`);
      if (graph) outputs.push(`${C.cyan}graph.html${C.reset}`);
      console.log(`  ${outputs.join("  ")}`);
    }
  } else if (!anim) {
    console.log(`  ${C.dim}→ ${t.outDir}/${C.reset}`);
  }
  if (failures > 0 && !anim) console.log(`  ${C.yellow}⚠  ${failures} tool(s) failed${C.reset}`);

  return failures;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAuditPipeline(args: string[]): Promise<void> {
  const showHelp = args.includes("--help") || args.includes("-h");
  const skipGo = args.includes("--no-go");
  const goOnly = args.includes("--go-only");

  if (showHelp) {
    console.log(`supergraph — full audit pipeline

Usage:
  supergraph                            Auto-detect monorepo packages and audit all
  supergraph <dir> [...]                Audit specific package(s) (auto-detects language)
  supergraph --no-go                    Skip Go packages
  supergraph --go-only                  Only audit Go packages
  supergraph --no-anim                  Disable terminal animation
  supergraph --root <path>              Target repo root (default: cwd)
  supergraph --help                     Show this help`);
    process.exit(0);
  }

  // Parse --root (when omitted, walk up from cwd to find monorepo root)
  const rootIdx = args.indexOf("--root");
  const ROOT =
    rootIdx >= 0 && args[rootIdx + 1]
      ? resolve(args[rootIdx + 1]!)
      : await findMonorepoRoot(process.cwd());

  const devtoolsRoot = resolve(import.meta.dir, "../..");

  // Ensure audit/ is in .gitignore
  await ensureGitignore(ROOT);

  // Filter out flags and their values to get explicit dirs
  const explicitDirs = args.filter((a, i) => {
    if (a.startsWith("--")) return false;
    const prev = args[i - 1];
    if (prev === "--root") return false;
    return true;
  });

  // Partition explicit dirs by detected language
  const explicitGoDirs: string[] = [];
  const explicitTsDirs: string[] = [];
  if (explicitDirs.length > 0) {
    for (const d of explicitDirs) {
      if (await isGoPackage(resolve(ROOT, d))) {
        explicitGoDirs.push(resolve(ROOT, d));
      } else {
        explicitTsDirs.push(d);
      }
    }
  }

  // Import drivers lazily to get references for target construction
  const { goDriver } = await import("../../packages/graph/src/cli/lang/go-driver.js");
  const { tsDriver } = await import("../../packages/graph/src/cli/lang/ts-driver.js");

  // -----------------------------------------------------------------------
  // Discover all packages BEFORE starting animation (so we have real names)
  // -----------------------------------------------------------------------
  let tsTargets: PkgTarget[] = [];
  let goTargets: PkgTarget[] = [];

  if (!goOnly && !(explicitDirs.length > 0 && explicitTsDirs.length === 0)) {
    let srcDirs: string[];
    if (explicitTsDirs.length > 0) {
      srcDirs = explicitTsDirs;
    } else if (explicitDirs.length === 0) {
      srcDirs = await discoverPackages(ROOT);
      if (srcDirs.length === 0) {
        console.error(
          "No packages found. Checked workspace configs (package.json workspaces, pnpm-workspace.yaml, lerna.json, rush.json, nx.json, turbo.json, .moon/workspace.yml), tsconfig.json project references, common directories (packages/, apps/, libs/, modules/, services/), and root src/.\nPass explicit src dirs or run from a monorepo root.",
        );
        process.exit(1);
      }
    } else {
      srcDirs = [];
    }

    if (srcDirs.length > 0) {
      tsTargets = srcDirs.map((srcDir) => {
        const pkgName = derivePkgName(srcDir, tsDriver);
        const outDir = `audit/packages/${pkgName}`;
        return {
          srcDir,
          pkgName,
          outDir,
          invDir: `${outDir}/invariants`,
          jsonDir: `${outDir}/json`,
          driver: tsDriver,
        };
      });
      checkCollisions(tsTargets);
    }
  }

  if (!skipGo) {
    let goDirs: string[] = [];
    if (explicitGoDirs.length > 0) {
      goDirs = explicitGoDirs;
    } else if (explicitDirs.length === 0) {
      const goPackagesDir = resolve(ROOT, "go-packages");
      try {
        await stat(goPackagesDir);
        goDirs = await discoverGoPackages(goPackagesDir);
      } catch {
        // go-packages/ doesn't exist — skip silently
      }
    }
    if (goDirs.length > 0) {
      goTargets = goDirs.map((goDir) => {
        const pkgName = derivePkgName(goDir, goDriver);
        const outDir = `audit/packages/${pkgName}`;
        return {
          srcDir: goDir,
          pkgName,
          outDir,
          invDir: `${outDir}/invariants`,
          jsonDir: `${outDir}/json`,
          driver: goDriver,
        };
      });
    }
  }

  // -----------------------------------------------------------------------
  // Start animation with real package names + dependency edges
  // -----------------------------------------------------------------------
  const allTargets = [...tsTargets, ...goTargets];
  const allPkgNames = allTargets.map((t) => t.pkgName);

  // Build real dependency edges by reading package.json files
  const pkgEdges: [number, number][] = [];
  const pkgNameToIdx = new Map(allPkgNames.map((n, i) => [n, i]));
  for (let i = 0; i < allTargets.length; i++) {
    const t = allTargets[i]!;
    // srcDir is like /path/packages/foo/src — go up one to get package root
    const pkgJsonPath = join(t.srcDir, "..", "package.json");
    try {
      const pkg = JSON.parse(await readFile(pkgJsonPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const depName of Object.keys(allDeps)) {
        // Match dep name to our package names (e.g., "@scope/core" → "core")
        const shortName = depName.split("/").pop()!;
        const targetIdx = pkgNameToIdx.get(shortName);
        if (targetIdx !== undefined && targetIdx !== i) {
          pkgEdges.push([i, targetIdx]);
        }
      }
    } catch {
      // No package.json or not parseable — skip
    }
  }

  const isTTY = process.stdout.isTTY && !args.includes("--no-anim");
  const anim = isTTY ? startAnimation({ packages: allPkgNames, edges: pkgEdges }) : undefined;

  // Ensure animation subprocess is cleaned up on Ctrl+C
  if (anim) {
    const cleanup = () => {
      anim.stop();
      // Give subprocess a moment to restore terminal, then exit
      setTimeout(() => process.exit(0), 100);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }

  let totalFailures = 0;

  // -----------------------------------------------------------------------
  // TypeScript packages
  // -----------------------------------------------------------------------
  if (tsTargets.length > 0) {
    anim?.update(`scanning ${tsTargets.length} TS packages...`);
    if (!anim) {
      console.log(`\n${C.accent}supergraph${C.reset} ${C.dim}·${C.reset} ${tsTargets.length} package${tsTargets.length > 1 ? "s" : ""} found\n`);
      for (const t of tsTargets) {
        console.log(`  ${C.bold}${t.pkgName.padEnd(24)}${C.reset}  ${C.dim}${t.srcDir}${C.reset}`);
      }
    }

    for (const t of tsTargets) {
      totalFailures += await auditPackage(t, anim);
    }
  }

  // -----------------------------------------------------------------------
  // Go packages
  // -----------------------------------------------------------------------
  if (goTargets.length > 0) {
    anim?.update(`scanning ${goTargets.length} Go packages...`);
    if (!anim) {
      console.log(`\n${C.accent}go packages${C.reset} ${C.dim}·${C.reset} ${goTargets.length} found\n`);
      for (const t of goTargets) {
        console.log(`  ${C.bold}${t.pkgName.padEnd(24)}${C.reset}  ${C.dim}${t.srcDir}${C.reset}`);
      }
    }

    for (const t of goTargets) {
      totalFailures += await auditPackage(t, anim);
    }
  }

  // -----------------------------------------------------------------------
  // Cross-package views
  // -----------------------------------------------------------------------
  anim?.update("cross-package analysis...");

  // Clean stale top-level cross-package artifacts
  const AUDIT_DIR = resolve(ROOT, "audit");
  const STALE_ARTIFACTS = [
    "supergraph.html", "pkg-graph.html",
    "supergraph.txt", "supergraph-compact.txt",
    "symbols-full.txt", "symbols.txt", "issues.txt",
  ];
  await Promise.all(STALE_ARTIFACTS.map(f => rm(join(AUDIT_DIR, f), { force: true })));

  const unmuteCross = muteConsole();
  const CROSS_TIMEOUT = 600_000;
  const crossResults = await Promise.allSettled([
    withTimeout(runPkgGraph({ root: ROOT }), CROSS_TIMEOUT, "pkg-graph"),
    withTimeout(runAggregate({ root: ROOT }), CROSS_TIMEOUT, "aggregate"),
    withTimeout(runCrossLangBridge({ root: ROOT }), CROSS_TIMEOUT, "cross-lang-bridge"),
    withTimeout(runNormagraph({ root: ROOT, detail: "full" }), CROSS_TIMEOUT, "hypergraph"),
    withTimeout(runNormagraph({ root: ROOT, detail: "brief" }), CROSS_TIMEOUT, "normagraph"),
  ]);
  unmuteCross();

  // Generate superhigh outputs (full + shortcut)
  anim?.update("generating superhigh...");
  const spawnIO = "pipe" as const;

  // Use process.execPath for compiled binary support, fall back to bun for dev
  const superhighScript = resolve(devtoolsRoot, "packages", "scripts", "superhigh.ts");
  const isCompiledBinary = !process.execPath.includes("bun");
  const spawnCmd = isCompiledBinary
    ? [process.execPath, "superhigh"]  // compiled: call self with subcommand
    : ["bun", superhighScript];         // dev: run script directly

  const SPAWN_TIMEOUT = 600_000;
  const superhighResults = await Promise.allSettled([
    withTimeout((async () => {
      const proc = Bun.spawn([...spawnCmd, "--full", "--root", ROOT], {
        cwd: ROOT, stdout: spawnIO, stderr: "pipe",
      });
      if (spawnIO === "pipe") {
        for await (const _ of proc.stdout) { /* drain */ }
      }
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`superhigh --full exited with ${code}${stderr ? `\n${stderr.trim()}` : ""}`);
      }
    })(), SPAWN_TIMEOUT, "superhigh --full"),
    withTimeout((async () => {
      const proc = Bun.spawn([...spawnCmd, "--root", ROOT], {
        cwd: ROOT, stdout: spawnIO, stderr: "pipe",
      });
      if (spawnIO === "pipe") {
        for await (const _ of proc.stdout) { /* drain */ }
      }
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`superhigh shortcut exited with ${code}${stderr ? `\n${stderr.trim()}` : ""}`);
      }
    })(), SPAWN_TIMEOUT, "superhigh shortcut"),
  ]);

  // -----------------------------------------------------------------------
  // Tally failures (while animation still runs)
  // -----------------------------------------------------------------------
  const crossToolNames = ["pkg-graph", "aggregate", "cross-lang-bridge", "symbols-full", "symbols"];
  const crossFailures: string[] = [];
  for (let i = 0; i < crossResults.length; i++) {
    const r = crossResults[i]!;
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      crossFailures.push(`  ✗  ${crossToolNames[i]}: ${msg}`);
    }
  }

  const superhighFailures: string[] = [];
  const superhighNames = ["supergraph.txt", "supergraph-compact.txt"];
  for (let i = 0; i < superhighResults.length; i++) {
    const r = superhighResults[i]!;
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      superhighFailures.push(`  ✗  ${superhighNames[i]}: ${msg}`);
    }
  }

  const totalProblems = totalFailures + crossFailures.length + superhighFailures.length;
  const supergraphHtml = resolve(ROOT, "audit/supergraph.html");
  const htmlExists = await stat(supergraphHtml).then(() => true).catch(() => false);

  if (!anim) {
    console.log(`\n${C.dim}━━${C.reset} ${C.bold}cross-package${C.reset} ${C.dim}${"━".repeat(43)}${C.reset}`);
    const crossLabels = ["pkg-graph", "supergraph", "cross-lang-bridge", "symbols-full", "symbols"];
    for (let i = 0; i < crossResults.length; i++) {
      const r = crossResults[i]!;
      const label = crossLabels[i]!;
      if (r.status === "fulfilled") {
        console.log(`  ${C.green}✓${C.reset}  ${label}`);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.log(`  ${C.red}✗${C.reset}  ${label}  ${C.dim}${msg.split("\n")[0]}${C.reset}`);
      }
    }
    const shLabels = ["supergraph.txt", "supergraph-compact.txt"];
    for (let i = 0; i < superhighResults.length; i++) {
      const r = superhighResults[i]!;
      if (r.status === "fulfilled") {
        console.log(`  ${C.green}✓${C.reset}  ${shLabels[i]}`);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.log(`  ${C.red}✗${C.reset}  ${shLabels[i]}  ${C.dim}${msg.split("\n")[0]}${C.reset}`);
      }
    }
    console.log(`  ${C.dim}→ audit/${C.reset}`);
  }

  // -----------------------------------------------------------------------
  // Interactive wait — animation keeps running, user can press o or enter
  // -----------------------------------------------------------------------
  if (anim) {
    const promptParts: string[] = [];
    if (htmlExists) promptParts.push("press o to open supergraph.html");
    promptParts.push("enter to exit");
    const promptSuffix = promptParts.join(" · ");

    if (totalProblems === 0) {
      anim.update(`done — ${promptSuffix}`);
    } else {
      anim.update(`done (${totalProblems} issue${totalProblems > 1 ? "s" : ""}) — ${promptSuffix}`);
    }

    const key = await waitForKeypress();

    if ((key === "o" || key === "O") && htmlExists) {
      const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
      try {
        Bun.spawn([openCmd, supergraphHtml], { stdout: "ignore", stderr: "ignore" });
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }

    anim.stop();
  }

  // -----------------------------------------------------------------------
  // Summary (printed after animation clears)
  // -----------------------------------------------------------------------
  const pkgsWithFailures = allResults.filter((p) => p.results.some((r) => !r.ok));

  const totalPkgs = tsTargets.length + goTargets.length;

  if (totalProblems === 0) {
    console.log(`\n${C.dim}${"═".repeat(60)}${C.reset}`);
    console.log(`${C.green}${C.bold}All ${totalPkgs} package(s) audited successfully.${C.reset}`);
    if (htmlExists) {
      console.log(`\n  ${C.cyan}open audit/supergraph.html${C.reset}`);
    }
    console.log(`${C.dim}${"═".repeat(60)}${C.reset}`);
    process.exit(0);
  } else {
    console.log(`\n${C.dim}${"═".repeat(60)}${C.reset}`);

    if (pkgsWithFailures.length > 0) {
      console.log(`\n${C.red}${C.bold}Tool failures:${C.reset}\n`);
      for (const pkg of pkgsWithFailures) {
        const failed = pkg.results.filter((r) => !r.ok);
        console.log(`  ${C.bold}${pkg.pkgName}${C.reset} ${C.dim}(${failed.length} failed)${C.reset}`);
        for (const r of failed) {
          console.log(`    ${C.red}✗${C.reset}  ${r.tool.label}`);
          if (r.error) {
            const preview = r.error.split("\n")[0];
            console.log(`       ${C.dim}${preview}${C.reset}`);
          }
        }
      }
    }

    if (crossFailures.length > 0) {
      console.log(`\n${C.red}${C.bold}Cross-package failures:${C.reset}\n`);
      for (const f of crossFailures) console.error(f);
    }

    if (superhighFailures.length > 0) {
      console.log(`\n${C.red}${C.bold}Superhigh failures:${C.reset}\n`);
      for (const f of superhighFailures) console.error(f);
    }

    console.log(`\n${C.yellow}${totalProblems} issue(s)${C.reset} across ${totalPkgs} package(s)`);
    if (htmlExists) {
      console.log(`\n  ${C.cyan}open audit/supergraph.html${C.reset}`);
    }
    console.log(`${C.dim}${"═".repeat(60)}${C.reset}`);

    process.exit(1);
  }
}
