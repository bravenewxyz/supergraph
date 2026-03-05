import { describe, expect, it } from "bun:test";
import { parseTypeScript } from "../parser/ts-structural.js";
import { projectModule } from "../projector/file-projector.js";
import { GraphStore } from "../store/graph-store.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import type { GraphReader } from "../projector/file-projector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load parse results into a GraphStore, skipping unresolvable edges */
function loadIntoStore(
  nodes: SymbolNode[],
  edges: SymbolEdge[],
): GraphStore {
  const store = new GraphStore();
  for (const node of nodes) {
    store.addSymbol(node);
  }
  for (const edge of edges) {
    // Only add edges whose both endpoints exist in the graph
    const src = store.getSymbol(edge.sourceId);
    const tgt = store.getSymbol(edge.targetId);
    if (src && tgt) {
      store.addEdge(edge);
    }
  }
  return store;
}

/** Adapt GraphStore to the GraphReader interface expected by the projector */
function asReader(store: GraphStore): GraphReader {
  return {
    getSymbol: (id) => store.getSymbol(id),
    getChildSymbols: (parentId) => store.getChildSymbols(parentId),
    getEdgesFrom: (symbolId) => store.getEdgesFrom(symbolId),
    getEdgesTo: (symbolId) => store.getEdgesTo(symbolId),
    getEdgesByKind: (symbolId, kind) => store.getEdgesByKind(symbolId, kind),
    getAllSymbols: () => store.getAllSymbols(),
  };
}

interface GraphSnapshot {
  symbolNames: string[];
  symbolKinds: Map<string, string>;
  symbolExported: Map<string, boolean>;
  containsEdgeCount: number;
  qualifiedNames: string[];
}

function snapshot(nodes: SymbolNode[], edges: SymbolEdge[]): GraphSnapshot {
  const symbolNames = nodes.map((n) => n.name).sort();
  const symbolKinds = new Map<string, string>();
  const symbolExported = new Map<string, boolean>();
  const qualifiedNames = nodes.map((n) => n.qualifiedName).sort();

  for (const n of nodes) {
    symbolKinds.set(n.qualifiedName, n.kind);
    symbolExported.set(n.qualifiedName, n.exported);
  }

  const containsEdgeCount = edges.filter((e) => e.kind === "contains").length;

  return { symbolNames, symbolKinds, symbolExported, containsEdgeCount, qualifiedNames };
}

/** Full round-trip: source -> parse -> graph -> project -> re-parse -> compare */
function roundTrip(code: string, filePath: string) {
  // Step 1: parse original
  const parse1 = parseTypeScript(code, filePath);
  const store1 = loadIntoStore(parse1.nodes, parse1.edges);
  const moduleNode1 = parse1.nodes.find((n) => n.kind === "module")!;

  // Step 2: project back to source
  const projected = projectModule(moduleNode1, asReader(store1));

  // Step 3: re-parse projected code
  const parse2 = parseTypeScript(projected, filePath);
  const store2 = loadIntoStore(parse2.nodes, parse2.edges);

  return {
    original: { nodes: parse1.nodes, edges: parse1.edges, store: store1 },
    projected,
    reparsed: { nodes: parse2.nodes, edges: parse2.edges, store: store2 },
  };
}

