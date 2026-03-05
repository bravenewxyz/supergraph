import type { ShapeType } from "../schema/shapes.js";

export interface Invariant {
  name: string;
  targetFunction: string;
  targetFile: string;
  description: string;
  postcondition: string;        // TypeScript boolean expression using `input` and `result`
  severity: "critical" | "high" | "medium";
  confidence: number;           // 0-1, from LLM self-assessment + structural heuristics
  verificationStatus:
    | "untested"
    | "proven"
    | "no-counterexample"
    | "failed"
    | "mutated"
    | "inconclusive";
  counterexample?: unknown;
  iterations: number;
  parentInvariant?: string;
}

export interface DiscoveredFunction {
  name: string;
  filePath: string;
  line: number;
  exportKind: "named" | "default";
  params: FunctionParam[];
  returnType: ShapeType;
  purityScore: number;          // 0-1, higher = more likely pure
  purityFlags: string[];        // reasons for impurity: "await", "fs-import", "mutation", etc.
  sourceText: string;
  signatureHash: string;        // for similarity clustering
  extractionHint?: string;      // if purity < 0.5, suggests what pure logic could be extracted
  similarFunctions?: string[];
}

export interface FunctionParam {
  name: string;
  type: ShapeType;
  optional: boolean;
}

export interface GeneratedTest {
  filePath: string;
  content: string;
  functionName: string;
  invariantCount: number;
}

export interface VerificationResult {
  invariant: Invariant;
  passed: boolean;
  counterexample?: unknown;
  mutationsAttempted: MutationResult[];
  refinementHistory: RefinementStep[];
}

export interface MutationResult {
  kind: "weaken" | "strengthen" | "generalize" | "specialize";
  mutatedPostcondition: string;
  passed: boolean;
  counterexample?: unknown;
}

export interface RefinementStep {
  iteration: number;
  invariantSnapshot: string;
  counterexample?: unknown;
  llmReasoning?: string;
}

export interface CalibrationResult {
  knownBug: string;
  detected: boolean;
  invariantThatCaughtIt?: string;
  falseNegativeReason?: string;
}

export interface ConsistencyInput {
  func: DiscoveredFunction;
  jsdoc: string | null;
  inlineComments: string[];
  invariants: Invariant[];
  specDescription?: string;
}

export type ConsistencyVerdict =
  | { type: "consistent"; confidence: number }
  | { type: "code-doc-mismatch"; description: string; evidence: string }
  | { type: "code-invariant-mismatch"; description: string; counterexample: unknown }
  | { type: "doc-invariant-mismatch"; description: string; docSays: string; invariantSays: string }
  | { type: "all-three-disagree"; description: string };

export interface RuntimeContract {
  targetFunction: string;
  targetFile: string;
  position: "pre" | "post";
  condition: string;
  message: string;
  enabled: boolean;
}

export interface LogInvariant {
  name: string;
  eventFilter: string;
  condition: string;
  severity: "critical" | "high" | "medium";
}

export interface MutationReport {
  totalMutants: number;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  mutationScore: number;
  survivingMutants: SurvivedMutant[];
}

export interface SurvivedMutant {
  file: string;
  line: number;
  mutatorName: string;
  replacement: string;
  suggestedInvariant?: string;
}
