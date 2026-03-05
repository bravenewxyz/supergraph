# @devtools/graph

Semantic code graph engine for TypeScript. Parses source files into a directed multigraph of symbols (functions, classes, interfaces, types, variables) connected by typed edges (imports, calls, extends, contains), then provides querying, mutation, projection, and multi-agent coordination on top.

## Quick start

```ts
import { GraphStore, parseTypeScript } from "@devtools/graph";

const code = `
export function greet(name: string): string {
  return "hello " + name;
}
`;

const { nodes, edges } = parseTypeScript(code, "src/greet.ts");

const store = new GraphStore();
for (const node of nodes) store.addSymbol(node);
for (const edge of edges) store.addEdge(edge);

const fn = store.getSymbolByQualifiedName("src/greet.greet");
console.log(fn?.signature); // "function greet(name: string): string"
```

## CLI

The `map` command analyzes any TypeScript package and outputs either structured JSON or compact LLM-friendly text:

```bash
# JSON manifest (default) — every symbol, edge, dependency, directory
bun packages/graph/src/cli/map.ts packages/orchestrator/src --out manifest.json

# Compact text for LLM context — ~10x smaller than JSON, zero information loss
bun packages/graph/src/cli/map.ts packages/orchestrator/src --format text

# Text with code comments (JSDoc, section headers, architectural notes)
bun packages/graph/src/cli/map.ts packages/orchestrator/src --format text --comments

# From within the graph package
bun run map -- ../../packages/orchestrator/src --format text --out /tmp/map.txt

# Pipe to stdout (no --out)
bun packages/graph/src/cli/map.ts packages/core/src --format text
```

**Options:**

| Flag | Description |
|---|---|
| `--format json` | (default) Full JSON manifest with all metadata |
| `--format text` | Compact text notation optimized for LLM context windows |
| `--comments` | Include extracted code comments in text output |
| `--out <file>` | Write to file instead of stdout |

**Text format notation:**

| Symbol | Meaning |
|---|---|
| `+` / ` ` | Exported / unexported |
| `fn` | Function |
| `const` / `let` | Variable |
| `L42-55` | Source line range |
| `←` | Internal imports |
| `←ext` | External imports |
| `━━━ module.ts ━━━` | Module separator |
| `// ...` | Code comment (with `--comments`) |

Interface, type alias, and enum bodies are shown inline with full field definitions. The text output preserves all symbols (exported and unexported), all dependencies, and all type definitions.

## Architecture

```
src/
├── schema/          Node, edge, operation, and contract type definitions
├── store/           GraphStore, SymbolRegistry, DependencyIndex
├── parser/          AST parsing (structural, semantic, incremental, comment extraction)
├── projector/       Code generation from graph back to TypeScript
├── operations/      Operation log, commutativity checks, merge engine, rollback
├── coordination/    Lock tables, contract layer, scope graphs, tier classification
└── cli/             Command-line tools (map)
```

### Schema

Type definitions for the graph's data model.

**`SymbolNode`** — a node in the graph representing a code symbol:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique UUID |
| `kind` | `SymbolKind` | `module`, `function`, `method`, `class`, `interface`, `type-alias`, `enum`, `enum-member`, `variable`, `parameter`, `property`, `test`, `namespace` |
| `name` | `string` | Simple name |
| `qualifiedName` | `string` | Fully qualified (e.g. `src/utils.greet`) |
| `parentId` | `string \| null` | Parent symbol (module, class) |
| `signature` | `string` | Public-facing signature |
| `typeText` | `string` | Return/value type |
| `exported` | `boolean` | Whether the symbol is exported |
| `body` | `string` | Implementation source |
| `modifiers` | `string[]` | `async`, `static`, `readonly`, `abstract`, etc. |
| `sourceRange` | `{ startLine, endLine } \| null` | Line range in source file |
| `version` | `number` | Incremented on mutation |

**`SymbolEdge`** — a directed relationship between two symbols:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique UUID |
| `kind` | `EdgeKind` | `contains`, `calls`, `imports`, `extends`, `implements`, `references`, `tests`, `depends-on` |
| `sourceId` | `string` | Source node ID |
| `targetId` | `string` | Target node ID |
| `metadata` | `Record<string, unknown>` | Edge-specific data (e.g. `moduleSpecifier`, `unresolved`) |

**`GraphOperation`** — a discrete mutation to the graph: `AddSymbol`, `RemoveSymbol`, `ModifyBody`, `ModifySignature`, `RenameSymbol`, `MoveSymbol`, `AddEdge`, `RemoveEdge`, `SetExported`, `AddModifier`, `RemoveModifier`.

**`Contract`** — the public-facing signature of a symbol, used by the coordination layer to detect breaking changes.

