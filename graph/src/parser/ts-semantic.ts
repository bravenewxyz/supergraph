import ts from "typescript";
import type { GraphStore } from "../store/graph-store.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge, EdgeKind } from "../schema/edges.js";
import { createSymbolEdge } from "../schema/edges.js";
import { filePathToModuleName } from "../projector/module-layout.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SemanticEnrichment {
  /** symbolId -> resolved type string */
  resolvedTypes: Map<string, string>;
  callEdges: Array<{ sourceId: string; targetId: string; callSite?: string }>;
  typeRefEdges: Array<{ sourceId: string; targetId: string }>;
  extendsEdges: Array<{ sourceId: string; targetId: string }>;
  implementsEdges: Array<{ sourceId: string; targetId: string }>;
}

export interface SemanticParserOptions {
  tsConfigPath?: string;
  compilerOptions?: ts.CompilerOptions;
  rootDir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function qualifiedName(modName: string, symbolName: string): string {
  return `${modName}.${symbolName}`;
}

/** Build a lookup from qualifiedName -> SymbolNode for the graph. */
function buildQnMap(graphStore: GraphStore): Map<string, SymbolNode> {
  const map = new Map<string, SymbolNode>();
  for (const node of graphStore.getAllSymbols()) {
    map.set(node.qualifiedName, node);
  }
  return map;
}

/** Attempt to get the fully-qualified name of a ts.Symbol within a file. */
function tsSymbolToQualifiedName(
  sym: ts.Symbol,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): string | null {
  // Follow import aliases to the original declaration
  let resolved = sym;
  if (resolved.flags & ts.SymbolFlags.Alias) {
    try {
      resolved = checker.getAliasedSymbol(resolved);
    } catch {
      // getAliasedSymbol can throw for some edge cases
    }
  }

  // Get the declaration
  const decls = resolved.getDeclarations();
  if (!decls || decls.length === 0) return null;

  const decl = decls[0]!;
  const declFile = decl.getSourceFile();
  const modName = filePathToModuleName(declFile.fileName);

  // Walk up to build the name chain
  const nameParts: string[] = [];
  let current: ts.Node | undefined = decl;

  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isEnumDeclaration(current)
    ) {
      const name = (current as any).name;
      if (name && ts.isIdentifier(name)) {
        nameParts.unshift(name.text);
      }
    } else if (ts.isVariableDeclaration(current)) {
      if (ts.isIdentifier(current.name)) {
        nameParts.unshift(current.name.text);
      }
    }
    current = current.parent;
  }

  if (nameParts.length === 0) {
    // Fallback: use the symbol name
    const name = sym.getName();
    if (name && name !== "default" && name !== "__function") {
      return qualifiedName(modName, name);
    }
    return null;
  }

  return qualifiedName(modName, nameParts.join("."));
}

/**
 * Get the name of the enclosing function/method for a call expression,
 * used to identify the source of a "calls" edge.
 */
function getEnclosingFunctionName(node: ts.Node): string | null {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text;
    }
    if (ts.isMethodDeclaration(current) && current.name) {
      return current.name.getText();
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      // Check if it's assigned to a variable
      const parent = current.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
    }
    current = current.parent;
  }
  return null;
}

/**
 * Get the class name for a method (if any).
 */
function getEnclosingClassName(node: ts.Node): string | null {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) && current.name) {
      return current.name.text;
    }
    current = current.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SemanticParser
// ---------------------------------------------------------------------------

export class SemanticParser {
  private program: ts.Program | null = null;
  private checker: ts.TypeChecker | null = null;
  private options: SemanticParserOptions;

  constructor(options: SemanticParserOptions = {}) {
    this.options = options;
  }

  /**
   * Initialize the TypeScript program from the given file paths.
   * Must be called before any query methods.
   */
  initialize(filePaths: string[]): void {
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      // Allow JS too so we don't choke on non-TS files
      allowJs: true,
      ...(this.options.compilerOptions ?? {}),
    };

