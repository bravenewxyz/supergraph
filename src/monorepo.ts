import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname, parse as parsePath } from "node:path";
import { Glob } from "bun";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk up the directory tree from `startDir` looking for monorepo sentinel
 * files. Returns the first directory where a known monorepo config is found,
 * or `startDir` itself when nothing is detected.
 */
export async function findMonorepoRoot(startDir: string): Promise<string> {
  let dir = resolve(startDir);
  const { root: fsRoot } = parsePath(dir);

  while (dir !== fsRoot) {
    if (await isMonorepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Check fsRoot itself (edge case: monorepo at filesystem root)
  if (await isMonorepoRoot(dir)) return dir;

  return resolve(startDir);
}

/**
 * Discover all TypeScript package source directories in a monorepo.
 *
 * Strategy (in order, returns first non-empty result):
 *   1. Read workspace globs from all config files (package.json, pnpm-workspace.yaml,
 *      lerna.json, rush.json, .moon/workspace.yml) — merges ALL sources
 *   2. TypeScript project references (tsconfig.json `references` field)
 *   3. Convention directories (packages/, apps/, libs/, modules/, services/)
 *   4. Single-package fallback (root src/)
 */
export async function discoverPackages(root: string): Promise<string[]> {
  // 1. Workspace config — merge from all tools
  const globs = await readAllWorkspaceGlobs(root);
  if (globs.length > 0) {
    const pkgDirs = await resolveWorkspaceDirs(root, globs);
    if (pkgDirs.length > 0) {
      const srcDirs = await findSrcDirs(pkgDirs);
      if (srcDirs.length > 0) return srcDirs;
    }
  }

  // 2. TypeScript project references
  const refDirs = await detectTsProjectReferences(root);
  if (refDirs.length > 0) {
    const srcDirs = await findSrcDirs(refDirs);
    if (srcDirs.length > 0) return srcDirs;
  }

  // 3. Convention directories fallback
  const conventionDirs = ["packages", "apps", "libs", "modules", "services"];
  for (const dir of conventionDirs) {
    const abs = resolve(root, dir);
    try {
      await stat(abs);
      const srcDirs = await walkForSrcDirs(abs);
      if (srcDirs.length > 0) return srcDirs;
    } catch {}
  }

  // 4. Single-package fallback: root src/
  const rootSrc = resolve(root, "src");
  try {
    const s = await stat(rootSrc);
    if (s.isDirectory()) return [rootSrc];
  } catch {}

  return [];
}

// ---------------------------------------------------------------------------
// Sentinel detection (for walk-up)
// ---------------------------------------------------------------------------

const SENTINEL_FILES = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "rush.json",
  "nx.json",
  "turbo.json",
];

const SENTINEL_DIRS = [".moon"];

/** Check whether `dir` looks like a monorepo root. */
async function isMonorepoRoot(dir: string): Promise<boolean> {
  // Check sentinel files
  for (const sentinel of SENTINEL_FILES) {
    try {
      await stat(join(dir, sentinel));
      return true;
    } catch {}
  }

  // Check sentinel directories
  for (const sentinel of SENTINEL_DIRS) {
    try {
      const s = await stat(join(dir, sentinel));
      if (s.isDirectory()) return true;
    } catch {}
  }

  // Check package.json workspaces field
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    const ws = pkg.workspaces;
    if (Array.isArray(ws) && ws.length > 0) return true;
    if (ws && typeof ws === "object" && Array.isArray(ws.packages) && ws.packages.length > 0)
      return true;
  } catch {}

  return false;
}

// ---------------------------------------------------------------------------
// Workspace glob collection — merges ALL sources (no short-circuit)
// ---------------------------------------------------------------------------

/** Read workspace glob patterns from ALL common monorepo config files and merge. */
async function readAllWorkspaceGlobs(root: string): Promise<string[]> {
  const allGlobs: string[] = [];

  // 1. package.json workspaces (npm, bun, yarn, turborepo)
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8"));
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) {
      allGlobs.push(...ws);
    } else if (ws && typeof ws === "object" && Array.isArray(ws.packages)) {
      // Yarn classic { packages: [...] } or Bun { packages: [...], catalog: {...} }
      allGlobs.push(...ws.packages);
    }
  } catch {}

  // 2. pnpm-workspace.yaml
  try {
    const yaml = await readFile(join(root, "pnpm-workspace.yaml"), "utf-8");
    const pnpmGlobs = parsePnpmWorkspaceYaml(yaml);
    allGlobs.push(...pnpmGlobs);
  } catch {}

  // 3. lerna.json
  try {
    const lernaRaw = await readFile(join(root, "lerna.json"), "utf-8");
    const lerna = JSON.parse(lernaRaw);
    // When useWorkspaces is true, Lerna delegates to the package manager —
    // those globs are already captured from package.json above.
    if (lerna.useWorkspaces !== true) {
      if (Array.isArray(lerna.packages) && lerna.packages.length > 0) {
        allGlobs.push(...lerna.packages);
      } else {
        // Lerna defaults to ["packages/*"] when packages field is absent
        allGlobs.push("packages/*");
      }
    }
  } catch {}

  // 4. rush.json (JSONC — supports comments)
  try {
    const rushRaw = await readFile(join(root, "rush.json"), "utf-8");
    const rush = JSON.parse(stripJsonComments(rushRaw));
    if (Array.isArray(rush.projects)) {
      for (const p of rush.projects) {
        if (p.projectFolder) allGlobs.push(p.projectFolder);
      }
    }
  } catch {}

  // 5. .moon/workspace.yml
  try {
    const moonYaml = await readFile(join(root, ".moon", "workspace.yml"), "utf-8");
    const moonGlobs = parseMoonWorkspaceYaml(moonYaml);
    allGlobs.push(...moonGlobs);
  } catch {}

  // Normalise and deduplicate
  const normalised = allGlobs.map((g) => g.replace(/^\.\//, "").trim()).filter(Boolean);
  return [...new Set(normalised)];
}

// ---------------------------------------------------------------------------
// YAML parsers (hand-rolled — no external deps)
// ---------------------------------------------------------------------------

/** Parse pnpm-workspace.yaml `packages:` list.  Handles `- 'glob'` entries. */
function parsePnpmWorkspaceYaml(yaml: string): string[] {
  const globs: string[] = [];
  const lines = yaml.split("\n");
  let inPackages = false;
  for (const line of lines) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*$/);
      if (m) {
        globs.push(m[1]!.trim());
      } else if (/^\S/.test(line)) {
        break; // next top-level key
      }
    }
  }
  return globs;
}

