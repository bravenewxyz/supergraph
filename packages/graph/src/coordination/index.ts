export { SymbolLockTable } from "./symbol-lock-table.js";
export type {
  ActiveModification,
  AcquireResult,
  ConflictInfo,
} from "./symbol-lock-table.js";

export { ContractLayer } from "./contract-layer.js";
export type {
  AgentContractView,
  ValidationResult,
  ValidationError,
  ChangeProposal,
} from "./contract-layer.js";

export { ScopeGraph } from "./scope-graph.js";
export type { SymbolConflict, AdvisoryInfo } from "./scope-graph.js";

export { classifyOperation, classifyBatch } from "./tier-classifier.js";
export type {
  CoordinationTier,
  TierClassification,
} from "./tier-classifier.js";
