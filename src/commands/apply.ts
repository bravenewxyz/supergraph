/**
 * supergraph apply — agent-safe graph mutations with CRDT coordination.
 *
 * Accepts a JSON file (or stdin) containing operations, classifies them by
 * coordination tier, checks commutativity, acquires symbol locks, and applies
 * via the merge engine. Writes the updated graph to .supergraph/graph.json.
 *
 * Usage:
 *   supergraph apply <operations.json>              Apply from file
 *   supergraph apply --stdin                        Apply from stdin
 *   supergraph apply <file> --agent <id>            Specify agent ID
 *   supergraph apply <file> --dry-run               Classify + check without applying
 *   supergraph apply --load <graph.json> <ops.json> Load existing graph first
 *   supergraph apply --format json                  JSON output
 */

import { resolve, join } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { GraphStore } from "../../packages/graph/src/store/graph-store.js";
import { classifyBatch } from "../../packages/graph/src/coordination/tier-classifier.js";
import { SymbolLockTable } from "../../packages/graph/src/coordination/symbol-lock-table.js";
import { getAffectedSymbolIds } from "../../packages/graph/src/operations/commutativity.js";
import { MergeEngine } from "../../packages/graph/src/operations/merge-engine.js";
import type { GraphOperation, OperationEntry } from "../../packages/graph/src/schema/operations.js";

interface ApplyInput {
  /** Agent submitting these operations. Defaults to "cli". */
  agentId?: string;
  /** Batch ID for grouping. Auto-generated if omitted. */
  batchId?: string;
  /** The operations to apply. */
  operations: GraphOperation[];
}

interface ApplyResult {
  tier: string;
  tierReason: string;
  requiresApproval: boolean;
  applied: number;
  conflicts: number;
  autoResolved: number;
  results: Array<{ applied: boolean; type: string; symbolId?: string; reason?: string }>;
  conflictDetails: Array<{ opA: string; opB: string; symbolId: string; reason: string }>;
  autoResolvedDetails: Array<{ winner: string; loser: string; strategy: string }>;
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export async function runApplyCommand(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(`supergraph apply — agent-safe graph mutations

Usage:
  supergraph apply <operations.json>              Apply operations from file
  supergraph apply --stdin                        Read operations from stdin
  supergraph apply <file> --agent <id>            Specify agent identity
  supergraph apply <file> --dry-run               Classify and check without applying
  supergraph apply --load <graph.json> <ops.json> Load existing graph first
  supergraph apply --format json                  Output as JSON

Input format (operations.json):
  {
    "agentId": "agent-1",          // optional, defaults to "cli"
    "batchId": "batch-abc",        // optional, auto-generated
    "operations": [
      { "type": "AddSymbol", "symbol": { "id": "...", "kind": "function", "name": "foo", "qualifiedName": "mod.foo" } },
      { "type": "ModifyBody", "symbolId": "...", "newBody": "return 42;" },
      { "type": "AddEdge", "edge": { "id": "...", "kind": "calls", "sourceId": "...", "targetId": "..." } }
    ]
  }`);
    process.exit(0);
  }

  const dryRun = hasFlag(args, "--dry-run");
  const formatJson = getArg(args, "--format") === "json";
  const agentIdOverride = getArg(args, "--agent");
  const graphPath = getArg(args, "--load");
  const useStdin = hasFlag(args, "--stdin");

  // Parse input
  let rawInput: string;
  if (useStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    rawInput = Buffer.concat(chunks).toString("utf-8");
  } else {
    const file = args.find((a) => !a.startsWith("--") && a !== getArg(args, "--format") && a !== getArg(args, "--agent") && a !== getArg(args, "--load"));
    if (!file) {
      console.error("Error: provide an operations file or use --stdin");
      process.exit(1);
    }
    rawInput = readFileSync(resolve(file), "utf-8");
  }

  let input: ApplyInput;
  try {
    input = JSON.parse(rawInput) as ApplyInput;
  } catch (e: any) {
    console.error(`Error: invalid JSON — ${e.message}`);
    process.exit(1);
  }

  if (!input.operations || !Array.isArray(input.operations) || input.operations.length === 0) {
    console.error("Error: input must have a non-empty 'operations' array");
    process.exit(1);
  }

  const agentId = agentIdOverride ?? input.agentId ?? "cli";
  const batchId = input.batchId ?? `batch-${Date.now()}`;

  // Load or create graph
  const graphStore = new GraphStore();
  const defaultGraphPath = join(process.cwd(), ".supergraph", "graph.json");
  const loadPath = graphPath ? resolve(graphPath) : (existsSync(defaultGraphPath) ? defaultGraphPath : null);

