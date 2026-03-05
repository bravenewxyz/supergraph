import { resolve } from "node:path";
import { runDeadExports } from "../../graph/src/cli/dead-exports.js";

export async function runDeadExportsCommand(args: string[]): Promise<void> {
  const srcDir = args.find((a) => !a.startsWith("--"));
  if (!srcDir || args.includes("--help") || args.includes("-h")) {
    console.error("Usage: supergraph dead-exports <src-dir> [--out <file>]");
    process.exit(1);
  }

  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;

  const output = await runDeadExports({ srcRoot: resolve(srcDir), outPath });
  if (!outPath) process.stdout.write(output);
}
