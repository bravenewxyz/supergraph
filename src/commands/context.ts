/**
 * supergraph context — 360-degree view of any symbol in the graph.
 *
 * Shows all incoming and outgoing edges grouped by type, plus symbol metadata.
 *
 * Usage:
 *   supergraph context <symbol-name>                    Lookup by name
 *   supergraph context <symbol-name> --format json      JSON output
 *   supergraph context <symbol-name> --pkg <filter>     Filter by package prefix
 *   supergraph context <symbol-name> --load <graph.json>  Load specific graph file
 */

import { resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { GraphStore } from "../../packages/graph/src/store/graph-store.js";
import {
  findSymbol,
  buildContext,
  formatContextText,
  formatDisambiguation,
  type ContextOptions,
} from "../../packages/graph/src/cli/context.js";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export async function runContextCommand(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(`supergraph context — 360-degree view of any symbol

Usage:
  supergraph context <symbol-name>                    Lookup by name
  supergraph context <symbol-name> --format json      JSON output
  supergraph context <symbol-name> --pkg <filter>     Filter edges by package prefix
  supergraph context <symbol-name> --load <graph.json>  Load specific graph file

The symbol name can be:
  - A simple name (e.g. "getSymbol") — matches by name, shows disambiguation if multiple
  - A qualified name (e.g. "graph-store.getSymbol") — exact match
  - A partial qualified name with dots/slashes — partial match against qualified names`);
    process.exit(0);
  }

  const format = (getArg(args, "--format") ?? "text") as "text" | "json";
  const pkg = getArg(args, "--pkg");
  const graphPath = getArg(args, "--load");

  // Find the positional argument (symbol name)
  const skipNext = new Set(["--format", "--pkg", "--load"]);
  let symbolName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (skipNext.has(args[i]!)) {
      i++; // skip the value after the flag
      continue;
    }
    if (args[i]!.startsWith("--")) continue;
    symbolName = args[i];
    break;
  }

  if (!symbolName) {
    console.error("Error: provide a symbol name");
    process.exit(1);
  }

  // Load graph
  const store = new GraphStore();
  const defaultGraphPath = join(process.cwd(), ".supergraph", "graph.json");
  const loadPath = graphPath ? resolve(graphPath) : (existsSync(defaultGraphPath) ? defaultGraphPath : null);

  if (!loadPath) {
    console.error("Error: no graph found. Run 'supergraph apply' first or use --load <graph.json>");
    process.exit(1);
  }

  try {
    const graphJson = readFileSync(loadPath, "utf-8");
    store.importJSON(graphJson);
  } catch (e: any) {
    console.error(`Error loading graph from ${loadPath}: ${e.message}`);
    process.exit(1);
  }

  // Find symbol
  const matches = findSymbol(store, symbolName);

  if (matches.length === 0) {
    console.error(`No symbol found matching "${symbolName}"`);
    process.exit(1);
  }

  if (matches.length > 1) {
    if (format === "json") {
      console.log(JSON.stringify({
        ambiguous: true,
        matches: matches.map((m) => ({
          id: m.id,
          kind: m.kind,
          qualifiedName: m.qualifiedName,
          file: m.qualifiedName.split(".")[0],
          line: m.sourceRange?.startLine ?? null,
        })),
      }, null, 2));
    } else {
      console.log(formatDisambiguation(matches));
    }
    process.exit(0);
  }

  // Build and display context
  const opts: ContextOptions = { format, pkg };
  const result = buildContext(store, matches[0]!, opts);

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatContextText(result));
  }
}
