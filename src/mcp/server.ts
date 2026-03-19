/**
 * MCP server for Supergraph — exposes graph intelligence as tools
 * that AI agents (Claude Code, Cursor, etc.) can call over stdio.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { GraphStore } from "../../packages/graph/src/store/graph-store.js";
import { parseTypeScript } from "../../packages/graph/src/parser/ts-structural.js";
import { collectTsFiles } from "../../packages/graph/src/cli/utils.js";
import type { SymbolNode } from "../../packages/graph/src/schema/nodes.js";
import type { SymbolEdge } from "../../packages/graph/src/schema/edges.js";

// ---------------------------------------------------------------------------
// Graph building (shared helper)
// ---------------------------------------------------------------------------

const CACHE_PATH = ".supergraph/graph-cache.json";

function resolveImportSpecifier(fromModule: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromDir = fromModule.replace(/\/[^/]+$/, "");
  const resolved = join(fromDir, specifier).replace(/\.(js|ts|tsx|jsx)$/, "");
  return resolved.replace(/\/index$/, "");
}

async function buildGraphFromSource(srcRoot: string): Promise<GraphStore> {
  const files = await collectTsFiles(srcRoot);
  const store = new GraphStore();
  const unresolvedEdges: SymbolEdge[] = [];
  const moduleIdByPath = new Map<string, string>();
  const pkgRoot = resolve(srcRoot, "..");

  for (const file of files) {
    const code = await readFile(file, "utf-8");
    const relPath = relative(pkgRoot, file);
    const result = parseTypeScript(code, relPath);

    for (const node of result.nodes) {
      store.addSymbol(node);
      if (node.kind === "module") {
        moduleIdByPath.set(node.qualifiedName, node.id);
      }
    }

    for (const edge of result.edges) {
      if (edge.metadata?.unresolved) {
        unresolvedEdges.push(edge);
      } else {
        try {
          store.addEdge(edge);
        } catch {
          /* skip edges with missing targets */
        }
      }
    }
  }

  // Resolve import edges
  for (const edge of unresolvedEdges) {
    if (edge.kind === "imports" && edge.metadata?.moduleSpecifier) {
      const sourceModule = store.getSymbol(edge.sourceId);
      if (!sourceModule) continue;
      const resolved = resolveImportSpecifier(
        sourceModule.qualifiedName,
        edge.metadata.moduleSpecifier as string,
      );
      if (!resolved) continue;
      const targetModuleId = moduleIdByPath.get(resolved);
      if (targetModuleId) {
        try {
          store.addEdge({ ...edge, targetId: targetModuleId });
        } catch {
          /* skip */
        }
      }
    }
  }

  return store;
}

async function loadGraph(root: string): Promise<GraphStore> {
  const cachePath = join(root, CACHE_PATH);
  if (existsSync(cachePath)) {
    try {
      const json = await readFile(cachePath, "utf-8");
      const store = new GraphStore();
      store.importJSON(json);
      console.error(`Loaded graph from cache: ${store.nodeCount} nodes, ${store.edgeCount} edges`);
      return store;
    } catch (err) {
      console.error(`Cache load failed, building from source: ${err}`);
    }
  }

  // Find all src directories in packages/*/src and root src/
  const store = new GraphStore();
  const srcDirs: string[] = [];

  // Root src/
  const rootSrc = join(root, "src");
  if (existsSync(rootSrc)) srcDirs.push(rootSrc);

  // packages/*/src
  const pkgsDir = join(root, "packages");
  if (existsSync(pkgsDir)) {
    const entries = await readdir(pkgsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pkgSrc = join(pkgsDir, entry.name, "src");
        if (existsSync(pkgSrc)) srcDirs.push(pkgSrc);
      }
    }
  }

  if (srcDirs.length === 0) {
    console.error("No src directories found, graph will be empty");
    return store;
  }

  for (const srcDir of srcDirs) {
    console.error(`Building graph for ${relative(root, srcDir)}...`);
    try {
      const partialStore = await buildGraphFromSource(srcDir);
      const data = partialStore.export();
      for (const node of data.nodes) store.addSymbol(node);
      for (const edge of data.edges) {
        try {
          store.addEdge(edge);
        } catch {
          /* cross-package edges may have missing targets */
        }
      }
    } catch (err) {
      console.error(`  Failed: ${err}`);
    }
  }

  console.error(`Graph built: ${store.nodeCount} nodes, ${store.edgeCount} edges`);
  return store;
}

