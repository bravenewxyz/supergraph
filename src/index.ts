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

import { resolve, join, dirname } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

// ── Resolve lang-go parser.so for standalone binary distribution ──────────
// The .so is loaded via dlopen (not require), so it can't be embedded in the
// binary. We ship it alongside in lib/ and tell lang-go where to find it.
const _execDir = dirname(process.execPath);
const _langGoSearchPaths = [
  join(_execDir, "lib", "lang-go-parser.so"),                // direct: ./lib/
  join(_execDir, "..", "lib", "supergraph", "lang-go-parser.so"), // install.sh: ~/.local/lib/supergraph/
  join(_execDir, "..", "libexec", "lib", "lang-go-parser.so"),    // homebrew: libexec/lib/
];

if (!process.env.AST_GREP_LANG_GO_PATH) {
  for (const p of _langGoSearchPaths) {
    if (existsSync(p)) {
      process.env.AST_GREP_LANG_GO_PATH = p;
      break;
    }
  }
}

const supergraphDir = join(homedir(), ".supergraph");
const setupDone = join(supergraphDir, ".setup-done");
if (!existsSync(setupDone)) {
  const BASE_URL = "https://raw.githubusercontent.com/bravenewxyz/supergraph/master/commands";
  const claudeCmdDir = join(homedir(), ".claude", "commands");
  try {
    mkdirSync(claudeCmdDir, { recursive: true });
    const commands = ["deep-audit.md", "high-level.md"];
    for (const cmd of commands) {
      const res = await fetch(`${BASE_URL}/${cmd}`);
      if (res.ok) {
        writeFileSync(join(claudeCmdDir, cmd), await res.text());
      }
    }
    console.log(`Installed /deep-audit and /high-level commands for Claude Code`);
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
  superhigh               Generate unified superhigh.txt / superhigh-shortcut.txt

The full pipeline also generates:
  audit/superhigh.txt             Unified map: domains + schemas + modules + types
  audit/superhigh-shortcut.txt    Compressed version for AI context windows

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
    case "superhigh": {
      // Re-export superhigh as a subcommand so compiled binary can call itself
      await import("../scripts/superhigh.js");
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
