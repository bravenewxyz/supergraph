import type { OperationEntry, GraphOperation } from "../schema/operations.js";

/**
 * NDJSON append-only operation log with in-memory indexes.
 *
 * The orchestrator uses this to track all graph operations in real-time.
 * Each entry is assigned a monotonically increasing Lamport timestamp,
 * a UUID, and a wall-clock timestamp at append time.
 */
export class OperationLog {
  private entries: OperationEntry[] = [];
  private lamport: number = 0;

  // In-memory indexes (built during append + replay)
  private byAgent: Map<string, OperationEntry[]> = new Map();
  private bySymbol: Map<string, OperationEntry[]> = new Map();
  private byBatch: Map<string, OperationEntry[]> = new Map();

  // File backing
  private filePath: string | null;
  private pendingWrites: OperationEntry[] = [];

  constructor(filePath?: string) {
    this.filePath = filePath ?? null;
  }

  // --- Core ---

  /**
   * Append a new operation to the log.
   * Increments the Lamport clock, assigns a UUID and timestamp,
   * indexes the entry, and queues it for flush.
   */
  append(
    op: GraphOperation,
    agentId: string,
    batchId: string,
    opts?: { symbolIds?: string[]; contractId?: string },
  ): OperationEntry {
    this.lamport++;
    const entry: OperationEntry = {
      id: crypto.randomUUID(),
      op,
      agentId,
      lamport: this.lamport,
      timestamp: Date.now(),
      batchId,
      symbolIds: opts?.symbolIds ?? [],
      contractId: opts?.contractId,
    };

    this.entries.push(entry);
    this.indexEntry(entry);
    this.pendingWrites.push(entry);

    return entry;
  }

  // --- Queries ---

  getByAgent(agentId: string): OperationEntry[] {
    return this.byAgent.get(agentId) ?? [];
  }

  getBySymbol(symbolId: string): OperationEntry[] {
    return this.bySymbol.get(symbolId) ?? [];
  }

  getByBatch(batchId: string): OperationEntry[] {
    return this.byBatch.get(batchId) ?? [];
  }

  getByLamportRange(from: number, to: number): OperationEntry[] {
    return this.entries.filter((e) => e.lamport >= from && e.lamport <= to);
  }

  getAll(): OperationEntry[] {
    return [...this.entries];
  }

  getLamport(): number {
    return this.lamport;
  }

  size(): number {
    return this.entries.length;
  }

  // --- Persistence ---

  /**
   * Write pending entries as NDJSON lines to the backing file.
   */
  async flush(): Promise<void> {
    if (!this.filePath || this.pendingWrites.length === 0) return;

    const lines = this.pendingWrites.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const { appendFile } = await import("node:fs/promises");
    await appendFile(this.filePath, lines);
    this.pendingWrites = [];
  }

  /**
   * Read an NDJSON file and rebuild all indexes from it.
   * Existing in-memory entries are cleared first.
   */
  async replay(filePath: string): Promise<void> {
    this.entries = [];
    this.lamport = 0;
    this.byAgent = new Map();
    this.bySymbol = new Map();
    this.byBatch = new Map();
    this.pendingWrites = [];

    const file = Bun.file(filePath);
    if (!(await file.exists())) return;

    const text = await file.text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      const entry = JSON.parse(line);
      if (!entry?.id || !entry?.op || !entry?.agentId || typeof entry?.lamport !== "number") {
        continue;
      }
      this.entries.push(entry as OperationEntry);
      this.indexEntry(entry as OperationEntry);
      if (entry.lamport > this.lamport) {
        this.lamport = entry.lamport;
      }
    }
  }

  // --- Compaction ---

  /**
   * Write a snapshot of the current graph state alongside the log.
   * This allows future replays to start from this checkpoint.
   */
  async snapshot(graphStore: { export(): { nodes: unknown[]; edges: unknown[] } }): Promise<void> {
    if (!this.filePath) return;
    const snapshotPath = this.filePath.replace(/\.ndjson$/, ".snapshot.json");
    const data = {
      lamport: this.lamport,
      entryCount: this.entries.length,
      graph: graphStore.export(),
      timestamp: Date.now(),
    };
    await Bun.write(snapshotPath, JSON.stringify(data, null, 2));
  }

  // --- Internal ---

  private indexEntry(entry: OperationEntry): void {
    // By agent
    let agentList = this.byAgent.get(entry.agentId);
    if (!agentList) {
      agentList = [];
      this.byAgent.set(entry.agentId, agentList);
    }
    agentList.push(entry);

    // By symbol
    for (const sid of entry.symbolIds) {
      let symList = this.bySymbol.get(sid);
      if (!symList) {
        symList = [];
        this.bySymbol.set(sid, symList);
      }
      symList.push(entry);
    }

    // By batch
    let batchList = this.byBatch.get(entry.batchId);
    if (!batchList) {
      batchList = [];
      this.byBatch.set(entry.batchId, batchList);
    }
    batchList.push(entry);
  }
}