// ---------------------------------------------------------------------------
// Symbol lookup (supports partial/fuzzy matching)
// ---------------------------------------------------------------------------

function findSymbol(store: GraphStore, name: string): SymbolNode | undefined {
  // 1. Exact qualified name match
  const byQn = store.getSymbolByQualifiedName(name);
  if (byQn) return byQn;

  const allSymbols = store.getAllSymbols();

  // 2. Exact simple name match
  const byName = allSymbols.filter((s) => s.name === name && s.kind !== "module");
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const exported = byName.filter((s) => s.exported);
    return exported.length >= 1 ? exported[0] : byName[0];
  }

  // 3. Qualified name ends-with match
  const byEndsWith = allSymbols.filter(
    (s) => s.qualifiedName.endsWith(`.${name}`) && s.kind !== "module",
  );
  if (byEndsWith.length >= 1) {
    const exported = byEndsWith.filter((s) => s.exported);
    return exported.length >= 1 ? exported[0] : byEndsWith[0];
  }

  // 4. Case-insensitive
  const lower = name.toLowerCase();
  const byCaseInsensitive = allSymbols.filter(
    (s) => s.name.toLowerCase() === lower && s.kind !== "module",
  );
  if (byCaseInsensitive.length >= 1) return byCaseInsensitive[0];

  return undefined;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function toolContext(store: GraphStore, symbol: string) {
  const node = findSymbol(store, symbol);
  if (!node) {
    return { error: `Symbol not found: ${symbol}` };
  }

  const inEdges = store.getEdgesTo(node.id);
  const outEdges = store.getEdgesFrom(node.id);

  const groupEdges = (edges: SymbolEdge[], getNodeId: (e: SymbolEdge) => string) => {
    const grouped: Record<string, Array<{ name: string; qualifiedName: string; kind: string }>> = {};
    for (const edge of edges) {
      const sym = store.getSymbol(getNodeId(edge));
      if (!sym) continue;
      if (!grouped[edge.kind]) grouped[edge.kind] = [];
      grouped[edge.kind]!.push({
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind,
      });
    }
    return grouped;
  };

  return {
    symbol: {
      name: node.name,
      qualifiedName: node.qualifiedName,
      kind: node.kind,
      signature: node.signature,
      typeText: node.typeText,
      exported: node.exported,
      modifiers: node.modifiers,
      lines: node.sourceRange,
    },
    incoming: groupEdges(inEdges, (e) => e.sourceId),
    outgoing: groupEdges(outEdges, (e) => e.targetId),
  };
}

const TRAVERSAL_EDGE_KINDS = new Set([
  "calls", "imports", "extends", "implements", "references", "depends-on",
]);

function toolImpact(
  store: GraphStore,
  symbol: string,
  direction: "upstream" | "downstream" | "both" = "upstream",
  depth: number = 3,
) {
  const target = findSymbol(store, symbol);
  if (!target) {
    return { error: `Symbol not found: ${symbol}` };
  }

  const visited = new Set<string>();
  visited.add(target.id);
  const byDepth: Record<number, Array<{ name: string; qualifiedName: string; kind: string; module: string; edgeKind: string }>> = {};
  let totalCount = 0;

  const queue: Array<{ id: string; depth: number }> = [{ id: target.id, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depth) continue;

    const nextDepth = current.depth + 1;
    const neighbors: Array<{ id: string; edgeKind: string }> = [];

    if (direction === "upstream" || direction === "both") {
      for (const edge of store.getEdgesTo(current.id)) {
        if (TRAVERSAL_EDGE_KINDS.has(edge.kind)) {
          neighbors.push({ id: edge.sourceId, edgeKind: edge.kind });
        }
      }
    }

    if (direction === "downstream" || direction === "both") {
      for (const edge of store.getEdgesFrom(current.id)) {
        if (TRAVERSAL_EDGE_KINDS.has(edge.kind)) {
          neighbors.push({ id: edge.targetId, edgeKind: edge.kind });
        }
      }
    }

    for (const neighbor of neighbors) {
      if (visited.has(neighbor.id)) continue;
      visited.add(neighbor.id);

      const node = store.getSymbol(neighbor.id);
      if (!node) continue;

      const module = node.qualifiedName.split(".")[0] ?? node.qualifiedName;
      if (!byDepth[nextDepth]) byDepth[nextDepth] = [];
      byDepth[nextDepth]!.push({
        name: node.name,
        qualifiedName: node.qualifiedName,
        kind: node.kind,
        module,
        edgeKind: neighbor.edgeKind,
      });
      totalCount++;

      queue.push({ id: neighbor.id, depth: nextDepth });
    }
  }

  const directCount = byDepth[1]?.length ?? 0;

  // Module aggregation
  const moduleMap = new Map<string, { total: number; direct: number }>();
  for (const [d, symbols] of Object.entries(byDepth)) {
    for (const sym of symbols) {
      const entry = moduleMap.get(sym.module) ?? { total: 0, direct: 0 };
      entry.total++;
      if (Number(d) === 1) entry.direct++;
      moduleMap.set(sym.module, entry);
    }
  }

  // Risk scoring
  let risk: string;
  if (directCount >= 30 || totalCount >= 200) risk = "CRITICAL";
  else if (directCount >= 15 || totalCount >= 100) risk = "HIGH";
  else if (directCount >= 5 || totalCount >= 30) risk = "MEDIUM";
  else risk = "LOW";

  return {
    target: {
      name: target.name,
      qualifiedName: target.qualifiedName,
      kind: target.kind,
    },
    direction,
    maxDepth: depth,
    risk,
    directCount,
    totalCount,
    moduleCount: moduleMap.size,
    byDepth,
    affectedModules: Object.fromEntries(moduleMap),
  };
}

