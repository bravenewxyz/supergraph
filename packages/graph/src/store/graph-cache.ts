import { mkdir, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { GraphStore } from "./graph-store.js";
import type { SerializedGraph } from "./graph-store.js";

const CACHE_DIR = ".supergraph";
const CACHE_FILE = "graph-cache.json";
const META_FILE = "graph-cache.meta.json";
const CACHE_VERSION = 1;

export interface CacheMeta {
  version: number;
  timestamp: number;
  fileChecksums: Record<string, number>; // filePath -> mtime (ms)
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export async function saveGraph(
  store: GraphStore,
  outputDir: string,
  sourceFiles: string[],
): Promise<void> {
  const cacheDir = join(outputDir, CACHE_DIR);
  await mkdir(cacheDir, { recursive: true });

  const data: SerializedGraph = store.export();
  const json = JSON.stringify(data);
  await Bun.write(join(cacheDir, CACHE_FILE), json);

  const fileChecksums: Record<string, number> = {};
  for (const file of sourceFiles) {
    try {
      const s = await stat(file);
      fileChecksums[file] = s.mtimeMs;
    } catch {
      // file may have been deleted between parse and save — skip
    }
  }

  const meta: CacheMeta = {
    version: CACHE_VERSION,
    timestamp: Date.now(),
    fileChecksums,
  };
  await Bun.write(join(cacheDir, META_FILE), JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export async function loadGraph(cacheDir: string): Promise<GraphStore | null> {
  try {
    const raw = await readFile(join(cacheDir, CACHE_DIR, CACHE_FILE), "utf-8");
    const data = JSON.parse(raw) as SerializedGraph;
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      return null;
    }
    const store = new GraphStore();
    store.import(data);
    return store;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export async function isCacheValid(
  cacheDir: string,
  sourceFiles: string[],
): Promise<boolean> {
  try {
    const raw = await readFile(join(cacheDir, CACHE_DIR, META_FILE), "utf-8");
    const meta = JSON.parse(raw) as CacheMeta;

    if (meta.version !== CACHE_VERSION) return false;

    // Check that the set of source files matches
    const cachedFiles = new Set(Object.keys(meta.fileChecksums));
    if (cachedFiles.size !== sourceFiles.length) return false;

    for (const file of sourceFiles) {
      const cachedMtime = meta.fileChecksums[file];
      if (cachedMtime === undefined) return false;

      try {
        const s = await stat(file);
        if (s.mtimeMs !== cachedMtime) return false;
      } catch {
        return false; // file no longer exists
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

export async function invalidateCache(cacheDir: string): Promise<void> {
  const dir = join(cacheDir, CACHE_DIR);
  await Promise.allSettled([
    unlink(join(dir, CACHE_FILE)),
    unlink(join(dir, META_FILE)),
  ]);
}

// ---------------------------------------------------------------------------
// High-level helper: load from cache or build fresh
// ---------------------------------------------------------------------------

export interface LoadOrBuildOptions {
  /** Root directory used as cache base (e.g., project root). */
  cacheDir: string;
  /** Resolved source files to parse. */
  sourceFiles: string[];
  /** Build callback — invoked when cache is stale or missing. */
  buildGraph: (sourceFiles: string[]) => Promise<GraphStore>;
  /** When true, skip the cache entirely. */
  noCache?: boolean;
}

export interface LoadOrBuildResult {
  store: GraphStore;
  fromCache: boolean;
}

export async function loadOrBuildGraph(
  opts: LoadOrBuildOptions,
): Promise<LoadOrBuildResult> {
  const { cacheDir, sourceFiles, buildGraph, noCache } = opts;

  if (!noCache) {
    const valid = await isCacheValid(cacheDir, sourceFiles);
    if (valid) {
      const store = await loadGraph(cacheDir);
      if (store) {
        return { store, fromCache: true };
      }
    }
  }

  const store = await buildGraph(sourceFiles);
  await saveGraph(store, cacheDir, sourceFiles);
  return { store, fromCache: false };
}