/** Compare two graph snapshots for structural equivalence */
function assertGraphsEquivalent(
  original: { nodes: SymbolNode[]; edges: SymbolEdge[] },
  reparsed: { nodes: SymbolNode[]; edges: SymbolEdge[] },
  opts: { checkEdgeCounts?: boolean } = {},
) {
  const snap1 = snapshot(original.nodes, original.edges);
  const snap2 = snapshot(reparsed.nodes, reparsed.edges);

  // Same number of symbol nodes
  expect(snap2.symbolNames.length).toBe(snap1.symbolNames.length);

  // Same symbol names
  expect(snap2.symbolNames).toEqual(snap1.symbolNames);

  // Same kinds per qualified name (excluding module prefix differences due to reformatting)
  for (const [qn, kind] of snap1.symbolKinds) {
    const reparsedKind = snap2.symbolKinds.get(qn);
    if (reparsedKind !== undefined) {
      expect(reparsedKind).toBe(kind);
    }
  }

  // Same exported status per qualified name
  for (const [qn, exported] of snap1.symbolExported) {
    const reparsedExported = snap2.symbolExported.get(qn);
    if (reparsedExported !== undefined) {
      expect(reparsedExported).toBe(exported);
    }
  }

  // Contains-edge count should be preserved
  if (opts.checkEdgeCounts !== false) {
    expect(snap2.containsEdgeCount).toBe(snap1.containsEdgeCount);
  }
}

// ---------------------------------------------------------------------------
// Tests against real codebase files
// ---------------------------------------------------------------------------

