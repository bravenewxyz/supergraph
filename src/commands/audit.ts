import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// Language driver abstraction
import { detectLanguage } from "../../graph/src/cli/lang/index.js";
import type { LanguageDriver } from "../../graph/src/cli/lang/index.js";

// TS-only flow tools (imported lazily via direct imports since they're always TS)
import { runSchemaMatch } from "../../flow/src/cli/schema-match.js";
import { runTrace } from "../../flow/src/cli/trace.js";
import { runLogicAudit } from "../../flow/src/cli/logic-audit.js";
import { runContracts } from "../../flow/src/cli/contracts.js";
import { runInvariantDiscover } from "../../flow/src/cli/invariant.js";

// Cross-package tools
import { runAggregate } from "../../scripts/supergraph.js";
import { runPkgGraph } from "../../scripts/pkg-graph.js";
import { runCrossLangBridge } from "../../scripts/cross-lang-bridge.js";

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

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------

async function discoverPackages(packagesDir: string): Promise<string[]> {
  const srcDirs: string[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 3) return;
    const entries = await readdir(dir, { withFileTypes: true });
    const hasSrc = entries.some((e) => e.isDirectory() && e.name === "src");
    if (hasSrc) {
      srcDirs.push(join(dir, "src"));
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".next")
        continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }

  await walk(packagesDir, 0);
  return srcDirs.sort();
}

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

