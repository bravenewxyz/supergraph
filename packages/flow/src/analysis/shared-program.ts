import * as ts from "typescript";
import { collectSourceFiles, createProgram } from "../extractor/typescript.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const cache = new Map<string, { program: ts.Program; checker: ts.TypeChecker; files: string[] }>();

export async function getSharedProgram(srcDir: string): Promise<{
  program: ts.Program;
  checker: ts.TypeChecker;
  files: string[];
}> {
  const key = resolve(srcDir);
  const cached = cache.get(key);
  if (cached) return cached;

  const files = await collectSourceFiles(key);
  const nonTestFiles = files.filter(
    (f) => !f.includes("__tests__") && !f.includes(".test.") && !f.includes(".spec."),
  );

  const tsConfigCandidates = [
    resolve(key, "tsconfig.json"),
    resolve(key, "..", "tsconfig.json"),
    resolve(key, "../..", "tsconfig.json"),
  ];
  const tsConfigPath = tsConfigCandidates.find((p) => existsSync(p));
  const program = createProgram(nonTestFiles, tsConfigPath);
  const checker = program.getTypeChecker();

  const entry = { program, checker, files };
  cache.set(key, entry);
  return entry;
}

export function clearProgramCache(): void {
  cache.clear();
}
