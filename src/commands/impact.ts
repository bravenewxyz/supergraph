import { resolve } from "node:path";
import { runImpact } from "../../packages/graph/src/cli/impact.js";

export async function runImpactCommand(args: string[]): Promise<void> {
  const positionals = args.filter((a) => !a.startsWith("--"));
  const srcDir = positionals[0];
  const symbolName = positionals[1];

  if (!srcDir || !symbolName || args.includes("--help") || args.includes("-h")) {
    console.error(
      "Usage: supergraph impact <src-dir> <symbol-name> [--direction upstream|downstream|both] [--depth <n>] [--format text|json] [--out <file>]",
    );
    process.exit(1);
  }

  const dirIdx = args.indexOf("--direction");
  const direction = (dirIdx !== -1 && args[dirIdx + 1])
    ? args[dirIdx + 1] as "upstream" | "downstream" | "both"
    : "upstream";

  const depthIdx = args.indexOf("--depth");
  const maxDepth = depthIdx !== -1 && args[depthIdx + 1]
    ? parseInt(args[depthIdx + 1]!, 10)
    : 3;

  const fmtIdx = args.indexOf("--format");
  const format = fmtIdx !== -1 && args[fmtIdx + 1] === "json" ? "json" as const : "text" as const;

  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;

  const srcRoot = resolve(srcDir);
  const output = await runImpact({ srcRoot, symbolName, direction, maxDepth, format, outPath });
  if (!outPath) process.stdout.write(output);
}