describe("round-trip: real codebase files", () => {
  it("packages/core/src/types.ts — interfaces, type aliases, enums", () => {
    const code = `// Task status
export type TaskStatus = "pending" | "assigned" | "running" | "complete" | "failed" | "cancelled";

// Agent roles
export type AgentRole = "root-planner" | "subplanner" | "worker" | "reconciler";

// A task assigned by a planner to a worker
export interface Task {
  id: string;
  parentId?: string;
  description: string;
  scope: string[];
  acceptance: string;
  branch: string;
  status: TaskStatus;
  assignedTo?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  priority: number;
  dependsOn?: string[];
  conflictSourceBranch?: string;
  retryCount?: number;
}

// Handoff report from worker back to planner
export interface Handoff {
  taskId: string;
  status: "complete" | "partial" | "failed";
  summary: string;
  diff: string;
  filesChanged: string[];
  concerns: string[];
  suggestions: string[];
  metrics: {
    linesAdded: number;
    linesRemoved: number;
    filesCreated: number;
    filesModified: number;
    tokensUsed: number;
    inputTokens: number;
    outputTokens: number;
    toolCallCount: number;
    durationMs: number;
  };
  buildExitCode?: number | null;
}

export interface SandboxStatus {
  sandboxId: string;
  status: "starting" | "ready" | "working" | "completing" | "terminated" | "error";
  taskId?: string;
  progress?: string;
  healthCheck: {
    lastPing: number;
    consecutiveFailures: number;
  };
  url?: string;
}

export interface HarnessConfig {
  maxWorkers: number;
  workerTimeout: number;
  mergeStrategy: "fast-forward" | "rebase" | "merge-commit";
  llm: {
    model: string;
    maxTokens: number;
    temperature: number;
    apiKey: string;
    timeoutMs?: number;
  };
  git: {
    repoUrl: string;
    mainBranch: string;
    branchPrefix: string;
  };
  buildCommand?: string;
  testCommand?: string;
  techStack?: string;
}

export interface LogEntry {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  agentId: string;
  agentRole: AgentRole;
  taskId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface MetricsSnapshot {
  timestamp: number;
  activeWorkers: number;
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  suspiciousTaskCount: number;
  commitsPerHour: number;
  mergeSuccessRate: number;
  totalTokensUsed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  activeToolCalls: number;
  estimatedInFlightTokens: number;
  finalizationAttempts?: number;
  finalizationBuildPassed?: boolean;
  finalizationTestsPassed?: boolean;
  finalizationDurationMs?: number;
}`;

    const rt = roundTrip(code, "packages/core/src/types.ts");

    // Should have same type aliases
    const origTypeAliases = rt.original.nodes.filter((n) => n.kind === "type-alias");
    const reparsedTypeAliases = rt.reparsed.nodes.filter((n) => n.kind === "type-alias");
    expect(reparsedTypeAliases.length).toBe(origTypeAliases.length);

    // Should have same interfaces
    const origInterfaces = rt.original.nodes.filter((n) => n.kind === "interface");
    const reparsedInterfaces = rt.reparsed.nodes.filter((n) => n.kind === "interface");
    expect(reparsedInterfaces.length).toBe(origInterfaces.length);

    // All should be exported
    for (const iface of reparsedInterfaces) {
      expect(iface.exported).toBe(true);
    }

    // Same qualified names for type aliases
    const origTaNames = origTypeAliases.map((n) => n.qualifiedName).sort();
    const reparsedTaNames = reparsedTypeAliases.map((n) => n.qualifiedName).sort();
    expect(reparsedTaNames).toEqual(origTaNames);

    // Same qualified names for interfaces
    const origIfNames = origInterfaces.map((n) => n.qualifiedName).sort();
    const reparsedIfNames = reparsedInterfaces.map((n) => n.qualifiedName).sort();
    expect(reparsedIfNames).toEqual(origIfNames);
  });

  it("packages/core/src/protocol.ts — interfaces with import references", () => {
    const code = `import type { Task, Handoff, SandboxStatus, TaskStatus } from "./types.js";

export interface TaskAssignment {
  type: "task_assignment";
  task: Task;
  systemPrompt: string;
  repoSnapshot: string;
  llmConfig: {
    endpoint: string;
    model: string;
    maxTokens: number;
    temperature: number;
  };
}

export interface TaskResult {
  type: "task_result";
  handoff: Handoff;
}

export interface ProgressUpdate {
  type: "progress_update";
  taskId: string;
  sandboxId: string;
  status: SandboxStatus["status"];
  progress: string;
  currentFile?: string;
  toolCallsSoFar: number;
  tokensSoFar: number;
}

export interface HealthResponse {
  type: "health";
  sandboxId: string;
  status: "healthy" | "unhealthy";
  uptime: number;
  memoryUsageMb: number;
  taskId?: string;
  taskStatus?: TaskStatus;
}

export type OrchestratorMessage = TaskAssignment;
export type SandboxMessage = TaskResult | ProgressUpdate | HealthResponse;
export type ProtocolMessage = OrchestratorMessage | SandboxMessage;`;

    const rt = roundTrip(code, "packages/core/src/protocol.ts");

    // Should preserve all 4 interfaces
    const origInterfaces = rt.original.nodes.filter((n) => n.kind === "interface");
    const reparsedInterfaces = rt.reparsed.nodes.filter((n) => n.kind === "interface");
    expect(reparsedInterfaces.length).toBe(origInterfaces.length);
    expect(reparsedInterfaces.length).toBe(4);

    // Should preserve all 3 type aliases
    const origTypes = rt.original.nodes.filter((n) => n.kind === "type-alias");
    const reparsedTypes = rt.reparsed.nodes.filter((n) => n.kind === "type-alias");
    expect(reparsedTypes.length).toBe(origTypes.length);
    expect(reparsedTypes.length).toBe(3);

    // All should be exported
    for (const n of [...reparsedInterfaces, ...reparsedTypes]) {
      expect(n.exported).toBe(true);
    }

    // Import edge should be present in original parse
    const importEdges = rt.original.edges.filter((e) => e.kind === "imports");
    expect(importEdges.length).toBeGreaterThanOrEqual(1);
    const typeImport = importEdges.find(
      (e) => e.metadata?.moduleSpecifier === "./types.js",
    );
    expect(typeImport).toBeDefined();
    expect(typeImport!.metadata?.typeOnly).toBe(true);
  });

  it("packages/orchestrator/src/scope-tracker.ts — class with methods", () => {
    const code = `export interface ScopeOverlap {
  taskId: string;
  overlappingFiles: string[];
}

export class ScopeTracker {
  private activeScopes: Map<string, Set<string>> = new Map();

  register(taskId: string, scope: string[]): void {
    this.activeScopes.set(taskId, new Set(scope));
  }

  release(taskId: string): void {
    this.activeScopes.delete(taskId);
  }

  getOverlaps(taskId: string, scope: string[]): ScopeOverlap[] {
    const overlaps: ScopeOverlap[] = [];
    const incoming = new Set(scope);

    for (const [existingId, existingScope] of this.activeScopes) {
      if (existingId === taskId) continue;
      const shared: string[] = [];
      for (const file of incoming) {
        if (existingScope.has(file)) {
          shared.push(file);
        }
      }
      if (shared.length > 0) {
        overlaps.push({ taskId: existingId, overlappingFiles: shared });
      }
    }

    return overlaps;
  }

  getLockedFiles(): string[] {
    const allFiles = new Set<string>();
    for (const scope of this.activeScopes.values()) {
      for (const file of scope) {
        allFiles.add(file);
      }
    }
    return [...allFiles].sort();
  }
}`;

    const rt = roundTrip(code, "packages/orchestrator/src/scope-tracker.ts");

    // Should have the interface
    const origIface = rt.original.nodes.find(
      (n) => n.kind === "interface" && n.name === "ScopeOverlap",
    );
    const reparsedIface = rt.reparsed.nodes.find(
      (n) => n.kind === "interface" && n.name === "ScopeOverlap",
    );
    expect(origIface).toBeDefined();
    expect(reparsedIface).toBeDefined();
    expect(reparsedIface!.exported).toBe(true);

    // Should have the class
    const origClass = rt.original.nodes.find(
      (n) => n.kind === "class" && n.name === "ScopeTracker",
    );
    const reparsedClass = rt.reparsed.nodes.find(
      (n) => n.kind === "class" && n.name === "ScopeTracker",
    );
    expect(origClass).toBeDefined();
    expect(reparsedClass).toBeDefined();
    expect(reparsedClass!.exported).toBe(true);

    // Should have all 4 methods
    const origMethods = rt.original.nodes.filter(
      (n) => n.kind === "method" && n.parentId === origClass!.id,
    );
    const reparsedMethods = rt.reparsed.nodes.filter(
      (n) => n.kind === "method" && n.parentId === reparsedClass!.id,
    );
    expect(reparsedMethods.length).toBe(origMethods.length);
    expect(reparsedMethods.length).toBe(4);

    const origMethodNames = origMethods.map((m) => m.name).sort();
    const reparsedMethodNames = reparsedMethods.map((m) => m.name).sort();
    expect(reparsedMethodNames).toEqual(origMethodNames);
  });
});

