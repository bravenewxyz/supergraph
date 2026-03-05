#!/usr/bin/env bun

import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import goLang from "@ast-grep/lang-go";
import { parse, registerDynamicLanguage } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";

let goRegistered = false;
function ensureGo(): void {
  if (!goRegistered) {
    registerDynamicLanguage({ go: goLang });
    goRegistered = true;
  }
}

const SKIP_DIRS = new Set(["vendor", "testdata", "node_modules", ".git"]);

async function collectGoFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) results.push(...(await collectGoFiles(full)));
    } else if (e.name.endsWith(".go") && !e.name.endsWith("_test.go"))
      results.push(full);
  }
  return results.sort();
}

const BRANCH_KINDS = new Set([
  "if_statement",
  "for_statement",
  "expression_switch_statement",
  "type_switch_statement",
  "select_statement",
  "expression_case",
  "type_case",
  "default_case",
]);

const LOGICAL_OPS = new Set(["&&", "||"]);

const NESTING_KINDS = new Set([
  "if_statement",
  "for_statement",
  "expression_switch_statement",
  "type_switch_statement",
  "select_statement",
]);

function countBranches(node: SgNode): number {
  let count = 0;
  if (BRANCH_KINDS.has(node.kind())) count++;
  if (node.kind() === "binary_expression") {
    const opNode = node.children().find((c) => LOGICAL_OPS.has(c.text()));
    if (opNode) count++;
  }
  for (const child of node.children()) {
    if (
      child.kind() !== "function_declaration" &&
      child.kind() !== "method_declaration" &&
      child.kind() !== "func_literal"
    ) {
      count += countBranches(child);
    }
  }
  return count;
}

function maxNesting(node: SgNode, depth = 0): number {
  let max = depth;
  const childDepth = NESTING_KINDS.has(node.kind()) ? depth + 1 : depth;
  for (const child of node.children()) {
    if (
      child.kind() !== "function_declaration" &&
      child.kind() !== "method_declaration" &&
      child.kind() !== "func_literal"
    ) {
      const n = maxNesting(child, childDepth);
      if (n > max) max = n;
    }
  }
  return max;
}

interface FnMetrics {
  name: string;
  module: string;
  complexity: number;
  nesting: number;
  loc: number;
  exported: boolean;
  line: number;
}

function isExported(name: string): boolean {
  return (
    name.length > 0 && name.charCodeAt(0) >= 65 && name.charCodeAt(0) <= 90
  );
}

function analyzeGoFile(code: string, module: string): FnMetrics[] {
  ensureGo();
  const tree = parse("go", code);
  const root = tree.root();
  const results: FnMetrics[] = [];

  const funcs = root.findAll({ rule: { kind: "function_declaration" } });
  for (const fn of funcs) {
    const name = fn.field("name")?.text() ?? "(anonymous)";
    const body = fn.field("body");
    if (!body) continue;
    const range = fn.range();
    const loc = range.end.line - range.start.line + 1;
    results.push({
      name,
      module,
      complexity: 1 + countBranches(body),
      nesting: maxNesting(body),
      loc,
      exported: isExported(name),
      line: range.start.line + 1,
    });
  }

  const methods = root.findAll({ rule: { kind: "method_declaration" } });
  for (const method of methods) {
    const name = method.field("name")?.text() ?? "(anonymous)";
    const receiver = method.field("receiver")?.text() ?? "";
    const receiverType = receiver.match(/\*?(\w+)\s*\)/)?.[1] ?? "";
    const fullName = receiverType ? `${receiverType}.${name}` : name;
    const body = method.field("body");
    if (!body) continue;
    const range = method.range();
    const loc = range.end.line - range.start.line + 1;
    results.push({
      name: fullName,
      module,
      complexity: 1 + countBranches(body),
      nesting: maxNesting(body),
      loc,
      exported: isExported(name),
      line: range.start.line + 1,
    });
  }

  return results;
}

function col(s: string | number, w: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(w) : str.padEnd(w);
}