    // If a tsconfig path is provided, read it
    if (this.options.tsConfigPath) {
      const configFile = ts.readConfigFile(this.options.tsConfigPath, ts.sys.readFile);
      if (!configFile.error) {
        const parsed = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
          this.options.rootDir ?? ".",
        );
        Object.assign(compilerOptions, parsed.options);
      }
    }

    this.program = ts.createProgram(filePaths, compilerOptions);
    this.checker = this.program.getTypeChecker();
  }

  /**
   * Enrich an existing GraphStore with semantic information extracted via the
   * TypeScript type checker. Returns the enrichment data and does NOT mutate
   * the graph directly (the caller can apply it).
   */
  enrichGraph(graphStore: GraphStore, filePaths: string[]): SemanticEnrichment {
    if (!this.program || !this.checker) {
      throw new Error("SemanticParser not initialized. Call initialize() first.");
    }

    const enrichment: SemanticEnrichment = {
      resolvedTypes: new Map(),
      callEdges: [],
      typeRefEdges: [],
      extendsEdges: [],
      implementsEdges: [],
    };

    const qnMap = buildQnMap(graphStore);
    const checker = this.checker;

    for (const filePath of filePaths) {
      const sourceFile = this.program.getSourceFile(filePath);
      if (!sourceFile) continue;

      const modName = filePathToModuleName(filePath);

      this.visitNode(sourceFile, sourceFile, modName, qnMap, checker, enrichment);
    }

    return enrichment;
  }

  /**
   * Resolve the type of a symbol in the given file.
   */
  getResolvedType(filePath: string, symbolName: string): string | null {
    if (!this.program || !this.checker) return null;

    const sourceFile = this.program.getSourceFile(filePath);
    if (!sourceFile) return null;

    const checker = this.checker;
    let result: string | null = null;

    const visit = (node: ts.Node): void => {
      if (result !== null) return;

      if (ts.isFunctionDeclaration(node) && node.name?.text === symbolName) {
        const sig = checker.getSignatureFromDeclaration(node);
        if (sig) {
          const retType = checker.getReturnTypeOfSignature(sig);
          result = checker.typeToString(retType);
        }
        return;
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === symbolName) {
        const type = checker.getTypeAtLocation(node);
        result = checker.typeToString(type);
        return;
      }

      if (ts.isClassDeclaration(node) && node.name?.text === symbolName) {
        const type = checker.getTypeAtLocation(node);
        result = checker.typeToString(type);
        return;
      }

      if (ts.isInterfaceDeclaration(node) && node.name?.text === symbolName) {
        const type = checker.getTypeAtLocation(node);
        result = checker.typeToString(type);
        return;
      }

      if (ts.isTypeAliasDeclaration(node) && node.name?.text === symbolName) {
        const type = checker.getTypeAtLocation(node);
        result = checker.typeToString(type);
        return;
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return result;
  }

  /**
   * Get the list of qualified names of functions/methods called from the
   * specified function in the file. Returns qualified names where possible,
   * otherwise raw symbol names.
   */
  getCallsFrom(filePath: string, functionName: string): string[] {
    if (!this.program || !this.checker) return [];

    const sourceFile = this.program.getSourceFile(filePath);
    if (!sourceFile) return [];

    const checker = this.checker;
    const calls: string[] = [];

    // First, find the function node
    let functionNode: ts.Node | null = null;

    const findFunc = (node: ts.Node): void => {
      if (functionNode) return;

      if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
        functionNode = node;
        return;
      }
      if (ts.isMethodDeclaration(node) && node.name?.getText() === functionName) {
        functionNode = node;
        return;
      }
      // Arrow function assigned to a variable
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === functionName) {
        if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          functionNode = node.initializer;
          return;
        }
      }

      ts.forEachChild(node, findFunc);
    };

    findFunc(sourceFile);
    if (!functionNode) return [];

    // Now walk the function body looking for call expressions
    const visitCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const sym = checker.getSymbolAtLocation(
          ts.isPropertyAccessExpression(callee) ? callee.name : callee,
        );
        if (sym) {
          const qn = tsSymbolToQualifiedName(sym, checker, sourceFile);
          if (qn) {
            calls.push(qn);
          } else {
            calls.push(sym.getName());
          }
        }
      }
      ts.forEachChild(node, visitCalls);
    };

    visitCalls(functionNode);
    return calls;
  }

  /**
   * Get the extends chain for a class (the names of the base classes).
   */
  getExtendsChain(filePath: string, className: string): string[] {
    if (!this.program || !this.checker) return [];

    const sourceFile = this.program.getSourceFile(filePath);
    if (!sourceFile) return [];

    const checker = this.checker;
    const chain: string[] = [];

    // Find the class
    let classNode: ts.ClassDeclaration | null = null;
    const findClass = (node: ts.Node): void => {
      if (classNode) return;
      if (ts.isClassDeclaration(node) && node.name?.text === className) {
        classNode = node;
        return;
      }
      ts.forEachChild(node, findClass);
    };
    findClass(sourceFile);

    if (!classNode) return [];

    // Walk the extends chain
    let current: ts.ClassDeclaration | null = classNode;
    while (current) {
      const heritageClauses = current.heritageClauses;
      if (!heritageClauses) break;

      let foundExtends = false;
      for (const clause of heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          for (const baseType of clause.types) {
            const type = checker.getTypeAtLocation(baseType.expression);
            const sym = type.getSymbol();
            if (sym) {
              chain.push(sym.getName());
              // Try to get the next class in the chain
              const decls = sym.getDeclarations();
              if (decls && decls.length > 0 && ts.isClassDeclaration(decls[0]!)) {
                current = decls[0];
                foundExtends = true;
              } else {
                current = null;
              }
            } else {
              current = null;
            }
          }
        }
      }
      if (!foundExtends) break;
    }

    return chain;
  }

  /**
   * Get the list of interfaces implemented by a class.
   */
  getImplements(filePath: string, className: string): string[] {
    if (!this.program || !this.checker) return [];

    const sourceFile = this.program.getSourceFile(filePath);
    if (!sourceFile) return [];

    const checker = this.checker;
    const implemented: string[] = [];

    let classNode: ts.ClassDeclaration | null = null;
    const findClass = (node: ts.Node): void => {
      if (classNode) return;
      if (ts.isClassDeclaration(node) && node.name?.text === className) {
        classNode = node;
        return;
      }
      ts.forEachChild(node, findClass);
    };
    findClass(sourceFile);

    if (!classNode) return [];

    const heritageClauses = (classNode as ts.ClassDeclaration).heritageClauses;
    if (!heritageClauses) return [];

    for (const clause of heritageClauses) {
      if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
        for (const impl of clause.types) {
          const type = checker.getTypeAtLocation(impl.expression);
          const sym = type.getSymbol();
          if (sym) {
            implemented.push(sym.getName());
          } else {
            // Fallback: use text
            implemented.push(impl.expression.getText());
          }
        }
      }
    }

    return implemented;
  }

  /**
   * Resolve an import module specifier to an actual file path.
   */
  resolveImportPath(importPath: string, fromFile: string): string | null {
    if (!this.program) return null;

    const compilerOptions = this.program.getCompilerOptions();
    const resolution = ts.resolveModuleName(
      importPath,
      fromFile,
      compilerOptions,
      ts.sys,
    );

    if (resolution.resolvedModule) {
      return resolution.resolvedModule.resolvedFileName;
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Private: AST visitor that collects semantic info
  // -------------------------------------------------------------------------

  private visitNode(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    modName: string,
    qnMap: Map<string, SymbolNode>,
    checker: ts.TypeChecker,
    enrichment: SemanticEnrichment,
  ): void {
    // --- Resolved types for functions ---
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const qn = qualifiedName(modName, name);
      const graphNode = qnMap.get(qn);
      if (graphNode) {
        const sig = checker.getSignatureFromDeclaration(node);
        if (sig) {
          const retType = checker.getReturnTypeOfSignature(sig);
          const typeStr = checker.typeToString(retType);
          enrichment.resolvedTypes.set(graphNode.id, typeStr);
        }
      }
    }

    // --- Resolved types for arrow functions assigned to variables ---
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const qn = qualifiedName(modName, name);
      const graphNode = qnMap.get(qn);
      if (graphNode) {
        const type = checker.getTypeAtLocation(node);
        const typeStr = checker.typeToString(type);
        enrichment.resolvedTypes.set(graphNode.id, typeStr);
      }
    }

    // --- Resolved types for methods ---
    if (ts.isMethodDeclaration(node) && node.name) {
      const methodName = node.name.getText();
      const className = getEnclosingClassName(node);
      if (className) {
        const qn = qualifiedName(modName, `${className}.${methodName}`);
        const graphNode = qnMap.get(qn);
        if (graphNode) {
          const sig = checker.getSignatureFromDeclaration(node);
          if (sig) {
            const retType = checker.getReturnTypeOfSignature(sig);
            const typeStr = checker.typeToString(retType);
            enrichment.resolvedTypes.set(graphNode.id, typeStr);
          }
        }
      }
    }

    // --- Call edges ---
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeSym = checker.getSymbolAtLocation(
        ts.isPropertyAccessExpression(callee) ? callee.name : callee,
      );

      if (calleeSym) {
        const calleeQn = tsSymbolToQualifiedName(calleeSym, checker, sourceFile);

        // Find the enclosing function to use as source
        const enclosingName = getEnclosingFunctionName(node);
        if (enclosingName) {
          const enclosingClassName = getEnclosingClassName(node);
          const sourceQn = enclosingClassName
            ? qualifiedName(modName, `${enclosingClassName}.${enclosingName}`)
            : qualifiedName(modName, enclosingName);

          const sourceNode = qnMap.get(sourceQn);
          const targetNode = calleeQn ? qnMap.get(calleeQn) : null;

          if (sourceNode && targetNode) {
            const callSiteLine = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
            enrichment.callEdges.push({
              sourceId: sourceNode.id,
              targetId: targetNode.id,
              callSite: `${sourceFile.fileName}:${callSiteLine + 1}`,
            });
          }
        }
      }
    }

    // --- Heritage clauses: extends / implements ---
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      const classQn = qualifiedName(modName, className);
      const classGraphNode = qnMap.get(classQn);

      if (classGraphNode && node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          const isExtends = clause.token === ts.SyntaxKind.ExtendsKeyword;
          const isImplements = clause.token === ts.SyntaxKind.ImplementsKeyword;

          for (const baseType of clause.types) {
            const type = checker.getTypeAtLocation(baseType.expression);
            const sym = type.getSymbol();
            if (sym) {
              const targetQn = tsSymbolToQualifiedName(sym, checker, sourceFile);
              const targetNode = targetQn ? qnMap.get(targetQn) : null;

              if (targetNode) {
                if (isExtends) {
                  enrichment.extendsEdges.push({
                    sourceId: classGraphNode.id,
                    targetId: targetNode.id,
                  });
                } else if (isImplements) {
                  enrichment.implementsEdges.push({
                    sourceId: classGraphNode.id,
                    targetId: targetNode.id,
                  });
                }
              }
            }
          }
        }
      }
    }

    // --- Type references ---
    if (ts.isTypeReferenceNode(node)) {
      const type = checker.getTypeAtLocation(node);
      const sym = type.getSymbol() ?? type.aliasSymbol;
      if (sym) {
        const targetQn = tsSymbolToQualifiedName(sym, checker, sourceFile);
        const targetNode = targetQn ? qnMap.get(targetQn) : null;

        // Find enclosing declaration as source
        let sourceGraphNode: SymbolNode | undefined;
        let current: ts.Node | undefined = node.parent;
        while (current && !sourceGraphNode) {
          if (ts.isFunctionDeclaration(current) && current.name) {
            sourceGraphNode = qnMap.get(qualifiedName(modName, current.name.text));
          } else if (ts.isMethodDeclaration(current) && current.name) {
            const cn = getEnclosingClassName(current);
            if (cn) {
              sourceGraphNode = qnMap.get(
                qualifiedName(modName, `${cn}.${current.name.getText()}`),
              );
            }
          } else if (ts.isClassDeclaration(current) && current.name) {
            sourceGraphNode = qnMap.get(qualifiedName(modName, current.name.text));
          } else if (ts.isInterfaceDeclaration(current) && current.name) {
            sourceGraphNode = qnMap.get(qualifiedName(modName, current.name.text));
          } else if (ts.isTypeAliasDeclaration(current) && current.name) {
            sourceGraphNode = qnMap.get(qualifiedName(modName, current.name.text));
          } else if (
            ts.isVariableDeclaration(current) &&
            ts.isIdentifier(current.name)
          ) {
            sourceGraphNode = qnMap.get(qualifiedName(modName, current.name.text));
          }
          current = current.parent;
        }

        if (sourceGraphNode && targetNode && sourceGraphNode.id !== targetNode.id) {
          enrichment.typeRefEdges.push({
            sourceId: sourceGraphNode.id,
            targetId: targetNode.id,
          });
        }
      }
    }

    ts.forEachChild(node, (child) =>
      this.visitNode(child, sourceFile, modName, qnMap, checker, enrichment),
    );
  }
}
