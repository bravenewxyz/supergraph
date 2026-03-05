import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const SKIP_DIRS = new Set([
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
