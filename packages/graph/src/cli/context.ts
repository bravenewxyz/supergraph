import type { GraphStore } from "../store/graph-store.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge, EdgeKind } from "../schema/edges.js";

export interface ContextOptions {
  format: "text" | "json";
  pkg?: string;
}

interface ConnectedSymbol {
  name: string;
  kind: string;
  qualifiedName: string;
  file: string;
  line: number | null;
}

interface GroupedEdges {
  [kind: string]: ConnectedSymbol[];
}

interface ContextResult {
  symbol: {
    id: string;
    kind: string;
    name: string;
    qualifiedName: string;
    signature: string;
    file: string;
    line: number | null;
    exported: boolean;
  };
  incoming: GroupedEdges;
  outgoing: GroupedEdges;
  summary: { incoming: Record<string, number>; outgoing: Record<string, number> };
}

function fileFromQualifiedName(node: SymbolNode): string {
  // The module-level qualifiedName prefix is the file key
  const parts = node.qualifiedName.split(".");
  return parts[0] ?? node.qualifiedName;
}

function resolveConnected(
  store: GraphStore,
  edge: SymbolEdge,
  otherId: string,
): ConnectedSymbol | null {
  const node = store.getSymbol(otherId);
  if (!node) return null;
  return {
    name: node.name,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    file: fileFromQualifiedName(node),
    line: node.sourceRange?.startLine ?? null,
  };
}

function groupEdges(
  store: GraphStore,
  edges: SymbolEdge[],
  getOtherId: (e: SymbolEdge) => string,
  pkg?: string,
): GroupedEdges {
  const groups: GroupedEdges = {};
  for (const edge of edges) {
    const otherId = getOtherId(edge);
    const connected = resolveConnected(store, edge, otherId);
    if (!connected) continue;
    if (pkg && !connected.qualifiedName.startsWith(pkg)) continue;
    if (!groups[edge.kind]) groups[edge.kind] = [];
    groups[edge.kind]!.push(connected);
  }
  return groups;
}

function buildSummary(groups: GroupedEdges): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const [kind, items] of Object.entries(groups)) {
    summary[kind] = items.length;
  }
  return summary;
}

export function findSymbol(
  store: GraphStore,
  name: string,
): SymbolNode[] {
  // 1. Exact qualified name match
  const exact = store.getSymbolByQualifiedName(name);
  if (exact) return [exact];

  // 2. Search all symbols
  const all = store.getAllSymbols();
  const matches: SymbolNode[] = [];

  const hasQualifier = name.includes(".") || name.includes("/");

  for (const sym of all) {
    if (hasQualifier) {
      // Partial match against qualified name
      if (sym.qualifiedName.includes(name)) {
        matches.push(sym);
      }
    } else {
      // Simple name match
      if (sym.name === name) {
        matches.push(sym);
      }
    }
  }

  return matches;
}

export function buildContext(
  store: GraphStore,
  symbol: SymbolNode,
  opts: ContextOptions,
): ContextResult {
  const incoming = groupEdges(
    store,
    store.getEdgesTo(symbol.id),
    (e) => e.sourceId,
    opts.pkg,
  );
  const outgoing = groupEdges(
    store,
    store.getEdgesFrom(symbol.id),
    (e) => e.targetId,
    opts.pkg,
  );

  return {
    symbol: {
      id: symbol.id,
      kind: symbol.kind,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      signature: symbol.signature,
      file: fileFromQualifiedName(symbol),
      line: symbol.sourceRange?.startLine ?? null,
      exported: symbol.exported,
    },
    incoming,
    outgoing,
    summary: {
      incoming: buildSummary(incoming),
      outgoing: buildSummary(outgoing),
    },
  };
}

export function formatContextText(result: ContextResult): string {
  const lines: string[] = [];
  const { symbol, incoming, outgoing, summary } = result;

  const fileLine = symbol.line != null ? `${symbol.file}:${symbol.line}` : symbol.file;
  lines.push(`CONTEXT | ${symbol.qualifiedName} | ${symbol.kind}`);
  lines.push(`File: ${fileLine}`);
  if (symbol.signature) lines.push(`Signature: ${symbol.signature}`);
  lines.push(`Exported: ${symbol.exported ? "yes" : "no"}`);

  // Incoming
  lines.push("");
  lines.push("## Incoming (who references this)");
  const inKinds = Object.keys(incoming);
  if (inKinds.length === 0) {
    lines.push("  (none)");
  } else {
    for (const kind of inKinds) {
      const items = incoming[kind]!;
      lines.push(`  ${kind} (${items.length}):`);
      for (const item of items) {
        const loc = item.line != null ? `${item.file}:${item.line}` : item.file;
        lines.push(`    ${item.name} [${item.qualifiedName}] — ${loc}`);
      }
    }
  }

  // Outgoing
  lines.push("");
  lines.push("## Outgoing (what this references)");
  const outKinds = Object.keys(outgoing);
  if (outKinds.length === 0) {
    lines.push("  (none)");
  } else {
    for (const kind of outKinds) {
      const items = outgoing[kind]!;
      lines.push(`  ${kind} (${items.length}):`);
      for (const item of items) {
        const loc = item.line != null ? `${item.file}:${item.line}` : item.file;
        lines.push(`    ${item.name} [${item.qualifiedName}] — ${loc}`);
      }
    }
  }

  // Summary
  lines.push("");
  lines.push("## Summary");
  const inParts = Object.entries(summary.incoming).map(([k, v]) => `${v} ${k}`);
  const outParts = Object.entries(summary.outgoing).map(([k, v]) => `${v} ${k}`);
  const inStr = inParts.length > 0 ? inParts.join(", ") : "nothing";
  const outStr = outParts.length > 0 ? outParts.join(", ") : "nothing";
  lines.push(`  ${inStr} | ${outStr}`);

  return lines.join("\n");
}

export function formatDisambiguation(matches: SymbolNode[]): string {
  const lines: string[] = [];
  lines.push(`Multiple symbols match "${matches[0]?.name ?? "??"}":`);
  for (let i = 0; i < matches.length; i++) {
    const sym = matches[i]!;
    const file = fileFromQualifiedName(sym);
    const loc = sym.sourceRange?.startLine != null ? `${file}:${sym.sourceRange.startLine}` : file;
    lines.push(`  ${i + 1}. ${sym.qualifiedName} [${sym.kind}] — ${loc}`);
  }
  lines.push("Use the full qualified name to disambiguate.");
  return lines.join("\n");
}
