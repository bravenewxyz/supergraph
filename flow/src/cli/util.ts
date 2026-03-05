import { writeFile } from "node:fs/promises";
import { relative } from "node:path";

export function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function positionalArg(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("--"));
}

export function shortPath(p: string, base?: string): string {
  if (base) {
    const r = relative(base, p);
    if (!r.startsWith("..")) return r;
  }
  const parts = p.split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : p;
}

export async function writeOutput(content: string, outFile?: string): Promise<void> {
  if (outFile) {
    await writeFile(outFile, content, "utf-8");
    console.error(`Written to ${outFile}`);
  } else {
    console.log(content);
  }
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function countBranches(source: string): number {
  let count = 0;
  const patterns = [/\bif\s*\(/g, /\belse\s+if\s*\(/g, /\?\s/g, /\bswitch\s*\(/g, /\bcase\s+/g];
  for (const p of patterns) {
    const matches = source.match(p);
    if (matches) count += matches.length;
  }
  return count;
}

export const STATUS_KEYWORDS = /\b(status|result|outcome|verdict|state)\b/i;
export const STATUS_VALUES = /\b(complete|completed|failed|partial|success|error|cancelled|pending|assigned|running|merged|conflict|skipped)\b/;