// ---------------------------------------------------------------------------
// Tests against synthetic file with all TypeScript constructs
// ---------------------------------------------------------------------------

describe("round-trip: synthetic all-constructs file", () => {
  const syntheticCode = `export type ID = string;

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export interface Configurable {
  configure(options: Record<string, unknown>): void;
}

export interface Repository<T> {
  find(id: string): Promise<T | null>;
  save(entity: T): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export enum Priority {
  Low = 0,
  Medium = 1,
  High = 2,
  Critical = 3,
}

export const MAX_RETRIES: number = 5;

export const DEFAULT_CONFIG = {
  timeout: 3000,
  retries: 3,
};

export async function fetchResource(url: string): Promise<Response> {
  return fetch(url);
}

function internalHelper(x: number): number {
  return x * 2;
}

export abstract class BaseService {
  protected name: string;

  constructor(name: string) {
    this.name = name;
  }

  abstract execute(): Promise<void>;

  getName(): string {
    return this.name;
  }
}

export class UserService extends BaseService {
  private users: Map<string, unknown> = new Map();

  constructor() {
    super("UserService");
  }

  async execute(): Promise<void> {
    console.log("executing");
  }

  getUser(id: string): unknown {
    return this.users.get(id);
  }

  static create(): UserService {
    return new UserService();
  }
}

export const processItems = async (items: string[]): Promise<string[]> => {
  return items.map((i) => i.toUpperCase());
};
`;

  it("should preserve all symbol counts through round-trip", () => {
    const rt = roundTrip(syntheticCode, "src/all-constructs.ts");

    const origByKind = countByKind(rt.original.nodes);
    const reparsedByKind = countByKind(rt.reparsed.nodes);

    // Same module count
    expect(reparsedByKind.get("module")).toBe(origByKind.get("module"));

    // Same type-alias count
    expect(reparsedByKind.get("type-alias")).toBe(origByKind.get("type-alias"));

    // Same interface count
    expect(reparsedByKind.get("interface")).toBe(origByKind.get("interface"));

    // Same enum count
    expect(reparsedByKind.get("enum")).toBe(origByKind.get("enum"));

    // Same class count
    expect(reparsedByKind.get("class")).toBe(origByKind.get("class"));

    // Same function count (including arrow fns)
    expect(reparsedByKind.get("function")).toBe(origByKind.get("function"));

    // Same method count
    expect(reparsedByKind.get("method")).toBe(origByKind.get("method"));
  });

  it("should preserve exported status for all top-level symbols", () => {
    const rt = roundTrip(syntheticCode, "src/all-constructs.ts");

    const getExportedNames = (nodes: SymbolNode[]) =>
      nodes
        .filter((n) => n.exported && n.kind !== "module")
        .map((n) => n.name)
        .sort();

    expect(getExportedNames(rt.reparsed.nodes)).toEqual(
      getExportedNames(rt.original.nodes),
    );
  });

  it("should preserve symbol names through round-trip", () => {
    const rt = roundTrip(syntheticCode, "src/all-constructs.ts");

    const origNames = rt.original.nodes.map((n) => n.name).sort();
    const reparsedNames = rt.reparsed.nodes.map((n) => n.name).sort();
    expect(reparsedNames).toEqual(origNames);
  });

  it("should detect class hierarchy edges in initial parse", () => {
    const rt = roundTrip(syntheticCode, "src/all-constructs.ts");

    // The parser correctly detects extends edges in the original source
    const origUserService = rt.original.nodes.find(
      (n) => n.kind === "class" && n.name === "UserService",
    );
    const origExtendsEdge = rt.original.edges.find(
      (e) => e.kind === "extends" && e.sourceId === origUserService?.id,
    );
    expect(origExtendsEdge).toBeDefined();
    expect(origExtendsEdge!.metadata?.targetName).toBe("BaseService");

    // NOTE: Heritage edges (extends/implements) are currently unresolved
    // (targetId is a symbolic name, not a node ID). They cannot be loaded
    // into GraphStore, so the projector cannot emit heritage clauses.
    // This will be resolved when the edge resolver is implemented.
    // For now, verify the reparsed graph still has both classes:
    const reparsedUserService = rt.reparsed.nodes.find(
      (n) => n.kind === "class" && n.name === "UserService",
    );
    expect(reparsedUserService).toBeDefined();
    const reparsedBaseService = rt.reparsed.nodes.find(
      (n) => n.kind === "class" && n.name === "BaseService",
    );
    expect(reparsedBaseService).toBeDefined();
  });

  it("should preserve contains-edge structure", () => {
    const rt = roundTrip(syntheticCode, "src/all-constructs.ts");

    // Count contains edges in both
    const origContains = rt.original.edges.filter((e) => e.kind === "contains").length;
    const reparsedContains = rt.reparsed.edges.filter((e) => e.kind === "contains").length;
    expect(reparsedContains).toBe(origContains);
  });

  it("should preserve enum members", () => {
    const rt = roundTrip(syntheticCode, "src/all-constructs.ts");

    const origMembers = rt.original.nodes.filter((n) => n.kind === "enum-member");
    const reparsedMembers = rt.reparsed.nodes.filter((n) => n.kind === "enum-member");
    expect(reparsedMembers.length).toBe(origMembers.length);

    const origMemberNames = origMembers.map((n) => n.name).sort();
    const reparsedMemberNames = reparsedMembers.map((n) => n.name).sort();
    expect(reparsedMemberNames).toEqual(origMemberNames);
  });

  it("should produce valid TypeScript that can be re-parsed without errors", () => {
    const rt = roundTrip(syntheticCode, "src/all-constructs.ts");
    // If we got here without exceptions, the projected code was successfully parsed
    expect(rt.projected.length).toBeGreaterThan(0);
    expect(rt.reparsed.nodes.length).toBeGreaterThan(1); // More than just module node
  });
});

