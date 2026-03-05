import { describe, test, expect } from "bun:test";
import {
  invariantsToContracts,
  generateContractCode,
  generateContractImport,
  applyContracts,
} from "../invariant/runtime-contracts.js";
import type { Invariant, DiscoveredFunction, RuntimeContract } from "../invariant/types.js";

const makeFunc = (name: string, filePath: string): DiscoveredFunction => ({
  name,
  filePath,
  line: 1,
  exportKind: "named",
  params: [{ name: "x", type: { kind: "primitive", value: "number" }, optional: false }],
  returnType: { kind: "primitive", value: "number" },
  purityScore: 1.0,
  purityFlags: [],
  sourceText: `function ${name}(x: number) { return x + 1; }`,
  signatureHash: "abc123",
});

const makeInvariant = (
  name: string,
  funcName: string,
  filePath: string,
  status: Invariant["verificationStatus"] = "no-counterexample",
): Invariant => ({
  name,
  targetFunction: funcName,
  targetFile: filePath,
  description: `${name} invariant`,
  postcondition: "result > input",
  severity: "high",
  confidence: 0.9,
  verificationStatus: status,
  iterations: 100,
});

describe("invariantsToContracts", () => {
  test("converts verified invariants to postcondition contracts", () => {
    const func = makeFunc("add", "/src/math.ts");
    const inv = makeInvariant("positive", "add", "/src/math.ts");
    const contracts = invariantsToContracts(func, [inv]);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.position).toBe("post");
    expect(contracts[0]!.condition).toContain("__invariantResult");
    expect(contracts[0]!.targetFunction).toBe("add");
  });

  test("skips unverified invariants", () => {
    const func = makeFunc("add", "/src/math.ts");
    const inv = makeInvariant("untested", "add", "/src/math.ts", "untested");
    expect(invariantsToContracts(func, [inv])).toHaveLength(0);
  });

  test("skips invariants for wrong function", () => {
    const func = makeFunc("add", "/src/math.ts");
    const inv = makeInvariant("other", "subtract", "/src/math.ts");
    expect(invariantsToContracts(func, [inv])).toHaveLength(0);
  });
});

describe("generateContractCode", () => {
  test("returns empty string for no contracts", () => {
    expect(generateContractCode([])).toBe("");
  });

  test("generates invariant() calls for enabled post contracts", () => {
    const contracts: RuntimeContract[] = [{
      targetFunction: "fn",
      targetFile: "/a.ts",
      position: "post",
      condition: "__invariantResult > 0",
      message: "must be positive",
      enabled: true,
    }];
    const code = generateContractCode(contracts);
    expect(code).toContain("invariant(__invariantResult > 0");
    expect(code).toContain("postconditions");
  });

  test("skips disabled contracts", () => {
    const contracts: RuntimeContract[] = [{
      targetFunction: "fn",
      targetFile: "/a.ts",
      position: "post",
      condition: "true",
      message: "msg",
      enabled: false,
    }];
    expect(generateContractCode(contracts)).toBe("");
  });
});

describe("generateContractImport", () => {
  test("generates tiny-invariant import", () => {
    expect(generateContractImport()).toContain("tiny-invariant");
  });
});

describe("applyContracts", () => {
  test("injects import and postcondition into source code", () => {
    const source = `function add(x: number): number {\n  return x + 1;\n}`;
    const func = makeFunc("add", "/a.ts");
    const contracts: RuntimeContract[] = [{
      targetFunction: "add",
      targetFile: "/a.ts",
      position: "post",
      condition: "__invariantResult > 0",
      message: "positive",
      enabled: true,
    }];
    const result = applyContracts(source, func, contracts);
    expect(result).toContain("tiny-invariant");
    expect(result).toContain("__invariantResult");
  });
});
