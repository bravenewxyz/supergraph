import type { DiscoveredFunction } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CallGraphNode {
  name: string;
  filePath: string;
  line: number;
  callers: string[]; // names of functions that call this one
  callees: string[]; // names of functions this one calls
}

export interface CallGraphAnalysis {
  nodes: CallGraphNode[];
  deadFunctions: CallGraphNode[]; // 0 callers, not an entry point
  hubFunctions: CallGraphNode[]; // 10+ callers
  singleCallerFunctions: CallGraphNode[]; // exactly 1 caller
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "do",
  "switch",
  "catch",
  "return",
  "throw",
  "typeof",
  "instanceof",
  "new",
  "await",
  "yield",
  "import",
  "export",
  "function",
  "class",
  "const",
  "let",
  "var",
  "delete",
  "void",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Promise",
  "Map",
  "Set",
  "Error",
  "console",
  "Math",
  "JSON",
  "Date",
]);

/**
 * Extract function-call names from a function body.
 *
 * Matches `identifier(` but skips language keywords and built-in globals.
 * Only names present in `allFunctionNames` are kept so we build edges
 * exclusively between discovered project functions.
 */
function extractCalls(
  sourceText: string,
  allFunctionNames: Set<string>,
): string[] {
  const calls = new Set<string>();
  const re = /\b([a-zA-Z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sourceText)) !== null) {
    const name = match[1]!;
    if (!KEYWORDS.has(name) && allFunctionNames.has(name)) {
      calls.add(name);
    }
  }
  return [...calls];
}

/**
 * Heuristic: functions that are expected to have 0 callers inside the
 * project and should therefore *not* be flagged as dead code.
 */
function isEntryPoint(fn: Pick<DiscoveredFunction, "name" | "filePath" | "exportKind">): boolean {
  if (fn.name === "main" || fn.name === "default") return true;
  if (/\.(test|spec)\.[tj]sx?$/.test(fn.filePath)) return true;
  if (fn.filePath.includes("/routes/") || fn.filePath.includes("/api/")) return true;
  if (fn.filePath.includes("/cli/") || fn.filePath.includes("/commands/")) return true;
  // Exported functions in index files are likely public API
  if (fn.filePath.endsWith("/index.ts") && fn.exportKind !== "internal") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * Build a function-level call graph from the set of discovered functions.
 *
 * For every function we scan its `sourceText` for identifiers that match
 * other discovered function names, then classify the graph into:
 *
 * - **dead functions** — zero callers and not an entry point
 * - **hub functions** — called by 10+ distinct functions (high-impact)
 * - **single-caller functions** — inlining candidates
 */
export function buildCallGraph(
  functions: DiscoveredFunction[],
): CallGraphAnalysis {
  const allNames = new Set(functions.map((f) => f.name));
  const nodeMap = new Map<string, CallGraphNode>();

  // Initialise one node per unique function name
  for (const fn of functions) {
    if (!nodeMap.has(fn.name)) {
      nodeMap.set(fn.name, {
        name: fn.name,
        filePath: fn.filePath,
        line: fn.line,
        callers: [],
        callees: [],
      });
    }
  }

  // Build directed edges (caller → callee)
  for (const fn of functions) {
    const callees = extractCalls(fn.sourceText, allNames);
    const node = nodeMap.get(fn.name);
    if (!node) continue;
    node.callees = callees;

    for (const calleeName of callees) {
      const calleeNode = nodeMap.get(calleeName);
      if (calleeNode && calleeNode.name !== fn.name) {
        // skip self-recursion for caller tracking
        calleeNode.callers.push(fn.name);
      }
    }
  }

  const nodes = [...nodeMap.values()];

  // Deduplicate callers (a caller may appear multiple times if there are
  // duplicate function names across files — we already collapsed to one node)
  for (const node of nodes) {
    node.callers = [...new Set(node.callers)];
  }

  // Build a quick lookup from name → DiscoveredFunction for the entry-point check
  const fnByName = new Map<string, DiscoveredFunction>();
  for (const fn of functions) {
    if (!fnByName.has(fn.name)) fnByName.set(fn.name, fn);
  }

  const deadFunctions = nodes.filter((n) => {
    if (n.callers.length !== 0) return false;
    const original = fnByName.get(n.name);
    return original ? !isEntryPoint(original) : false;
  });

  const hubFunctions = nodes
    .filter((n) => n.callers.length >= 10)
    .sort((a, b) => b.callers.length - a.callers.length);

  const singleCallerFunctions = nodes.filter((n) => n.callers.length === 1);

  return { nodes, deadFunctions, hubFunctions, singleCallerFunctions };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function shortPath(p: string): string {
  const idx = p.indexOf("/src/");
  return idx >= 0 ? p.slice(idx + 5) : p;
}

/** Human-readable summary of the call-graph analysis. */
export function formatCallGraph(analysis: CallGraphAnalysis): string {
  const lines: string[] = [];

  if (analysis.hubFunctions.length > 0) {
    lines.push(
      `## Hub Functions (${analysis.hubFunctions.length} — called by 10+ others)`,
    );
    for (const fn of analysis.hubFunctions.slice(0, 20)) {
      lines.push(
        `  ${fn.name} (${fn.callers.length} callers) ${shortPath(fn.filePath)}:${fn.line}`,
      );
    }
  }

  if (analysis.deadFunctions.length > 0) {
    lines.push(
      `## Potentially Dead Functions (${analysis.deadFunctions.length} — 0 internal callers)`,
    );
    for (const fn of analysis.deadFunctions.slice(0, 30)) {
      lines.push(`  ${fn.name} ${shortPath(fn.filePath)}:${fn.line}`);
    }
  }

  if (analysis.singleCallerFunctions.length > 0) {
    lines.push(
      `## Single-Caller Functions (${analysis.singleCallerFunctions.length} — inlining candidates)`,
    );
    for (const fn of analysis.singleCallerFunctions.slice(0, 20)) {
      lines.push(
        `  ${fn.name} <- ${fn.callers[0]} ${shortPath(fn.filePath)}:${fn.line}`,
      );
    }
  }

  return lines.join("\n");
}