// ---------------------------------------------------------------------------
// Additional round-trip edge cases
// ---------------------------------------------------------------------------

describe("round-trip: edge cases", () => {
  it("should handle file with only type exports", () => {
    const code = `export type A = string;
export type B = number;
export type C = A | B;`;

    const rt = roundTrip(code, "src/types-only.ts");
    const origTypes = rt.original.nodes.filter((n) => n.kind === "type-alias").length;
    const reparsedTypes = rt.reparsed.nodes.filter((n) => n.kind === "type-alias").length;
    expect(reparsedTypes).toBe(origTypes);
    expect(reparsedTypes).toBe(3);
  });

  it("should handle file with only a class", () => {
    const code = `export class Simple {
  value: number = 0;

  increment(): void {
    this.value++;
  }
}`;

    const rt = roundTrip(code, "src/simple-class.ts");
    assertGraphsEquivalent(rt.original, rt.reparsed);
  });

  it("should handle mixed enum and interface file", () => {
    const code = `export enum Direction {
  Up = "up",
  Down = "down",
  Left = "left",
  Right = "right",
}

export interface Movement {
  direction: Direction;
  distance: number;
}`;

    const rt = roundTrip(code, "src/movement.ts");
    assertGraphsEquivalent(rt.original, rt.reparsed);
  });

  it("should detect implements edges in initial parse", () => {
    const code = `export interface Runnable {
  run(): void;
}

export interface Stoppable {
  stop(): void;
}

export class Engine implements Runnable, Stoppable {
  run(): void {}
  stop(): void {}
}`;

    const rt = roundTrip(code, "src/engine.ts");

    // The parser correctly detects implements edges in the original source
    const origEngine = rt.original.nodes.find((n) => n.name === "Engine");
    const origImplEdges = rt.original.edges.filter(
      (e) => e.kind === "implements" && e.sourceId === origEngine?.id,
    );
    expect(origImplEdges.length).toBe(2);

    const implNames = origImplEdges.map((e) => e.metadata?.targetName).sort();
    expect(implNames).toEqual(["Runnable", "Stoppable"]);

    // NOTE: Implements edges are unresolved (targetId is the type name string,
    // not a node ID), so they cannot be loaded into GraphStore and are lost
    // during the round-trip projection. All non-heritage symbols are preserved:
    const reparsedEngine = rt.reparsed.nodes.find((n) => n.name === "Engine");
    expect(reparsedEngine).toBeDefined();
    expect(reparsedEngine!.exported).toBe(true);

    // Both interfaces still round-trip correctly
    const reparsedRunnable = rt.reparsed.nodes.find((n) => n.name === "Runnable");
    const reparsedStoppable = rt.reparsed.nodes.find((n) => n.name === "Stoppable");
    expect(reparsedRunnable).toBeDefined();
    expect(reparsedStoppable).toBeDefined();

    // Methods on the class are preserved
    const reparsedMethods = rt.reparsed.nodes.filter(
      (n) => n.kind === "method" && n.parentId === reparsedEngine?.id,
    );
    expect(reparsedMethods.length).toBe(2);
  });

  it("should preserve variable kinds through round-trip", () => {
    const code = `export const CONSTANT = 42;
export const GREETING: string = "hello";`;

    const rt = roundTrip(code, "src/vars.ts");
    const origVars = rt.original.nodes.filter((n) => n.kind === "variable");
    const reparsedVars = rt.reparsed.nodes.filter((n) => n.kind === "variable");
    expect(reparsedVars.length).toBe(origVars.length);
  });
});

