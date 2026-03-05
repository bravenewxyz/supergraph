import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Returns the repo root to operate on.
 * Prefers --root <path> from argv; falls back to `defaultRoot` (typically
 * `resolve(import.meta.dir, "../..")` which points at the guild-v3 root when
 * the devtools live inside that repo, but can be any monorepo).
 *
 * In compiled binaries, import.meta.dir resolves to /$bunfs/root/ which is
 * read-only, so we fall back to process.cwd() instead.
 */
export function parseRootArg(defaultRoot: string): string {
  const idx = process.argv.indexOf("--root");
  if (idx >= 0 && process.argv[idx + 1]) {
    return resolve(process.argv[idx + 1]!);
  }
  // Compiled Bun binaries embed files under /$bunfs/ — detect and use cwd instead
  if (defaultRoot.startsWith("/$bunfs/")) {
    return process.cwd();
  }
  return defaultRoot;
}

export async function readFile(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

export async function findFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const results: string[] = [];
  const exists = await stat(dir)
    .then(() => true)
    .catch(() => false);
  if (!exists) return results;

  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(d, entry.name);
      if (
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        entry.name !== ".turbo" &&
        entry.name !== "dist" &&
        entry.name !== ".next"
      ) {
        await walk(full);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results.sort();
}
