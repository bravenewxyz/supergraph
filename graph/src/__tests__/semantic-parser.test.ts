import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SemanticParser } from "../parser/ts-semantic.js";
import { IncrementalParser } from "../parser/incremental.js";
import { parseTypeScript } from "../parser/ts-structural.js";
import { GraphStore } from "../store/graph-store.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

let testDir: string;
let testId = 0;

function createTestDir(): string {
  testId++;
  const dir = join(tmpdir(), `semantic-parser-test-${Date.now()}-${testId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTestFile(dir: string, name: string, content: string): string {
  const filePath = join(dir, name);
  const dirName = filePath.substring(0, filePath.lastIndexOf("/"));
  mkdirSync(dirName, { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function findNode(
  nodes: SymbolNode[],
  predicate: (n: SymbolNode) => boolean,
): SymbolNode | undefined {
  return nodes.find(predicate);
}

/**
 * Populate a GraphStore from structural parse results for the given files.
 * Returns any edges that could not be added (unresolved targets).
 */
function populateGraph(
  graphStore: GraphStore,
  files: Map<string, string>,
): SymbolEdge[] {
  const unresolvedEdges: SymbolEdge[] = [];
  for (const [filePath, code] of files) {
    const result = parseTypeScript(code, filePath);
    for (const node of result.nodes) {
      graphStore.addSymbol(node);
    }
    for (const edge of result.edges) {
      // Only add edges whose endpoints exist
      try {
        graphStore.addEdge(edge);
      } catch {
        // Collect unresolved edges (symbolic targets like "./b.js" or "Serializable")
        unresolvedEdges.push(edge);
      }
    }
  }
  return unresolvedEdges;
}

// ---------------------------------------------------------------------------
// SemanticParser tests
// ---------------------------------------------------------------------------

describe("SemanticParser", () => {
  describe("initialize", () => {
    it("should create a program from file paths", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "simple.ts", `export function hello(): string { return "hi"; }`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);

      // Should not throw and should be able to query
      const type = parser.getResolvedType(filePath, "hello");
      expect(type).toBe("string");

      rmSync(dir, { recursive: true, force: true });
    });

    it("should throw when enrichGraph called before initialize", () => {
      const parser = new SemanticParser();
      const store = new GraphStore();
      expect(() => parser.enrichGraph(store, [])).toThrow("not initialized");
    });
  });

  describe("getResolvedType", () => {
    it("should resolve explicit return type of a function", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "typed.ts", `
export function greet(name: string): string {
  return "hello " + name;
}
`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      expect(parser.getResolvedType(filePath, "greet")).toBe("string");

      rmSync(dir, { recursive: true, force: true });
    });

    it("should resolve inferred return type", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "inferred.ts", `
export function getNumber() {
  return 42;
}
`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      expect(parser.getResolvedType(filePath, "getNumber")).toBe("number");

      rmSync(dir, { recursive: true, force: true });
    });

    it("should resolve generic return type", () => {
      const dir = createTestDir();
      const basePath = writeTestFile(dir, "base.ts", `
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
`);
      const implPath = writeTestFile(dir, "impl.ts", `
import { Result } from "./base.js";
export function createSuccess(value: string): Result<string> {
  return { ok: true, value };
}
`);

      const parser = new SemanticParser();
      parser.initialize([basePath, implPath]);
      const type = parser.getResolvedType(implPath, "createSuccess");
      // Should resolve to the Result<string> union
      expect(type).toBeDefined();
      expect(type).not.toBeNull();
      // The exact string depends on TS version, but it should contain the structure
      expect(type!.length).toBeGreaterThan(0);

      rmSync(dir, { recursive: true, force: true });
    });

    it("should resolve variable types", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "vars.ts", `
export const count = 42;
export const name: string = "hello";
`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      expect(parser.getResolvedType(filePath, "count")).toBe("42");
      expect(parser.getResolvedType(filePath, "name")).toBe("string");

      rmSync(dir, { recursive: true, force: true });
    });

    it("should return null for unknown symbols", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "empty.ts", `export const x = 1;`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      expect(parser.getResolvedType(filePath, "nonexistent")).toBeNull();

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("getCallsFrom", () => {
    it("should detect direct function calls", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "calls.ts", `
function helper(): number { return 1; }
function doWork(): void { helper(); }
`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const calls = parser.getCallsFrom(filePath, "doWork");
      // Should find the call to helper
      const hasHelper = calls.some((c) => c.includes("helper"));
      expect(hasHelper).toBe(true);

      rmSync(dir, { recursive: true, force: true });
    });

    it("should detect cross-file function calls", () => {
      const dir = createTestDir();
      const utilPath = writeTestFile(dir, "util.ts", `
export function format(s: string): string { return s.trim(); }
`);
      const mainPath = writeTestFile(dir, "main.ts", `
import { format } from "./util.js";
export function run(): string { return format("  hello  "); }
`);

      const parser = new SemanticParser();
      parser.initialize([utilPath, mainPath]);
      const calls = parser.getCallsFrom(mainPath, "run");
      const hasFormat = calls.some((c) => c.includes("format"));
      expect(hasFormat).toBe(true);

      rmSync(dir, { recursive: true, force: true });
    });

    it("should return empty array for function with no calls", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "nocalls.ts", `
export function noop(): void {}
`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const calls = parser.getCallsFrom(filePath, "noop");
      expect(calls).toEqual([]);

      rmSync(dir, { recursive: true, force: true });
    });

    it("should return empty array for nonexistent function", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "empty2.ts", `export const x = 1;`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const calls = parser.getCallsFrom(filePath, "missing");
      expect(calls).toEqual([]);

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("getExtendsChain", () => {
    it("should detect single-level extends", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "hierarchy.ts", `
class Base {
  baseMethod(): void {}
}
class Child extends Base {
  childMethod(): void {}
}
`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const chain = parser.getExtendsChain(filePath, "Child");
      expect(chain).toContain("Base");

      rmSync(dir, { recursive: true, force: true });
    });

    it("should detect multi-level extends chain", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "deep.ts", `
class A { a(): void {} }
class B extends A { b(): void {} }
class C extends B { c(): void {} }
`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const chain = parser.getExtendsChain(filePath, "C");
      expect(chain).toContain("B");
      expect(chain).toContain("A");
      expect(chain.indexOf("B")).toBeLessThan(chain.indexOf("A"));

      rmSync(dir, { recursive: true, force: true });
    });

    it("should return empty for class with no extends", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "noext.ts", `
class Standalone { method(): void {} }
`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const chain = parser.getExtendsChain(filePath, "Standalone");
      expect(chain).toEqual([]);

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("getImplements", () => {
    it("should detect implemented interfaces", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "impl.ts", `
interface Serializable { serialize(): string; }
interface Loggable { log(): void; }
class User implements Serializable, Loggable {
  serialize(): string { return "{}"; }
  log(): void {}
}
`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const impls = parser.getImplements(filePath, "User");
      expect(impls).toContain("Serializable");
      expect(impls).toContain("Loggable");

      rmSync(dir, { recursive: true, force: true });
    });

    it("should detect cross-file implements", () => {
      const dir = createTestDir();
      const ifacePath = writeTestFile(dir, "iface.ts", `
export interface Serializable { serialize(): string; }
`);
      const implPath = writeTestFile(dir, "user.ts", `
import { Serializable } from "./iface.js";
export class User implements Serializable {
  serialize(): string { return "user"; }
}
`);

      const parser = new SemanticParser();
      parser.initialize([ifacePath, implPath]);
      const impls = parser.getImplements(implPath, "User");
      expect(impls).toContain("Serializable");

      rmSync(dir, { recursive: true, force: true });
    });

    it("should return empty for class with no implements", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "noimpl.ts", `
class Plain { method(): void {} }
`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const impls = parser.getImplements(filePath, "Plain");
      expect(impls).toEqual([]);

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("resolveImportPath", () => {
    it("should resolve relative import to actual file", () => {
      const dir = createTestDir();
      const utilPath = writeTestFile(dir, "util.ts", `export function helper() {}`);
      const mainPath = writeTestFile(dir, "main.ts", `import { helper } from "./util.js";`);

      const parser = new SemanticParser();
      parser.initialize([utilPath, mainPath]);

      const resolved = parser.resolveImportPath("./util.js", mainPath);
      // Should resolve to the actual util.ts file
      expect(resolved).not.toBeNull();
      expect(resolved!).toContain("util.ts");

      rmSync(dir, { recursive: true, force: true });
    });

    it("should return null for unresolvable paths", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "test.ts", `export const x = 1;`);

      const parser = new SemanticParser();
      parser.initialize([filePath]);

      const resolved = parser.resolveImportPath("./nonexistent.js", filePath);
      expect(resolved).toBeNull();

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("enrichGraph", () => {
    it("should enrich graph with resolved types", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "enriched.ts", `
export function add(a: number, b: number): number {
  return a + b;
}
export function inferred() {
  return "hello";
}
`);

      // Build structural graph
      const code = readFileSync(filePath, "utf-8");
      const graphStore = new GraphStore();
      const parseResult = parseTypeScript(code, filePath);
      for (const node of parseResult.nodes) {
        graphStore.addSymbol(node);
      }
      for (const edge of parseResult.edges) {
        try { graphStore.addEdge(edge); } catch {}
      }

      // Semantic enrichment
      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const enrichment = parser.enrichGraph(graphStore, [filePath]);

      // Should have resolved types for the functions
      expect(enrichment.resolvedTypes.size).toBeGreaterThan(0);

      // Find the "add" function node and check its resolved type
      const addNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "function" && n.name === "add",
      );
      if (addNode) {
        expect(enrichment.resolvedTypes.get(addNode.id)).toBe("number");
      }

      rmSync(dir, { recursive: true, force: true });
    });

    it("should detect call edges between functions", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "callgraph.ts", `
function helper(): number { return 42; }
function main(): void {
  const x = helper();
}
`);

      const code = readFileSync(filePath, "utf-8");
      const graphStore = new GraphStore();
      const parseResult = parseTypeScript(code, filePath);
      for (const node of parseResult.nodes) {
        graphStore.addSymbol(node);
      }
      for (const edge of parseResult.edges) {
        try { graphStore.addEdge(edge); } catch {}
      }

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const enrichment = parser.enrichGraph(graphStore, [filePath]);

      // Should find a call edge from main -> helper
      const mainNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "function" && n.name === "main",
      );
      const helperNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "function" && n.name === "helper",
      );

      expect(mainNode).toBeDefined();
      expect(helperNode).toBeDefined();

      const callEdge = enrichment.callEdges.find(
        (e) => e.sourceId === mainNode!.id && e.targetId === helperNode!.id,
      );
      expect(callEdge).toBeDefined();

      rmSync(dir, { recursive: true, force: true });
    });

    it("should detect extends and implements edges", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "heritage.ts", `
interface Serializable {
  serialize(): string;
}
class Base {
  id: number = 0;
}
class User extends Base implements Serializable {
  name: string = "";
  serialize(): string { return this.name; }
}
`);

      const code = readFileSync(filePath, "utf-8");
      const graphStore = new GraphStore();
      const parseResult = parseTypeScript(code, filePath);
      for (const node of parseResult.nodes) {
        graphStore.addSymbol(node);
      }
      for (const edge of parseResult.edges) {
        try { graphStore.addEdge(edge); } catch {}
      }

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const enrichment = parser.enrichGraph(graphStore, [filePath]);

      const userNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "class" && n.name === "User",
      );
      const baseNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "class" && n.name === "Base",
      );
      const serializableNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "interface" && n.name === "Serializable",
      );

      expect(userNode).toBeDefined();
      expect(baseNode).toBeDefined();
      expect(serializableNode).toBeDefined();

      // Extends edge: User -> Base
      const extendsEdge = enrichment.extendsEdges.find(
        (e) => e.sourceId === userNode!.id && e.targetId === baseNode!.id,
      );
      expect(extendsEdge).toBeDefined();

      // Implements edge: User -> Serializable
      const implEdge = enrichment.implementsEdges.find(
        (e) => e.sourceId === userNode!.id && e.targetId === serializableNode!.id,
      );
      expect(implEdge).toBeDefined();

      rmSync(dir, { recursive: true, force: true });
    });

    it("should detect type reference edges", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "typerefs.ts", `
interface Config {
  port: number;
}
function createConfig(): Config {
  return { port: 3000 };
}
`);

      const code = readFileSync(filePath, "utf-8");
      const graphStore = new GraphStore();
      const parseResult = parseTypeScript(code, filePath);
      for (const node of parseResult.nodes) {
        graphStore.addSymbol(node);
      }
      for (const edge of parseResult.edges) {
        try { graphStore.addEdge(edge); } catch {}
      }

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const enrichment = parser.enrichGraph(graphStore, [filePath]);

      const configNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "interface" && n.name === "Config",
      );
      const createConfigNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "function" && n.name === "createConfig",
      );

      expect(configNode).toBeDefined();
      expect(createConfigNode).toBeDefined();

      // Should have a type reference from createConfig -> Config
      const typeRef = enrichment.typeRefEdges.find(
        (e) => e.sourceId === createConfigNode!.id && e.targetId === configNode!.id,
      );
      expect(typeRef).toBeDefined();

      rmSync(dir, { recursive: true, force: true });
    });

    it("should handle the full example scenario: base + impl + consumer", () => {
      const dir = createTestDir();
      const basePath = writeTestFile(dir, "base.ts", `
export interface Serializable { serialize(): string; }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
`);
      const implPath = writeTestFile(dir, "impl.ts", `
import { Serializable, Result } from "./base.js";
export class User implements Serializable {
  constructor(public name: string) {}
  serialize(): string { return JSON.stringify({ name: this.name }); }
}
export function createUser(name: string): Result<User> {
  return { ok: true, value: new User(name) };
}
`);
      const consumerPath = writeTestFile(dir, "consumer.ts", `
import { createUser } from "./impl.js";
export function main() {
  const result = createUser("Alice");
  if (result.ok) console.log(result.value.serialize());
}
`);

      // Build structural graph for all three files
      const graphStore = new GraphStore();
      const files = new Map<string, string>();

      for (const fp of [basePath, implPath, consumerPath]) {
        const code = readFileSync(fp, "utf-8");
        files.set(fp, code);
      }
      populateGraph(graphStore, files);

      // Semantic enrichment
      const parser = new SemanticParser();
      parser.initialize([basePath, implPath, consumerPath]);
      const enrichment = parser.enrichGraph(graphStore, [basePath, implPath, consumerPath]);

      // 1. User implements Serializable
      const userNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "class" && n.name === "User",
      );
      const serializableNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "interface" && n.name === "Serializable",
      );
      expect(userNode).toBeDefined();
      expect(serializableNode).toBeDefined();

      const implEdge = enrichment.implementsEdges.find(
        (e) => e.sourceId === userNode!.id && e.targetId === serializableNode!.id,
      );
      expect(implEdge).toBeDefined();

      // 2. createUser should have a resolved type that includes Result
      const createUserNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "function" && n.name === "createUser",
      );
      expect(createUserNode).toBeDefined();
      const resolvedType = enrichment.resolvedTypes.get(createUserNode!.id);
      expect(resolvedType).toBeDefined();

      // 3. main calls createUser
      const mainNode = graphStore.getAllSymbols().find(
        (n) => n.kind === "function" && n.name === "main",
      );
      expect(mainNode).toBeDefined();

      const mainCallsCreateUser = enrichment.callEdges.find(
        (e) => e.sourceId === mainNode!.id && e.targetId === createUserNode!.id,
      );
      expect(mainCallsCreateUser).toBeDefined();

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("method types within classes", () => {
    it("should resolve method return types", () => {
      const dir = createTestDir();
      const filePath = writeTestFile(dir, "methods.ts", `
class Calculator {
  add(a: number, b: number): number { return a + b; }
  greet() { return "hello"; }
}
`);

      const code = readFileSync(filePath, "utf-8");
      const graphStore = new GraphStore();
      const parseResult = parseTypeScript(code, filePath);
      for (const node of parseResult.nodes) {
        graphStore.addSymbol(node);
      }
      for (const edge of parseResult.edges) {
        try { graphStore.addEdge(edge); } catch {}
      }

      const parser = new SemanticParser();
      parser.initialize([filePath]);
      const enrichment = parser.enrichGraph(graphStore, [filePath]);

      const addMethod = graphStore.getAllSymbols().find(
        (n) => n.kind === "method" && n.name === "add",
      );
      if (addMethod) {
        expect(enrichment.resolvedTypes.get(addMethod.id)).toBe("number");
      }

      const greetMethod = graphStore.getAllSymbols().find(
        (n) => n.kind === "method" && n.name === "greet",
      );
      if (greetMethod) {
        expect(enrichment.resolvedTypes.get(greetMethod.id)).toBe("string");
      }

      rmSync(dir, { recursive: true, force: true });
    });
  });
});

// ---------------------------------------------------------------------------
// IncrementalParser tests
// ---------------------------------------------------------------------------

describe("IncrementalParser", () => {
  describe("buildDependencyMap", () => {
    it("should build a dependency map from import edges in the graph", () => {
      const graphStore = new GraphStore();

      // Simulate two modules: a.ts imports from b.ts
      const files = new Map<string, string>();
      files.set("src/b.ts", `export function helper(): number { return 1; }`);
      files.set(
        "src/a.ts",
        `import { helper } from "./b.js";\nexport function main() { return helper(); }`,
      );
      const unresolvedEdges = populateGraph(graphStore, files);

      const incremental = new IncrementalParser(graphStore);
      incremental.buildDependencyMap(unresolvedEdges);

      // Changing b should affect a (since a imports b)
      const affected = incremental.getAffectedModules({
        modified: ["src/b.ts"],
        added: [],
        removed: [],
      });

      // Should include both src/b (directly changed) and src/a (depends on b)
      expect(affected).toContain("src/b");
      expect(affected).toContain("src/a");
    });

    it("should handle modules with no imports", () => {
      const graphStore = new GraphStore();
      const files = new Map<string, string>();
      files.set("src/standalone.ts", `export const VALUE = 42;`);
      const unresolvedEdges = populateGraph(graphStore, files);

      const incremental = new IncrementalParser(graphStore);
      incremental.buildDependencyMap(unresolvedEdges);

      const affected = incremental.getAffectedModules({
        modified: ["src/standalone.ts"],
        added: [],
        removed: [],
      });

      expect(affected).toContain("src/standalone");
      expect(affected.length).toBe(1);
    });
  });

  describe("getAffectedModules", () => {
    it("should include transitive dependents", () => {
      const graphStore = new GraphStore();

      // c imports b, b imports a
      const files = new Map<string, string>();
      files.set("src/a.ts", `export const BASE = 1;`);
      files.set("src/b.ts", `import { BASE } from "./a.js";\nexport const MID = BASE + 1;`);
      files.set("src/c.ts", `import { MID } from "./b.js";\nexport const TOP = MID + 1;`);
      const unresolvedEdges = populateGraph(graphStore, files);

      const incremental = new IncrementalParser(graphStore);
      incremental.buildDependencyMap(unresolvedEdges);

      // Changing a should affect a, b, and c (transitively)
      const affected = incremental.getAffectedModules({
        modified: ["src/a.ts"],
        added: [],
        removed: [],
      });

      expect(affected).toContain("src/a");
      expect(affected).toContain("src/b");
      expect(affected).toContain("src/c");
    });

    it("should handle added files", () => {
      const graphStore = new GraphStore();
      const files = new Map<string, string>();
      files.set("src/existing.ts", `export const X = 1;`);
      const unresolvedEdges = populateGraph(graphStore, files);

      const incremental = new IncrementalParser(graphStore);
      incremental.buildDependencyMap(unresolvedEdges);

      const affected = incremental.getAffectedModules({
        modified: [],
        added: ["src/new.ts"],
        removed: [],
      });

      expect(affected).toContain("src/new");
    });

    it("should handle removed files", () => {
      const graphStore = new GraphStore();
      const files = new Map<string, string>();
      files.set("src/toremove.ts", `export const Y = 2;`);
      const unresolvedEdges = populateGraph(graphStore, files);

      const incremental = new IncrementalParser(graphStore);
      incremental.buildDependencyMap(unresolvedEdges);

      const affected = incremental.getAffectedModules({
        modified: [],
        added: [],
        removed: ["src/toremove.ts"],
      });

      expect(affected).toContain("src/toremove");
    });
  });

  describe("update", () => {
    it("should add symbols from a new file", async () => {
      const graphStore = new GraphStore();
      const files = new Map<string, string>();
      files.set("src/existing.ts", `export const X = 1;`);
      const unresolvedEdges = populateGraph(graphStore, files);

      const incremental = new IncrementalParser(graphStore);
      incremental.buildDependencyMap(unresolvedEdges);

      const nodesBefore = graphStore.nodeCount;

      const result = await incremental.update(
        { modified: [], added: ["src/new.ts"], removed: [] },
        async (filePath: string) => {
          return parseTypeScript(`export function newFunc(): void {}`, filePath);
        },
      );

      expect(result.affectedModules).toContain("src/new");
      expect(result.affectedSymbols.length).toBeGreaterThan(0);
      expect(graphStore.nodeCount).toBeGreaterThan(nodesBefore);

      // The new function should be in the graph
      const newFunc = graphStore.getAllSymbols().find(
        (n) => n.kind === "function" && n.name === "newFunc",
      );
      expect(newFunc).toBeDefined();
    });

    it("should remove symbols when a file is deleted", async () => {
      const graphStore = new GraphStore();
      const files = new Map<string, string>();
      files.set("src/toremove.ts", `export function removeMe(): void {}`);
      const unresolvedEdges = populateGraph(graphStore, files);

      const incremental = new IncrementalParser(graphStore);
      incremental.buildDependencyMap(unresolvedEdges);

      // Verify function exists before
      const beforeRemove = graphStore.getAllSymbols().find(
        (n) => n.kind === "function" && n.name === "removeMe",
      );
      expect(beforeRemove).toBeDefined();

      const result = await incremental.update(
        { modified: [], added: [], removed: ["src/toremove.ts"] },
        async () => ({ nodes: [], edges: [] }),
      );

      expect(result.affectedSymbols.length).toBeGreaterThan(0);

      // The function should be gone
      const afterRemove = graphStore.getAllSymbols().find(
        (n) => n.kind === "function" && n.name === "removeMe",
      );
      expect(afterRemove).toBeUndefined();
    });

    it("should update symbols when a file is modified", async () => {
      const graphStore = new GraphStore();
      const files = new Map<string, string>();
      files.set("src/mod.ts", `export function greet(): string { return "hello"; }`);
      const unresolvedEdges = populateGraph(graphStore, files);

      const incremental = new IncrementalParser(graphStore);
      incremental.buildDependencyMap(unresolvedEdges);

      // Modify the file: change the function body
      const result = await incremental.update(
        { modified: ["src/mod.ts"], added: [], removed: [] },
        async (filePath: string) => {
          return parseTypeScript(
            `export function greet(): string { return "goodbye"; }\nexport function newHelper(): void {}`,
            filePath,
          );
        },
      );

      expect(result.affectedModules).toContain("src/mod");
      expect(result.affectedSymbols.length).toBeGreaterThan(0);

      // newHelper should now exist
      const newHelper = graphStore.getAllSymbols().find(
        (n) => n.kind === "function" && n.name === "newHelper",
      );
      expect(newHelper).toBeDefined();
    });

    it("should track edge changes accurately", async () => {
      const graphStore = new GraphStore();
      const files = new Map<string, string>();
      files.set("src/edgetest.ts", `export function a(): void {}\nexport function b(): void {}`);
      const unresolvedEdges = populateGraph(graphStore, files);

      const incremental = new IncrementalParser(graphStore);
      incremental.buildDependencyMap(unresolvedEdges);

      const result = await incremental.update(
        { modified: ["src/edgetest.ts"], added: [], removed: [] },
        async (filePath: string) => {
          // Same file, same content -- edges should be re-added
          return parseTypeScript(
            `export function a(): void {}\nexport function b(): void {}\nexport function c(): void {}`,
            filePath,
          );
        },
      );

      // New edges (contains edges for the new function)
      expect(result.newEdges).toBeGreaterThan(0);
    });
  });
});
