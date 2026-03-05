import type { GraphStore } from "../store/graph-store.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";
import { filePathToModuleName } from "../projector/module-layout.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChangeSet {
  /** File paths that were modified on disk */
  modified: string[];
  /** New files that were added */
  added: string[];
  /** Files that were deleted */
  removed: string[];
}

export interface IncrementalResult {
  /** Symbol IDs that were updated (added, removed, or changed) */
  affectedSymbols: string[];
  /** Module qualified names that were re-parsed */
  affectedModules: string[];
  /** Number of new edges added */
  newEdges: number;
  /** Number of edges removed */
  removedEdges: number;
}

export interface ParseFileResult {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// IncrementalParser
// ---------------------------------------------------------------------------

export class IncrementalParser {
  /** filePath -> module qualifiedName */
  private fileToModule: Map<string, string> = new Map();
  /** module qualifiedName -> set of module qualifiedNames that import it */
  private moduleDeps: Map<string, Set<string>> = new Map();

  constructor(private graphStore: GraphStore) {}

  /**
   * Build the initial dependency map by scanning the graph for module nodes
   * and import edges. Should be called once after the graph is populated.
   *
   * @param unresolvedEdges - Optional array of edges that were not stored in the
   *   graph (e.g., import edges whose target is a module specifier string rather
   *   than a node ID). The structural parser produces these with
   *   `metadata.unresolved: true`.
   */
  buildDependencyMap(unresolvedEdges?: SymbolEdge[]): void {
    this.fileToModule.clear();
    this.moduleDeps.clear();

    const allNodes = this.graphStore.getAllSymbols();
    const allEdges = this.graphStore.getAllEdges();

    // Map file paths to module qualified names
    // Module nodes have kind "module" and their qualifiedName is the file path without extension
    for (const node of allNodes) {
      if (node.kind === "module") {
        // The qualifiedName IS the module name (filePath without extension)
        this.fileToModule.set(node.qualifiedName, node.qualifiedName);
        // Also store with common extensions for reverse lookup
        this.fileToModule.set(`${node.qualifiedName}.ts`, node.qualifiedName);
        this.fileToModule.set(`${node.qualifiedName}.tsx`, node.qualifiedName);
        this.fileToModule.set(`${node.qualifiedName}.js`, node.qualifiedName);
        this.fileToModule.set(`${node.qualifiedName}.jsx`, node.qualifiedName);
      }
    }

    // Collect all import edges from both stored graph edges AND unresolved edges
    const importEdges: SymbolEdge[] = allEdges.filter((e) => e.kind === "imports");
    if (unresolvedEdges) {
      for (const e of unresolvedEdges) {
        if (e.kind === "imports") {
          importEdges.push(e);
        }
      }
    }

    // Build dependency graph from import edges
    for (const edge of importEdges) {
      // sourceId is the module node that imports
      // metadata.moduleSpecifier is the import path (might be relative)
      const sourceModule = this.graphStore.getSymbol(edge.sourceId);
      if (sourceModule && sourceModule.kind === "module") {
        const targetModSpec = edge.metadata?.moduleSpecifier as string | undefined;
        if (targetModSpec) {
          // Resolve relative paths against the source module
          const resolvedTarget = this.resolveModuleSpecifier(
            targetModSpec,
            sourceModule.qualifiedName,
          );
          if (resolvedTarget) {
            // resolvedTarget is a module that sourceModule depends on
            // We want: when resolvedTarget changes, sourceModule is affected
            let dependents = this.moduleDeps.get(resolvedTarget);
            if (!dependents) {
              dependents = new Set();
              this.moduleDeps.set(resolvedTarget, dependents);
            }
            dependents.add(sourceModule.qualifiedName);
          }
        }
      }
    }
  }

  /**
   * Compute which module qualified names need re-parsing based on the changes.
   * Returns the direct changed modules plus their transitive dependents.
   */
  getAffectedModules(changes: ChangeSet): string[] {
    const affected = new Set<string>();

    // Collect directly changed modules
    for (const filePath of [...changes.modified, ...changes.added, ...changes.removed]) {
      const modName = this.fileToModule.get(filePath) ?? filePathToModuleName(filePath);
      affected.add(modName);
    }

    // Expand to transitive dependents
    const queue = [...affected];
    while (queue.length > 0) {
      const current = queue.pop()!;
      const dependents = this.moduleDeps.get(current);
      if (dependents) {
        for (const dep of dependents) {
          if (!affected.has(dep)) {
            affected.add(dep);
            queue.push(dep);
          }
        }
      }
    }

    return [...affected];
  }

