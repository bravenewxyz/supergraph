#!/usr/bin/env bun
/**
 * Structural impedance analysis — detect accidental complexity from type misalignment.
 *
 * This CLI delegates to @supergraph/graph's complexity analysis which is a
 * superset (cyclomatic complexity, nesting depth, escape-hatch density,
 * pure adapters, data clumps, type overlaps).
 *
 * Usage:
 *   bun packages/flow/src/cli/complexity-audit.ts <src-dir> [--out <file>] [--top N] [--min-complexity N]
 */

import { resolve } from "node:path";
import { runComplexity } from "../../../graph/src/cli/complexity.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const srcDir = args.find(a => !a.startsWith("--"));
  if (!srcDir) {
    console.error("Usage: bun complexity-audit.ts <src-dir> [--out <file>] [--top N] [--min-complexity N]");
    process.exit(1);
  }

  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;
  const topIdx = args.indexOf("--top");
  const topN = topIdx !== -1 && args[topIdx + 1] ? parseInt(args[topIdx + 1]!, 10) : undefined;
  const minIdx = args.indexOf("--min-complexity");
  const minComplexity = minIdx !== -1 && args[minIdx + 1] ? parseInt(args[minIdx + 1]!, 10) : undefined;

  const output = await runComplexity({
    srcRoot: resolve(srcDir),
    outPath,
    topN,
    minComplexity,
  });

  if (!outPath) process.stdout.write(output);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
