import { resolve } from "node:path";

export async function runInvariantCommand(args: string[]): Promise<void> {
  // The invariant CLI has its own subcommand dispatch.
  // For the "discover" subcommand, use the exported function.
  // For all others, delegate to the original CLI's main().
  const subcommand = args[0];

  if (subcommand === "discover") {
    const { runInvariantDiscover } = await import("../../flow/src/cli/invariant.js");

    const restArgs = args.slice(1);
    const srcDir = restArgs.find((a) => !a.startsWith("--"));
    if (!srcDir || restArgs.includes("--help") || restArgs.includes("-h")) {
      console.error("Usage: supergraph invariant discover <src-dir> [--min-purity <n>] [--suggest-extractions] [--format text|json|compact] [--out <file>]");
      process.exit(1);
    }

    const getArg = (flag: string) => {
      const idx = restArgs.indexOf(flag);
      return idx >= 0 && restArgs[idx + 1] ? restArgs[idx + 1] : undefined;
    };

    const output = await runInvariantDiscover({
      srcDir: resolve(srcDir),
      minPurity: Number(getArg("--min-purity") ?? "0"),
      suggestExtractions: restArgs.includes("--suggest-extractions"),
      format: (getArg("--format") as "text" | "json" | "compact") ?? "text",
      outFile: getArg("--out"),
    });
    if (!getArg("--out")) process.stdout.write(output);
  } else {
    // For other subcommands (generate, verify, calibrate, contracts, check-log, mutate, prove),
    // reconstruct argv and let the original CLI handle them.
    process.argv = ["bun", "invariant.ts", ...args];
    await import("../../flow/src/cli/invariant.js");
  }
}
