import { runDetectChanges } from "../../packages/graph/src/cli/detect-changes.js";
import type { Scope } from "../../packages/graph/src/cli/detect-changes.js";

export async function runDetectChangesCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.error(
      "Usage: supergraph detect-changes [--scope staged|unstaged|all|compare] [--compare <ref>] [--format text|json] [--pkg <name>]",
    );
    process.exit(1);
  }

  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const scope = (getArg("--scope") as Scope) ?? "unstaged";
  const compareRef = getArg("--compare");
  const format = (getArg("--format") as "text" | "json") ?? "text";
  const pkg = getArg("--pkg");

  if (scope === "compare" && !compareRef) {
    console.error("Error: --compare <ref> is required when --scope is 'compare'");
    process.exit(1);
  }

  const output = await runDetectChanges({ scope, compareRef, format, pkg });
  process.stdout.write(output);
}
