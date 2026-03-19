import { parse, Lang } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { collectSourceFiles } from "../extractor/typescript.js";
import { findEnclosingFunction } from "./ast-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaintSourceKind =
  | "request-body"
  | "request-query"
  | "request-param"
  | "request-header"
  | "json-parse"
  | "file-read";

export interface TaintSource {
  filePath: string;
  line: number;
  kind: TaintSourceKind;
  variable: string;
  functionContext: string;
}

export type TaintSinkKind = "sql-string" | "command-exec" | "file-path" | "eval";

export interface TaintSink {
  filePath: string;
  line: number;
  kind: TaintSinkKind;
  raw: string;
  functionContext: string;
}

export interface TaintSanitizer {
  kind: string;
  line: number;
  variable: string;
}

export interface TaintFlow {
  source: TaintSource;
  sink: TaintSink;
  sanitized: boolean;
  sanitizer?: { kind: string; line: number };
  severity: "critical" | "high" | "medium";
}

export interface TaintAnalysis {
  sources: TaintSource[];
  sinks: TaintSink[];
  flows: TaintFlow[];
  unsanitizedFlows: TaintFlow[];
}

// ---------------------------------------------------------------------------
// Source patterns — where tainted data enters
// ---------------------------------------------------------------------------

interface SourcePattern {
  kind: TaintSourceKind;
  patterns: string[];
}

const EXPRESS_SOURCE_PATTERNS: SourcePattern[] = [
  { kind: "request-body", patterns: ["$REQ.body"] },
  { kind: "request-query", patterns: ["$REQ.query"] },
  { kind: "request-param", patterns: ["$REQ.params"] },
  { kind: "request-header", patterns: ["$REQ.headers"] },
];

const HONO_SOURCE_PATTERNS: SourcePattern[] = [
  { kind: "request-body", patterns: ["$CTX.req.json()", "$CTX.req.valid('json')"] },
  { kind: "request-query", patterns: ["$CTX.req.query()", "$CTX.req.valid('query')"] },
  { kind: "request-param", patterns: ["$CTX.req.param($NAME)", "$CTX.req.valid('param')"] },
  { kind: "request-header", patterns: ["$CTX.req.header($NAME)"] },
];

const GENERAL_SOURCE_PATTERNS: SourcePattern[] = [
  { kind: "json-parse", patterns: ["JSON.parse($DATA)"] },
  { kind: "file-read", patterns: ["readFile($PATH)", "readFileSync($PATH)"] },
];

const ALL_SOURCE_PATTERNS: SourcePattern[] = [
  ...EXPRESS_SOURCE_PATTERNS,
  ...HONO_SOURCE_PATTERNS,
  ...GENERAL_SOURCE_PATTERNS,
];

// ---------------------------------------------------------------------------
// Sink patterns — where tainted data is dangerous
// ---------------------------------------------------------------------------

interface SinkPattern {
  kind: TaintSinkKind;
  patterns: string[];
}

const SQL_SINK_PATTERNS: SinkPattern[] = [
  { kind: "sql-string", patterns: ["$DB.query($$$)", "$DB.run($$$)", "$DB.exec($$$)", "$DB.prepare($$$)"] },
];

const COMMAND_SINK_PATTERNS: SinkPattern[] = [
  {
    kind: "command-exec",
    patterns: [
      "exec($CMD)",
      "execSync($CMD)",
      "spawn($CMD, $$$)",
      "spawnSync($CMD, $$$)",
      "Bun.spawn($$$)",
      "Bun.spawnSync($$$)",
    ],
  },
];

const FILE_SINK_PATTERNS: SinkPattern[] = [
  {
    kind: "file-path",
    patterns: [
      "writeFile($PATH, $$$)",
      "writeFileSync($PATH, $$$)",
      "readFile($PATH)",
      "readFileSync($PATH)",
      "Bun.write($PATH, $$$)",
    ],
  },
];

const EVAL_SINK_PATTERNS: SinkPattern[] = [
  { kind: "eval", patterns: ["eval($CODE)", "new Function($$$)"] },
];

const ALL_SINK_PATTERNS: SinkPattern[] = [
  ...SQL_SINK_PATTERNS,
  ...COMMAND_SINK_PATTERNS,
  ...FILE_SINK_PATTERNS,
  ...EVAL_SINK_PATTERNS,
];