async function fileSizeKB(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${(s.size / 1024).toFixed(0)} KB`;
  } catch {
    return "? KB";
  }
}

async function runTools(tools: ToolRun[]): Promise<RunResult[]> {
  return Promise.all(
    tools.map(async (tool): Promise<RunResult> => {
      const t0 = Date.now();
      try {
        await tool.run();
        const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
        const size = await fileSizeKB(tool.checkFile);
        return { tool, ok: true, elapsed, size };
      } catch (err) {
        const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
        return { tool, ok: false, elapsed, error: String(err) };
      }
    }),
  );
}

function reportResults(results: RunResult[], anim?: AnimationHandle): number {
  let failures = 0;
  for (const r of results) {
    if (r.ok) {
      // silent when animated — results shown after animation stops
    } else {
      failures++;
    }
  }
  if (anim) {
    const ok = results.filter((r) => r.ok).length;
    anim.update(`${ok}/${results.length} tools completed${failures > 0 ? `, ${failures} failed` : ""}`);
  } else {
    for (const r of results) {
      const kind = r.tool.json ? " (json)" : "       ";
      if (r.ok) {
        const extras = r.tool.extraFiles?.map((f) => basename(f)).join(", ");
        const note = extras ? `  → also ${extras}` : "";
        console.log(
          `  ✓  Phase ${r.tool.phase}${kind}  ${r.tool.label.padEnd(30)}  ${(r.size ?? "").padStart(7)}  (${r.elapsed})${note}`,
        );
      } else {
        console.error(
          `  ✗  Phase ${r.tool.phase}${kind}  ${r.tool.label.padEnd(30)}  FAILED  (${r.elapsed})`,
        );
        if (r.error) {
          const preview = r.error.split("\n").slice(0, 3).join("\n         ");
          console.error(`         ${preview}`);
        }
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

async function injectTemplate(
  devtoolsRoot: string,
  templateFile: string,
  payload: Record<string, unknown>,
  outPath: string,
): Promise<boolean> {
  try {
    const template = await readFile(
      resolve(devtoolsRoot, "dashboard", templateFile),
      "utf-8",
    );
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
  devtoolsRoot: string,
  t: PkgTarget,
): Promise<{ dash: boolean; graph: boolean }> {
  // Dashboard templates aren't available in compiled binaries (not embedded by bundler)
  const templateDir = resolve(devtoolsRoot, "dashboard");
  if (!existsSync(templateDir)) return { dash: false, graph: false };

  const payload = await loadPayload(t.jsonDir);
  const [dash, graph] = await Promise.all([
    injectTemplate(devtoolsRoot, "index.html", payload, `${t.outDir}/dashboard.html`),
    injectTemplate(devtoolsRoot, "graph.html", payload, `${t.outDir}/graph.html`),
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

async function auditPackage(devtoolsRoot: string, t: PkgTarget, anim?: AnimationHandle): Promise<number> {
  const langLabel = t.driver.id === "typescript" ? "" : `  (${t.driver.name})`;
  if (anim) {
    anim.update(`auditing ${t.pkgName}...`);
  } else {
    console.log(`\n${"━".repeat(60)}`);
    console.log(`  ${t.pkgName}  ←  ${t.srcDir}${langLabel}`);
    console.log(`${"━".repeat(60)}`);
  }

  await mkdir(t.outDir, { recursive: true });
  await mkdir(t.invDir, { recursive: true });
  await mkdir(t.jsonDir, { recursive: true });

  const tools = buildTools(t);
  if (anim) {
    anim.update(`${t.pkgName}: ${tools.length} tools running...`);
  } else {
    console.log(`  Running ${tools.length} tools in parallel...\n`);
  }
  const results = await runTools(tools);
  const failures = reportResults(results, anim);

  // Dashboards only for TS packages (they use flow-tool JSON)
  if (t.driver.id === "typescript") {
    anim?.update(`${t.pkgName}: building dashboards...`);
    const { dash, graph } = await buildDashboards(devtoolsRoot, t);
    if (!anim) {
      console.log("");
      console.log(`  Text:  ${t.outDir}/`);
      console.log(`  JSON:  ${t.jsonDir}/`);
      if (dash) console.log(`  Dash:  ${t.outDir}/dashboard.html`);
      if (graph) console.log(`  Graph: ${t.outDir}/graph.html`);
    }
  } else if (!anim) {
    console.log("");
    console.log(`  Text:  ${t.outDir}/`);
    console.log(`  JSON:  ${t.jsonDir}/`);
  }
  if (failures > 0 && !anim) console.log(`  ⚠  ${failures} tool(s) failed`);

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
  supergraph                            Audit all packages under packages/ + go-packages/
  supergraph <dir> [...]                Audit specific package(s) (auto-detects language)
  supergraph --no-go                    Skip Go packages
  supergraph --go-only                  Only audit Go packages
  supergraph --no-anim                  Disable terminal animation
  supergraph --root <path>              Target repo root (default: cwd)
  supergraph --help                     Show this help`);
    process.exit(0);
  }

  // Parse --root
  const rootIdx = args.indexOf("--root");
  const ROOT =
    rootIdx >= 0 && args[rootIdx + 1]
      ? resolve(args[rootIdx + 1]!)
      : process.cwd();

  const devtoolsRoot = resolve(import.meta.dir, "../..");

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
  const { goDriver } = await import("../../graph/src/cli/lang/go-driver.js");
  const { tsDriver } = await import("../../graph/src/cli/lang/ts-driver.js");

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
      const packagesDir = resolve(ROOT, "packages");
      try {
        await stat(packagesDir);
      } catch {
        console.error(
          "No packages/ directory found. Pass explicit src dirs or run from monorepo root.",
        );
        process.exit(1);
      }
      srcDirs = await discoverPackages(packagesDir);
      if (srcDirs.length === 0) {
        console.error("No packages with src/ directories found under packages/.");
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
  // Start animation with real package names
  // -----------------------------------------------------------------------
  const allPkgNames = [...tsTargets, ...goTargets].map((t) => t.pkgName);
  const isTTY = process.stdout.isTTY && !args.includes("--no-anim");
  const anim = isTTY ? startAnimation({ packages: allPkgNames }) : undefined;

  let totalFailures = 0;

  // -----------------------------------------------------------------------
  // TypeScript packages
  // -----------------------------------------------------------------------
  if (tsTargets.length > 0) {
    anim?.update(`scanning ${tsTargets.length} TS packages...`);
    if (!anim) {
      console.log(`TS audit targets (${tsTargets.length}):`);
      for (const t of tsTargets) {
        console.log(`  ${t.pkgName.padEnd(30)}  ←  ${t.srcDir}`);
      }
    }

    for (const t of tsTargets) {
      totalFailures += await auditPackage(devtoolsRoot, t, anim);
    }
  }

  // -----------------------------------------------------------------------
  // Go packages
  // -----------------------------------------------------------------------
  if (goTargets.length > 0) {
    anim?.update(`scanning ${goTargets.length} Go packages...`);
    if (!anim) {
      console.log(`\nGo audit targets (${goTargets.length}):`);
      for (const t of goTargets) {
        console.log(`  ${t.pkgName.padEnd(30)}  ←  ${t.srcDir}`);
      }
    }

    for (const t of goTargets) {
      totalFailures += await auditPackage(devtoolsRoot, t, anim);
    }
  }

  // -----------------------------------------------------------------------
  // Cross-package views
  // -----------------------------------------------------------------------
  anim?.update("cross-package analysis...");

  const crossResults = await Promise.allSettled([
    runPkgGraph({ root: ROOT }),
    runAggregate({ root: ROOT }),
    runCrossLangBridge({ root: ROOT }),
  ]);

  // Generate superhigh outputs (full + shortcut)
  anim?.update("generating superhigh...");
  if (!anim) console.log("\nGenerating superhigh...");
  const spawnIO = anim ? "pipe" as const : "inherit" as const;

  // Use process.execPath for compiled binary support, fall back to bun for dev
  const superhighScript = resolve(devtoolsRoot, "scripts", "superhigh.ts");
  const isCompiledBinary = !process.execPath.includes("bun");
  const spawnCmd = isCompiledBinary
    ? [process.execPath, "superhigh"]  // compiled: call self with subcommand
    : ["bun", superhighScript];         // dev: run script directly

  const superhighResults = await Promise.allSettled([
    (async () => {
      const proc = Bun.spawn([...spawnCmd, "--full", "--root", ROOT], {
        cwd: ROOT, stdout: spawnIO, stderr: spawnIO,
      });
      const code = await proc.exited;
      if (code !== 0) throw new Error(`superhigh --full exited with ${code}`);
    })(),
    (async () => {
      const proc = Bun.spawn([...spawnCmd, "--root", ROOT], {
        cwd: ROOT, stdout: spawnIO, stderr: spawnIO,
      });
      const code = await proc.exited;
      if (code !== 0) throw new Error(`superhigh shortcut exited with ${code}`);
    })(),
  ]);

  anim?.update("done.");

  // Brief pause so "done." is visible before clearing
  if (anim) await new Promise((r) => setTimeout(r, 800));

  // Stop animation before printing summary
  anim?.stop();

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n${"═".repeat(60)}`);
  if (totalFailures === 0) {
    console.log("All package(s) audited successfully.");
  } else {
    console.log(`${totalFailures} tool failure(s) across package(s).`);
  }
  console.log(`${"═".repeat(60)}`);

  for (const r of crossResults) {
    if (r.status === "rejected") {
      console.error(`  ✗  Cross-package tool failed: ${r.reason}`);
    }
  }

  for (const r of superhighResults) {
    if (r.status === "rejected") {
      console.error(`  ✗  superhigh failed: ${r.reason}`);
    }
  }

  if (totalFailures > 0) process.exit(1);
}
