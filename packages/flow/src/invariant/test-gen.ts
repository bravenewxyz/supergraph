import { relative, dirname, join } from "node:path";
import { generateArbitraryBlock } from "./arbitrary-gen.js";
import type {
  DiscoveredFunction,
  Invariant,
  GeneratedTest,
  FunctionParam,
} from "./types.js";

export interface TestGenOptions {
  outDir?: string;
  prove?: boolean;
}

function sourceToImportPath(
  testFilePath: string,
  sourceFilePath: string
): string {
  const testDir = dirname(testFilePath);
  const rel = relative(testDir, sourceFilePath);
  return rel.replace(/\.ts$/, ".js");
}

function buildPropertyCallback(
  func: DiscoveredFunction,
  inv: Invariant,
  params: FunctionParam[]
): string {
  const fnName = func.name;
  const postcond = inv.postcondition;

  if (params.length === 0) {
    return `(_input) => {
      const result = ${fnName}();
      const input = undefined;
      return ${postcond};
    }`;
  }

  if (params.length === 1) {
    return `(input) => {
      const result = ${fnName}(input);
      return ${postcond};
    }`;
  }

  const destructured = params.map((p) => p.name).join(", ");
  const args = params.map((p) => p.name).join(", ");
  const inputBuild = params
    .map((p) => `${JSON.stringify(p.name)}: ${p.name}`)
    .join(", ");
  return `([${destructured}]) => {
      const input = { ${inputBuild} };
      const result = ${fnName}(${args});
      return ${postcond};
    }`;
}

function generateArbitraryDeclaration(
  func: DiscoveredFunction,
  params: FunctionParam[]
): string {
  if (params.length === 0) {
    return "const inputArb = fc.constant(undefined);";
  }
  return generateArbitraryBlock(params);
}

export function generateTestFile(
  func: DiscoveredFunction,
  invariants: Invariant[],
  options?: TestGenOptions
): GeneratedTest {
  const outDir =
    options?.outDir ??
    join(dirname(func.filePath), "__tests__", "invariants");
  const testFileName = `${func.name}.invariant.test.ts`;
  const testFilePath = join(outDir, testFileName);
  const importPath = sourceToImportPath(testFilePath, func.filePath);

  const importClause =
    func.exportKind === "default"
      ? `import ${func.name} from "${importPath}";`
      : `import { ${func.name} } from "${importPath}";`;

  const arbDecl = generateArbitraryDeclaration(func, func.params);

  const testBlocks: string[] = invariants.map((inv) => {
    const callback = buildPropertyCallback(func, inv, func.params);
    let block = `  it("${inv.name}: ${inv.description.replace(/"/g, '\\"')}", () => {
    fc.assert(fc.property(inputArb, ${callback}));
  });`;
    if (options?.prove && inv.severity === "critical") {
      block += `
  // TODO: Z3 proof for critical invariant "${inv.name}"
  // import { init_z3 } from "z3-solver";
  // const prove = async () => { ... };`;
    }
    return block;
  });

  const content = `import { describe, it, expect } from "bun:test";
import fc from "fast-check";
${importClause}

describe("${func.name} invariants", () => {
  ${arbDecl}

${testBlocks.join("\n\n")}
});
`;

  return {
    filePath: testFilePath,
    content,
    functionName: func.name,
    invariantCount: invariants.length,
  };
}

export function generateTestSuite(
  functions: DiscoveredFunction[],
  invariantsByFunction: Map<string, Invariant[]>,
  options?: TestGenOptions
): GeneratedTest[] {
  return functions
    .filter((func) => {
      const invariants = invariantsByFunction.get(func.name);
      return invariants && invariants.length > 0;
    })
    .map((func) => {
      const invariants = invariantsByFunction.get(func.name)!;
      return generateTestFile(func, invariants, options);
    });
}
