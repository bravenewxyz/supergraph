import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LanguageDriver, MapOptions, MapResult, ComplexityOptions, DeadExportsOptions } from "./types.js";

export const tsDriver: LanguageDriver = {
  id: "typescript",
  name: "TypeScript",

  async detect(dir: string): Promise<boolean> {
    let current = resolve(dir);
    for (let i = 0; i < 3; i++) {
      try {
        await stat(join(current, "tsconfig.json"));
        return true;
      } catch {}
      try {
        await stat(join(current, "package.json"));
        return true;
      } catch {}
      const parent = resolve(current, "..");
      if (parent === current) break;
      current = parent;
    }
    return false;
  },

  async map(opts: MapOptions): Promise<MapResult> {
    const { runMap } = await import("../map.js");
    return runMap(opts);
  },

  async complexity(opts: ComplexityOptions): Promise<string> {
    const { runComplexity } = await import("../complexity.js");
    return runComplexity(opts);
  },

  async deadExports(opts: DeadExportsOptions): Promise<string> {
    const { runDeadExports } = await import("../dead-exports.js");
    return runDeadExports(opts);
  },
};