function toolDetectChanges(
  scope: "staged" | "unstaged" | "all" | "compare" = "unstaged",
  compareRef?: string,
) {
  // Get changed files from git
  let cmd: string;
  switch (scope) {
    case "staged":
      cmd = "git diff --staged --name-only";
      break;
    case "unstaged":
      cmd = "git diff --name-only";
      break;
    case "all":
      cmd = "git diff HEAD --name-only";
      break;
    case "compare":
      if (!compareRef) return { error: "--compare_ref is required when scope is 'compare'" };
      cmd = `git diff ${compareRef} --name-only`;
      break;
  }

  let changedFiles: string[];
  try {
    const output = execSync(cmd, { encoding: "utf-8" }).trim();
    changedFiles = output ? output.split("\n").filter(Boolean) : [];
  } catch {
    changedFiles = [];
  }

  if (changedFiles.length === 0) {
    return {
      scope,
      changedFiles: [],
      changedSymbols: [],
      risk: "LOW",
      totalDependents: 0,
    };
  }

  return {
    scope,
    changedFiles,
    note: "File-level change detection. For full symbol-level analysis with dependents, run `supergraph detect-changes` CLI.",
  };
}

function toolQuery(
  store: GraphStore,
  query: string,
  kind?: string,
) {
  const allSymbols = store.getAllSymbols().filter((s) => s.kind !== "module");

  // Support regex patterns
  let matcher: (s: SymbolNode) => boolean;
  try {
    const regex = new RegExp(query, "i");
    matcher = (s) => regex.test(s.name) || regex.test(s.qualifiedName);
  } catch {
    // Fallback to simple includes
    const lower = query.toLowerCase();
    matcher = (s) =>
      s.name.toLowerCase().includes(lower) ||
      s.qualifiedName.toLowerCase().includes(lower);
  }

  let results = allSymbols.filter(matcher);
  if (kind) {
    results = results.filter((s) => s.kind === kind);
  }

  // Limit results
  const total = results.length;
  results = results.slice(0, 50);

  return {
    query,
    kind: kind ?? "all",
    total,
    results: results.map((s) => ({
      name: s.name,
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      signature: s.signature,
      exported: s.exported,
      lines: s.sourceRange,
    })),
  };
}

