import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const SKIP_DIRS = new Set([
  "__tests__",
  "__test__",
  "test",
  "tests",
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "__mocks__",
  ".next",
  ".turbo",
]);

const GO_SKIP_DIRS = new Set([
  "vendor",
  "testdata",
  "node_modules",
  ".git",
  "dist",
  "build",
]);

export async function collectGoFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!GO_SKIP_DIRS.has(entry.name))
        results.push(...(await collectGoFiles(full)));
    } else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) {
      results.push(full);
    }
  }
  return results.sort();
}

export async function collectTsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) results.push(...(await collectTsFiles(full)));
    } else if (
      /\.(tsx?|jsx?)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".spec.")
    ) {
      results.push(full);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Shared graph utilities
// ---------------------------------------------------------------------------

/** DFS cycle detection. Returns each cycle as a path of node names. */
export function findCycles(graph: Record<string, string[]>): string[][] {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  const allNodes = new Set([
    ...Object.keys(graph),
    ...Object.values(graph).flat(),
  ]);
  for (const n of allNodes) color.set(n, WHITE);

  const cycles: string[][] = [];
  const seen = new Set<string>(); // canonical cycle keys, for dedup

  function dfs(node: string, path: string[]): void {
    color.set(node, GRAY);
    path.push(node);
    for (const nb of graph[node] ?? []) {
      if (color.get(nb) === GRAY) {
        const start = path.indexOf(nb);
        const cycle = path.slice(start);
        // Canonicalize: rotate to smallest node so duplicates collapse
        const minIdx = cycle.indexOf([...cycle].sort()[0]!);
        const canonical = [
          ...cycle.slice(minIdx),
          ...cycle.slice(0, minIdx),
        ].join("→");
        if (!seen.has(canonical)) {
          seen.add(canonical);
          cycles.push(cycle);
        }
      } else if (color.get(nb) === WHITE) {
        dfs(nb, path);
      }
    }
    path.pop();
    color.set(node, BLACK);
  }

  for (const node of allNodes) {
    if (color.get(node) === WHITE) dfs(node, []);
  }
  return cycles;
}

/**
 * Collapse a function signature's parameter list to `(…)` when the params
 * exceed `maxParamLen` characters. Return-type annotation is preserved.
 * Only `()` depth is tracked — sufficient for TypeScript signatures.
 */
export function truncateParams(sig: string, maxParamLen = 60): string {
  const open = sig.indexOf("(");
  if (open === -1) return sig;

  let depth = 0;
  let close = -1;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === "(") depth++;
    else if (sig[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  // Handle truncated signatures where the parser cut off before the closing paren.
  const params = close !== -1 ? sig.slice(open + 1, close) : sig.slice(open + 1);
  if (params.length <= maxParamLen) return sig;

  if (close !== -1) {
    return `${sig.slice(0, open)}(…)${sig.slice(close + 1)}`;
  }
  // Incomplete signature — keep only name + (…)
  return `${sig.slice(0, open)}(…)`;
}

/**
 * Minimal interfaces for collectDirectories — compatible with both TS and Go
 * ModuleManifest types (only requires `relativePath`).
 */
export interface DirectoryManifest {
  path: string;
  modules: string[];
  subdirectories: string[];
}

export function collectDirectories(
  modules: Array<{ relativePath: string }>,
): DirectoryManifest[] {
  const dirMap = new Map<string, { modules: Set<string>; subdirs: Set<string> }>();

  for (const mod of modules) {
    const dir = dirname(mod.relativePath);
    if (!dirMap.has(dir)) {
      dirMap.set(dir, { modules: new Set(), subdirs: new Set() });
    }
    dirMap.get(dir)!.modules.add(mod.relativePath);

    let parent = dirname(dir);
    let child = dir;
    while (parent !== child) {
      if (!dirMap.has(parent)) {
        dirMap.set(parent, { modules: new Set(), subdirs: new Set() });
      }
      dirMap.get(parent)!.subdirs.add(child);
      child = parent;
      parent = dirname(parent);
    }
  }

  return [...dirMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, data]) => ({
      path,
      modules: [...data.modules].sort(),
      subdirectories: [...data.subdirs].sort(),
    }));
}

/** Collect all exported symbol names from a module (recurse into children). */
export function collectExports(
  symbols: Array<{ name: string; kind: string; exported: boolean; children?: Array<{ name: string; kind: string; exported: boolean; children?: any[] }> }>,
): string[] {
  const names: string[] = [];
  for (const sym of symbols) {
    if (sym.exported && sym.name && sym.name !== "(anonymous)") {
      // Skip import/re-export stubs (kind === "import")
      if (sym.kind !== "import") names.push(sym.name);
    }
    if (sym.children) names.push(...collectExports(sym.children));
  }
  return names;
}

/** Strip `src/` prefix from a module path. */
export function strip(modulePath: string): string {
  return modulePath.replace(/^src\//, "");
}

/** Escape a string for use in a RegExp constructor. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
