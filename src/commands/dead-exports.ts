import { resolve } from "node:path";
import { detectLanguage } from "../../graph/src/cli/lang/index.js";
import { runDeadExports } from "../../graph/src/cli/dead-exports.js";

export async function runDeadExportsCommand(args: string[]): Promise<void> {
  const srcDir = args.find((a) => !a.startsWith("--"));
  if (!srcDir || args.includes("--help") || args.includes("-h")) {
    console.error("Usage: supergraph dead-exports <src-dir> [--out <file>]");
    process.exit(1);
  }

  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;
  const srcRoot = resolve(srcDir);

  const driver = await detectLanguage(srcRoot);
  if (driver) {
    console.error(`Detected language: ${driver.name}`);
    const output = await driver.deadExports({ srcRoot, outPath });
    if (!outPath) process.stdout.write(output);
  } else {
    const output = await runDeadExports({ srcRoot, outPath });
    if (!outPath) process.stdout.write(output);
  }
}