async function toolMap(root: string, pkg?: string) {
  // Try reading the compact text map
  const compactPath = join(root, ".supergraph", "supergraph-compact.txt");
  if (existsSync(compactPath)) {
    let content = await readFile(compactPath, "utf-8");
    if (pkg) {
      // Filter to lines relevant to the package
      const lines = content.split("\n");
      const filtered: string[] = [];
      let inPkg = false;
      for (const line of lines) {
        if (line.startsWith("# ") || line.startsWith("## ")) {
          inPkg = line.toLowerCase().includes(pkg.toLowerCase());
        }
        if (inPkg) filtered.push(line);
      }
      content = filtered.length > 0 ? filtered.join("\n") : content;
    }
    return { source: "supergraph-compact.txt", content };
  }

  // Fallback: try the full supergraph.txt
  const fullPath = join(root, ".supergraph", "supergraph.txt");
  if (existsSync(fullPath)) {
    let content = await readFile(fullPath, "utf-8");
    // Truncate if too long
    if (content.length > 100_000) {
      content = content.slice(0, 100_000) + "\n\n... (truncated, full file at .supergraph/supergraph.txt)";
    }
    return { source: "supergraph.txt", content };
  }

  return {
    error: "No .supergraph/supergraph-compact.txt or supergraph.txt found. Run `supergraph` first to generate the architecture map.",
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export async function startServer(root: string): Promise<void> {
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8"));
    version = pkg.version ?? version;
  } catch {
    // ignore
  }

  console.error(`supergraph MCP server v${version}`);
  console.error(`Root: ${root}`);
  console.error("Loading graph...");

  const store = await loadGraph(root);

  console.error(`Ready: ${store.nodeCount} nodes, ${store.edgeCount} edges`);

  const server = new Server(
    {
      name: "supergraph",
      version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // --- List tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "supergraph_context",
        description:
          "360-degree view of a symbol: its type, signature, and all incoming/outgoing edges grouped by relationship kind (calls, imports, extends, etc.)",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: {
              type: "string",
              description: "Symbol name or qualified name to look up",
            },
          },
          required: ["symbol"],
        },
      },
      {
        name: "supergraph_impact",
        description:
          "Blast radius analysis: BFS through the dependency graph to find everything affected by (upstream) or depended on by (downstream) a symbol. Returns risk level, affected symbols grouped by depth, and affected modules.",
        inputSchema: {
          type: "object" as const,
          properties: {
            symbol: {
              type: "string",
              description: "Symbol name or qualified name to analyze",
            },
            direction: {
              type: "string",
              enum: ["upstream", "downstream", "both"],
              description: "Traversal direction (default: upstream)",
            },
            depth: {
              type: "number",
              description: "Max BFS depth (default: 3)",
            },
          },
          required: ["symbol"],
        },
      },
      {
        name: "supergraph_detect_changes",
        description:
          "Pre-commit scope analysis: detects which files changed via git diff and maps them to affected symbols/modules.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scope: {
              type: "string",
              enum: ["staged", "unstaged", "all", "compare"],
              description: "Git diff scope (default: unstaged)",
            },
            compare_ref: {
              type: "string",
              description: "Git ref to compare against (required when scope is 'compare')",
            },
          },
        },
      },
      {
        name: "supergraph_query",
        description:
          "Search symbols by name or pattern (supports regex). Returns matching symbols with file locations, kinds, and signatures.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Search query (symbol name, partial name, or regex pattern)",
            },
            kind: {
              type: "string",
              enum: [
                "function",
                "class",
                "interface",
                "type-alias",
                "enum",
                "variable",
                "method",
                "property",
              ],
              description: "Filter by symbol kind",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "supergraph_map",
        description:
          "Get the compact architecture overview of the codebase (modules, symbols, dependencies). Optionally filter to a specific package.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pkg: {
              type: "string",
              description: "Optional package name to filter the map to",
            },
          },
        },
      },
    ],
  }));

  // --- Call tool ---
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "supergraph_context": {
          const symbol = args?.symbol as string;
          if (!symbol) return errorResponse("Missing required argument: symbol");
          const result = toolContext(store, symbol);
          return jsonResponse(result);
        }

        case "supergraph_impact": {
          const symbol = args?.symbol as string;
          if (!symbol) return errorResponse("Missing required argument: symbol");
          const direction = (args?.direction as "upstream" | "downstream" | "both") ?? "upstream";
          const depth = typeof args?.depth === "number" ? args.depth : 3;
          const result = toolImpact(store, symbol, direction, depth);
          return jsonResponse(result);
        }

        case "supergraph_detect_changes": {
          const scope = (args?.scope as "staged" | "unstaged" | "all" | "compare") ?? "unstaged";
          const compareRef = args?.compare_ref as string | undefined;
          const result = toolDetectChanges(scope, compareRef);
          return jsonResponse(result);
        }

        case "supergraph_query": {
          const query = args?.query as string;
          if (!query) return errorResponse("Missing required argument: query");
          const kind = args?.kind as string | undefined;
          const result = toolQuery(store, query, kind);
          return jsonResponse(result);
        }

        case "supergraph_map": {
          const pkg = args?.pkg as string | undefined;
          const result = await toolMap(root, pkg);
          // For map, return the content as text for better readability
          if ("content" in result) {
            return {
              content: [
                { type: "text" as const, text: result.content },
              ],
            };
          }
          return jsonResponse(result);
        }

        default:
          return errorResponse(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Tool error (${name}): ${msg}`);
      return errorResponse(msg);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

function jsonResponse(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorResponse(message: string) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: message },
    ],
  };
}
