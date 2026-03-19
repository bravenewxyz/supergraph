/**
 * temporal.ts — Git temporal analysis: hotspots, change coupling, file age, author knowledge.
 *
 * Finds risk zones that static analysis can't detect by mining git history.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, basename } from "node:path";
import { parseRootArg } from "./utils.js";

const execAsync = promisify(exec);

// ─── Public API ──────────────────────────────────────────────────────────────

export interface TemporalOptions {
  root: string;
  window?: "2w" | "3mo" | "6mo" | "1yr" | "all";
  format?: "text" | "json";
}

export async function runTemporal(opts: TemporalOptions): Promise<string> {
  const root = resolve(opts.root);
  const window = opts.window ?? "3mo";
  const format = opts.format ?? "text";
  const since = sinceFlag(window);

  // ── 1. Gather raw data ──────────────────────────────────────────────────
  const [hotspots, coupling, projectStats] = await Promise.all([
    getHotspots(root, since),
    getChangeCoupling(root, since),
    getProjectStats(root, since),
  ]);
  // These depend on hotspots, so run after
  const [ageInfo, authorInfo] = await Promise.all([
    getFileAge(root, hotspots.map((h) => h.file)),
    getAuthorKnowledge(root, hotspots.map((h) => h.file)),
  ]);

  // ── 2. Merge into enriched hotspot list ─────────────────────────────────
  const enriched = hotspots.slice(0, 20).map((h) => ({
    file: h.file,
    changes: h.count,
    age: ageInfo.get(h.file) ?? { label: "UNKNOWN", days: -1 },
    authors: authorInfo.get(h.file) ?? [],
  }));

  // ── 3. Cross-package coupling detection ─────────────────────────────────
  const couplingEnriched = coupling.map((c) => {
    // Compare at package level: "packages/flow/..." vs "packages/graph/..."
    const pkgOf = (f: string) => {
      const parts = f.split("/");
      if (parts[0] === "packages" && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      if (parts[0] === "src") return "src";
      return parts[0] ?? "";
    };
    const samePkg = pkgOf(c.fileA) === pkgOf(c.fileB);
    return { ...c, samePkg };
  });

  // ── 4. Knowledge risk ───────────────────────────────────────────────────
  const allAuthors = new Map<string, number>();
  for (const [, authors] of authorInfo) {
    for (const a of authors) {
      allAuthors.set(a, (allAuthors.get(a) ?? 0) + 1);
    }
  }
  const totalFiles = authorInfo.size;
  const singleAuthorFiles = [...authorInfo.values()].filter((a) => a.length === 1).length;
  const singleAuthorPct = totalFiles > 0 ? (singleAuthorFiles / totalFiles) * 100 : 0;
  const knowledgeRisk =
    singleAuthorPct > 80 ? "CRITICAL" : singleAuthorPct > 60 ? "HIGH" : singleAuthorPct > 40 ? "MODERATE" : "LOW";

  // Sort authors by commit involvement
  const authorCommits = await getAuthorCommitCounts(root, since);
  const sortedAuthors = [...authorCommits.entries()].sort((a, b) => b[1] - a[1]);
  const totalCommits = sortedAuthors.reduce((s, [, c]) => s + c, 0);

  // ── 5. Build output ─────────────────────────────────────────────────────
  const data = {
    project: basename(root),
    date: new Date().toISOString().slice(0, 10),
    window,
    stats: projectStats,
    hotspots: enriched,
    coupling: couplingEnriched,
    authors: sortedAuthors.map(([email, commits]) => ({
      email,
      commits,
      pct: totalCommits > 0 ? +((commits / totalCommits) * 100).toFixed(1) : 0,
    })),
    knowledgeRisk: {
      singleAuthorFiles,
      totalFiles,
      pct: +singleAuthorPct.toFixed(0),
      level: knowledgeRisk,
    },
    summary: {
      hotspotsAbove5: hotspots.filter((h) => h.count >= 5).length,
      couplingPairs: coupling.length,
      crossPkgPairs: couplingEnriched.filter((c) => !c.samePkg).length,
      knowledgeRisk,
    },
  };

  if (format === "json") return JSON.stringify(data, null, 2);
  return formatText(data);
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

async function git(cmd: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git ${cmd}`, { cwd, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function sinceFlag(window: string): string {
  switch (window) {
    case "2w":  return '--since="2 weeks ago"';
    case "3mo": return '--since="3 months ago"';
    case "6mo": return '--since="6 months ago"';
    case "1yr": return '--since="1 year ago"';
    case "all": return "";
    default:    return '--since="3 months ago"';
  }
}

const CODE_EXT = /\.(tsx?|jsx?)$/;
const EXCLUDE = /^(dist|node_modules|\.git)\//;
const FILTER_OUT = /\.(lock|yml|yaml|md)$|^package\.json$|\.json$/;

function isRelevantFile(f: string): boolean {
  if (!f || EXCLUDE.test(f)) return false;
  if (FILTER_OUT.test(f) && !f.endsWith("tsconfig.json")) return false;
  return CODE_EXT.test(f);
}

// ─── Analysis functions ──────────────────────────────────────────────────────

async function getHotspots(root: string, since: string): Promise<{ file: string; count: number }[]> {
  const raw = await git(`log --no-merges ${since} --name-only --format=""`, root);
  if (!raw) return [];
  const counts = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const f = line.trim();
    if (!isRelevantFile(f)) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count);
}

async function getChangeCoupling(
  root: string,
  since: string,
): Promise<{ fileA: string; fileB: string; count: number }[]> {
  const raw = await git(`log --no-merges ${since} --name-only --format="%H"`, root);
  if (!raw) return [];

  // Parse commits
  const commits: string[][] = [];
  let current: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length > 0) {
        commits.push(current);
        current = [];
      }
      continue;
    }
    // SHA lines are 40 hex chars
    if (/^[0-9a-f]{40}$/.test(trimmed)) {
      if (current.length > 0) commits.push(current);
      current = [];
    } else if (isRelevantFile(trimmed)) {
      current.push(trimmed);
    }
  }
  if (current.length > 0) commits.push(current);

  // Count pairs
  const pairs = new Map<string, number>();
  for (const files of commits) {
    if (files.length < 2 || files.length > 50) continue; // skip huge commits
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = files[i]! < files[j]! ? `${files[i]}|${files[j]}` : `${files[j]}|${files[i]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  return [...pairs.entries()]
    .filter(([, count]) => count >= 3)
    .map(([key, count]) => {
      const [fileA, fileB] = key.split("|") as [string, string];
      return { fileA, fileB, count };
    })
    .sort((a, b) => b.count - a.count);
}

async function getFileAge(root: string, files: string[]): Promise<Map<string, { label: string; days: number }>> {
  const result = new Map<string, { label: string; days: number }>();
  const now = Date.now();
  for (const f of files) {
    const dateStr = await git(`log -1 --format="%aI" -- "${f}"`, root);
    if (!dateStr) continue;
    const ms = now - new Date(dateStr).getTime();
    const days = Math.floor(ms / 86_400_000);
    let label: string;
    if (days <= 7) label = "RECENT";
    else if (days <= 30) label = "ACTIVE";
    else if (days <= 90) label = "STABLE";
    else label = "DORMANT";
    result.set(f, { label, days });
  }
  return result;
}

async function getAuthorKnowledge(root: string, files: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const f of files) {
    const raw = await git(`log --all --format="%ae" -- "${f}"`, root);
    if (!raw) continue;
    const unique = [...new Set(raw.split("\n").map((l) => l.trim()).filter(Boolean))];
    result.set(f, unique);
  }
  return result;
}

async function getAuthorCommitCounts(root: string, since: string): Promise<Map<string, number>> {
  const raw = await git(`log --no-merges ${since} --format="%ae"`, root);
  if (!raw) return new Map();
  const counts = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const email = line.trim();
    if (!email) continue;
    counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  return counts;
}

async function getProjectStats(root: string, since: string): Promise<{ commits: number; authors: number; activeDays: number }> {
  const raw = await git(`log --no-merges ${since} --format="%ae|%aI"`, root);
  if (!raw) return { commits: 0, authors: 0, activeDays: 0 };
  const authors = new Set<string>();
  const days = new Set<string>();
  let commits = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    commits++;
    const [email, date] = trimmed.split("|") as [string, string];
    authors.add(email);
    days.add(date.slice(0, 10));
  }
  return { commits, authors: authors.size, activeDays: days.size };
}

// ─── Text formatter ──────────────────────────────────────────────────────────

function formatText(data: ReturnType<typeof buildData>): string {
  const lines: string[] = [];
  const { project, date, window, stats, hotspots, coupling, authors, knowledgeRisk, summary } = data as any;

  lines.push(`TEMPORAL | ${project} | ${date} | window: ${window}`);
  lines.push(`${stats.commits} commits · ${stats.authors} authors · ${stats.activeDays} days active`);
  lines.push("");

  // Hotspots
  lines.push("## Hotspots (top 20 by change frequency)");
  if (hotspots.length === 0) {
    lines.push("  (no code file changes in window)");
  }
  for (const h of hotspots) {
    const countStr = String(h.changes).padStart(4);
    const ageStr = h.age.days >= 0 ? `[${h.age.label} ${h.age.days}d]` : "[UNKNOWN]";
    const authStr = `${h.authors.length} author${h.authors.length !== 1 ? "s" : ""}`;
    lines.push(`  ${countStr}× ${h.file.padEnd(45)} ${ageStr.padEnd(14)} ${authStr}`);
  }
  lines.push("");

  // Coupling
  lines.push("## Change Coupling (co-changed 3+ times)");
  if (coupling.length === 0) {
    lines.push("  (no coupling detected)");
  }
  for (const c of coupling) {
    const countStr = String(c.count).padStart(4);
    const tag = c.samePkg ? "[same pkg]" : "[cross-pkg !]";
    lines.push(`  ${countStr}× ${c.fileA} ↔ ${c.fileB}  ${tag}`);
  }
  lines.push("");

  // Knowledge risk
  lines.push("## Knowledge Risk");
  for (const a of authors) {
    lines.push(`  Authors: ${a.email} (${a.commits} commits, ${a.pct}%)`);
  }
  lines.push(
    `  Single-author files: ${knowledgeRisk.singleAuthorFiles}/${knowledgeRisk.totalFiles} (${knowledgeRisk.pct}%) → ${knowledgeRisk.level}`,
  );
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push(`  Hotspots: ${summary.hotspotsAbove5} files with 5+ changes`);
  lines.push(`  Coupling: ${summary.couplingPairs} pairs with 3+ co-changes (${summary.crossPkgPairs} cross-package)`);
  lines.push(`  Knowledge risk: ${summary.knowledgeRisk} (single author dominance)`);

  return lines.join("\n");
}

// Dummy type alias so formatText signature reads well
type buildData = never;

// ─── CLI entry point ─────────────────────────────────────────────────────────

if (import.meta.main) {
  const root = parseRootArg(process.cwd());
  const window = (process.argv.find((a) => a.startsWith("--window="))?.split("=")[1] ?? "3mo") as TemporalOptions["window"];
  const format = process.argv.includes("--json") ? "json" : "text";
  const outArg = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1];

  const result = await runTemporal({ root, window, format });
  if (outArg) await Bun.write(outArg, result);
  else console.log(result);
}