/**
 * Parse Moon's workspace.yml `projects:` section.
 * Supports both array form (`- "packages/*"`) and map form (`name: "path"`).
 */
function parseMoonWorkspaceYaml(yaml: string): string[] {
  const globs: string[] = [];
  const lines = yaml.split("\n");
  let inProjects = false;
  for (const line of lines) {
    if (/^projects\s*:/.test(line)) {
      inProjects = true;
      continue;
    }
    if (inProjects) {
      // Array form:  - 'packages/*'
      const arrayMatch = line.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*$/);
      if (arrayMatch) {
        globs.push(arrayMatch[1]!.trim());
        continue;
      }
      // Map form:  name: 'packages/core'
      const mapMatch = line.match(/^\s+\S+\s*:\s*['"]?([^'"#]+?)['"]?\s*$/);
      if (mapMatch) {
        globs.push(mapMatch[1]!.trim());
        continue;
      }
      // End of section (next top-level key or blank line after entries)
      if (/^\S/.test(line)) break;
    }
  }
  return globs;
}

// ---------------------------------------------------------------------------
// JSON utilities
// ---------------------------------------------------------------------------

/** Strip single-line (`// …`) and multi-line (`/* … *​/`) comments from text. */
function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let stringChar = "";

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];

    // Handle string literals (don't strip inside strings)
    if (inString) {
      result += ch;
      if (ch === "\\" && i + 1 < text.length) {
        result += next;
        i += 2;
        continue;
      }
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }

    // Single-line comment
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    // Multi-line comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // skip closing */
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// TypeScript project references
// ---------------------------------------------------------------------------

/** Detect package directories from tsconfig.json `references` field. */
async function detectTsProjectReferences(root: string): Promise<string[]> {
  const dirs: string[] = [];
  try {
    const raw = await readFile(join(root, "tsconfig.json"), "utf-8");
    const tsconfig = JSON.parse(stripJsonComments(raw));
    if (!Array.isArray(tsconfig.references)) return dirs;

    for (const ref of tsconfig.references) {
      if (!ref.path) continue;
      const abs = resolve(root, ref.path);
      try {
        const s = await stat(abs);
        if (s.isDirectory()) dirs.push(abs);
      } catch {}
    }
  } catch {}
  return dirs;
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

/** Resolve workspace globs to actual package directories that contain package.json. */
async function resolveWorkspaceDirs(root: string, patterns: string[]): Promise<string[]> {
  const pkgDirs = new Set<string>();

  for (let pattern of patterns) {
    // Strip negation patterns (e.g. "!packages/internal")
    if (pattern.startsWith("!")) continue;

    // Normalise ./prefix
    pattern = pattern.replace(/^\.\//, "");

    // Exact path like "apps/web" — use directly
    if (!pattern.includes("*")) {
      const abs = resolve(root, pattern);
      try {
        const s = await stat(abs);
        if (s.isDirectory()) pkgDirs.add(abs);
      } catch {}
      continue;
    }

    // Use Bun's Glob to resolve patterns
    const glob = new Glob(pattern);
    for await (const match of glob.scan({ cwd: root, onlyFiles: false })) {
      const abs = resolve(root, match);
      try {
        const s = await stat(abs);
        if (!s.isDirectory()) continue;
        if (match.includes("node_modules")) continue;
        // Verify it's a real package (has package.json)
        try {
          await stat(join(abs, "package.json"));
          pkgDirs.add(abs);
        } catch {}
      } catch {}
    }
  }

  return [...pkgDirs].sort();
}

// ---------------------------------------------------------------------------
// Source directory discovery
// ---------------------------------------------------------------------------

/** Find src/ directories within resolved package dirs. */
async function findSrcDirs(pkgDirs: string[]): Promise<string[]> {
  const srcDirs: string[] = [];
  for (const dir of pkgDirs) {
    const srcDir = join(dir, "src");
    try {
      const s = await stat(srcDir);
      if (s.isDirectory()) {
        srcDirs.push(srcDir);
        continue;
      }
    } catch {}
    // No src/ — check if the package root itself has source files
    try {
      const entries = await readdir(dir);
      const hasSource = entries.some(
        (e) => e.endsWith(".ts") || e.endsWith(".tsx") || e.endsWith(".js") || e.endsWith(".jsx"),
      );
      if (hasSource) srcDirs.push(dir);
    } catch {}
  }
  return srcDirs;
}

/** Walk a directory looking for src/ subdirectories (convention fallback). */
async function walkForSrcDirs(baseDir: string): Promise<string[]> {
  const srcDirs: string[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 3) return;
    const entries = await readdir(dir, { withFileTypes: true });
    const hasSrc = entries.some((e) => e.isDirectory() && e.name === "src");
    if (hasSrc) {
      srcDirs.push(join(dir, "src"));
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".next")
        continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }

  await walk(baseDir, 0);
  return srcDirs.sort();
}
