import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { MutationReport, SurvivedMutant } from "./types.js";

export interface MutationTestOptions {
  testDir: string;
  sourceDir: string;
  mutators?: string[];
  threshold?: number;
  strykerConfigPath?: string;
}

interface StrykerMutant {
  id: string;
  mutatorName: string;
  location: { start: { line: number }; end?: { line: number } };
  replacement?: string;
  status: string;
}

interface StrykerReport {
  files?: Record<string, { mutants: StrykerMutant[] }>;
}

export async function runMutationTesting(
  options: MutationTestOptions
): Promise<MutationReport> {
  const { testDir, sourceDir, strykerConfigPath } = options;
  let configPath: string;

  if (strykerConfigPath) {
    configPath = strykerConfigPath;
  } else {
    const config = generateStrykerConfig(options);
    configPath = join(process.cwd(), ".stryker-mutation-config.json");
    await writeFile(configPath, JSON.stringify(config, null, 2));
  }

  const proc = spawnSync("npx", ["stryker", "run", "--configFile", configPath], {
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (proc.status !== 0) {
    throw new Error(`Stryker exited with code ${proc.status}`);
  }

  const reportPath = join(process.cwd(), "reports", "mutation", "mutation.json");
  return parseStrykerReport(reportPath);
}

export async function parseStrykerReport(
  reportPath: string
): Promise<MutationReport> {
  const raw = await readFile(reportPath, "utf-8");
  const data = JSON.parse(raw) as StrykerReport;

  if (!data || typeof data !== "object") {
    return {
      totalMutants: 0, killed: 0, survived: 0, timeout: 0,
      noCoverage: 0, mutationScore: 0, survivingMutants: [],
    };
  }

  let totalMutants = 0;
  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let noCoverage = 0;
  const survivingMutants: SurvivedMutant[] = [];

  const files = data.files ?? {};
  for (const [file, fileData] of Object.entries(files)) {
    for (const mutant of fileData.mutants ?? []) {
      totalMutants++;
      switch (mutant.status) {
        case "Killed":
          killed++;
          break;
        case "Survived":
          survived++;
          survivingMutants.push({
            file,
            line: mutant.location.start.line,
            mutatorName: mutant.mutatorName,
            replacement: mutant.replacement ?? "",
          });
          break;
        case "Timeout":
          timeout++;
          break;
        case "NoCoverage":
          noCoverage++;
          break;
      }
    }
  }

  const scorable = killed + survived;
  const mutationScore = scorable > 0 ? (killed / scorable) * 100 : 0;

  return {
    totalMutants,
    killed,
    survived,
    timeout,
    noCoverage,
    mutationScore,
    survivingMutants,
  };
}

export function generateStrykerConfig(
  options: MutationTestOptions
): Record<string, unknown> {
  const { testDir, sourceDir, mutators } = options;
  const config: Record<string, unknown> = {
    mutate: [
      `${sourceDir}/**/*.ts`,
      `!${sourceDir}/**/*.test.ts`,
    ],
    testRunner: "command",
    commandRunner: { command: `bun test ${testDir}` },
    reporters: ["json", "clear-text"],
    tempDirName: ".stryker-tmp",
    checkers: ["typescript"],
    tsconfigFile: "tsconfig.json",
  };

  if (mutators && mutators.length > 0) {
    config.mutator = { includedMutations: mutators };
  }

  return config;
}

export function formatMutationReport(report: MutationReport): string {
  const lines: string[] = [
    `Mutation score: ${report.mutationScore.toFixed(1)}%`,
    `Total mutants: ${report.totalMutants} (killed: ${report.killed}, survived: ${report.survived}, timeout: ${report.timeout}, no coverage: ${report.noCoverage})`,
  ];

  if (report.survivingMutants.length > 0) {
    lines.push("", "Surviving mutants:");
    for (const m of report.survivingMutants) {
      lines.push(`  ${m.file}:${m.line} [${m.mutatorName}] ${m.replacement}`);
      if (m.suggestedInvariant) {
        lines.push(`    → ${m.suggestedInvariant}`);
      }
    }
  }

  return lines.join("\n");
}
