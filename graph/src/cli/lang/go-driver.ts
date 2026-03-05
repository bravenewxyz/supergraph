import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LanguageDriver, MapOptions, MapResult, ComplexityOptions, DeadExportsOptions } from "./types.js";

export const goDriver: LanguageDriver = {
  id: "go",
  name: "Go",

  async detect(dir: string): Promise<boolean> {
    let current = resolve(dir);
    for (let i = 0; i < 4; i++) {
      try {
        await stat(join(current, "go.mod"));
        return true;
      } catch {}
      const parent = resolve(current, "..");
      if (parent === current) break;
      current = parent;
    }
    return false;
  },

  async map(opts: MapOptions): Promise<MapResult> {
    const { runGoMap } = await import("../go-map.js");
    return runGoMap({ srcRoot: opts.srcRoot, format: opts.format, outPath: opts.outPath });
  },

  async complexity(opts: ComplexityOptions): Promise<string> {
    const { runGoComplexity } = await import("../go-complexity.js");
    return runGoComplexity({ srcRoot: opts.srcRoot, outPath: opts.outPath, topN: opts.topN, minComplexity: opts.minComplexity });
  },

  async deadExports(opts: DeadExportsOptions): Promise<string> {
    const { runGoDeadExports } = await import("../go-dead-exports.js");
    return runGoDeadExports({ srcRoot: opts.srcRoot, outPath: opts.outPath });
  },
};