// ---------------------------------------------------------------------------
// Sanitizer patterns
// ---------------------------------------------------------------------------

const SANITIZER_PATTERNS: string[] = [
  "$SCHEMA.parse($DATA)",
  "$SCHEMA.safeParse($DATA)",
  "validateJson($$$)",
  "validateQuery($$$)",
  "escapeHtml($DATA)",
  "encodeURIComponent($DATA)",
  "sanitize($DATA)",
  "sanitizeHtml($DATA)",
  "DOMPurify.sanitize($DATA)",
];

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

/**
 * Extract the variable name that a source expression is assigned to.
 * Handles: `const body = c.req.valid('json')`, destructuring `const { x } = req.body`, etc.
 */
function extractAssignedVariable(node: SgNode): string | null {
  const parent = node.parent();
  if (!parent) return null;

  // Direct assignment: const x = <source>
  if (parent.kind() === "variable_declarator") {
    const nameNode = parent.field("name");
    if (nameNode) return nameNode.text();
  }

  // await expression: const x = await <source>
  if (parent.kind() === "await_expression") {
    const grandparent = parent.parent();
    if (grandparent?.kind() === "variable_declarator") {
      const nameNode = grandparent.field("name");
      if (nameNode) return nameNode.text();
    }
  }

  return null;
}

/**
 * Check if a SQL sink uses string interpolation (template literal with ${} or string concatenation).
 * Parameterized queries with ? placeholders are considered safe.
 */
function isSqlInjectionRisk(sinkNode: SgNode): boolean {
  const args = sinkNode.field("arguments");
  if (!args) return false;

  const children = args.children().filter((c) => c.kind() !== "(" && c.kind() !== ")" && c.kind() !== ",");
  if (children.length === 0) return false;

  const sqlArg = children[0]!;

  // Template literals with ${} = risky
  if (sqlArg.kind() === "template_string") {
    const substitutions = sqlArg.findAll({ rule: { kind: "template_substitution" } });
    if (substitutions.length > 0) return true;
  }

  // String concatenation with + = risky
  if (sqlArg.kind() === "binary_expression") {
    const text = sqlArg.text();
    if (text.includes("+")) return true;
  }

  return false;
}

/**
 * Check if a command sink uses string interpolation.
 */
function isCommandInjectionRisk(sinkNode: SgNode): boolean {
  const args = sinkNode.field("arguments");
  if (!args) return false;

  const children = args.children().filter((c) => c.kind() !== "(" && c.kind() !== ")" && c.kind() !== ",");
  if (children.length === 0) return false;

  const cmdArg = children[0]!;

  if (cmdArg.kind() === "template_string") {
    const substitutions = cmdArg.findAll({ rule: { kind: "template_substitution" } });
    if (substitutions.length > 0) return true;
  }

  if (cmdArg.kind() === "binary_expression") {
    const text = cmdArg.text();
    if (text.includes("+")) return true;
  }

  // If the argument is an identifier, it could be tainted — but skip
  // ALL_CAPS names which are conventionally constants (e.g. CMD_PATH)
  if (cmdArg.kind() === "identifier") {
    const name = cmdArg.text();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return true;
  }

  return false;
}

/**
 * Extract variable names referenced inside a sink expression.
 */
