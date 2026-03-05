import { resolve } from "node:path";
import { runLogicAudit } from "../../flow/src/cli/logic-audit.js";

export async function runLogicAuditCommand(args: string[]): Promise<void> {
  const srcDir = args.find((a) => !a.startsWith("--"));
  if (!srcDir || args.includes("--help") || args.includes("-h")) {
    console.error("Usage: supergraph logic-audit <src-dir> [--format text|json] [--out <file>] [--min-confidence high|med|low]");
    process.exit(1);
  }

  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const output = await runLogicAudit({
    srcDir: resolve(srcDir),
    format: (getArg("--format") as "text" | "json") ?? "text",
    outFile: getArg("--out"),
    minConfidence: (getArg("--min-confidence") as "high" | "med" | "low") ?? "med",
  });
  if (!getArg("--out")) process.stdout.write(output);
}
