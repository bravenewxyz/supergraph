import { mutateInvariant } from "./invariant-mutator.js";
import type {
  Invariant,
  DiscoveredFunction,
  VerificationResult,
  MutationResult,
  RefinementStep,
} from "./types.js";

export interface RefineOptions {
  maxIterations?: number;
  verify: (
    postcondition: string
  ) => Promise<{ passed: boolean; counterexample?: unknown }>;
}

const DEFAULT_MAX_ITERATIONS = 3;

const REFINEMENT_PROMPT = `The invariant you generated failed.

Function:
{{SOURCE_TEXT}}

Invariant: {{POSTCONDITION}}
Counterexample: {{COUNTEREXAMPLE}}

Either:
(a) This is a REAL BUG in the code — the function does not satisfy the invariant
    and it shouldn't. Respond with: { "verdict": "bug", "explanation": "..." }
(b) The invariant is WRONG — the function is correct but the invariant was too
    strong. Respond with a corrected invariant JSON.

Important: Do NOT weaken the invariant just to make it pass. If you believe the
function should satisfy the original invariant, say "bug".`;

export async function refineInvariant(
  invariant: Invariant,
  counterexample: unknown,
  func: DiscoveredFunction,
  llmGenerate: (
    prompt: string
  ) => Promise<Invariant | { verdict: "bug"; explanation: string }>,
  options?: RefineOptions
): Promise<VerificationResult> {
  if (!options?.verify) {
    throw new Error("refineInvariant requires options.verify");
  }
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const verify = options.verify;
  const refinementHistory: RefinementStep[] = [];
  const mutationsAttempted: MutationResult[] = [];

  refinementHistory.push({
    iteration: 0,
    invariantSnapshot: invariant.postcondition,
    counterexample,
  });

  const mutations = mutateInvariant(invariant.postcondition);
  for (const m of mutations) {
    const { passed, counterexample: cx } = await verify(m.mutatedPostcondition);
    mutationsAttempted.push({
      kind: m.kind,
      mutatedPostcondition: m.mutatedPostcondition,
      passed,
      counterexample: cx,
    });
    if (passed) {
      const mutatedInvariant: Invariant = {
        ...invariant,
        postcondition: m.mutatedPostcondition,
        verificationStatus: "mutated",
        parentInvariant: invariant.name,
        counterexample: undefined,
        iterations: invariant.iterations + 1,
      };
      return {
        invariant: mutatedInvariant,
        passed: true,
        mutationsAttempted,
        refinementHistory,
      };
    }
  }

  let currentInvariant = invariant;
  let currentCounterexample = counterexample;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const prompt = REFINEMENT_PROMPT.replace("{{SOURCE_TEXT}}", func.sourceText)
      .replace("{{POSTCONDITION}}", currentInvariant.postcondition)
      .replace(
        "{{COUNTEREXAMPLE}}",
        JSON.stringify(currentCounterexample, null, 2)
      );

    const llmResult = await llmGenerate(prompt);

    if ("verdict" in llmResult && llmResult.verdict === "bug") {
      refinementHistory.push({
        iteration,
        invariantSnapshot: currentInvariant.postcondition,
        counterexample: currentCounterexample,
        llmReasoning: llmResult.explanation,
      });
      const failedInvariant: Invariant = {
        ...currentInvariant,
        verificationStatus: "failed",
        counterexample: currentCounterexample,
        iterations: invariant.iterations + iteration,
      };
      return {
        invariant: failedInvariant,
        passed: false,
        counterexample: currentCounterexample,
        mutationsAttempted,
        refinementHistory,
      };
    }

    if (!("postcondition" in llmResult) || typeof (llmResult as any).postcondition !== "string") {
      refinementHistory.push({
        iteration,
        invariantSnapshot: currentInvariant.postcondition,
        counterexample: currentCounterexample,
        llmReasoning: "LLM returned invalid invariant structure",
      });
      continue;
    }
    const refinedInvariant = llmResult as Invariant;
    refinementHistory.push({
      iteration,
      invariantSnapshot: refinedInvariant.postcondition,
      counterexample: currentCounterexample,
      llmReasoning: refinedInvariant.description,
    });

    const { passed, counterexample: cx } = await verify(
      refinedInvariant.postcondition
    );
    if (passed) {
      const provenInvariant: Invariant = {
        ...refinedInvariant,
        verificationStatus: "proven",
        counterexample: undefined,
        iterations: invariant.iterations + iteration,
      };
      return {
        invariant: provenInvariant,
        passed: true,
        mutationsAttempted,
        refinementHistory,
      };
    }

    currentInvariant = refinedInvariant;
    currentCounterexample = cx;
  }

  const inconclusiveInvariant: Invariant = {
    ...currentInvariant,
    verificationStatus: "inconclusive",
    counterexample: currentCounterexample,
    iterations: invariant.iterations + maxIterations,
  };
  return {
    invariant: inconclusiveInvariant,
    passed: false,
    counterexample: currentCounterexample,
    mutationsAttempted,
    refinementHistory,
  };
}