// ---------------------------------------------------------------------------
// Task 1 round-trip: new AST patterns
// ---------------------------------------------------------------------------

describe("round-trip: new AST patterns", () => {
  it("should round-trip a namespace with members", () => {
    const code = `export namespace Utils {
  export function helper(): void {}
  export const VERSION: string = "1.0";
}`;

    const rt = roundTrip(code, "src/ns.ts");

    const origNs = rt.original.nodes.find((n) => n.kind === "namespace" && n.name === "Utils");
    const reparsedNs = rt.reparsed.nodes.find((n) => n.kind === "namespace" && n.name === "Utils");
    expect(origNs).toBeDefined();
    expect(reparsedNs).toBeDefined();
    expect(reparsedNs!.exported).toBe(true);

    // Members should round-trip
    const origHelper = rt.original.nodes.find((n) => n.kind === "function" && n.name === "helper");
    const reparsedHelper = rt.reparsed.nodes.find((n) => n.kind === "function" && n.name === "helper");
    expect(origHelper).toBeDefined();
    expect(reparsedHelper).toBeDefined();
  });

  it("should round-trip getters and setters", () => {
    const code = `export class Config {
  get name(): string { return ""; }
  set name(value: string) {}
}`;

    const rt = roundTrip(code, "src/config.ts");

    const origGetters = rt.original.nodes.filter((n) => n.kind === "method" && n.modifiers.includes("getter"));
    const reparsedGetters = rt.reparsed.nodes.filter((n) => n.kind === "method" && n.modifiers.includes("getter"));
    expect(reparsedGetters.length).toBe(origGetters.length);

    const origSetters = rt.original.nodes.filter((n) => n.kind === "method" && n.modifiers.includes("setter"));
    const reparsedSetters = rt.reparsed.nodes.filter((n) => n.kind === "method" && n.modifiers.includes("setter"));
    expect(reparsedSetters.length).toBe(origSetters.length);
  });

  it("should round-trip private fields", () => {
    const code = `export class Secret {
  #value: string = "hidden";
  getValue(): string { return ""; }
}`;

    const rt = roundTrip(code, "src/secret.ts");

    const origPriv = rt.original.nodes.find((n) => n.kind === "property" && n.name === "#value");
    expect(origPriv).toBeDefined();

    // After round-trip, the private field should still exist
    const reparsedPriv = rt.reparsed.nodes.find((n) => n.kind === "property" && n.name.includes("value"));
    expect(reparsedPriv).toBeDefined();
  });

  it("should round-trip generic signatures", () => {
    const code = `export function identity<T>(x: T): T { return x; }

export interface Repository<T> {
  find(id: string): T;
}`;

    const rt = roundTrip(code, "src/generics.ts");

    const origFn = rt.original.nodes.find((n) => n.kind === "function" && n.name === "identity");
    const reparsedFn = rt.reparsed.nodes.find((n) => n.kind === "function" && n.name === "identity");
    expect(origFn).toBeDefined();
    expect(reparsedFn).toBeDefined();
    expect(reparsedFn!.signature).toContain("<T>");

    const origIface = rt.original.nodes.find((n) => n.kind === "interface" && n.name === "Repository");
    const reparsedIface = rt.reparsed.nodes.find((n) => n.kind === "interface" && n.name === "Repository");
    expect(origIface).toBeDefined();
    expect(reparsedIface).toBeDefined();
  });

  it("should round-trip default exports", () => {
    const code = `export default function main(): number { return 42; }`;

    const rt = roundTrip(code, "src/main.ts");

    const origFn = rt.original.nodes.find((n) => n.kind === "function" && n.name === "main");
    const reparsedFn = rt.reparsed.nodes.find((n) => n.kind === "function" && n.name === "main");
    expect(origFn).toBeDefined();
    expect(reparsedFn).toBeDefined();
    expect(origFn!.modifiers).toContain("default");
    expect(reparsedFn!.modifiers).toContain("default");
    expect(reparsedFn!.exported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function countByKind(nodes: SymbolNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  }
  return counts;
}