function renderText(
  pkg: string,
  functions: FnMetrics[],
  topN: number,
  minComplexity: number,
): string {
  const lines: string[] = [];
  const totalFiles = new Set(functions.map((f) => f.module)).size;

  lines.push(`# ${pkg} — Go Complexity Analysis`);
  lines.push(`${totalFiles} files | ${functions.length} functions analyzed`);
  lines.push("");

  const hot = functions
    .filter((f) => f.complexity >= minComplexity)
    .sort((a, b) => b.complexity - a.complexity || b.nesting - a.nesting)
    .slice(0, topN);

  lines.push("## Complexity Hotspots");
  lines.push(`(cyclomatic ≥ ${minComplexity}, top ${topN} by complexity)`);
  lines.push("");
  if (hot.length === 0) {
    lines.push("  none above threshold");
  } else {
    lines.push(
      `  ${col("complexity", 11, true)}  ${col("nesting", 7, true)}  ${col("loc", 5, true)}  ${col("function", 40)}  module`,
    );
    for (const f of hot) {
      const name = f.name.length > 38 ? `${f.name.slice(0, 37)}…` : f.name;
      lines.push(
        `  ${col(f.complexity, 11, true)}  ${col(f.nesting, 7, true)}  ${col(f.loc, 5, true)}  ${col(name + (f.exported ? "" : " (unexp)"), 40)}  ${f.module}:${f.line}`,
      );
    }
  }
  lines.push("");

  const hotNesting = functions
    .filter((f) => f.nesting >= 4)
    .sort((a, b) => b.nesting - a.nesting || b.complexity - a.complexity)
    .slice(0, topN);

  lines.push("## Nesting Hotspots");
  lines.push("(max nesting depth ≥ 4)");
  lines.push("");
  if (hotNesting.length === 0) {
    lines.push("  none above threshold");
  } else {
    lines.push(
      `  ${col("nesting", 7, true)}  ${col("complexity", 11, true)}  ${col("loc", 5, true)}  ${col("function", 40)}  module`,
    );
    for (const f of hotNesting) {
      const name = f.name.length > 38 ? `${f.name.slice(0, 37)}…` : f.name;
      lines.push(
        `  ${col(f.nesting, 7, true)}  ${col(f.complexity, 11, true)}  ${col(f.loc, 5, true)}  ${col(name, 40)}  ${f.module}:${f.line}`,
      );
    }
  }
  lines.push("");

  const avgComplexity =
    functions.length > 0
      ? (
          functions.reduce((s, f) => s + f.complexity, 0) / functions.length
        ).toFixed(1)
      : "0.0";
  const maxC =
    functions.length > 0 ? Math.max(...functions.map((f) => f.complexity)) : 0;
  lines.push("## Summary");
  lines.push(`  Average complexity: ${avgComplexity}`);
  lines.push(`  Max complexity: ${maxC}`);
  lines.push(`  Functions ≥ ${minComplexity}: ${hot.length}`);
  lines.push(`  Functions with nesting ≥ 4: ${hotNesting.length}`);

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export interface GoComplexityOptions {
  srcRoot: string;
  outPath?: string;
  topN?: number;
  minComplexity?: number;
}

export async function runGoComplexity(opts: GoComplexityOptions): Promise<string> {
  const srcRoot = opts.srcRoot;
  const outPath = opts.outPath;
  const topN = opts.topN ?? 30;
  const minComplexity = opts.minComplexity ?? 5;

  let packageName = basename(resolve(srcRoot, ".."));
  try {
    const modFile = await readFile(join(srcRoot, "go.mod"), "utf-8");
    const match = modFile.match(/^module\s+(\S+)/m);
    if (match?.[1]) packageName = match[1].split("/").pop() ?? packageName;
  } catch {
    try {
      const modFile = await readFile(join(dirname(srcRoot), "go.mod"), "utf-8");
      const match = modFile.match(/^module\s+(\S+)/m);
      if (match?.[1]) packageName = match[1].split("/").pop() ?? packageName;
    } catch {
      /* use dir name */
    }
  }

  const files = await collectGoFiles(srcRoot);
  const allFunctions: FnMetrics[] = [];

  await Promise.all(
    files.map(async (filePath) => {
      const code = await readFile(filePath, "utf-8");
      const relPath = relative(srcRoot, filePath).replace(/\.go$/, "");
      allFunctions.push(...analyzeGoFile(code, relPath));
    }),
  );

  const output = renderText(packageName, allFunctions, topN, minComplexity);

  if (outPath) {
    await Bun.write(outPath, output);
    process.stderr.write(
      `Output written to ${outPath} (${(output.length / 1024).toFixed(0)} KB)\n`,
    );
  }

  return output;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || args[0] === "--help" || args[0] === "-h") {
    process.stderr.write(
      "Usage: bun devtools/graph/src/cli/go-complexity.ts <go-dir> [--out <file>] [--top N] [--min-complexity N]\n",
    );
    process.exit(1);
  }

  const arg0 = args[0];
  if (!arg0) process.exit(1);
  const srcRoot = resolve(arg0);
  const outIdx = args.indexOf("--out");
  const outPath =
    outIdx !== -1 && args[outIdx + 1]
      ? resolve(args[outIdx + 1] as string)
      : undefined;
  const topIdx = args.indexOf("--top");
  const topN =
    topIdx !== -1 && args[topIdx + 1]
      ? Number.parseInt(args[topIdx + 1] as string, 10)
      : 30;
  const minIdx = args.indexOf("--min-complexity");
  const minComplexity =
    minIdx !== -1 && args[minIdx + 1]
      ? Number.parseInt(args[minIdx + 1] as string, 10)
      : 5;

  const output = await runGoComplexity({ srcRoot, outPath, topN, minComplexity });
  if (!outPath) process.stdout.write(output);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`${err}\n`);
    process.exit(1);
  });
}
