/**
 * Shared structural parser core.
 *
 * Both `ts-structural` and `go-structural` produce the same output shape
 * (SymbolNode[] + SymbolEdge[]). This module extracts the common scaffolding
 * so each language file only needs to supply language-specific extraction
 * logic and configuration.
 */

import type { SgNode } from "@ast-grep/napi";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import { createSymbolNode } from "../schema/nodes.js";
import { createSymbolEdge } from "../schema/edges.js";

// ─── Shared types ───────────────────────────────────────────────────────────

export interface ParseResult {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
}

/**
 * Accumulator passed through all extraction functions so they can append
 * nodes and edges without return-value plumbing.
 */
export interface ParseContext {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
  modName: string;
  moduleId: string;
}

/**
 * Language-specific configuration provided by each thin wrapper.
 */
export interface LanguageConfig {
  /** Parse source code into an ast-grep root node. */
  parseRoot: (code: string, filePath: string) => SgNode;

  /** Derive the module/package name from a file path. */
  filePathToModuleName: (filePath: string) => string;

  /** Build the module-level signature (e.g. `module foo` or `package main`). */
  moduleSignature: (root: SgNode, modName: string) => string;

  /** Run all language-specific extractors against the AST root. */
  extract: (root: SgNode, ctx: ParseContext) => void;
}

// ─── Shared utilities ───────────────────────────────────────────────────────

export function makeId(): string {
  return crypto.randomUUID();
}

export function qualifiedName(modName: string, symbolName: string): string {
  return `${modName}.${symbolName}`;
}

export function getSourceRange(node: SgNode): { startLine: number; endLine: number } {
  const range = node.range();
  return { startLine: range.start.line, endLine: range.end.line };
}

/** Push a node + its "contains" edge in one call. */
export function addSymbol(
  ctx: ParseContext,
  parentId: string,
  node: Parameters<typeof createSymbolNode>[0],
): string {
  ctx.nodes.push(createSymbolNode(node));
  ctx.edges.push(
    createSymbolEdge({
      id: makeId(),
      kind: "contains",
      sourceId: parentId,
      targetId: node.id,
    }),
  );
  return node.id;
}

// Re-export schema helpers so language files only need one import
export { createSymbolNode, createSymbolEdge };
export type { SymbolNode, SymbolEdge };
export type { SymbolKind } from "../schema/nodes.js";
export type { EdgeKind } from "../schema/edges.js";
export type { SgNode };

// ─── Generic parse driver ───────────────────────────────────────────────────

/**
 * Language-agnostic structural parse entry point.
 *
 * 1. Parse the source into an AST root via `config.parseRoot`.
 * 2. Create the module-level SymbolNode.
 * 3. Delegate to `config.extract` for all language-specific symbol extraction.
 */
export function parseStructural(
  code: string,
  filePath: string,
  config: LanguageConfig,
): ParseResult {
  const nodes: SymbolNode[] = [];
  const edges: SymbolEdge[] = [];

  const root = config.parseRoot(code, filePath);
  const modName = config.filePathToModuleName(filePath);
  const moduleId = makeId();

  // Module node
  nodes.push(
    createSymbolNode({
      id: moduleId,
      kind: "module",
      name: modName,
      qualifiedName: modName,
      signature: config.moduleSignature(root, modName),
      exported: true,
      sourceRange: { startLine: 0, endLine: code.split("\n").length - 1 },
    }),
  );

  const ctx: ParseContext = { nodes, edges, modName, moduleId };
  config.extract(root, ctx);

  return { nodes, edges };
}
