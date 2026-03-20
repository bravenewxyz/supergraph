import { appendFile, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, relative } from "node:path";
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
import { clearProgramCache } from "../../packages/flow/src/analysis/shared-program.js";

// Cross-package tools
import { runAggregate } from "../../packages/scripts/supergraph.js";
import { runPkgGraph } from "../../packages/scripts/pkg-graph.js";
import { runCrossLangBridge } from "../../packages/scripts/cross-lang-bridge.js";
import { runNormagraph } from "../../packages/scripts/normagraph.js";
import { runTemporal } from "../../packages/scripts/temporal.js";
import { serializeJsonForHtmlScriptTag } from "../../packages/scripts/shared.js";
import {
  contextPackageDir,
  legacyPackageDir,
  legacyRepoArtifacts,
  mirrorCanonicalToLegacy,
  rawPackageDir,
  repoArtifacts,
  viewsPackageDir,
} from "../../packages/scripts/artifact-paths.js";
import {
  type ArtifactFormat,
  type ArtifactRecordInput,
  type ArtifactStatus,
  buildArtifactManifest,
  serializeArtifactManifest,
} from "./artifact-manifest.js";

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
  viewDir: string;
  legacyDir: string;
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
    if (lines.some(l => l.trim() === ".supergraph/" || l.trim() === ".supergraph")) return;
    await appendFile(gitignorePath, `${content.endsWith("\n") ? "" : "\n"}.supergraph/\n`);
  } catch {
    // No .gitignore exists — create one
    await writeFile(gitignorePath, ".supergraph/\n");
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
    {
      label: "taint analysis",
      phase: "8",
      run: async () => {
        const { runTaintAnalysis } = await import("../../packages/flow/src/analysis/taint-tracker.js");
        const analysis = await runTaintAnalysis(srcDir);
        const output = JSON.stringify({
          sources: analysis.sources.length,
          sinks: analysis.sinks.length,
          flows: analysis.flows.length,
          unsanitizedFlows: analysis.unsanitizedFlows.length,
          unsanitizedBySeverity: {
            critical: analysis.unsanitizedFlows.filter((f: { severity: string }) => f.severity === "critical").length,
            high: analysis.unsanitizedFlows.filter((f: { severity: string }) => f.severity === "high").length,
            medium: analysis.unsanitizedFlows.filter((f: { severity: string }) => f.severity === "medium").length,
          },
          details: analysis.unsanitizedFlows.slice(0, 20).map((f: { severity: string; sink: { kind: string; filePath: string; line: number }; source: { kind: string; filePath: string; line: number } }) => ({
            severity: f.severity,
            sinkKind: f.sink.kind,
            sinkFile: f.sink.filePath,
            sinkLine: f.sink.line,
            sourceKind: f.source.kind,
            sourceFile: f.source.filePath,
            sourceLine: f.source.line,
          })),
        }, null, 2);
        await writeFile(`${jsonDir}/taint.json`, output);
      },
      checkFile: `${jsonDir}/taint.json`,
      json: true,
    },
    {
      label: "compound analysis",
      phase: "9",
      run: async () => {
        const { runCompoundAnalysis } = await import("../../packages/flow/src/analysis/compound-analysis.js");
        const findings = await runCompoundAnalysis(t.pkgName, jsonDir);
        if (findings.length > 0) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(`${jsonDir}/compound.json`, JSON.stringify(findings, null, 2));
        }
      },
      checkFile: `${jsonDir}/compound.json`,
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

async function runTools(
  tools: ToolRun[],
  muted: boolean,
  concurrency = 3,
  onResult?: (result: RunResult, doneCount: number, total: number) => void,
): Promise<RunResult[]> {
  const unmute = muted ? muteConsole() : undefined;
  try {
    const results: RunResult[] = new Array(tools.length);
    let nextIdx = 0;
    let doneCount = 0;

    async function worker() {
      while (nextIdx < tools.length) {
        const idx = nextIdx++;
        const tool = tools[idx]!;
        const t0 = Date.now();
        const TOOL_TIMEOUT = 600_000;
        let result: RunResult;
        try {
          await withTimeout(tool.run(), TOOL_TIMEOUT, tool.label);
          const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
          const size = await fileSizeKB(tool.checkFile);
          result = { tool, ok: true, elapsed, size };
        } catch (err) {
          const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
          const msg = err instanceof Error ? err.message : String(err);
          result = { tool, ok: false, elapsed, error: msg };
        }
        results[idx] = result;
        doneCount++;
        onResult?.(result, doneCount, tools.length);
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
const allArtifactRecords: ArtifactRecordInput[] = [];

type ArtifactProbe = {
  status: ArtifactStatus;
  bytes?: number;
  reason?: string;
  summary?: string;
};

function artifactFormatFromPath(path: string): ArtifactFormat {
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "md";
  return "txt";
}

function resolveArtifactPath(root: string, path: string): { absPath: string; relPath: string } {
  const absPath = path.startsWith("/") ? path : resolve(root, path);
  return { absPath, relPath: relative(root, absPath) };
}

function defaultMissingReason(status: ArtifactStatus): string {
  switch (status) {
    case "skipped": return "artifact not applicable for this run";
    case "empty": return "analysis completed with no output";
    case "failed": return "expected artifact was not written";
    case "generated": return "";
  }
}

async function probeArtifact(
  root: string,
  path: string,
  fallbackStatusOnMissing: ArtifactStatus,
  summary?: string,
): Promise<ArtifactProbe> {
  const { absPath } = resolveArtifactPath(root, path);
  let bytes = 0;
  try {
    const st = await stat(absPath);
    bytes = st.size;
  } catch {
    return {
      status: fallbackStatusOnMissing,
      reason: defaultMissingReason(fallbackStatusOnMissing),
      summary,
    };
  }

  const format = artifactFormatFromPath(path);
  if (bytes === 0) {
    return { status: "empty", bytes, reason: "artifact is empty", summary };
  }

  if (format === "txt" || format === "md" || format === "html") {
    const text = await readFile(absPath, "utf-8");
    const trimmed = text.trim();
    if (!trimmed) {
      return { status: "empty", bytes, reason: "artifact is empty", summary };
    }
    if (trimmed === "No runtime schemas found.") {
      return { status: "skipped", bytes, reason: trimmed, summary: summary ?? trimmed };
    }
    if (trimmed.startsWith("Skipped:")) {
      return { status: "skipped", bytes, reason: trimmed, summary: summary ?? trimmed };
    }
    if (/^No .+ found\.$/.test(trimmed) && bytes <= 256) {
      return { status: "empty", bytes, reason: trimmed, summary: summary ?? trimmed };
    }
    return { status: "generated", bytes, summary };
  }

  if (format === "json") {
    try {
      const value = JSON.parse(await readFile(absPath, "utf-8")) as unknown;
      if (path.endsWith("schema-match.json")) {
        const data = value as { schemas?: number };
        if ((data.schemas ?? 0) === 0) {
          return { status: "skipped", bytes, reason: "no runtime schemas found", summary };
        }
      }
      if (path.endsWith("contracts.json")) {
        const data = value as { skipped?: boolean; reason?: string };
        if (data.skipped) {
          return { status: "skipped", bytes, reason: data.reason ?? "contracts analysis skipped", summary };
        }
      }
      if (path.endsWith("trace-boundaries.json")) {
        const data = value as { boundaries?: unknown[] };
        if (Array.isArray(data.boundaries) && data.boundaries.length === 0) {
          return { status: "empty", bytes, reason: "no serialization boundaries found", summary };
        }
      }
      if (path.endsWith("taint.json")) {
        const data = value as { unsanitizedFlows?: number };
        if ((data.unsanitizedFlows ?? 0) === 0) {
          return { status: "empty", bytes, reason: "no unsanitized taint flows", summary };
        }
      }
      if (Array.isArray(value) && value.length === 0) {
        return { status: "empty", bytes, reason: "artifact contains no records", summary };
      }
    } catch {
      // Keep status as generated for now; parse errors should already fail the producer.
    }
  }

  return { status: "generated", bytes, summary };
}

function pushArtifactRecord(record: ArtifactRecordInput): void {
  allArtifactRecords.push(record);
}

async function recordArtifact(
  root: string,
  base: Omit<ArtifactRecordInput, "format" | "status" | "bytes" | "reason"> & {
    fallbackStatusOnMissing: ArtifactStatus;
  },
): Promise<void> {
  const { relPath } = resolveArtifactPath(root, base.path);
  const probe = await probeArtifact(root, base.path, base.fallbackStatusOnMissing, base.summary);
  pushArtifactRecord({
    id: base.id,
    scope: base.scope,
    producer: base.producer,
    packageName: base.packageName,
    path: relPath,
    format: artifactFormatFromPath(relPath),
    status: probe.status,
    bytes: probe.bytes,
    summary: probe.summary ?? base.summary,
    reason: probe.reason,
    inputs: base.inputs,
  });
}

async function promoteLegacyArtifact(canonicalPath: string, legacyPath: string): Promise<void> {
  try {
    await stat(canonicalPath);
    return;
  } catch {
    // canonical missing — fall through
  }
  try {
    await stat(legacyPath);
  } catch {
    return;
  }
  await mkdir(dirname(canonicalPath), { recursive: true });
  await copyFile(legacyPath, canonicalPath);
}

function statusIcon(status: ArtifactStatus): string {
  switch (status) {
    case "generated": return `${C.green}✓${C.reset}`;
    case "empty": return `${C.yellow}○${C.reset}`;
    case "skipped": return `${C.dim}·${C.reset}`;
    case "failed": return `${C.red}✗${C.reset}`;
  }
}

function statusSuffix(record: { status: ArtifactStatus; reason?: string }): string {
  if (!record.reason) {
    return record.status === "empty" ? `  ${C.dim}empty${C.reset}` :
      record.status === "skipped" ? `  ${C.dim}skipped${C.reset}` :
      "";
  }
  if (record.status === "generated") return "";
  return `  ${C.dim}${record.reason}${C.reset}`;
}

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
      `<script id="__AUDIT_DATA__" type="application/json">${serializeJsonForHtmlScriptTag(payload)}</script>`,
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
    injectTemplate("index.html", payload, `${t.viewDir}/dashboard.html`),
    injectTemplate("graph.html", payload, `${t.viewDir}/graph.html`),
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

async function auditPackage(root: string, t: PkgTarget, anim?: AnimationHandle): Promise<number> {
  const langLabel = t.driver.id === "typescript" ? "" : `  (${t.driver.name})`;
  if (anim) {
    anim.update(`auditing ${t.pkgName}...`);
  } else {
    const bar = "━".repeat(56);
    console.log(`\n${C.dim}━━${C.reset} ${C.bold}${t.pkgName}${C.reset}${langLabel} ${C.dim}${bar.slice(0, Math.max(1, 56 - t.pkgName.length))}${C.reset}`);
  }

  // Clean previous outputs so stale artifacts don't persist across runs
  await rm(t.outDir, { recursive: true, force: true });
  await rm(t.viewDir, { recursive: true, force: true });
  await rm(t.legacyDir, { recursive: true, force: true });
  await mkdir(t.outDir, { recursive: true });
  await mkdir(t.invDir, { recursive: true });
  await mkdir(t.jsonDir, { recursive: true });
  await mkdir(t.viewDir, { recursive: true });

  const tools = buildTools(t);
  let failures = 0;
  if (anim) {
    anim.update(`${t.pkgName}: 0/${tools.length} tools...`);
  }
  const results = await runTools(tools, true, 3, (result, done, total) => {
    if (anim) {
      // Stream each result as it completes
      const kind = result.tool.json ? " (json)" : "";
      if (result.ok) {
        anim.log(`  ✓  ${t.pkgName}  ${result.tool.label}${kind}  ${result.size ?? ""}  (${result.elapsed})`);
      } else {
        failures++;
        anim.log(`  ✗  ${t.pkgName}  ${result.tool.label}${kind}  FAILED  (${result.elapsed})`);
      }
      anim.update(`${t.pkgName}: ${done}/${total} tools...`);
    }
  });
  allResults.push({ pkgName: t.pkgName, results });
  if (!anim) {
    failures = reportResults(results, t.pkgName);
  } else {
    const ok = results.filter((r) => r.ok).length;
    anim.update(`${t.pkgName}: ${ok}/${results.length} tools${failures > 0 ? `, ${failures} failed` : ""}`);
  }

  // Dashboards only for TS packages (they use flow-tool JSON)
  if (t.driver.id === "typescript") {
    anim?.update(`${t.pkgName}: building dashboards...`);
    const { dash, graph } = await buildDashboards(t);
    await recordArtifact(root, {
      id: `package:${t.pkgName}:dashboard`,
      scope: "package",
      producer: "dashboard",
      packageName: t.pkgName,
      path: `${t.viewDir}/dashboard.html`,
      summary: "package dashboard",
      fallbackStatusOnMissing: "failed",
    });
    await mirrorCanonicalToLegacy(root, resolve(root, `${t.viewDir}/dashboard.html`)).catch(() => {});
    await recordArtifact(root, {
      id: `package:${t.pkgName}:graph-view`,
      scope: "package",
      producer: "dashboard-graph",
      packageName: t.pkgName,
      path: `${t.viewDir}/graph.html`,
      summary: "package graph view",
      fallbackStatusOnMissing: "failed",
    });
    await mirrorCanonicalToLegacy(root, resolve(root, `${t.viewDir}/graph.html`)).catch(() => {});
    if (!anim) {
      const outputs = [`${C.dim}→ ${t.viewDir}/${C.reset}`];
      if (dash) outputs.push(`${C.cyan}dashboard.html${C.reset}`);
      if (graph) outputs.push(`${C.cyan}graph.html${C.reset}`);
      console.log(`  ${outputs.join("  ")}`);
    }
  } else if (!anim) {
    console.log(`  ${C.dim}→ ${t.outDir}/${C.reset}`);
  }
  if (failures > 0 && !anim) console.log(`  ${C.yellow}⚠  ${failures} tool(s) failed${C.reset}`);

  anim?.packageReady(t.pkgName);

  for (const result of results) {
    await mirrorCanonicalToLegacy(root, resolve(root, result.tool.checkFile)).catch(() => {});
    await recordArtifact(root, {
      id: `package:${t.pkgName}:${basename(result.tool.checkFile)}`,
      scope: "package",
      producer: result.tool.label,
      packageName: t.pkgName,
      path: result.tool.checkFile,
      summary: result.tool.label,
      fallbackStatusOnMissing: result.ok
        ? (result.tool.checkFile.endsWith("compound.json") ? "empty" : "failed")
        : "failed",
    });
    for (const extraFile of result.tool.extraFiles ?? []) {
      await mirrorCanonicalToLegacy(root, resolve(root, extraFile)).catch(() => {});
      await recordArtifact(root, {
        id: `package:${t.pkgName}:${basename(extraFile)}`,
        scope: "package",
        producer: result.tool.label,
        packageName: t.pkgName,
        path: extraFile,
        summary: result.tool.label,
        fallbackStatusOnMissing: result.ok ? "failed" : "failed",
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAuditPipeline(args: string[]): Promise<void> {
  const pipelineT0 = Date.now();
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

  // Ensure .supergraph/ is in .gitignore
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
        const outDir = relative(ROOT, contextPackageDir(ROOT, pkgName));
        const jsonDir = relative(ROOT, rawPackageDir(ROOT, pkgName));
        return {
          srcDir,
          pkgName,
          outDir,
          invDir: `${outDir}/invariants`,
          jsonDir,
          viewDir: relative(ROOT, viewsPackageDir(ROOT, pkgName)),
          legacyDir: relative(ROOT, legacyPackageDir(ROOT, pkgName)),
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
        const outDir = relative(ROOT, contextPackageDir(ROOT, pkgName));
        const jsonDir = relative(ROOT, rawPackageDir(ROOT, pkgName));
        return {
          srcDir: goDir,
          pkgName,
          outDir,
          invDir: `${outDir}/invariants`,
          jsonDir,
          viewDir: relative(ROOT, viewsPackageDir(ROOT, pkgName)),
          legacyDir: relative(ROOT, legacyPackageDir(ROOT, pkgName)),
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
      anim.stop().then(() => process.exit(0));
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
      totalFailures += await auditPackage(ROOT, t, anim);
      clearProgramCache(); // free TS Program memory between packages
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
      totalFailures += await auditPackage(ROOT, t, anim);
    }
  }

  // -----------------------------------------------------------------------
  // Cross-package views
  // -----------------------------------------------------------------------
  anim?.update("cross-package analysis...");

  // Clean stale top-level cross-package artifacts
  const AUDIT_DIR = resolve(ROOT, ".supergraph");
  const STALE_ARTIFACTS = [
    legacyRepoArtifacts.supergraphHtml(ROOT),
    legacyRepoArtifacts.pkgGraphHtml(ROOT),
    legacyRepoArtifacts.architectureFull(ROOT),
    legacyRepoArtifacts.architectureCompact(ROOT),
    legacyRepoArtifacts.symbolsSource(ROOT),
    legacyRepoArtifacts.symbolsBrief(ROOT),
    legacyRepoArtifacts.findings(ROOT),
    legacyRepoArtifacts.temporal(ROOT),
    legacyRepoArtifacts.crossLangText(ROOT),
    legacyRepoArtifacts.crossLangJson(ROOT),
    repoArtifacts.supergraphHtml(ROOT),
    repoArtifacts.pkgGraphHtml(ROOT),
    repoArtifacts.architectureFull(ROOT),
    repoArtifacts.architectureCompact(ROOT),
    repoArtifacts.symbolsSource(ROOT),
    repoArtifacts.symbolsBrief(ROOT),
    repoArtifacts.findings(ROOT),
    repoArtifacts.temporal(ROOT),
    repoArtifacts.crossLangText(ROOT),
    repoArtifacts.crossLangJson(ROOT),
    repoArtifacts.index(ROOT),
    resolve(ROOT, ".supergraph/context/issues.txt"),
    resolve(ROOT, ".supergraph/context/supergraph.txt"),
    resolve(ROOT, ".supergraph/context/supergraph-compact.txt"),
    resolve(ROOT, ".supergraph/context/symbols.txt"),
    resolve(ROOT, ".supergraph/context/symbols-full.txt"),
    resolve(ROOT, ".supergraph/raw/cross-lang-bridge.json"),
  ];
  await Promise.all(STALE_ARTIFACTS.map(f => rm(f, { force: true })));

  // Clean stale per-package directories that don't belong to the current run.
  // Without this, leftover directories from auditing a different project pollute
  // the aggregate cross-package output (superhigh, supergraph, normagraph).
  const packageRoots = [
    resolve(ROOT, ".supergraph/raw/packages"),
    resolve(ROOT, ".supergraph/views/packages"),
    resolve(ROOT, ".supergraph/context/packages"),
    resolve(ROOT, ".supergraph/packages"),
  ];
  const validPkgNames = new Set([
    ...tsTargets.map(t => t.pkgName),
    ...goTargets.map(t => t.pkgName),
  ]);
  for (const packagesDir of packageRoots) {
    try {
      const existingDirs = await readdir(packagesDir, { withFileTypes: true });
      await Promise.all(
        existingDirs
          .filter(e => e.isDirectory() && !validPkgNames.has(e.name))
          .map(e => rm(join(packagesDir, e.name), { recursive: true, force: true })),
      );
    } catch { /* packages dir doesn't exist yet */ }
  }

  const unmuteCross = muteConsole();
  const CROSS_TIMEOUT = 600_000;
  const crossT0 = Date.now();

  function crossDone(label: string) {
    return {
      then: (r: unknown) => { anim?.log(`  ✓  cross  ${label}  (${((Date.now() - crossT0) / 1000).toFixed(1)}s)`); return r; },
      catch: (err: unknown) => { anim?.log(`  ✗  cross  ${label}  FAILED  (${((Date.now() - crossT0) / 1000).toFixed(1)}s)`); throw err; },
    };
  }

  const crossResults = await Promise.allSettled([
    withTimeout(runPkgGraph({ root: ROOT }), CROSS_TIMEOUT, "pkg-graph").then(crossDone("pkg-graph").then, crossDone("pkg-graph").catch),
    withTimeout(runAggregate({ root: ROOT }), CROSS_TIMEOUT, "aggregate").then(crossDone("aggregate").then, crossDone("aggregate").catch),
    withTimeout(runCrossLangBridge({ root: ROOT }), CROSS_TIMEOUT, "cross-lang-bridge").then(crossDone("cross-lang-bridge").then, crossDone("cross-lang-bridge").catch),
    withTimeout(runNormagraph({ root: ROOT, detail: "full" }), CROSS_TIMEOUT, "hypergraph").then(crossDone("hypergraph").then, crossDone("hypergraph").catch),
    withTimeout(runNormagraph({ root: ROOT, detail: "brief" }), CROSS_TIMEOUT, "normagraph").then(crossDone("normagraph").then, crossDone("normagraph").catch),
    withTimeout(runTemporal({ root: ROOT }).then(txt => writeFile(join(AUDIT_DIR, "temporal.txt"), txt)), CROSS_TIMEOUT, "temporal").then(crossDone("temporal").then, crossDone("temporal").catch),
  ]);
  unmuteCross();

  // Generate superhigh outputs (full + shortcut)
  anim?.update("generating superhigh...");

  // Run superhigh in-process to avoid native module loading issues in compiled
  // binaries (dprint-node / ast-grep-napi can't load from /$bunfs/root/).
  const { runSuperhigh } = await import("../../packages/scripts/superhigh.js");
  const SPAWN_TIMEOUT = 600_000;
  const superhighT0 = Date.now();
  const unmuteSH = muteConsole();
  const superhighResults = await Promise.allSettled([
    withTimeout(
      runSuperhigh({ root: ROOT, full: true }),
      SPAWN_TIMEOUT, "superhigh --full",
    ).then(() => { anim?.log(`  ✓  cross  superhigh --full  (${((Date.now() - superhighT0) / 1000).toFixed(1)}s)`); }),
    withTimeout(
      runSuperhigh({ root: ROOT, full: false }),
      SPAWN_TIMEOUT, "superhigh compact",
    ).then(() => { anim?.log(`  ✓  cross  superhigh compact  (${((Date.now() - superhighT0) / 1000).toFixed(1)}s)`); }),
  ]);
  unmuteSH();

  // -----------------------------------------------------------------------
  // Tally failures (while animation still runs)
  // -----------------------------------------------------------------------
  const crossToolNames = ["pkg-graph", "aggregate", "cross-lang-bridge", "symbols-full", "symbols", "temporal"];
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

  const crossLangResult =
    crossResults[2]?.status === "fulfilled" ? crossResults[2].value : null;

  await promoteLegacyArtifact(repoArtifacts.pkgGraphHtml(ROOT), legacyRepoArtifacts.pkgGraphHtml(ROOT));
  await promoteLegacyArtifact(repoArtifacts.supergraphHtml(ROOT), legacyRepoArtifacts.supergraphHtml(ROOT));
  await promoteLegacyArtifact(repoArtifacts.findings(ROOT), legacyRepoArtifacts.findings(ROOT));
  await promoteLegacyArtifact(repoArtifacts.crossLangText(ROOT), legacyRepoArtifacts.crossLangText(ROOT));
  await promoteLegacyArtifact(repoArtifacts.crossLangJson(ROOT), legacyRepoArtifacts.crossLangJson(ROOT));
  await promoteLegacyArtifact(repoArtifacts.symbolsSource(ROOT), legacyRepoArtifacts.symbolsSource(ROOT));
  await promoteLegacyArtifact(repoArtifacts.symbolsBrief(ROOT), legacyRepoArtifacts.symbolsBrief(ROOT));
  await promoteLegacyArtifact(repoArtifacts.temporal(ROOT), legacyRepoArtifacts.temporal(ROOT));
  await promoteLegacyArtifact(repoArtifacts.architectureFull(ROOT), legacyRepoArtifacts.architectureFull(ROOT));
  await promoteLegacyArtifact(repoArtifacts.architectureCompact(ROOT), legacyRepoArtifacts.architectureCompact(ROOT));

  await recordArtifact(ROOT, {
    id: "repo:pkg-graph",
    scope: "repo",
    producer: "pkg-graph",
    path: repoArtifacts.pkgGraphHtml(ROOT),
    summary: "package dependency graph",
    fallbackStatusOnMissing: crossResults[0]?.status === "fulfilled" ? "failed" : "failed",
  });
  await recordArtifact(ROOT, {
    id: "repo:supergraph-html",
    scope: "repo",
    producer: "aggregate",
    path: repoArtifacts.supergraphHtml(ROOT),
    summary: "interactive supergraph view",
    fallbackStatusOnMissing: crossResults[1]?.status === "fulfilled" ? "failed" : "failed",
  });
  await recordArtifact(ROOT, {
    id: "repo:issues",
    scope: "repo",
    producer: "aggregate",
    path: repoArtifacts.findings(ROOT),
    summary: "aggregated findings",
    fallbackStatusOnMissing: crossResults[1]?.status === "fulfilled" ? "failed" : "failed",
  });
  if (crossLangResult?.status === "skipped") {
    for (const path of [repoArtifacts.crossLangText(ROOT), repoArtifacts.crossLangJson(ROOT)]) {
      pushArtifactRecord({
        id: `repo:${basename(path)}`,
        scope: "repo",
        producer: "cross-lang-bridge",
        path: relative(ROOT, path),
        format: artifactFormatFromPath(path),
        status: "skipped",
        summary: "cross-language bridge report",
        reason: crossLangResult.reason,
      });
    }
  } else {
    await recordArtifact(ROOT, {
      id: "repo:cross-lang-bridge-text",
      scope: "repo",
      producer: "cross-lang-bridge",
      path: repoArtifacts.crossLangText(ROOT),
      summary: "cross-language bridge report",
      fallbackStatusOnMissing: crossResults[2]?.status === "fulfilled" ? "failed" : "failed",
    });
    await recordArtifact(ROOT, {
      id: "repo:cross-lang-bridge-json",
      scope: "repo",
      producer: "cross-lang-bridge",
      path: repoArtifacts.crossLangJson(ROOT),
      summary: "cross-language bridge data",
      fallbackStatusOnMissing: crossResults[2]?.status === "fulfilled" ? "failed" : "failed",
    });
  }
  await recordArtifact(ROOT, {
    id: "repo:symbols-full",
    scope: "repo",
    producer: "normagraph",
    path: repoArtifacts.symbolsSource(ROOT),
    summary: "full symbol index",
    fallbackStatusOnMissing: crossResults[3]?.status === "fulfilled" ? "failed" : "failed",
  });
  await recordArtifact(ROOT, {
    id: "repo:symbols-brief",
    scope: "repo",
    producer: "normagraph",
    path: repoArtifacts.symbolsBrief(ROOT),
    summary: "brief symbol index",
    fallbackStatusOnMissing: crossResults[4]?.status === "fulfilled" ? "failed" : "failed",
  });
  await recordArtifact(ROOT, {
    id: "repo:temporal",
    scope: "repo",
    producer: "temporal",
    path: repoArtifacts.temporal(ROOT),
    summary: "temporal change analysis",
    fallbackStatusOnMissing: crossResults[5]?.status === "fulfilled" ? "failed" : "failed",
  });
  await recordArtifact(ROOT, {
    id: "repo:supergraph-full",
    scope: "repo",
    producer: "superhigh",
    path: repoArtifacts.architectureFull(ROOT),
    summary: "full architecture context",
    fallbackStatusOnMissing: superhighResults[0]?.status === "fulfilled" ? "failed" : "failed",
  });
  await recordArtifact(ROOT, {
    id: "repo:supergraph-compact",
    scope: "repo",
    producer: "superhigh",
    path: repoArtifacts.architectureCompact(ROOT),
    summary: "compact architecture context",
    fallbackStatusOnMissing: superhighResults[1]?.status === "fulfilled" ? "failed" : "failed",
  });

  for (const canonicalPath of [
    repoArtifacts.pkgGraphHtml(ROOT),
    repoArtifacts.supergraphHtml(ROOT),
    repoArtifacts.findings(ROOT),
    repoArtifacts.crossLangText(ROOT),
    repoArtifacts.crossLangJson(ROOT),
    repoArtifacts.symbolsSource(ROOT),
    repoArtifacts.symbolsBrief(ROOT),
    repoArtifacts.temporal(ROOT),
    repoArtifacts.architectureFull(ROOT),
    repoArtifacts.architectureCompact(ROOT),
  ]) {
    await mirrorCanonicalToLegacy(ROOT, canonicalPath).catch(() => {});
  }

  const manifest = buildArtifactManifest(ROOT, allArtifactRecords);
  const manifestPath = repoArtifacts.index(ROOT);
  await writeFile(manifestPath, serializeArtifactManifest(manifest));
  const manifestStat = await stat(manifestPath);

  const totalProblems = totalFailures + crossFailures.length + superhighFailures.length;
  const supergraphHtml = repoArtifacts.supergraphHtml(ROOT);
  const htmlExists = await stat(supergraphHtml).then(() => true).catch(() => false);

  if (!anim) {
    console.log(`\n${C.dim}━━${C.reset} ${C.bold}cross-package${C.reset} ${C.dim}${"━".repeat(43)}${C.reset}`);
    const crossLabels = ["pkg-graph", "supergraph", "cross-lang-bridge", "symbols-full", "symbols", "temporal"];
    for (let i = 0; i < crossResults.length; i++) {
      const r = crossResults[i]!;
      const label = crossLabels[i]!;
      if (i === 2 && r.status === "fulfilled" && crossLangResult?.status === "skipped") {
        console.log(`  ${C.dim}·${C.reset}  ${label}  ${C.dim}${crossLangResult.reason ?? "skipped"}${C.reset}`);
        continue;
      }
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
    console.log(`  ${C.dim}→ .supergraph/${C.reset}`);
  }

  // -----------------------------------------------------------------------
  // Stop animation before summary
  // -----------------------------------------------------------------------
  if (anim) {
    if (totalProblems === 0) {
      anim.update("done — finishing up...");
    } else {
      anim.update(`done (${totalProblems} issue${totalProblems > 1 ? "s" : ""}) — finishing up...`);
    }
    // Let the animation render the final status for a moment, then kill the
    // subprocess entirely.  Bun's process.stdin events don't fire while a
    // child process with inherited stdout is alive.
    await new Promise((r) => setTimeout(r, 400));
    await anim.stop(); // waits for subprocess to exit + clear screen
  }

  // -----------------------------------------------------------------------
  // Summary (printed after animation clears)
  // -----------------------------------------------------------------------
  const pkgsWithFailures = allResults.filter((p) => p.results.some((r) => !r.ok));
  const totalPkgs = tsTargets.length + goTargets.length;
  const totalElapsed = ((Date.now() - pipelineT0) / 1000).toFixed(1);

  const bar = `${C.dim}${"═".repeat(60)}${C.reset}`;
  console.log(`\n${bar}`);

  // ── Header ──
  if (totalProblems === 0) {
    console.log(`${C.green}${C.bold}  ✓  All ${totalPkgs} package(s) audited successfully${C.reset}  ${C.dim}(${totalElapsed}s)${C.reset}`);
  } else {
    console.log(`${C.yellow}${C.bold}  ⚠  ${totalPkgs} package(s) audited with ${totalProblems} issue(s)${C.reset}  ${C.dim}(${totalElapsed}s)${C.reset}`);
  }
  console.log(bar);

  // ── Per-package results ──
  console.log(`\n${C.bold}  Packages${C.reset}\n`);
  for (const { pkgName, results } of allResults) {
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    const totalTools = results.length;
    const icon = failed.length === 0 ? `${C.green}✓${C.reset}` : `${C.yellow}⚠${C.reset}`;
    // Collect sizes (non-json text outputs only)
    const textResults = results.filter((r) => r.ok && !r.tool.json && r.size && r.size !== "? KB");
    const sizeNote = textResults.length > 0
      ? `  ${C.dim}${textResults.map(r => `${r.tool.label}: ${r.size}`).join(", ")}${C.reset}`
      : "";
    console.log(`  ${icon}  ${C.bold}${pkgName.padEnd(22)}${C.reset} ${C.dim}${ok}/${totalTools} tools${C.reset}${failed.length > 0 ? `  ${C.red}${failed.length} failed${C.reset}` : ""}`);
    if (failed.length > 0) {
      for (const r of failed) {
        const preview = r.error ? `  ${C.dim}${r.error.split("\n")[0]}${C.reset}` : "";
        console.log(`       ${C.red}✗${C.reset}  ${r.tool.label}${preview}`);
      }
    }
  }

  // ── Cross-package results ──
  const repoArtifactEntries = [
    ...manifest.artifacts.filter((artifact) => artifact.scope === "repo"),
    {
      id: "repo:index",
      scope: "repo" as const,
      producer: "audit",
      format: "json" as const,
      path: relative(ROOT, manifestPath),
      status: "generated" as const,
      bytes: manifestStat.size,
      summary: "artifact manifest",
    },
  ];

  console.log(`\n${C.bold}  Cross-package${C.reset}\n`);
  for (const artifact of repoArtifactEntries) {
    console.log(`  ${statusIcon(artifact.status)}  ${artifact.path}${statusSuffix(artifact)}`);
  }

  // ── Output artifacts ──
  console.log(`\n${C.bold}  Output${C.reset}  ${C.dim}→ .supergraph/${C.reset}\n`);
  for (const artifact of repoArtifactEntries) {
    if (artifact.status !== "generated" || typeof artifact.bytes !== "number") continue;
    const sizeKB = (artifact.bytes / 1024).toFixed(0);
    const sizeMB = artifact.bytes > 1024 * 1024 ? ` (${(artifact.bytes / 1024 / 1024).toFixed(1)} MB)` : "";
    console.log(`  ${C.dim}${sizeKB.padStart(6)} KB${C.reset}  ${artifact.path}${sizeMB}`);
  }
  for (const artifact of manifest.artifacts.filter((entry) =>
    entry.scope === "package" &&
    entry.status === "generated" &&
    entry.format === "html" &&
    typeof entry.bytes === "number",
  )) {
    console.log(`  ${C.dim}${(artifact.bytes / 1024).toFixed(0).padStart(6)} KB${C.reset}  ${artifact.path}`);
  }

  console.log(`\n${bar}`);

  if (htmlExists) {
    console.log(`\n  ${C.cyan}open .supergraph/views/supergraph.html${C.reset}`);
  }

  // In animation mode, wait for keypress before exiting so user can read the summary
  if (anim && htmlExists) {
    console.log(`\n  ${C.dim}press${C.reset} ${C.bold}o${C.reset} ${C.dim}to open ·${C.reset} ${C.bold}enter${C.reset} ${C.dim}to exit${C.reset}`);
    const key = await waitForKeypress();
    if (key === "o" || key === "O") {
      const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
      try {
        Bun.spawn([openCmd, supergraphHtml], { stdout: "ignore", stderr: "ignore" });
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  process.exitCode = totalProblems > 0 ? 1 : 0;
  return;
}
