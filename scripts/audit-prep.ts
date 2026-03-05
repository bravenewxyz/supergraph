#!/usr/bin/env bun

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const devtoolsRoot = resolve(import.meta.dir, "..");

// --root <path> support: allows running the devtools against any repo
const _rootArgIdx = process.argv.indexOf("--root");
const ROOT =
  _rootArgIdx >= 0 && process.argv[_rootArgIdx + 1]
    ? resolve(process.argv[_rootArgIdx + 1]!)
    : resolve(import.meta.dir, "../..");
const graph = (file: string) => `${devtoolsRoot}/graph/src/cli/${file}`;
const flow = (file: string) => `${devtoolsRoot}/flow/src/cli/${file}`;

type Job = {
  label: string;
  phase: string;
  cmd: string[];
  checkFile: string;
  extraFiles?: string[];
  json?: boolean;
};

type JobResult = {
  job: Job;
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
};

function derivePkgName(p: string): string {
  const normalized = p.replace(/\/+$/, "");
  const parts = normalized.split("/");
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
// Go package discovery
// ---------------------------------------------------------------------------

type GoPkgTarget = {
  goDir: string;
  pkgName: string;
  outDir: string;
  jsonDir: string;
};

function deriveGoPkgName(goModDir: string): string {
  const normalized = goModDir.replace(/\/+$/, "");
  const parts = normalized.split("/");
  const last = parts[parts.length - 1]!;
  const secondLast = parts.length >= 2 ? parts[parts.length - 2] : null;
  if (secondLast && secondLast !== "go-packages")
    return `go-${secondLast}-${last}`;
  return `go-${last}`;
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

function buildGoJobs(t: GoPkgTarget): Job[] {
  const { goDir, outDir, jsonDir } = t;
  return [
    {
      label: "structural map (Go)",
      phase: "1",
      cmd: [
        "bun",
        graph("go-map.ts"),
        goDir,
        "--format",
        "text",
        "--out",
        `${outDir}/map.txt`,
      ],
      checkFile: `${outDir}/map.txt`,
      extraFiles: [`${outDir}/deps.txt`, `${outDir}/imports.txt`],
    },
    {
      label: "structural map (Go)",
      phase: "1",
      cmd: [
        "bun",
        graph("go-map.ts"),
        goDir,
        "--format",
        "json",
        "--out",
        `${jsonDir}/map.json`,
      ],
      checkFile: `${jsonDir}/map.json`,
      json: true,
    },
    {
      label: "complexity (Go)",
      phase: "2",
      cmd: [
        "bun",
        graph("go-complexity.ts"),
        goDir,
        "--out",
        `${outDir}/complexity.txt`,
      ],
      checkFile: `${outDir}/complexity.txt`,
    },
    {
      label: "dead export detection (Go)",
      phase: "2",
      cmd: [
        "bun",
        graph("go-dead-exports.ts"),
        goDir,
        "--out",
        `${outDir}/dead.txt`,
      ],
      checkFile: `${outDir}/dead.txt`,
    },
  ];
}

async function auditGoPackage(t: GoPkgTarget): Promise<number> {
  console.log(`\n${"━".repeat(60)}`);
  console.log(`  ${t.pkgName}  ←  ${t.goDir}  (Go)`);
  console.log(`${"━".repeat(60)}`);

  await mkdir(t.outDir, { recursive: true });
  await mkdir(t.jsonDir, { recursive: true });

  const jobs = buildGoJobs(t);
  console.log(`  Running ${jobs.length} Go tools in parallel...\n`);
  const results = await runJobs(jobs);
  const failures = reportResults(results);

  console.log("");
  console.log(`  Text:  ${t.outDir}/`);
  console.log(`  JSON:  ${t.jsonDir}/`);
  if (failures > 0) console.log(`  ⚠  ${failures} tool(s) failed`);

  return failures;
}

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

function buildJobs(t: PkgTarget): Job[] {
  const { srcDir, outDir, invDir, jsonDir } = t;
  return [
    {
      label: "structural map",
      phase: "1",
      cmd: [
        "bun",
        graph("map.ts"),
        srcDir,
        "--format",
        "text",
        "--comments",
        "--out",
        `${outDir}/map.txt`,
      ],
      checkFile: `${outDir}/map.txt`,
      extraFiles: [`${outDir}/deps.txt`, `${outDir}/imports.txt`],
    },
    {
      label: "structural map",
      phase: "1",
      cmd: [
        "bun",
        graph("map.ts"),
        srcDir,
        "--format",
        "json",
        "--out",
        `${jsonDir}/map.json`,
      ],
      checkFile: `${jsonDir}/map.json`,
      json: true,
    },
    {
      label: "complexity & type-safety",
      phase: "2",
      cmd: [
        "bun",
        graph("complexity.ts"),
        srcDir,
        "--out",
        `${outDir}/complexity.txt`,
      ],
      checkFile: `${outDir}/complexity.txt`,
    },
    {
      label: "dead export detection",
      phase: "2",
      cmd: [
        "bun",
        graph("dead-exports.ts"),
        srcDir,
        "--out",
        `${outDir}/dead.txt`,
      ],
      checkFile: `${outDir}/dead.txt`,
    },
    {
      label: "schema ↔ type mismatches",
      phase: "5",
      cmd: [
        "bun",
        flow("schema-match.ts"),
        srcDir,
        "--format",
        "text",
        "--out",
        `${outDir}/schema-match.txt`,
      ],
      checkFile: `${outDir}/schema-match.txt`,
    },
    {
      label: "schema ↔ type mismatches",
      phase: "5",
      cmd: [
        "bun",
        flow("schema-match.ts"),
        srcDir,
        "--format",
        "json",
        "--out",
        `${jsonDir}/schema-match.json`,
      ],
      checkFile: `${jsonDir}/schema-match.json`,
      json: true,
    },
    {
      label: "FE↔BE contracts",
      phase: "5",
      cmd: [
        "bun",
        flow("contracts.ts"),
        srcDir,
        "--format",
        "text",
        "--out",
        `${outDir}/contracts.txt`,
      ],
      checkFile: `${outDir}/contracts.txt`,
    },
    {
      label: "FE↔BE contracts",
      phase: "5",
      cmd: [
        "bun",
        flow("contracts.ts"),
        srcDir,
        "--format",
        "json",
        "--out",
        `${jsonDir}/contracts.json`,
      ],
      checkFile: `${jsonDir}/contracts.json`,
      json: true,
    },
    {
      label: "serialization boundaries",
      phase: "5",
      cmd: [
        "bun",
        flow("trace.ts"),
        srcDir,
        "--boundaries",
        "--format",
        "text",
        "--out",
        `${outDir}/trace-boundaries.txt`,
      ],
      checkFile: `${outDir}/trace-boundaries.txt`,
    },
    {
      label: "serialization boundaries",
      phase: "5",
      cmd: [
        "bun",
        flow("trace.ts"),
        srcDir,
        "--boundaries",
        "--format",
        "json",
        "--out",
        `${jsonDir}/trace-boundaries.json`,
      ],
      checkFile: `${jsonDir}/trace-boundaries.json`,
      json: true,
    },
    {
      label: "logic audit",
      phase: "6",
      cmd: [
        "bun",
        flow("logic-audit.ts"),
        srcDir,
        "--format",
        "text",
        "--out",
        `${outDir}/logic-audit.txt`,
      ],
      checkFile: `${outDir}/logic-audit.txt`,
    },
    {
      label: "logic audit",
      phase: "6",
      cmd: [
        "bun",
        flow("logic-audit.ts"),
        srcDir,
        "--format",
        "json",
        "--out",
        `${jsonDir}/logic-audit.json`,
      ],
      checkFile: `${jsonDir}/logic-audit.json`,
      json: true,
    },
    {
      label: "invariant discovery",
      phase: "7",
      cmd: [
        "bun",
        flow("invariant.ts"),
        "discover",
        srcDir,
        "--format",
        "compact",
        "--suggest-extractions",
        "--out",
        `${invDir}/discovery.txt`,
      ],
      checkFile: `${invDir}/discovery.txt`,
    },
    {
      label: "invariant discovery",
      phase: "7",
      cmd: [
        "bun",
        flow("invariant.ts"),
        "discover",
        srcDir,
        "--format",
        "json",
        "--suggest-extractions",
        "--out",
        `${jsonDir}/discovery.json`,
      ],
      checkFile: `${jsonDir}/discovery.json`,
      json: true,
    },
  ];
}

async function fileSizeKB(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${(s.size / 1024).toFixed(0)} KB`;
  } catch {
    return "? KB";
  }
}

async function runJobs(jobs: Job[]): Promise<JobResult[]> {
  return Promise.all(
    jobs.map(async (job): Promise<JobResult> => {
      const t0 = Date.now();
      try {
        const proc = Bun.spawn(job.cmd, {
          stdout: "pipe",
          stderr: "pipe",
          cwd: ROOT,
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
        if (code !== 0) {
          return { job, ok: false, elapsed, error: (stderr || stdout).trim() };
        }
        const size = await fileSizeKB(job.checkFile);
        return { job, ok: true, elapsed, size };
      } catch (err) {
        return {
          job,
          ok: false,
          elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
          error: String(err),
        };
      }
    }),
  );
}

function reportResults(results: JobResult[]): number {
  let failures = 0;
  for (const r of results) {
    const kind = r.job.json ? " (json)" : "       ";
    if (r.ok) {
      const extras = r.job.extraFiles?.map((f) => basename(f)).join(", ");
      const note = extras ? `  → also ${extras}` : "";
      console.log(
        `  ✓  Phase ${r.job.phase}${kind}  ${r.job.label.padEnd(30)}  ${(r.size ?? "").padStart(7)}  (${r.elapsed})${note}`,
      );
    } else {
      console.error(
        `  ✗  Phase ${r.job.phase}${kind}  ${r.job.label.padEnd(30)}  FAILED  (${r.elapsed})`,
      );
      if (r.error) {
        const preview = r.error.split("\n").slice(0, 3).join("\n         ");
        console.error(`         ${preview}`);
      }
      failures++;
    }
  }
  return failures;
}

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
  t: PkgTarget,
): Promise<{ dash: boolean; graph: boolean }> {
  const payload = await loadPayload(t.jsonDir);
  const [dash, graph] = await Promise.all([
    injectTemplate("index.html", payload, `${t.outDir}/dashboard.html`),
    injectTemplate("graph.html", payload, `${t.outDir}/graph.html`),
  ]);
  return { dash, graph };
}

async function auditPackage(t: PkgTarget): Promise<number> {
  console.log(`\n${"━".repeat(60)}`);
  console.log(`  ${t.pkgName}  ←  ${t.srcDir}`);
  console.log(`${"━".repeat(60)}`);

  await mkdir(t.outDir, { recursive: true });
  await mkdir(t.invDir, { recursive: true });
  await mkdir(t.jsonDir, { recursive: true });

  const jobs = buildJobs(t);
  console.log(`  Running ${jobs.length} tools in parallel...\n`);
  const results = await runJobs(jobs);
  const failures = reportResults(results);

  const { dash, graph } = await buildDashboards(t);
  console.log("");
  console.log(`  Text:  ${t.outDir}/`);
  console.log(`  JSON:  ${t.jsonDir}/`);
  if (dash) console.log(`  Dash:  ${t.outDir}/dashboard.html`);
  if (graph) console.log(`  Graph: ${t.outDir}/graph.html`);
  if (failures > 0) console.log(`  ⚠  ${failures} tool(s) failed`);

  return failures;
}

const args = process.argv.slice(2);
const showHelp = args.includes("--help") || args.includes("-h");
const skipGo = args.includes("--no-go");
const goOnly = args.includes("--go-only");
if (showHelp) {
  console.log("Usage:");
  console.log(
    "  bun audit-prep.ts                    Audit all packages under packages/ + go-packages/",
  );
  console.log(
    "  bun audit-prep.ts <dir> [...]          Audit specific package(s) (auto-detects Go via go.mod)",
  );
  console.log("  bun audit-prep.ts --no-go             Skip Go packages");
  console.log("  bun audit-prep.ts --go-only           Only audit Go packages");
  console.log(
    "  bun audit-prep.ts --root <path>       Target repo root (default: guild-v3 root)",
  );
  console.log("  bun audit-prep.ts --help              Show this help");
  process.exit(0);
}

// Filter out flags and their values (--root <path>, etc.)
const explicitDirs = args.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = args[i - 1];
  if (prev === "--root") return false;
  return true;
});
// ---------------------------------------------------------------------------
// Partition explicit dirs into Go and TS packages
// ---------------------------------------------------------------------------

async function isGoPackage(dir: string): Promise<boolean> {
  try {
    await stat(join(resolve(ROOT, dir), "go.mod"));
    return true;
  } catch {
    return false;
  }
}

const explicitGoDirs: string[] = [];
const explicitTsDirs: string[] = [];
if (explicitDirs.length > 0) {
  for (const d of explicitDirs) {
    if (await isGoPackage(d)) {
      explicitGoDirs.push(resolve(ROOT, d));
    } else {
      explicitTsDirs.push(d);
    }
  }
}

// ---------------------------------------------------------------------------
// TypeScript packages
// ---------------------------------------------------------------------------

let totalFailures = 0;

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
    const targets: PkgTarget[] = srcDirs.map((srcDir) => {
      const pkgName = derivePkgName(srcDir);
      const outDir = `audit/packages/${pkgName}`;
      return {
        srcDir,
        pkgName,
        outDir,
        invDir: `${outDir}/invariants`,
        jsonDir: `${outDir}/json`,
      };
    });

    checkCollisions(targets);
    console.log(`TS audit targets (${targets.length}):`);
    for (const t of targets) {
      console.log(`  ${t.pkgName.padEnd(30)}  ←  ${t.srcDir}`);
    }

    for (const t of targets) {
      totalFailures += await auditPackage(t);
    }
  }
}

// ---------------------------------------------------------------------------
// Go packages
// ---------------------------------------------------------------------------

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
    const goTargets: GoPkgTarget[] = goDirs.map((goDir) => {
      const pkgName = deriveGoPkgName(goDir);
      const outDir = `audit/packages/${pkgName}`;
      return { goDir, pkgName, outDir, jsonDir: `${outDir}/json` };
    });
    console.log(`\nGo audit targets (${goTargets.length}):`);
    for (const t of goTargets) {
      console.log(`  ${t.pkgName.padEnd(30)}  ←  ${t.goDir}`);
    }

    for (const t of goTargets) {
      totalFailures += await auditGoPackage(t);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary + cross-package views
// ---------------------------------------------------------------------------
console.log(`\n${"═".repeat(60)}`);
if (totalFailures === 0) {
  console.log("All package(s) audited successfully.");
} else {
  console.log(`${totalFailures} tool failure(s) across package(s).`);
}
console.log(`${"═".repeat(60)}`);
const scriptsDir = resolve(devtoolsRoot, "scripts");
await Promise.all(
  [
    ["bun", resolve(scriptsDir, "pkg-graph.ts"), "--root", ROOT],
    ["bun", resolve(scriptsDir, "supergraph.ts"), "--root", ROOT],
    ["bun", resolve(scriptsDir, "cross-lang-bridge.ts"), "--root", ROOT],
  ].map(async (cmd) => {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: ROOT,
    });
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) console.error(`  ✗  ${basename(cmd[1]!)}: failed`);
    else
      out
        .trim()
        .split("\n")
        .forEach((l) => l.trim() && console.log(`  ${l.trim()}`));
  }),
);
if (totalFailures > 0) process.exit(1);
