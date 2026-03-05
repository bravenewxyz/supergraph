import { resolve } from "node:path";
import { runMap } from "../../graph/src/cli/map.js";

export async function runMapCommand(args: string[]): Promise<void> {
  const srcDir = args.find((a) => !a.startsWith("--"));
  if (!srcDir || args.includes("--help") || args.includes("-h")) {
    console.error("Usage: supergraph map <src-dir> [--format json|text] [--comments] [--out <file>]");
    process.exit(1);
  }

  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]!) : undefined;
  const fmtIdx = args.indexOf("--format");
  const format = fmtIdx !== -1 && args[fmtIdx + 1] === "text" ? "text" as const : "json" as const;
  const comments = args.includes("--comments");

  const { output } = await runMap({ srcRoot: resolve(srcDir), format, comments, outPath });
  if (!outPath) process.stdout.write(output);
}
