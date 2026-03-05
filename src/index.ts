#!/usr/bin/env bun

/**
 * supergraph CLI — unified entry point for all analysis tools.
 *
 * Usage:
 *   supergraph                              Full pipeline: audit all packages + aggregate
 *   supergraph map <src-dir> [options]      Per-package: map.txt, deps.txt, imports.txt
 *   supergraph complexity <src-dir> [opts]  Per-package: complexity.txt
 *   supergraph dead-exports <src-dir>       Per-package: dead.txt
 *   supergraph schema-match <src-dir>       Per-package: schema-match.txt
 *   supergraph trace <src-dir> [opts]       Per-package: trace-boundaries.txt
 *   supergraph logic-audit <src-dir>        Per-package: logic-audit.txt
 *   supergraph contracts [options]          Per-package: contracts.txt
 *   supergraph invariant <subcmd> [opts]    Per-package: discovery.txt + subcommands
 *   supergraph aggregate [--root <path>]    Cross-package: supergraph.txt/html
 *   supergraph pkg-graph [--root <path>]    Cross-package: pkg-graph.html
 */

import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// Auto-install /deep-audit Claude Code command on first run
import { existsSync } from "node:fs";

const supergraphDir = join(homedir(), ".supergraph");
const setupDone = join(supergraphDir, ".setup-done");
if (!existsSync(setupDone)) {
  const DEEP_AUDIT_URL = "https://raw.githubusercontent.com/bravenewxyz/supergraph/master/commands/deep-audit.md";
  const claudeCmdDir = join(homedir(), ".claude", "commands");
  const deepAuditDest = join(claudeCmdDir, "deep-audit.md");
  try {
    const res = await fetch(DEEP_AUDIT_URL);
    if (res.ok) {
      mkdirSync(claudeCmdDir, { recursive: true });
      writeFileSync(deepAuditDest, await res.text());
      console.log(`Installed /deep-audit command for Claude Code`);
    }
    mkdirSync(supergraphDir, { recursive: true });
    writeFileSync(setupDone, new Date().toISOString());
  } catch {
    // offline — skip silently
  }
}

const args = process.argv.slice(2);
const subcommand = args[0] && !args[0].startsWith("--") ? args[0] : null;
const restArgs = subcommand ? args.slice(1) : args;

function parseRoot(): string {
  const idx = args.indexOf("--root");
  if (idx >= 0 && args[idx + 1]) return resolve(args[idx + 1]!);
  return process.cwd();
}

async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    if (!subcommand) {
      console.log(`supergraph — unified code analysis toolkit

Usage:
  supergraph                              Run full audit pipeline
  supergraph <command> [options]          Run a specific tool

Commands:
  map <src-dir>           Build semantic graph (map.txt, deps.txt, imports.txt)
  complexity <src-dir>    Per-function cyclomatic complexity analysis
  dead-exports <src-dir>  Detect unused exports
  schema-match <src-dir>  Find runtime schema ↔ TypeScript type mismatches
  trace <src-dir>         Trace data flow through boundaries
  logic-audit <src-dir>   Detect decision-logic bugs
  contracts [options]     FE↔BE contract verification
  invariant <subcmd>      Invariant verification system
  aggregate               Build cross-package supergraph visualization
  pkg-graph               Build package dependency visualization

Global options:
  --root <path>           Target repo root (default: cwd)
  --help, -h              Show help`);
      process.exit(0);
    }
  }

  switch (subcommand) {
    case "map": {
      const { runMapCommand } = await import("./commands/map.js");
      await runMapCommand(restArgs);
      break;
    }
    case "complexity": {
      const { runComplexityCommand } = await import("./commands/complexity.js");
      await runComplexityCommand(restArgs);
      break;
    }
    case "dead-exports": {
      const { runDeadExportsCommand } = await import("./commands/dead-exports.js");
      await runDeadExportsCommand(restArgs);
      break;
    }
    case "schema-match": {
      const { runSchemaMatchCommand } = await import("./commands/schema-match.js");
      await runSchemaMatchCommand(restArgs);
      break;
    }
    case "trace": {
      const { runTraceCommand } = await import("./commands/trace.js");
      await runTraceCommand(restArgs);
      break;
    }
    case "logic-audit": {
      const { runLogicAuditCommand } = await import("./commands/logic-audit.js");
      await runLogicAuditCommand(restArgs);
      break;
    }
    case "contracts": {
      const { runContractsCommand } = await import("./commands/contracts.js");
      await runContractsCommand(restArgs);
      break;
    }
    case "invariant": {
      const { runInvariantCommand } = await import("./commands/invariant.js");
      await runInvariantCommand(restArgs);
      break;
    }
    case "aggregate": {
      const { runAggregate } = await import("../scripts/supergraph.js");
      await runAggregate({ root: parseRoot() });
      break;
    }
    case "pkg-graph": {
      const { runPkgGraph } = await import("../scripts/pkg-graph.js");
      await runPkgGraph({ root: parseRoot() });
      break;
    }
    default: {
      // No subcommand → run full pipeline
      const { runAuditPipeline } = await import("./commands/audit.js");
      await runAuditPipeline(args);
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
