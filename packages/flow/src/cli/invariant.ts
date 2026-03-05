#!/usr/bin/env bun
/**
 * Invariant verification system CLI.
 *
 * Usage:
 *   bun packages/flow/src/cli/invariant.ts <subcommand> [options]
 *
 * Subcommands:
 *   discover <src-dir>     Find testable functions with purity analysis
 *   generate <src-dir>     Produce property-based test skeletons
 *   verify <test-dir>      Run tests with feedback loop
 *   calibrate <corpus-dir> Validate against known bugs
 *   contracts <src-dir>    Generate runtime contracts from verified invariants
 *   check-log <log-file>   Check NDJSON log against invariants
 *   mutate <test-dir>      Run mutation testing
 *   prove <src-dir>        Symbolic execution proof via Z3
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { discoverFunctions } from "../invariant/function-finder.js";
import { generateTestFile, generateTestSuite } from "../invariant/test-gen.js";
import { invariantsToContracts, applyContracts, generateContractImport } from "../invariant/runtime-contracts.js";
import { checkLogInvariants, formatLogReport } from "../invariant/log-monitor.js";
import { runMutationTesting, formatMutationReport } from "../invariant/mutation-testing.js";
import { shapeToString } from "../schema/shapes.js";
import type { Invariant, DiscoveredFunction } from "../invariant/types.js";
import { getArg, hasFlag, writeOutput, shortPath, positionalArg, countBranches, STATUS_KEYWORDS, STATUS_VALUES } from "./util.js";

function printUsage(): void {
  console.log(`Usage: bun invariant.ts <subcommand> [options]

Subcommands:
  discover <src-dir>      Find testable functions with purity analysis
  generate <src-dir>      Produce property-based test skeletons
  verify <test-dir>       Run tests with feedback loop
  calibrate <corpus-dir>  Validate against known bugs
  contracts <src-dir>     Generate runtime contracts from verified invariants
  check-log <log-file>    Check NDJSON log against invariants
  mutate <test-dir>       Run mutation testing
  prove <src-dir>         Symbolic execution proof via Z3

Run '<subcommand> --help' for subcommand-specific options.`);
}

// ── discover ────────────────────────────────────────────────────────────

export interface InvariantDiscoverOptions {
  srcDir: string;
  minPurity?: number;
  suggestExtractions?: boolean;
  format?: "text" | "json" | "compact";
  outFile?: string;
}

export async function runInvariantDiscover(opts: InvariantDiscoverOptions): Promise<string> {
  const format = opts.format ?? "text";
  const minPurity = opts.minPurity ?? 0;
  const suggestExtractions = opts.suggestExtractions ?? false;

  const functions = await discoverFunctions(resolve(opts.srcDir), { minPurity, suggestExtractions });

  if (format === "json") {
    const output = JSON.stringify(functions, null, 2);
    if (opts.outFile) await writeOutput(output, opts.outFile);
    return output;
  }

  if (format === "compact") {
    const output = formatCompact(functions);
    if (opts.outFile) await writeOutput(output, opts.outFile);
    return output;
  }

  const pure = functions.filter((f) => f.purityScore >= 0.7);
  const extractable = functions.filter((f) => f.purityScore < 0.5);
  const lines: string[] = [];

  lines.push("━━━ Discovered Functions ━━━");
  lines.push("");

  if (pure.length > 0) {
    lines.push(`Pure functions (purity ≥ 0.7): ${pure.length}`);
    for (const fn of pure) {
      lines.push(`  ${fn.name}  ${shortPath(fn.filePath)}:${fn.line}  purity=${fn.purityScore.toFixed(2)}  → ${shapeToString(fn.returnType)}`);
      if (fn.similarFunctions?.length) {
        lines.push(`    similar: ${fn.similarFunctions.join(", ")}`);
      }
    }
    lines.push("");
  }

  if (extractable.length > 0) {
    lines.push(`Extraction candidates (purity < 0.5): ${extractable.length}`);
    for (const fn of extractable) {
      lines.push(`  ${fn.name}  ${shortPath(fn.filePath)}:${fn.line}  purity=${fn.purityScore.toFixed(2)}  flags=[${fn.purityFlags.join(", ")}]`);
      if (fn.extractionHint) {
        lines.push(`    hint: ${fn.extractionHint}`);
      }
    }
    lines.push("");
  }

  const middle = functions.filter((f) => f.purityScore >= 0.5 && f.purityScore < 0.7);
  if (middle.length > 0) {
    lines.push(`Other (0.5 ≤ purity < 0.7): ${middle.length}`);
    for (const fn of middle) {
      lines.push(`  ${fn.name}  ${shortPath(fn.filePath)}:${fn.line}  purity=${fn.purityScore.toFixed(2)}`);
    }
    lines.push("");
  }

  lines.push("━━━ Summary ━━━");
  lines.push(`Total: ${functions.length}  Pure: ${pure.length}  Extractable: ${extractable.length}`);

  const output = lines.join("\n");
  if (opts.outFile) await writeOutput(output, opts.outFile);
  return output;
}

async function discover(args: string[]): Promise<void> {
  const srcDir = positionalArg(args);
  if (!srcDir) {
    console.error("Usage: invariant discover <src-dir> [--min-purity <n>] [--suggest-extractions] [--format text|json] [--out <file>]");
    process.exit(1);
  }

  const minPurity = Number(getArg(args, "--min-purity") ?? "0");
  const suggestExtractions = hasFlag(args, "--suggest-extractions");
  const format = (getArg(args, "--format") ?? "text") as "text" | "json" | "compact";
  const outFile = getArg(args, "--out");

  const output = await runInvariantDiscover({ srcDir, minPurity, suggestExtractions, format, outFile });
  if (!outFile) console.log(output);
}

// ── generate ────────────────────────────────────────────────────────────

async function generate(args: string[]): Promise<void> {
  const srcDir = positionalArg(args);
  if (!srcDir) {
    console.error("Usage: invariant generate <src-dir> [--min-purity <n>] [--out-dir <dir>] [--invariants <file>] [--prove] [--dry-run]");
    process.exit(1);
  }

  const resolvedSrc = resolve(srcDir);
  const minPurity = Number(getArg(args, "--min-purity") ?? "0.7");
  const outDir = getArg(args, "--out-dir") ?? join(resolvedSrc, "__tests__", "invariants");
  const invariantsFile = getArg(args, "--invariants");
  const prove = hasFlag(args, "--prove");
  const dryRun = hasFlag(args, "--dry-run");

  const functions = await discoverFunctions(resolvedSrc, { minPurity });

  let invariantsByFunction = new Map<string, Invariant[]>();
  if (invariantsFile) {
    const raw = await readFile(resolve(invariantsFile), "utf-8");
    const invariants: Invariant[] = JSON.parse(raw);
    for (const inv of invariants) {
      const existing = invariantsByFunction.get(inv.targetFunction) ?? [];
      existing.push(inv);
      invariantsByFunction.set(inv.targetFunction, existing);
    }
  }

  const tests = generateTestSuite(functions, invariantsByFunction, { outDir: resolve(outDir), prove });

  if (dryRun) {
    console.log("Dry run — would generate:");
    for (const t of tests) {
      console.log(`  ${t.filePath}  (${t.functionName}, ${t.invariantCount} invariants)`);
    }
    console.log(`\nTotal: ${tests.length} test files`);
    return;
  }

  await mkdir(resolve(outDir), { recursive: true });
  for (const t of tests) {
    await mkdir(join(resolve(outDir)), { recursive: true });
    await writeFile(t.filePath, t.content, "utf-8");
  }

  console.log(`Generated ${tests.length} test files in ${outDir}`);
  for (const t of tests) {
    console.log(`  ${shortPath(t.filePath)}  (${t.functionName}, ${t.invariantCount} invariants)`);
  }
}

// ── verify ──────────────────────────────────────────────────────────────

async function verify(args: string[]): Promise<void> {
  const testDir = positionalArg(args);
  if (!testDir) {
    console.error("Usage: invariant verify <test-dir> [--max-retries <n>] [--prove] [--no-mutate] [--json]");
    process.exit(1);
  }

  const jsonOutput = hasFlag(args, "--json");
  const resolvedDir = resolve(testDir);

  try {
    const output = execSync(`bun test ${JSON.stringify(resolvedDir)}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (jsonOutput) {
      console.log(JSON.stringify({ status: "pass", testDir: resolvedDir, output }, null, 2));
    } else {
      console.log("━━━ Verification Results ━━━");
      console.log("");
      console.log("✓ All tests passed");
      console.log("");
      console.log(output);
    }
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; status?: number };
    if (jsonOutput) {
      console.log(JSON.stringify({
        status: "fail",
        testDir: resolvedDir,
        exitCode: execErr.status,
        stdout: execErr.stdout ?? "",
        stderr: execErr.stderr ?? "",
      }, null, 2));
    } else {
      console.log("━━━ Verification Results ━━━");
      console.log("");
      console.log("✗ Tests failed");
      console.log("");
      if (execErr.stdout) console.log(execErr.stdout);
      if (execErr.stderr) console.error(execErr.stderr);
    }
    process.exit(1);
  }
}

// ── calibrate ───────────────────────────────────────────────────────────

async function calibrate(args: string[]): Promise<void> {
  const corpusDir = positionalArg(args);
  if (!corpusDir) {
    console.error("Usage: invariant calibrate <corpus-dir>");
    process.exit(1);
  }

  const resolvedDir = resolve(corpusDir);
  const { readdirSync } = await import("node:fs");
  const entries = readdirSync(resolvedDir, { withFileTypes: true });
  const tsFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => e.name);

  console.log("━━━ Calibration ━━━");
  console.log("");
  console.log(`Corpus directory: ${resolvedDir}`);
  console.log(`Source files found: ${tsFiles.length}`);
  console.log("");

  let detected = 0;
  let total = 0;

  for (const file of tsFiles) {
    total++;
    const srcPath = join(resolvedDir, file);
    const functions = await discoverFunctions(srcPath, { minPurity: 0 });

    if (functions.length > 0) {
      const tests = generateTestSuite(functions, new Map(), {
        outDir: join(resolvedDir, ".calibrate-tmp"),
      });

      for (const t of tests) {
        await mkdir(join(resolvedDir, ".calibrate-tmp"), { recursive: true });
        await writeFile(t.filePath, t.content, "utf-8");
      }

      try {
        execSync(`bun test ${JSON.stringify(join(resolvedDir, ".calibrate-tmp"))}`, {
          encoding: "utf-8",
          stdio: "pipe",
        });
      } catch {
        detected++;
        console.log(`  ✓ ${file}: bug detected`);
        continue;
      }
    }

    console.log(`  ✗ ${file}: not detected`);
  }

  console.log("");
  console.log(`Detection rate: ${total > 0 ? ((detected / total) * 100).toFixed(1) : 0}% (${detected}/${total})`);
}

// ── contracts ───────────────────────────────────────────────────────────

async function contracts(args: string[]): Promise<void> {
  const srcDir = positionalArg(args);
  if (!srcDir) {
    console.error("Usage: invariant contracts <src-dir> --invariants <file> [--dry-run]");
    process.exit(1);
  }

  const invariantsFile = getArg(args, "--invariants");
  if (!invariantsFile) {
    console.error("--invariants <file> is required");
    process.exit(1);
  }

  const dryRun = hasFlag(args, "--dry-run");
  const resolvedSrc = resolve(srcDir);

  const raw = await readFile(resolve(invariantsFile), "utf-8");
  const invariants: Invariant[] = JSON.parse(raw);

  const functions = await discoverFunctions(resolvedSrc, { minPurity: 0 });

  const fileChanges: Array<{ filePath: string; original: string; modified: string }> = [];

  for (const func of functions) {
    const funcInvariants = invariants.filter(
      (inv) => inv.targetFunction === func.name && inv.targetFile === func.filePath,
    );
    if (funcInvariants.length === 0) continue;

    const generated = invariantsToContracts(func, funcInvariants);
    if (generated.length === 0) continue;

    const sourceCode = await readFile(func.filePath, "utf-8");
    const modified = applyContracts(sourceCode, func, generated);

    if (modified !== sourceCode) {
      fileChanges.push({ filePath: func.filePath, original: sourceCode, modified });
    }
  }

  if (fileChanges.length === 0) {
    console.log("No contracts to apply (no verified invariants matched discovered functions).");
    return;
  }

  if (dryRun) {
    console.log("Dry run — would modify:");
    for (const change of fileChanges) {
      console.log(`  ${shortPath(change.filePath)}`);
      const addedLines = change.modified.split("\n").length - change.original.split("\n").length;
      console.log(`    +${addedLines} lines (contract assertions)`);
    }
    return;
  }

  for (const change of fileChanges) {
    await writeFile(change.filePath, change.modified, "utf-8");
    console.log(`  Updated ${shortPath(change.filePath)}`);
  }
  console.log(`\nApplied contracts to ${fileChanges.length} file(s).`);
}

// ── check-log ───────────────────────────────────────────────────────────

async function checkLog(args: string[]): Promise<void> {
  const logFile = positionalArg(args);
  if (!logFile) {
    console.error("Usage: invariant check-log <log-file> --invariants <file>");
    process.exit(1);
  }

  const invariantsFile = getArg(args, "--invariants");
  if (!invariantsFile) {
    console.error("--invariants <file> is required (JSON array of {name, eventFilter, condition, severity})");
    process.exit(1);
  }

  const raw = await readFile(resolve(invariantsFile), "utf-8");
  const invariants = JSON.parse(raw);

  const results = await checkLogInvariants(resolve(logFile), invariants);
  const report = formatLogReport(results);
  console.log(report);

  const hasViolations = results.some((r) => r.violations.length > 0);
  if (hasViolations) process.exit(1);
}

// ── mutate ──────────────────────────────────────────────────────────────

async function mutate(args: string[]): Promise<void> {
  const testDir = positionalArg(args);
  if (!testDir) {
    console.error("Usage: invariant mutate <test-dir> --source-dir <dir> [--threshold <n>] [--suggest]");
    process.exit(1);
  }

  const sourceDir = getArg(args, "--source-dir");
  if (!sourceDir) {
    console.error("--source-dir <dir> is required");
    process.exit(1);
  }

  const threshold = Number(getArg(args, "--threshold") ?? "80");

  const report = await runMutationTesting({
    testDir: resolve(testDir),
    sourceDir: resolve(sourceDir),
    threshold,
  });

  console.log(formatMutationReport(report));

  if (report.mutationScore < threshold) {
    console.error(`\nMutation score ${report.mutationScore.toFixed(1)}% is below threshold ${threshold}%`);
    process.exit(1);
  }
}

// ── prove ───────────────────────────────────────────────────────────────

async function prove(args: string[]): Promise<void> {
  const srcDir = positionalArg(args);
  if (!srcDir) {
    console.error("Usage: invariant prove <src-dir> --invariants <file> [--max-paths <n>] [--timeout <ms>]");
    process.exit(1);
  }

  const invariantsFile = getArg(args, "--invariants");
  if (!invariantsFile) {
    console.error("--invariants <file> is required");
    process.exit(1);
  }

  const maxPaths = Number(getArg(args, "--max-paths") ?? "64");
  const timeout = Number(getArg(args, "--timeout") ?? "10000");
  const jsonOutput = hasFlag(args, "--json");
  const resolvedSrc = resolve(srcDir);

  const functions = await discoverFunctions(resolvedSrc, { minPurity: 0 });
  const raw = await readFile(resolve(invariantsFile), "utf-8");
  const invariants: Invariant[] = JSON.parse(raw);

  const { proveInvariant, formatProofResults } = await import("../invariant/symbolic-executor.js");
  type ProofResult = Awaited<ReturnType<typeof proveInvariant>>;
  const results: ProofResult[] = [];

  for (const func of functions) {
    const funcInvariants = invariants.filter((inv) => inv.targetFunction === func.name);
    if (funcInvariants.length === 0) continue;

    if (!jsonOutput) console.log(`Proving ${func.name}...`);
    for (const inv of funcInvariants) {
      const result = await proveInvariant(func, inv, { maxPaths, timeoutMs: timeout });
      results.push(result);
      if (!jsonOutput) {
        const sym = result.status === "proven" ? "✓" : result.status === "counterexample" ? "✗" : "?";
        console.log(`  ${sym} ${inv.name}: ${result.status}`);
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log("");
    console.log(formatProofResults(results));
  }

  const hasFailed = results.some((r) => r.status === "counterexample");
  if (hasFailed) process.exit(1);
}

// ── compact format ──────────────────────────────────────────────────

const DISPATCH_KEYWORDS = /\b(dispatch|spawn|schedule|assign|enqueue|start|launch)\b/i;

function isStatusFunction(fn: DiscoveredFunction): boolean {
  const retStr = shapeToString(fn.returnType);
  if (STATUS_VALUES.test(retStr)) return true;
  if (fn.returnType.kind === "union") {
    const hasStatusLiteral = fn.returnType.members.some(
      (m) => m.kind === "literal" && typeof m.value === "string" && STATUS_VALUES.test(m.value),
    );
    if (hasStatusLiteral) return true;
  }
  if (fn.returnType.kind === "object") {
    const hasStatusField = fn.returnType.fields.some(
      (f) => STATUS_KEYWORDS.test(f.name) || (f.type.kind === "union" && f.type.members.some(
        (m) => m.kind === "literal" && typeof m.value === "string" && STATUS_VALUES.test(m.value),
      )),
    );
    if (hasStatusField) return true;
  }
  if (STATUS_KEYWORDS.test(fn.name)) return true;
  return false;
}

function isDispatchFunction(fn: DiscoveredFunction): boolean {
  if (DISPATCH_KEYWORDS.test(fn.name)) return true;
  if (fn.returnType.kind === "promise") return false; // too broad on its own
  return false;
}

function formatCompact(functions: DiscoveredFunction[]): string {
  const lines: string[] = [];
  const statusFns = functions.filter(isStatusFunction);
  const dispatchFns = functions.filter((fn) => isDispatchFunction(fn) && !statusFns.includes(fn));
  const pure = functions.filter((f) => f.purityScore >= 0.7);

  const complexFns = functions
    .map((fn) => ({ fn, branches: countBranches(fn.sourceText) }))
    .filter((x) => x.branches > 6)
    .sort((a, b) => b.branches - a.branches)
    .slice(0, 20);

  lines.push("━━━ Compact Function Discovery ━━━");
  lines.push(`Total: ${functions.length} exported functions`);
  lines.push("");

  // Status-determining functions
  lines.push(`## Status-Determining Functions (${statusFns.length})`);
  lines.push("Functions that return or produce status/outcome values — priority targets for decision pipeline analysis.");
  lines.push("");
  for (const fn of statusFns) {
    const branches = countBranches(fn.sourceText);
    lines.push(`  ${fn.name}  ${shortPath(fn.filePath)}:${fn.line}  branches=${branches}  purity=${fn.purityScore.toFixed(2)}  → ${shapeToString(fn.returnType)}`);
  }
  lines.push("");

  // Dispatch/scheduling functions
  lines.push(`## Dispatch/Scheduling Functions (${dispatchFns.length})`);
  lines.push("Functions that dispatch work, collect dependencies, or make scheduling decisions — check for guard completeness.");
  lines.push("");
  for (const fn of dispatchFns) {
    const branches = countBranches(fn.sourceText);
    lines.push(`  ${fn.name}  ${shortPath(fn.filePath)}:${fn.line}  branches=${branches}  purity=${fn.purityScore.toFixed(2)}  flags=[${fn.purityFlags.join(", ")}]`);
  }
  lines.push("");

  // Pure functions (invariant candidates)
  lines.push(`## Pure Functions — Invariant Candidates (${pure.length})`);
  lines.push("Functions with purity >= 0.7, suitable for property-based testing.");
  lines.push("");
  for (const fn of pure) {
    lines.push(`  ${fn.name}  ${shortPath(fn.filePath)}:${fn.line}  purity=${fn.purityScore.toFixed(2)}  → ${shapeToString(fn.returnType)}`);
    if (fn.similarFunctions?.length) {
      lines.push(`    similar: ${fn.similarFunctions.join(", ")}`);
    }
  }
  lines.push("");

  // Async-pure functions
  const asyncPureFns = functions.filter(
    (f) => f.purityScore >= 0.5 && f.purityScore < 0.7 && f.purityFlags.includes("await-pure"),
  );
  lines.push(`## Async-Pure Functions (${asyncPureFns.length})`);
  lines.push("Async functions with high effective purity — good candidates for integration-level invariant testing.");
  lines.push("");
  for (const fn of asyncPureFns) {
    lines.push(`  ${fn.name}  ${shortPath(fn.filePath)}:${fn.line}  purity=${fn.purityScore.toFixed(2)}  flags=[${fn.purityFlags.join(", ")}]  → ${shapeToString(fn.returnType)}`);
  }
  lines.push("");

  // Complexity hotspots
  lines.push(`## Complexity Hotspots (${complexFns.length})`);
  lines.push("Functions with high branch count — review for predicate correctness and temporal ordering.");
  lines.push("");
  for (const { fn, branches } of complexFns) {
    const lineCount = fn.sourceText.split("\n").length;
    lines.push(`  ${fn.name}  ${shortPath(fn.filePath)}:${fn.line}  branches=${branches}  lines=${lineCount}  purity=${fn.purityScore.toFixed(2)}`);
    if (fn.extractionHint) {
      lines.push(`    hint: ${fn.extractionHint}`);
    }
  }
  lines.push("");

  lines.push("━━━ Summary ━━━");
  lines.push(`Status functions: ${statusFns.length}  Dispatch functions: ${dispatchFns.length}  Pure: ${pure.length}  Async-pure: ${asyncPureFns.length}  Complex: ${complexFns.length}`);

  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const restArgs = args.slice(1);

  switch (subcommand) {
    case "discover": return discover(restArgs);
    case "generate": return generate(restArgs);
    case "verify": return verify(restArgs);
    case "calibrate": return calibrate(restArgs);
    case "contracts": return contracts(restArgs);
    case "check-log": return checkLog(restArgs);
    case "mutate": return mutate(restArgs);
    case "prove": return prove(restArgs);
    default:
      printUsage();
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
