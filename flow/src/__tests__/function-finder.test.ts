import { describe, test, expect } from "bun:test";
import { discoverFunctions } from "../invariant/function-finder.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function withTempSrc(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "flow-test-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, "utf8");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("discoverFunctions", () => {
  test("discovers exported function declarations", async () => {
    await withTempSrc(
      {
        "math.ts": `export function add(a: number, b: number): number { return a + b; }`,
      },
      async (dir) => {
        const fns = await discoverFunctions(dir);
        expect(fns.length).toBeGreaterThanOrEqual(1);
        const add = fns.find((f) => f.name === "add");
        expect(add).toBeDefined();
        expect(add!.params).toHaveLength(2);
        expect(add!.exportKind).toBe("named");
      },
    );
  });

  test("classifies pure functions with high purity score", async () => {
    await withTempSrc(
      {
        "pure.ts": `export function double(x: number): number { return x * 2; }`,
      },
      async (dir) => {
        const fns = await discoverFunctions(dir);
        const double = fns.find((f) => f.name === "double");
        expect(double).toBeDefined();
        expect(double!.purityScore).toBe(1.0);
        expect(double!.purityFlags).toHaveLength(0);
      },
    );
  });

  test("detects impurity from await keyword", async () => {
    await withTempSrc(
      {
        "async.ts": `export async function fetchData(url: string): Promise<string> { return await fetch(url).then(r => r.text()); }`,
      },
      async (dir) => {
        const fns = await discoverFunctions(dir);
        const fn = fns.find((f) => f.name === "fetchData");
        expect(fn).toBeDefined();
        expect(fn!.purityScore).toBeLessThan(1.0);
        expect(fn!.purityFlags).toContain("await");
      },
    );
  });

  test("discovers exported arrow functions", async () => {
    await withTempSrc(
      {
        "arrow.ts": `export const greet = (name: string): string => \`Hello \${name}\`;`,
      },
      async (dir) => {
        const fns = await discoverFunctions(dir);
        const greet = fns.find((f) => f.name === "greet");
        expect(greet).toBeDefined();
        expect(greet!.params).toHaveLength(1);
      },
    );
  });

  test("respects minPurity filter", async () => {
    await withTempSrc(
      {
        "mixed.ts": [
          `export function pure(x: number): number { return x; }`,
          `export async function impure(): Promise<void> { await new Promise(r => setTimeout(r, 0)); console.log("done"); }`,
        ].join("\n"),
      },
      async (dir) => {
        const all = await discoverFunctions(dir);
        expect(all.length).toBe(2);

        const pureFns = await discoverFunctions(dir, { minPurity: 0.9 });
        expect(pureFns.length).toBe(1);
        expect(pureFns[0]!.name).toBe("pure");
      },
    );
  });
});
