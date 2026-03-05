import { resolve } from "node:path";
import { runSchemaMatch } from "../../packages/flow/src/cli/schema-match.js";

export async function runSchemaMatchCommand(args: string[]): Promise<void> {
  const srcDir = args.find((a) => !a.startsWith("--"));
  if (!srcDir || args.includes("--help") || args.includes("-h")) {
    console.error("Usage: supergraph schema-match <src-dir> [--format text|json] [--out <file>] [--library <name>]");
    process.exit(1);
  }

  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const output = await runSchemaMatch({
    srcDir: resolve(srcDir),
    format: (getArg("--format") as "text" | "json") ?? "text",
    outFile: getArg("--out"),
    library: getArg("--library"),
  });
  if (!getArg("--out")) process.stdout.write(output);
}