  if (loadPath) {
    try {
      const graphJson = readFileSync(loadPath, "utf-8");
      graphStore.importJSON(graphJson);
    } catch (e: any) {
      console.error(`Error loading graph from ${loadPath}: ${e.message}`);
      process.exit(1);
    }
  }

  // Classify the batch
  const tier = classifyBatch(input.operations, graphStore);

  // Build OperationEntry objects
  const entries: OperationEntry[] = input.operations.map((op, i) => ({
    id: `${batchId}-${i}`,
    op,
    agentId,
    lamport: i,
    timestamp: Date.now(),
    batchId,
    symbolIds: getAffectedSymbolIds(op),
  }));

  // Acquire locks
  const lockTable = new SymbolLockTable();
  const allSymbolIds = new Set<string>();
  for (const entry of entries) {
    for (const sid of entry.symbolIds) allSymbolIds.add(sid);
  }

  for (const entry of entries) {
    for (const sid of entry.symbolIds) {
      const lockResult = lockTable.acquire(sid, agentId, entry.op.type);
      if (lockResult.status === "conflict") {
        const conflictMsg = lockResult.conflicts.map((c) =>
          `symbol ${c.symbolId} locked by ${c.existingAgent} (${c.existingOpType})`
        ).join(", ");
        if (formatJson) {
          console.log(JSON.stringify({ error: "lock-conflict", detail: conflictMsg }, null, 2));
        } else {
          console.error(`Lock conflict: ${conflictMsg}`);
        }
        process.exit(1);
      }
    }
  }

  // Run merge engine (even for single-agent, validates commutativity within batch)
  const mergeEngine = new MergeEngine(graphStore);
  const composeResult = mergeEngine.compose([entries]);

  const result: ApplyResult = {
    tier: tier.tier,
    tierReason: tier.reason,
    requiresApproval: tier.requiresApproval,
    applied: 0,
    conflicts: composeResult.conflicts.length,
    autoResolved: composeResult.autoResolved.length,
    results: [],
    conflictDetails: composeResult.conflicts.map((c) => ({
      opA: `${c.opA.op.type}(${c.opA.id})`,
      opB: `${c.opB.op.type}(${c.opB.id})`,
      symbolId: c.symbolId,
      reason: c.reason,
    })),
    autoResolvedDetails: composeResult.autoResolved.map((r) => ({
      winner: `${r.winner.op.type}(${r.winner.id})`,
      loser: `${r.loser.op.type}(${r.loser.id})`,
      strategy: r.strategy,
    })),
  };

  if (dryRun) {
    result.applied = composeResult.applied.length;
    result.results = composeResult.applied.map((e) => ({
      applied: true,
      type: e.op.type,
      symbolId: e.symbolIds[0],
    }));

    if (formatJson) {
      console.log(JSON.stringify({ dryRun: true, ...result }, null, 2));
    } else {
      printTextResult(result, true);
    }
    return;
  }

  // Apply operations
  for (const entry of composeResult.applied) {
    const opResult = graphStore.applyOperation(entry.op);
    result.results.push({
      applied: opResult.applied,
      type: opResult.operationType,
      symbolId: opResult.symbolId,
      reason: opResult.reason,
    });
    if (opResult.applied) result.applied++;
  }

  // Write graph
  const outDir = join(process.cwd(), ".supergraph");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "graph.json");
  const serialized = graphStore.exportJSON();
  await Bun.write(outPath, serialized);

  // Release locks
  lockTable.releaseAgent(agentId);

  if (formatJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextResult(result, false);
    console.log(`\nGraph written to ${outPath} (${graphStore.nodeCount} nodes, ${graphStore.edgeCount} edges)`);
  }
}

function printTextResult(result: ApplyResult, dryRun: boolean): void {
  const prefix = dryRun ? "[dry-run] " : "";
  console.log(`${prefix}Tier: ${result.tier} — ${result.tierReason}`);
  if (result.requiresApproval) {
    console.log(`${prefix}  Requires approval: yes`);
  }
  console.log(`${prefix}Applied: ${result.applied}  Conflicts: ${result.conflicts}  Auto-resolved: ${result.autoResolved}`);

  for (const r of result.results) {
    const sym = r.symbolId ? ` (${r.symbolId})` : "";
    const status = r.applied ? "OK" : `SKIP: ${r.reason}`;
    console.log(`  ${r.type}${sym} — ${status}`);
  }

  if (result.conflictDetails.length > 0) {
    console.log("\nConflicts:");
    for (const c of result.conflictDetails) {
      console.log(`  ${c.opA} vs ${c.opB} on ${c.symbolId}: ${c.reason}`);
    }
  }

  if (result.autoResolvedDetails.length > 0) {
    console.log("\nAuto-resolved:");
    for (const r of result.autoResolvedDetails) {
      console.log(`  ${r.winner} wins over ${r.loser} (${r.strategy})`);
    }
  }
}