function extractReferencedVariables(node: SgNode): string[] {
  const vars: string[] = [];

  // Collect all identifiers in the subtree
  const identifiers = node.findAll({ rule: { kind: "identifier" } });
  for (const id of identifiers) {
    const name = id.text();
    // Skip common non-variable identifiers
    if (name === "db" || name === "console" || name === "require" || name === "module") continue;
    vars.push(name);
  }

  // Also collect from template substitutions
  const substitutions = node.findAll({ rule: { kind: "template_substitution" } });
  for (const sub of substitutions) {
    const subIdentifiers = sub.findAll({ rule: { kind: "identifier" } });
    for (const id of subIdentifiers) {
      vars.push(id.text());
    }
  }

  return [...new Set(vars)];
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

interface FileAnalysisResult {
  sources: TaintSource[];
  sinks: TaintSink[];
  sanitizers: TaintSanitizer[];
}

function analyzeFile(root: SgNode, filePath: string): FileAnalysisResult {
  const sources: TaintSource[] = [];
  const sinks: TaintSink[] = [];
  const sanitizers: TaintSanitizer[] = [];

  // --- Detect sources ---
  for (const sp of ALL_SOURCE_PATTERNS) {
    for (const pattern of sp.patterns) {
      const matches = root.findAll({ rule: { pattern } });
      for (const match of matches) {
        const range = match.range();
        const variable = extractAssignedVariable(match) ?? match.text();
        const funcCtx = findEnclosingFunction(match);

        sources.push({
          filePath,
          line: range.start.line + 1,
          kind: sp.kind,
          variable,
          functionContext: funcCtx ?? "<module>",
        });
      }
    }
  }

  // --- Detect sinks ---
  for (const sp of ALL_SINK_PATTERNS) {
    for (const pattern of sp.patterns) {
      const matches = root.findAll({ rule: { pattern } });
      for (const match of matches) {
        const range = match.range();
        const funcCtx = findEnclosingFunction(match);

        // For SQL sinks, only flag those with string interpolation
        if (sp.kind === "sql-string") {
          if (!isSqlInjectionRisk(match)) continue;
        }

        // For command sinks, check for interpolation risk
        if (sp.kind === "command-exec") {
          if (!isCommandInjectionRisk(match)) continue;
        }

        sinks.push({
          filePath,
          line: range.start.line + 1,
          kind: sp.kind,
          raw: truncate(match.text(), 200),
          functionContext: funcCtx ?? "<module>",
        });
      }
    }
  }

  // --- Detect sanitizers ---
  for (const pattern of SANITIZER_PATTERNS) {
    const matches = root.findAll({ rule: { pattern } });
    for (const match of matches) {
      const range = match.range();
      const variable = extractAssignedVariable(match) ?? match.text();

      sanitizers.push({
        kind: inferSanitizerKind(match.text()),
        line: range.start.line + 1,
        variable,
      });
    }
  }

  return { sources, sinks, sanitizers };
}

function inferSanitizerKind(text: string): string {
  if (text.includes("parse(") || text.includes("safeParse(")) return "schema-validation";
  if (text.includes("validate")) return "validation-middleware";
  if (text.includes("escape") || text.includes("sanitize") || text.includes("DOMPurify")) return "escaping";
  if (text.includes("encodeURI")) return "encoding";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Flow analysis — connect sources to sinks within same function scope
// ---------------------------------------------------------------------------

function computeFlows(
  sources: TaintSource[],
  sinks: TaintSink[],
  sanitizers: TaintSanitizer[],
  root: SgNode,
): TaintFlow[] {
  const flows: TaintFlow[] = [];

  // Group sources and sinks by function context within the same file
  const sourcesByScope = groupBy(sources, (s) => `${s.filePath}::${s.functionContext}`);
  const sinksByScope = groupBy(sinks, (s) => `${s.filePath}::${s.functionContext}`);
  const sanitizersByScope = groupBy(sanitizers, (s) => `${s.variable}::scope`);

  // Pre-index: map each sink to its AST nodes (single pass per unique pattern
  // instead of re-searching the entire AST for every sink in every scope)
  const sinkNodeIndex = new Map<TaintSink, SgNode[]>();
  for (const scopeSinks of sinksByScope.values()) {
    for (const sink of scopeSinks) {
      sinkNodeIndex.set(sink, findSinkNodes(root, sink));
    }
  }

  for (const [scope, scopeSources] of sourcesByScope) {
    const scopeSinks = sinksByScope.get(scope);
    if (!scopeSinks) continue;

    // Build set of tainted variable names in this scope
    const taintedVars = new Set<string>();
    for (const source of scopeSources) {
      taintedVars.add(source.variable);

      // Also add destructured properties: if variable is `{ x, y }` pattern,
      // extract individual names
      if (source.variable.startsWith("{")) {
        const inner = source.variable.slice(1, -1);
        for (const part of inner.split(",")) {
          const name = part.trim().split(":")[0]?.trim().split("=")[0]?.trim();
          if (name) taintedVars.add(name);
        }
      }
    }

    for (const sink of scopeSinks) {
      // Look up pre-computed sink nodes instead of re-searching the AST
      const sinkNodes = sinkNodeIndex.get(sink) ?? [];

      // Collect variables referenced in the sink
      let referencedVars: string[] = [];
      if (sinkNodes.length > 0) {
        referencedVars = extractReferencedVariables(sinkNodes[0]!);
      } else {
        // Fallback: extract identifiers from the raw text
        referencedVars = extractIdentifiersFromText(sink.raw);
      }

      // Check if any tainted variable flows into this sink
      const taintedInSink = referencedVars.filter((v) => taintedVars.has(v));
      if (taintedInSink.length === 0) continue;

      // Find the closest matching source for this sink
      const matchingSource = findClosestSource(scopeSources, taintedInSink);
      if (!matchingSource) continue;

      // Check for sanitizer between source and sink
      const sanitizer = findSanitizerBetween(
        matchingSource,
        sink,
        sanitizers,
        taintedInSink,
      );

      const severity = computeSeverity(sink.kind, sanitizer !== null);

      flows.push({
        source: matchingSource,
        sink,
        sanitized: sanitizer !== null,
        sanitizer: sanitizer ? { kind: sanitizer.kind, line: sanitizer.line } : undefined,
        severity,
      });
    }
  }

  return flows;
}

function findSinkNodes(root: SgNode, sink: TaintSink): SgNode[] {
  // `sink.raw` is a display string and may be truncated. Feeding an incomplete
  // expression back into ast-grep as a pattern can throw and abort the entire
  // package audit, so fall back to text-based identifier extraction instead.
  if (sink.raw.endsWith("...")) {
    return [];
  }

  try {
    return root.findAll({ rule: { pattern: sink.raw } });
  } catch {
    return [];
  }
}

function extractIdentifiersFromText(text: string): string[] {
  const matches = text.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g);
  if (!matches) return [];
  const keywords = new Set([
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "new", "delete", "typeof", "void", "await", "async", "from", "import",
    "export", "default", "true", "false", "null", "undefined", "this",
    "db", "console", "require", "module",
  ]);
  return [...new Set(matches.filter((m) => !keywords.has(m)))];
}

function findClosestSource(sources: TaintSource[], taintedVars: string[]): TaintSource | null {
  const taintedSet = new Set(taintedVars);
  // Prefer sources whose variable directly matches
  for (const source of sources) {
    if (taintedSet.has(source.variable)) return source;
  }
  // Fall back to first source (data could flow through assignment chain)
  return sources[0] ?? null;
}

function findSanitizerBetween(
  source: TaintSource,
  sink: TaintSink,
  sanitizers: TaintSanitizer[],
  taintedVars: string[],
): TaintSanitizer | null {
  const taintedSet = new Set(taintedVars);

  // NOTE: This is intraprocedural — source and sink are always in the same
  // file/scope because computeFlows() groups by `${filePath}::${functionContext}`
  // and runTaintAnalysis() partitions per file. Cross-file taint tracking is
  // not yet supported (known limitation).

  for (const san of sanitizers) {
    // Sanitizer line must be between source and sink
    if (san.line > source.line && san.line < sink.line) {
      // Check if the sanitizer operates on a tainted variable
      if (taintedSet.has(san.variable) || san.variable.includes("validate") || san.variable.includes("parse")) {
        return san;
      }
    }
  }

  return null;
}

function computeSeverity(sinkKind: TaintSinkKind, sanitized: boolean): "critical" | "high" | "medium" {
  if (sanitized) return "medium";

  switch (sinkKind) {
    case "sql-string":
      return "critical";
    case "command-exec":
      return "critical";
    case "eval":
      return "critical";
    case "file-path":
      return "high";
    default:
      return "high";
  }
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    let group = map.get(key);
    if (!group) {
      group = [];
      map.set(key, group);
    }
    group.push(item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface TaintAnalysisOptions {
  srcDir: string;
  fileContents?: Map<string, string>;
}

export async function runTaintAnalysis(
  srcDir: string,
  options?: { fileContents?: Map<string, string> },
): Promise<TaintAnalysis> {
  const fileContents = options?.fileContents;
  const files = fileContents
    ? [...fileContents.keys()]
    : await collectSourceFiles(srcDir);

  const allSources: TaintSource[] = [];
  const allSinks: TaintSink[] = [];
  const allSanitizers: TaintSanitizer[] = [];
  const rootsByFile = new Map<string, SgNode>();

  for (const filePath of files) {
    const source = fileContents?.get(filePath) ?? await readFile(filePath, "utf-8");
    const tree = parse(Lang.TypeScript, source);
    const root = tree.root();
    const relPath = relative(srcDir, filePath);

    rootsByFile.set(relPath, root);

    const result = analyzeFile(root, relPath);
    allSources.push(...result.sources);
    allSinks.push(...result.sinks);
    allSanitizers.push(...result.sanitizers);
  }

  // Compute flows per file (intraprocedural)
  const allFlows: TaintFlow[] = [];
  const fileGroups = new Set([
    ...allSources.map((s) => s.filePath),
    ...allSinks.map((s) => s.filePath),
  ]);

  for (const filePath of fileGroups) {
    const root = rootsByFile.get(filePath);
    if (!root) continue;

    const fileSources = allSources.filter((s) => s.filePath === filePath);
    const fileSinks = allSinks.filter((s) => s.filePath === filePath);
    const fileSanitizers = allSanitizers.filter((s) => {
      // Match sanitizers in the same file by checking source file paths
      // Sanitizers don't carry filePath, so we match by line proximity
      return true;
    });

    const flows = computeFlows(fileSources, fileSinks, fileSanitizers, root);
    allFlows.push(...flows);
  }

  const unsanitizedFlows = allFlows.filter((f) => !f.sanitized);

  return {
    sources: allSources,
    sinks: allSinks,
    flows: allFlows,
    unsanitizedFlows,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTaintAnalysis(analysis: TaintAnalysis): string {
  const lines: string[] = [];

  // Summary
  lines.push("## Taint Analysis");

  const sourceCounts = countBy(analysis.sources, (s) => s.kind);
  const sourceDetails = Object.entries(sourceCounts)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  lines.push(`Sources: ${analysis.sources.length} (${sourceDetails})`);

  const sinkCounts = countBy(analysis.sinks, (s) => s.kind);
  const sinkDetails = Object.entries(sinkCounts)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  lines.push(`Sinks: ${analysis.sinks.length} (${sinkDetails})`);

  lines.push(`Flows: ${analysis.flows.length} total, ${analysis.unsanitizedFlows.length} unsanitized`);

  if (analysis.unsanitizedFlows.length === 0) {
    lines.push("");
    lines.push("No unsanitized taint flows detected.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`Unsanitized flows: ${analysis.unsanitizedFlows.length}`);
  lines.push("");

  // Sort unsanitized flows by severity
  const sorted = [...analysis.unsanitizedFlows].sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2 };
    return order[a.severity] - order[b.severity];
  });

  for (const flow of sorted) {
    const label = sinkKindToLabel(flow.sink.kind);
    lines.push(`  ${flow.severity.toUpperCase()} ${label}: ${flow.sink.filePath}:${flow.sink.line}`);
    lines.push(`    source: ${flow.source.variable} (${flow.source.kind}, line ${flow.source.line})`);
    lines.push(`    sink: ${flow.sink.raw}`);
    lines.push(`    no sanitizer between source and sink`);
    lines.push("");
  }

  // Also summarize sanitized flows
  const sanitizedFlows = analysis.flows.filter((f) => f.sanitized);
  if (sanitizedFlows.length > 0) {
    lines.push(`Sanitized flows: ${sanitizedFlows.length}`);
    for (const flow of sanitizedFlows) {
      const label = sinkKindToLabel(flow.sink.kind);
      lines.push(`  OK ${label}: ${flow.sink.filePath}:${flow.sink.line}`);
      lines.push(`    sanitizer: ${flow.sanitizer?.kind ?? "unknown"} (line ${flow.sanitizer?.line ?? "?"})`);
    }
  }

  return lines.join("\n");
}

function sinkKindToLabel(kind: TaintSinkKind): string {
  switch (kind) {
    case "sql-string":
      return "sql-injection";
    case "command-exec":
      return "command-injection";
    case "file-path":
      return "path-traversal";
    case "eval":
      return "code-injection";
    default:
      return kind;
  }
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
