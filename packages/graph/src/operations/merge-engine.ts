import type { OperationEntry } from "../schema/operations.js";
import type { GraphStore } from "../store/graph-store.js";
import { checkCommutativity, getAffectedSymbolIds } from "./commutativity.js";
import { resolveLWW } from "./lww-resolver.js";

export interface ComposeResult {
  applied: OperationEntry[];
  conflicts: MergeConflict[];
  autoResolved: AutoResolution[];
}

export interface MergeConflict {
  opA: OperationEntry;
  opB: OperationEntry;
  symbolId: string;
  reason: string;
}

export interface AutoResolution {
  winner: OperationEntry;
  loser: OperationEntry;
  strategy: "lww" | "idempotent";
}

/**
 * Compose concurrent operation batches from multiple agents.
 *
 * Algorithm:
 * 1. Flatten all op sets into pairs
 * 2. For each pair of ops from different agents on same symbol, check commutativity
 * 3. "commutes" -> both go to applied
 * 4. "lww" -> resolve with Lamport timestamp; winner to applied, noted in autoResolved
 * 5. "idempotent" -> keep one in applied
 * 6. "conflict" -> both go to conflicts
 * 7. Final: deduplicate applied list, order by Lamport
 */
export class MergeEngine {
  constructor(private graphStore: GraphStore) {}

  compose(opSets: OperationEntry[][]): ComposeResult {
    const applied = new Map<string, OperationEntry>(); // keyed by entry id
    const conflicts: MergeConflict[] = [];
    const autoResolved: AutoResolution[] = [];
    const excluded = new Set<string>(); // entry ids excluded due to conflict

    // Start by marking all entries as candidates for applied
    const allEntries: OperationEntry[] = [];
    for (const set of opSets) {
      for (const entry of set) {
        allEntries.push(entry);
        applied.set(entry.id, entry);
      }
    }

    // Build a map of symbolId -> entries that affect it.
    // Only compare entries that share at least one symbol (different-symbol ops always commute).
    const symbolToEntries = new Map<string, OperationEntry[]>();
    for (const entry of allEntries) {
      const symbolIds = getAffectedSymbolIds(entry.op);
      for (const sid of symbolIds) {
        let list = symbolToEntries.get(sid);
        if (!list) {
          list = [];
          symbolToEntries.set(sid, list);
        }
        list.push(entry);
      }
    }

    // Track which pairs we've already compared to avoid duplicate work
    const comparedPairs = new Set<string>();

    for (const [, entries] of symbolToEntries) {
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const entryA = entries[i]!;
          const entryB = entries[j]!;

          // Skip ops from the same agent
          if (entryA.agentId === entryB.agentId) continue;

          // Deduplicate pairs (an entry pair may share multiple symbols)
          const pairKey = entryA.id < entryB.id
            ? `${entryA.id}:${entryB.id}`
            : `${entryB.id}:${entryA.id}`;
          if (comparedPairs.has(pairKey)) continue;
          comparedPairs.add(pairKey);

          const result = checkCommutativity(entryA.op, entryB.op);

          if (result === "commutes") {
            // Both stay in applied
            continue;
          }

          if (result === "lww") {
            const resolution = resolveLWW(entryA, entryB);
            autoResolved.push({
              winner: resolution.winner,
              loser: resolution.loser,
              strategy: "lww",
            });
            // Remove loser from applied
            applied.delete(resolution.loser.id);
            excluded.add(resolution.loser.id);
            continue;
          }

          if (result === "contract-dependent") {
            // Contract drift checking not yet implemented — fall back to LWW.
            // Both ops stay but the caller is informed via autoResolved.
            const resolution = resolveLWW(entryA, entryB);
            autoResolved.push({
              winner: resolution.winner,
              loser: resolution.loser,
              strategy: "lww",
            });
            applied.delete(resolution.loser.id);
            excluded.add(resolution.loser.id);
            continue;
          }

          if (result === "idempotent") {
            // Keep the one with higher Lamport (or either, they're equivalent)
            const resolution = resolveLWW(entryA, entryB);
            autoResolved.push({
              winner: resolution.winner,
              loser: resolution.loser,
              strategy: "idempotent",
            });
            applied.delete(resolution.loser.id);
            excluded.add(resolution.loser.id);
            continue;
          }

          // conflict
          const symbolsA = getAffectedSymbolIds(entryA.op);
          const symbolsB = getAffectedSymbolIds(entryB.op);
          const sharedSymbols = symbolsA.filter((s) => symbolsB.includes(s));
          const symbolId = sharedSymbols[0] ?? "unknown";

          conflicts.push({
            opA: entryA,
            opB: entryB,
            symbolId,
            reason: `${entryA.op.type} conflicts with ${entryB.op.type} on symbol ${symbolId}`,
          });

          // Remove both from applied
          applied.delete(entryA.id);
          applied.delete(entryB.id);
          excluded.add(entryA.id);
          excluded.add(entryB.id);
        }
      }
    }

    // Sort applied by Lamport order
    const sortedApplied = [...applied.values()].sort(
      (a, b) => a.lamport - b.lamport,
    );

    return {
      applied: sortedApplied,
      conflicts,
      autoResolved,
    };
  }
}
