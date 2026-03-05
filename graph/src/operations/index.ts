export { OperationLog } from "./op-log.js";
export {
  checkCommutativity,
  checkCommutativityByType,
  checkBatchCommutativity,
  getAffectedSymbolIds,
} from "./commutativity.js";
export type { CommutativityResult } from "./commutativity.js";
export { MergeEngine } from "./merge-engine.js";
export type {
  ComposeResult,
  MergeConflict,
  AutoResolution,
} from "./merge-engine.js";
export { resolveLWW } from "./lww-resolver.js";
export type { LWWResolution } from "./lww-resolver.js";
export { computeInverse, rollbackAgent } from "./rollback.js";
export type { RollbackResult } from "./rollback.js";
