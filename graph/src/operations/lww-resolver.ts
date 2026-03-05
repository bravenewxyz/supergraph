import type { OperationEntry } from "../schema/operations.js";

export interface LWWResolution {
  winner: OperationEntry;
  loser: OperationEntry;
}

/**
 * Resolve two conflicting operations using last-writer-wins semantics.
 *
 * Resolution order:
 * 1. Higher Lamport timestamp wins
 * 2. Tie-break: higher wall-clock timestamp
 * 3. Final tie-break: lexicographic agent ID comparison (deterministic)
 */
export function resolveLWW(
  opA: OperationEntry,
  opB: OperationEntry,
): LWWResolution {
  let winner: OperationEntry;
  let loser: OperationEntry;

  if (opA.lamport !== opB.lamport) {
    winner = opA.lamport > opB.lamport ? opA : opB;
    loser = winner === opA ? opB : opA;
  } else if (opA.timestamp !== opB.timestamp) {
    winner = opA.timestamp > opB.timestamp ? opA : opB;
    loser = winner === opA ? opB : opA;
  } else {
    // Deterministic: lexicographic comparison on agentId
    winner = opA.agentId >= opB.agentId ? opA : opB;
    loser = winner === opA ? opB : opA;
  }

  return { winner, loser };
}
