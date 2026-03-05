import { describe, test, expect } from "bun:test";
import { mutateInvariant, type MutatedInvariant } from "../invariant/invariant-mutator.js";

describe("mutateInvariant", () => {
  test("produces mutations from a simple comparison postcondition", () => {
    const results = mutateInvariant("result.count >= 0");
    expect(results.length).toBeGreaterThan(0);

    const kinds = new Set(results.map((r) => r.kind));
    expect(kinds.has("specialize")).toBe(true);

    const specialized = results.filter((r) => r.kind === "specialize");
    expect(specialized.some((r) => r.mutatedPostcondition.includes("=== 0"))).toBe(true);
  });

  test("produces generalize mutations for strict equality", () => {
    const results = mutateInvariant("result.status === true");
    const generalized = results.filter((r) => r.kind === "generalize");
    expect(generalized.length).toBeGreaterThan(0);
    expect(generalized.some((r) => r.mutatedPostcondition.includes("!== false"))).toBe(true);
  });

  test("produces weaken mutations for ternary-guarded postconditions", () => {
    const postcond = "input.x > 0 ? result.value > 0 : true";
    const results = mutateInvariant(postcond);
    const weakened = results.filter((r) => r.kind === "weaken");
    expect(weakened.length).toBeGreaterThan(0);
    for (const w of weakened) {
      expect(w.mutatedPostcondition).not.toBe(postcond);
    }
  });

  test("never returns the original postcondition as a mutation", () => {
    const original = "result.value >= 0";
    const results = mutateInvariant(original);
    for (const r of results) {
      expect(r.mutatedPostcondition).not.toBe(original);
    }
  });

  test("handles postconditions with string comparisons (strengthen)", () => {
    const results = mutateInvariant('result.status === "failed"');
    const strengthened = results.filter((r) => r.kind === "strengthen");
    expect(strengthened.length).toBeGreaterThan(0);
    expect(
      strengthened.some((r) => r.mutatedPostcondition.includes("!== undefined")),
    ).toBe(true);
  });
});
