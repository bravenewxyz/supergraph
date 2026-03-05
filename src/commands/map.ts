import { resolve } from "node:path";
import { detectLanguage } from "../../graph/src/cli/lang/index.js";
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
  const srcRoot = resolve(srcDir);

  const driver = await detectLanguage(srcRoot);
  if (driver) {
    console.error(`Detected language: ${driver.name}`);
    const { output } = await driver.map({ srcRoot, format, comments, outPath });
    if (!outPath) process.stdout.write(output);
  } else {
    // Fallback to TypeScript for backwards compatibility
    const { output } = await runMap({ srcRoot, format, comments, outPath });
    if (!outPath) process.stdout.write(output);
  }
}
