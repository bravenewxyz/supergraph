import { resolve } from "node:path";
import { runTrace } from "../../flow/src/cli/trace.js";

export async function runTraceCommand(args: string[]): Promise<void> {
  const srcDir = args.find((a) => !a.startsWith("--"));
  if (!srcDir || args.includes("--help") || args.includes("-h")) {
    console.error("Usage: supergraph trace <src-dir> [--type <name>] [--boundaries] [--full] [--format text|json] [--out <file>]");
    process.exit(1);
  }

  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const output = await runTrace({
    srcDir: resolve(srcDir),
    targetType: getArg("--type"),
    boundariesOnly: args.includes("--boundaries"),
    full: args.includes("--full"),
    format: (getArg("--format") as "text" | "json") ?? "text",
    outFile: getArg("--out"),
  });
  if (!getArg("--out")) process.stdout.write(output);
}
