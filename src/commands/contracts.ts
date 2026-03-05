import { resolve } from "node:path";
import { runContracts } from "../../packages/flow/src/cli/contracts.js";

export async function runContractsCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.error("Usage: supergraph contracts [<fe-src-dir>] <be-src-dir> [--format text|json] [--out <file>]");
    process.exit(1);
  }

  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const positionals = args.filter((_, i, a) => {
    if (a[i]!.startsWith("--")) return false;
    if (i > 0 && a[i - 1]!.startsWith("--")) return false;
    return true;
  });

  const rootIdx = args.indexOf("--root");
  const cwd = rootIdx >= 0 && args[rootIdx + 1] ? resolve(args[rootIdx + 1]!) : process.cwd();

  const output = await runContracts({
    srcDir: positionals[positionals.length - 1] ?? "",
    feSrcDir: positionals.length >= 2 ? positionals[0] : undefined,
    format: (getArg("--format") as "text" | "json") ?? "text",
    outFile: getArg("--out"),
    cwd,
  });
  if (!getArg("--out")) process.stdout.write(output);
}
