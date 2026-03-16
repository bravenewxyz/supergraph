// ── types ───────────────────────────────────────────────────────────

export interface CrossRepField {
  fieldName: string;
  schemaOptional: boolean;
  typeOptional: boolean;
}

export interface CrossRepMismatch {
  schemaName: string;
  typeName: string;
  field: CrossRepField;
  mismatchKind: string;
  message: string;
}

export interface GuardInconsistency {
  filePath: string;
  line: number;
  loopVariable: string;
  guardedPush: { collection: string; guard: string; line: number };
  unguardedPush: { collection: string; line: number };
  message: string;
  confidence: "high" | "med" | "low";
}

export interface PushSite {
  collection: string;
  line: number;
  guard: string | null;
  guardLine: number | null;
}

export interface StatusFunction {
  name: string;
  filePath: string;
  line: number;
  returnType: string;
  branchCount: number;
  lineCount: number;
}

export interface DecisionRow {
  conditions: Record<string, string>;
  outcome: string;
  line: number;
}

export interface SuspiciousCell {
  signal: string;
  outcome: string;
  line: number;
  reason: string;
  /** Explicit gap scenario: the case where the failure sub-expression is true but the AND-gate
   *  suppressor is false, producing a success outcome. Makes the predicate soundness question
   *  concrete so auditors cannot stop at verifying the downstream gate logic. */
  gapScenario?: string;
  /** Whether the gap is reachable by the caller, and why. "certain" = failure leaf is a function
   *  param; "likely" = leaf comes from external call result; "unknown" = static analysis insufficient. */
  reachabilityNote?: string;
  /** Contrast row: what the outcome becomes when the gate condition IS true (the suppressed path).
   *  Proves the gate condition is the sole differentiator between success and failure outcomes. */
  contrastNote?: string;
  /** One-sentence verdict synthesised from reachability + contrast. */
  verdictNote?: string;
}

export interface DecisionTable {
  functionName: string;
  filePath: string;
  line: number;
  signals: string[];
  definitions: Record<string, string>;
  rows: DecisionRow[];
  suspiciousCells: SuspiciousCell[];
}

export interface ExhaustivenessGap {
  filePath: string;
  line: number;
  switchExpression: string;
  knownMembers: string[];
  handledMembers: string[];
  missingMembers: string[];
  hasDefault: boolean;
  message: string;
}

export interface LogicAuditOptions {
  srcDir: string;
  format?: "text" | "json";
  outFile?: string;
  minConfidence?: "high" | "med" | "low";
}

export interface LogicAuditResult {
  crossRep: CrossRepMismatch[];
  guards: GuardInconsistency[];
  broadGuards: GuardInconsistency[];
  statusFunctions: StatusFunction[];
  decisionTables: DecisionTable[];
  exhaustivenessGaps: ExhaustivenessGap[];
}

export interface OpSite {
  op: string;
  line: number;
  guard: string | null;
}

export interface AssignSite {
  varName: string;
  line: number;
  guard: string | null;
}