### Store

**`GraphStore`** wraps a [graphology](https://graphology.github.io/) directed multigraph with symbol-aware indexing.

```ts
const store = new GraphStore();

// Symbols
store.addSymbol(node);
store.getSymbol(id);
store.getSymbolByQualifiedName("src/utils.format");
store.getChildSymbols(parentId);
store.getAllSymbols();

// Edges
store.addEdge(edge);
store.getEdgesFrom(symbolId);
store.getEdgesTo(symbolId);
store.getEdgesByKind(symbolId, "calls");

// Dependency queries
store.getDependencies(symbolId);    // what this symbol depends on
store.getDependents(symbolId);      // what depends on this symbol
store.getTransitiveDependencies(symbolId);

// Mutations
store.applyOperation({ type: "ModifyBody", symbolId, newBody: "return 42;" });
store.applyOperation({ type: "RenameSymbol", symbolId, newName: "newName" });

// Serialization
const json = store.exportJSON();
store.importJSON(json);
```

**`SymbolRegistry`** provides qualified-name lookups and parent-child indexing. **`DependencyIndex`** maintains reverse-edge indexes for fast dependent queries.

### Parser

Four parsing strategies, each with different speed/richness tradeoffs:

**`parseTypeScript(code, filePath)`** — structural parser using `@ast-grep/napi`. Fast. Extracts functions, classes, interfaces, type aliases, enums, variables, imports, exports, heritage clauses, and source ranges. Returns `{ nodes, edges }`.

**`SemanticParser`** — uses the TypeScript compiler API for type-resolved analysis. Slower but produces resolved types, call edges, and type reference edges. Use after structural parsing to enrich an existing graph.

**`IncrementalParser`** — tracks file changes and re-parses only affected modules, returning the set of affected symbols and edges.

**`extractComments(code, filePath)`** — extracts meaningful comments from TypeScript source. Uses `@ast-grep/napi` to find comment nodes, classifies them as `jsdoc`, `section`, `line`, or `block`, filters out trivial/boilerplate comments, and attaches each to its next sibling declaration via line proximity.

```ts
// Structural (fast)
const result = parseTypeScript(code, "src/file.ts");

// Comments
const comments = extractComments(code, "src/file.ts");
// comments: ExtractedComment[] — { text, kind, line, endLine, attachedToLine }

// Semantic (type-aware)
const semantic = new SemanticParser({ tsConfigPath: "./tsconfig.json" });
semantic.initialize(["src/file.ts"]);
const enrichment = semantic.enrichGraph(store, ["src/file.ts"]);

// Incremental (on file change)
const incremental = new IncrementalParser(store);
incremental.buildDependencyMap();
const delta = await incremental.update(
  { modified: ["src/file.ts"], added: [], removed: [] },
  async (path) => parseTypeScript(await readFile(path, "utf-8"), path),
);
```

### Projector

Converts the graph back into TypeScript source files.

```ts
import { projectModule, projectGraph } from "@devtools/graph";

// Single module
const code = projectModule(moduleNode, store);

// Entire graph
const projection = projectGraph(store);
// projection.files: Map<filePath, code>
```

Also exports `formatTypeScript` (dprint formatter), `qualifiedNameToFilePath`, `filePathToModuleName`, and `generateImports`.

### Operations

Append-only operation log with conflict detection and rollback.

```ts
import { OperationLog, MergeEngine, computeInverse, rollbackAgent } from "@devtools/graph";

const log = new OperationLog();
log.append(entry);

// Check if two operations can be reordered safely
const result = checkCommutativity(opA, opB);

// Merge concurrent operation streams
const engine = new MergeEngine(store, log);
const mergeResult = engine.compose(branchA, branchB);

// Rollback all operations from a specific agent
const inverse = computeInverse(operation, store);
rollbackAgent(agentId, log, store);
```

### Coordination

Multi-agent coordination primitives for concurrent graph access.

**`SymbolLockTable`** — pessimistic locking of symbols during modification. **`ContractLayer`** — validates that an agent's changes don't break the public contract of symbols it doesn't own. **`ScopeGraph`** — tracks which agents have read/write access to which symbols and detects conflicts. **`classifyOperation`** — assigns a coordination tier (local, advisory, coordinated, exclusive) to determine the level of synchronization needed.

## Dependencies

- [`graphology`](https://graphology.github.io/) — directed multigraph data structure
- [`@ast-grep/napi`](https://ast-grep.github.io/) — fast AST parsing via tree-sitter
- [`dprint-node`](https://dprint.dev/) — TypeScript code formatting
- [`typescript`](https://www.typescriptlang.org/) — compiler API for semantic analysis