  /**
   * Re-parse only the affected files and update the graph with minimal operations.
   *
   * @param changes - The set of file changes
   * @param parseFile - A function that parses a single file and returns symbols and edges.
   *                    Typically wraps `parseTypeScript(code, filePath)`.
   * @returns Statistics about what changed
   */
  async update(
    changes: ChangeSet,
    parseFile: (filePath: string) => Promise<ParseFileResult>,
  ): Promise<IncrementalResult> {
    const affectedModules = this.getAffectedModules(changes);
    const affectedSymbols: string[] = [];
    let newEdges = 0;
    let removedEdges = 0;

    // 1. Handle removed files: remove all symbols belonging to those modules
    for (const filePath of changes.removed) {
      const modName = this.fileToModule.get(filePath) ?? filePathToModuleName(filePath);
      const oldSymbols = this.findSymbolsByModule(modName);
      for (const sym of oldSymbols) {
        affectedSymbols.push(sym.id);
        const edgeCount = this.graphStore.getEdgesFrom(sym.id).length + this.graphStore.getEdgesTo(sym.id).length;
        this.graphStore.removeSymbol(sym.id);
        removedEdges += edgeCount;
      }
    }

    // 2. Handle added and modified files: re-parse and diff
    const filesToReparse = [...changes.added, ...changes.modified];
    for (const filePath of filesToReparse) {
      const modName = filePathToModuleName(filePath);

      // Get old symbols for this module
      const oldSymbols = this.findSymbolsByModule(modName);
      const oldSymbolMap = new Map<string, SymbolNode>();
      for (const sym of oldSymbols) {
        oldSymbolMap.set(sym.qualifiedName, sym);
      }

      // Get old edges that originate from symbols in this module
      const oldEdgeSet = new Set<string>();
      for (const sym of oldSymbols) {
        for (const edge of this.graphStore.getEdgesFrom(sym.id)) {
          oldEdgeSet.add(edge.id);
        }
      }

      // Parse the new version
      const parseResult = await parseFile(filePath);
      const newSymbolMap = new Map<string, SymbolNode>();
      for (const sym of parseResult.nodes) {
        newSymbolMap.set(sym.qualifiedName, sym);
      }

      // Build a mapping from new parse IDs -> actual graph IDs.
      // For unchanged symbols we keep the old ID; for new/modified ones
      // we use the new ID.
      const newIdToGraphId = new Map<string, string>();

      // Diff: find added, removed, and modified symbols
      // Removed symbols: in old but not in new
      for (const [qn, oldSym] of oldSymbolMap) {
        if (!newSymbolMap.has(qn)) {
          affectedSymbols.push(oldSym.id);
          const edgeCount = this.graphStore.getEdgesFrom(oldSym.id).length + this.graphStore.getEdgesTo(oldSym.id).length;
          this.graphStore.removeSymbol(oldSym.id);
          removedEdges += edgeCount;
        }
      }

      // Added symbols: in new but not in old
      for (const [qn, newSym] of newSymbolMap) {
        if (!oldSymbolMap.has(qn)) {
          this.graphStore.addSymbol(newSym);
          affectedSymbols.push(newSym.id);
          newIdToGraphId.set(newSym.id, newSym.id);
        }
      }

      // Modified or unchanged symbols: in both
      for (const [qn, newSym] of newSymbolMap) {
        const oldSym = oldSymbolMap.get(qn);
        if (oldSym) {
          if (oldSym.body !== newSym.body || oldSym.signature !== newSym.signature) {
            // Update by removing old and adding new
            this.graphStore.removeSymbol(oldSym.id);
            this.graphStore.addSymbol(newSym);
            affectedSymbols.push(newSym.id);
            newIdToGraphId.set(newSym.id, newSym.id);
          } else {
            // Unchanged: keep old node, map new ID -> old ID
            newIdToGraphId.set(newSym.id, oldSym.id);
          }
        }
      }

      // Handle edges: remove old edges from this module's symbols, add new ones
      for (const edgeId of oldEdgeSet) {
        if (this.graphStore.getEdge(edgeId)) {
          this.graphStore.removeEdge(edgeId);
          removedEdges++;
        }
      }

      // Add new edges, remapping IDs to match graph nodes
      for (const edge of parseResult.edges) {
        const remappedEdge: SymbolEdge = {
          ...edge,
          sourceId: newIdToGraphId.get(edge.sourceId) ?? edge.sourceId,
          targetId: newIdToGraphId.get(edge.targetId) ?? edge.targetId,
        };
        try {
          this.graphStore.addEdge(remappedEdge);
          newEdges++;
        } catch {
          // Endpoint missing, skip edge
        }
      }
    }

    // 3. Rebuild dependency map after changes
    this.buildDependencyMap();

    return {
      affectedSymbols,
      affectedModules,
      newEdges,
      removedEdges,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private findSymbolsByModule(modName: string): SymbolNode[] {
    const allSymbols = this.graphStore.getAllSymbols();
    return allSymbols.filter((s) => s.qualifiedName === modName || s.qualifiedName.startsWith(`${modName}.`));
  }

  private resolveModuleSpecifier(specifier: string, fromModule: string): string | null {
    // Only resolve relative specifiers
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      return null; // External package, not in graph
    }

    // Strip extension from specifier if present
    const stripped = specifier.replace(/\.(tsx?|jsx?)$/, "");

    // Resolve relative to the importing module's directory
    const fromParts = fromModule.split("/");
    fromParts.pop(); // Remove filename part
    const specParts = stripped.split("/");

    const resolved = [...fromParts];
    for (const part of specParts) {
      if (part === ".") continue;
      if (part === "..") {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    const resolvedPath = resolved.join("/");

    // Check if this module exists in our file map
    if (this.fileToModule.has(resolvedPath)) {
      return resolvedPath;
    }

    return resolvedPath;
  }
}
