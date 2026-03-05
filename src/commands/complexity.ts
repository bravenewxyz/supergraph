import { resolve } from "node:path";
import { detectLanguage } from "../../graph/src/cli/lang/index.js";
import { runComplexity } from "../../graph/src/cli/complexity.js";

export async function runComplexityCommand(args: string[]): Promise<void> {
  const srcDir = args.find((a) => !a.startsWith("--"));
  if (!srcDir || args.includes("--help") || args.includes("-h")) {
    console.error("Usage: supergraph complexity <src-dir> [--out <file>] [--top N] [--min-complexity N]");
    process.exit(1);
  }

  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;
  const topIdx = args.indexOf("--top");
  const topN = topIdx !== -1 && args[topIdx + 1] ? parseInt(args[topIdx + 1]!, 10) : undefined;
  const minIdx = args.indexOf("--min-complexity");
  const minComplexity = minIdx !== -1 && args[minIdx + 1] ? parseInt(args[minIdx + 1]!, 10) : undefined;
  const srcRoot = resolve(srcDir);

  const driver = await detectLanguage(srcRoot);
  if (driver) {
    console.error(`Detected language: ${driver.name}`);
    const output = await driver.complexity({ srcRoot, outPath, topN, minComplexity });
    if (!outPath) process.stdout.write(output);
  } else {
    const output = await runComplexity({ srcRoot, outPath, topN, minComplexity });
    if (!outPath) process.stdout.write(output);
  }
}
