import { describe, test, expect } from "bun:test";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge, EdgeKind } from "../schema/edges.js";
import { createSymbolNode } from "../schema/nodes.js";
import { createSymbolEdge } from "../schema/edges.js";
import type { GraphReader } from "../projector/file-projector.js";
import { projectModule, projectGraph } from "../projector/file-projector.js";
import { formatTypeScript } from "../projector/formatter.js";
import { qualifiedNameToFilePath, filePathToModuleName } from "../projector/module-layout.js";
import { generateImports } from "../projector/import-generator.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildGraphReader(
  symbols: SymbolNode[],
  edges: SymbolEdge[],
): GraphReader {
  const symbolMap = new Map(symbols.map((s) => [s.id, s]));

  return {
    getSymbol(id: string) {
      return symbolMap.get(id);
    },
    getChildSymbols(parentId: string) {
      return symbols.filter((s) => s.parentId === parentId);
    },
    getEdgesFrom(symbolId: string) {
      return edges.filter((e) => e.sourceId === symbolId);
    },
    getEdgesTo(symbolId: string) {
      return edges.filter((e) => e.targetId === symbolId);
    },
    getEdgesByKind(symbolId: string, kind: EdgeKind) {
      return edges.filter(
        (e) => e.sourceId === symbolId && e.kind === kind,
      );
    },
    getAllSymbols() {
      return [...symbols];
    },
  };
}

function makeModule(id: string, qualifiedName: string): SymbolNode {
  return createSymbolNode({
    id,
    kind: "module",
    name: qualifiedName.split("/").pop()!,
    qualifiedName,
  });
}

function makeFunction(
  id: string,
  name: string,
  parentId: string,
  opts: Partial<SymbolNode> = {},
): SymbolNode {
  return createSymbolNode({
    id,
    kind: "function",
    name,
    qualifiedName: `${name}`,
    parentId,
    exported: true,
    signature: `${name}()`,
    typeText: "void",
    body: "{}",
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// module-layout tests
// ---------------------------------------------------------------------------

describe("module-layout", () => {
  test("qualifiedNameToFilePath appends .ts", () => {
    expect(qualifiedNameToFilePath("src/auth/middleware")).toBe(
      "src/auth/middleware.ts",
    );
  });

  test("qualifiedNameToFilePath preserves existing extension", () => {
    expect(qualifiedNameToFilePath("src/auth/middleware.ts")).toBe(
      "src/auth/middleware.ts",
    );
    expect(qualifiedNameToFilePath("src/app.tsx")).toBe("src/app.tsx");
  });

  test("filePathToModuleName strips extension", () => {
    expect(filePathToModuleName("src/auth/middleware.ts")).toBe(
      "src/auth/middleware",
    );
    expect(filePathToModuleName("src/app.tsx")).toBe("src/app");
  });

  test("filePathToModuleName returns as-is for no extension", () => {
    expect(filePathToModuleName("src/utils")).toBe("src/utils");
  });
});

// ---------------------------------------------------------------------------
// formatter tests
// ---------------------------------------------------------------------------

describe("formatter", () => {
  test("formats valid TypeScript", () => {
    const result = formatTypeScript(
      'const   x:number=1;export function foo(){return   x;}',
    );
    expect(result).toContain("const x");
    expect(result).toContain("function foo()");
  });

  test("returns unformatted code on malformed input", () => {
    const bad = "function {{{{";
    const result = formatTypeScript(bad);
    // Should return something (either formatted attempt or the original)
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Single function projection
// ---------------------------------------------------------------------------

describe("projectModule", () => {
  test("projects a module with a single function", () => {
    const mod = makeModule("mod1", "src/utils");
    const fn = makeFunction("fn1", "greet", "mod1", {
      signature: "greet(name: string)",
      typeText: "string",
      body: '{ return `Hello ${name}`; }',
    });

    const graph = buildGraphReader([mod, fn], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("export function greet");
    expect(result).toContain("name: string");
    expect(result).toContain("Hello");
  });

  test("projects a module with a class", () => {
    const mod = makeModule("mod1", "src/models");
    const cls = createSymbolNode({
      id: "cls1",
      kind: "class",
      name: "User",
      qualifiedName: "User",
      parentId: "mod1",
      exported: true,
    });
    const prop = createSymbolNode({
      id: "prop1",
      kind: "property",
      name: "name",
      qualifiedName: "User.name",
      parentId: "cls1",
      typeText: "string",
    });
    const method = createSymbolNode({
      id: "meth1",
      kind: "method",
      name: "greet",
      qualifiedName: "User.greet",
      parentId: "cls1",
      signature: "greet()",
      typeText: "string",
      body: '{ return this.name; }',
    });
    const ctor = createSymbolNode({
      id: "ctor1",
      kind: "method",
      name: "constructor",
      qualifiedName: "User.constructor",
      parentId: "cls1",
      signature: "constructor(name: string)",
      body: "{ this.name = name; }",
    });

    const graph = buildGraphReader([mod, cls, prop, method, ctor], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("export class User");
    expect(result).toContain("name: string");
    expect(result).toContain("constructor(name: string)");
    expect(result).toContain("greet()");
  });

  test("projects interfaces and type aliases", () => {
    const mod = makeModule("mod1", "src/types");
    const iface = createSymbolNode({
      id: "if1",
      kind: "interface",
      name: "Config",
      qualifiedName: "Config",
      parentId: "mod1",
      exported: true,
      body: "{\n  port: number;\n  host: string;\n}",
    });
    const alias = createSymbolNode({
      id: "ta1",
      kind: "type-alias",
      name: "ID",
      qualifiedName: "ID",
      parentId: "mod1",
      exported: true,
      typeText: "string | number",
    });

    const graph = buildGraphReader([mod, iface, alias], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("export interface Config");
    expect(result).toContain("port: number");
    expect(result).toContain("export type ID = string | number;");
  });

  test("projects enum with members", () => {
    const mod = makeModule("mod1", "src/enums");
    const enumNode = createSymbolNode({
      id: "en1",
      kind: "enum",
      name: "Color",
      qualifiedName: "Color",
      parentId: "mod1",
      exported: true,
    });
    const red = createSymbolNode({
      id: "em1",
      kind: "enum-member",
      name: "Red",
      qualifiedName: "Color.Red",
      parentId: "en1",
      body: '"red"',
    });
    const green = createSymbolNode({
      id: "em2",
      kind: "enum-member",
      name: "Green",
      qualifiedName: "Color.Green",
      parentId: "en1",
      body: '"green"',
    });

    const graph = buildGraphReader([mod, enumNode, red, green], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("export enum Color");
    expect(result).toContain('Red = "red"');
    expect(result).toContain('Green = "green"');
  });

  test("projects variables", () => {
    const mod = makeModule("mod1", "src/config");
    const variable = createSymbolNode({
      id: "v1",
      kind: "variable",
      name: "MAX_RETRIES",
      qualifiedName: "MAX_RETRIES",
      parentId: "mod1",
      exported: true,
      typeText: "number",
      body: "3",
    });

    const graph = buildGraphReader([mod, variable], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("export const MAX_RETRIES: number = 3;");
  });

  test("handles async modifier on functions", () => {
    const mod = makeModule("mod1", "src/api");
    const fn = makeFunction("fn1", "fetchData", "mod1", {
      modifiers: ["async"],
      signature: "fetchData(url: string)",
      typeText: "Promise<Response>",
      body: "{ return fetch(url); }",
    });

    const graph = buildGraphReader([mod, fn], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("export async function fetchData");
  });

  test("handles static and abstract modifiers on class members", () => {
    const mod = makeModule("mod1", "src/base");
    const cls = createSymbolNode({
      id: "cls1",
      kind: "class",
      name: "Base",
      qualifiedName: "Base",
      parentId: "mod1",
      exported: true,
      modifiers: ["abstract"],
    });
    const staticProp = createSymbolNode({
      id: "sp1",
      kind: "property",
      name: "count",
      qualifiedName: "Base.count",
      parentId: "cls1",
      modifiers: ["static"],
      typeText: "number",
      body: "0",
    });
    const abstractMethod = createSymbolNode({
      id: "am1",
      kind: "method",
      name: "render",
      qualifiedName: "Base.render",
      parentId: "cls1",
      modifiers: ["abstract"],
      signature: "render()",
      typeText: "void",
      body: "{}",
    });

    const graph = buildGraphReader([mod, cls, staticProp, abstractMethod], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("export abstract class Base");
    expect(result).toContain("static count: number = 0;");
    expect(result).toContain("abstract render()");
  });

  test("handles readonly modifier", () => {
    const mod = makeModule("mod1", "src/models");
    const cls = createSymbolNode({
      id: "cls1",
      kind: "class",
      name: "Config",
      qualifiedName: "Config",
      parentId: "mod1",
      exported: true,
    });
    const roProp = createSymbolNode({
      id: "rp1",
      kind: "property",
      name: "version",
      qualifiedName: "Config.version",
      parentId: "cls1",
      modifiers: ["readonly"],
      typeText: "string",
      body: '"1.0.0"',
    });

    const graph = buildGraphReader([mod, cls, roProp], []);
    const result = projectModule(mod, graph);

    expect(result).toContain('readonly version: string = "1.0.0"');
  });

  test("handles decorators", () => {
    const mod = makeModule("mod1", "src/controllers");
    const cls = createSymbolNode({
      id: "cls1",
      kind: "class",
      name: "AppController",
      qualifiedName: "AppController",
      parentId: "mod1",
      exported: true,
      decorators: ["@Controller()"],
    });

    const graph = buildGraphReader([mod, cls], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("@Controller()");
    expect(result).toContain("export class AppController");
  });

  test("handles default export", () => {
    const mod = makeModule("mod1", "src/main");
    const fn = makeFunction("fn1", "main", "mod1", {
      modifiers: ["default"],
      signature: "main()",
      typeText: "void",
      body: '{ console.log("hello"); }',
    });

    const graph = buildGraphReader([mod, fn], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("export default function main");
  });

  test("handles non-exported symbols", () => {
    const mod = makeModule("mod1", "src/internal");
    const fn = makeFunction("fn1", "helper", "mod1", {
      exported: false,
      signature: "helper()",
      typeText: "void",
      body: "{}",
    });

    const graph = buildGraphReader([mod, fn], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("function helper()");
    expect(result).not.toContain("export function helper");
  });

  test("handles class with extends and implements", () => {
    const mod = makeModule("mod1", "src/models");
    const baseClass = createSymbolNode({
      id: "base1",
      kind: "class",
      name: "BaseModel",
      qualifiedName: "BaseModel",
      parentId: "mod1",
      exported: true,
    });
    const iface = createSymbolNode({
      id: "if1",
      kind: "interface",
      name: "Serializable",
      qualifiedName: "Serializable",
      parentId: "mod1",
      exported: true,
      body: "{\n  serialize(): string;\n}",
    });
    const childClass = createSymbolNode({
      id: "cls1",
      kind: "class",
      name: "User",
      qualifiedName: "User",
      parentId: "mod1",
      exported: true,
    });

    const extendsEdge = createSymbolEdge({
      id: "e1",
      kind: "extends",
      sourceId: "cls1",
      targetId: "base1",
    });
    const implEdge = createSymbolEdge({
      id: "e2",
      kind: "implements",
      sourceId: "cls1",
      targetId: "if1",
    });

    const graph = buildGraphReader(
      [mod, baseClass, iface, childClass],
      [extendsEdge, implEdge],
    );
    const result = projectModule(mod, graph);

    expect(result).toContain("class User extends BaseModel implements Serializable");
  });
});

// ---------------------------------------------------------------------------
// Import generation
// ---------------------------------------------------------------------------

describe("import generation", () => {
  test("generates imports from another module", () => {
    const modA = makeModule("modA", "src/handlers");
    const modB = makeModule("modB", "src/utils");

    const fnA = makeFunction("fnA", "handle", "modA");
    const fnB = createSymbolNode({
      id: "fnB",
      kind: "function",
      name: "formatDate",
      qualifiedName: "formatDate",
      parentId: "modB",
      exported: true,
    });

    const importEdge = createSymbolEdge({
      id: "imp1",
      kind: "imports",
      sourceId: "fnA",
      targetId: "fnB",
    });

    const graph = buildGraphReader([modA, modB, fnA, fnB], [importEdge]);

    const imports = generateImports(
      modA,
      [fnA],
      [importEdge],
      (id) => graph.getSymbol(id),
    );

    expect(imports).toContain("import { formatDate }");
    expect(imports).toContain("./utils.js");
  });

  test("generates type-only imports", () => {
    const modA = makeModule("modA", "src/handlers");
    const modB = makeModule("modB", "src/types");

    const fnA = makeFunction("fnA", "handle", "modA");
    const typeB = createSymbolNode({
      id: "typeB",
      kind: "type-alias",
      name: "Config",
      qualifiedName: "Config",
      parentId: "modB",
      exported: true,
    });

    const importEdge = createSymbolEdge({
      id: "imp1",
      kind: "imports",
      sourceId: "fnA",
      targetId: "typeB",
      metadata: { typeOnly: true },
    });

    const graph = buildGraphReader([modA, modB, fnA, typeB], [importEdge]);
    const imports = generateImports(
      modA,
      [fnA],
      [importEdge],
      (id) => graph.getSymbol(id),
    );

    expect(imports).toContain("import type { Config }");
  });

  test("generates default import", () => {
    const modA = makeModule("modA", "src/app");
    const modB = makeModule("modB", "src/router");

    const fnA = makeFunction("fnA", "init", "modA");
    const defaultExport = createSymbolNode({
      id: "defB",
      kind: "function",
      name: "createRouter",
      qualifiedName: "createRouter",
      parentId: "modB",
      exported: true,
    });

    const importEdge = createSymbolEdge({
      id: "imp1",
      kind: "imports",
      sourceId: "fnA",
      targetId: "defB",
      metadata: { isDefault: true },
    });

    const graph = buildGraphReader(
      [modA, modB, fnA, defaultExport],
      [importEdge],
    );
    const imports = generateImports(
      modA,
      [fnA],
      [importEdge],
      (id) => graph.getSymbol(id),
    );

    expect(imports).toContain("import createRouter from");
    expect(imports).toContain("./router.js");
  });

  test("groups multiple imports from same module", () => {
    const modA = makeModule("modA", "src/app");
    const modB = makeModule("modB", "src/utils");

    const fnA = makeFunction("fnA", "init", "modA");
    const fn1 = createSymbolNode({
      id: "u1",
      kind: "function",
      name: "alpha",
      qualifiedName: "alpha",
      parentId: "modB",
      exported: true,
    });
    const fn2 = createSymbolNode({
      id: "u2",
      kind: "function",
      name: "beta",
      qualifiedName: "beta",
      parentId: "modB",
      exported: true,
    });

    const edge1 = createSymbolEdge({
      id: "e1",
      kind: "imports",
      sourceId: "fnA",
      targetId: "u1",
    });
    const edge2 = createSymbolEdge({
      id: "e2",
      kind: "imports",
      sourceId: "fnA",
      targetId: "u2",
    });

    const graph = buildGraphReader(
      [modA, modB, fnA, fn1, fn2],
      [edge1, edge2],
    );
    const imports = generateImports(
      modA,
      [fnA],
      [edge1, edge2],
      (id) => graph.getSymbol(id),
    );

    expect(imports).toContain("{ alpha, beta }");
    expect(imports.split("\n").length).toBe(1); // one line only
  });
});

// ---------------------------------------------------------------------------
// projectGraph — multiple modules
// ---------------------------------------------------------------------------

describe("projectGraph", () => {
  test("projects multiple modules with import relationships", () => {
    const modA = makeModule("modA", "src/handlers");
    const modB = makeModule("modB", "src/utils");

    const fnA = makeFunction("fnA", "handle", "modA", {
      signature: "handle()",
      typeText: "void",
      body: "{ format(); }",
    });
    const fnB = createSymbolNode({
      id: "fnB",
      kind: "function",
      name: "format",
      qualifiedName: "format",
      parentId: "modB",
      exported: true,
      signature: "format()",
      typeText: "string",
      body: '{ return "formatted"; }',
    });

    const importEdge = createSymbolEdge({
      id: "imp1",
      kind: "imports",
      sourceId: "fnA",
      targetId: "fnB",
    });

    const graph = buildGraphReader(
      [modA, modB, fnA, fnB],
      [importEdge],
    );
    const result = projectGraph(graph);

    expect(result.files.size).toBe(2);
    expect(result.files.has("src/handlers.ts")).toBe(true);
    expect(result.files.has("src/utils.ts")).toBe(true);

    const handlersContent = result.files.get("src/handlers.ts")!;
    expect(handlersContent).toContain("import { format }");
    expect(handlersContent).toContain("function handle");

    const utilsContent = result.files.get("src/utils.ts")!;
    expect(utilsContent).toContain("function format");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("handles empty module", () => {
    const mod = makeModule("mod1", "src/empty");
    const graph = buildGraphReader([mod], []);
    const result = projectModule(mod, graph);
    expect(typeof result).toBe("string");
  });

  test("handles symbol with no body", () => {
    const mod = makeModule("mod1", "src/stubs");
    const fn = makeFunction("fn1", "stub", "mod1", {
      signature: "stub()",
      body: "",
    });

    const graph = buildGraphReader([mod, fn], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("function stub");
  });

  test("handles symbol with no signature", () => {
    const mod = makeModule("mod1", "src/minimal");
    const fn = createSymbolNode({
      id: "fn1",
      kind: "function",
      name: "doStuff",
      qualifiedName: "doStuff",
      parentId: "mod1",
      exported: true,
      body: "{}",
    });

    const graph = buildGraphReader([mod, fn], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("function doStuff");
  });

  test("stable ordering: types before classes before functions before variables", () => {
    const mod = makeModule("mod1", "src/mixed");
    const variable = createSymbolNode({
      id: "v1",
      kind: "variable",
      name: "CONFIG",
      qualifiedName: "CONFIG",
      parentId: "mod1",
      exported: true,
      body: "{}",
    });
    const fn = makeFunction("fn1", "init", "mod1");
    const cls = createSymbolNode({
      id: "cls1",
      kind: "class",
      name: "App",
      qualifiedName: "App",
      parentId: "mod1",
      exported: true,
    });
    const iface = createSymbolNode({
      id: "if1",
      kind: "interface",
      name: "IApp",
      qualifiedName: "IApp",
      parentId: "mod1",
      exported: true,
      body: "{}",
    });

    const graph = buildGraphReader([mod, variable, fn, cls, iface], []);
    const result = projectModule(mod, graph);

    const ifacePos = result.indexOf("interface IApp");
    const classPos = result.indexOf("class App");
    const fnPos = result.indexOf("function init");
    const varPos = result.indexOf("const CONFIG");

    expect(ifacePos).toBeLessThan(classPos);
    expect(classPos).toBeLessThan(fnPos);
    expect(fnPos).toBeLessThan(varPos);
  });

  test("const enum projection", () => {
    const mod = makeModule("mod1", "src/enums");
    const enumNode = createSymbolNode({
      id: "en1",
      kind: "enum",
      name: "Direction",
      qualifiedName: "Direction",
      parentId: "mod1",
      exported: true,
      modifiers: ["const"],
    });
    const up = createSymbolNode({
      id: "em1",
      kind: "enum-member",
      name: "Up",
      qualifiedName: "Direction.Up",
      parentId: "en1",
      body: "0",
    });

    const graph = buildGraphReader([mod, enumNode, up], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("export const enum Direction");
    expect(result).toContain("Up = 0");
  });

  test("decorator on class method", () => {
    const mod = makeModule("mod1", "src/routes");
    const cls = createSymbolNode({
      id: "cls1",
      kind: "class",
      name: "UserController",
      qualifiedName: "UserController",
      parentId: "mod1",
      exported: true,
      decorators: ["@Controller()"],
    });
    const method = createSymbolNode({
      id: "m1",
      kind: "method",
      name: "getUsers",
      qualifiedName: "UserController.getUsers",
      parentId: "cls1",
      decorators: ["@Get('/users')"],
      signature: "getUsers()",
      typeText: "User[]",
      body: "{ return []; }",
    });

    const graph = buildGraphReader([mod, cls, method], []);
    const result = projectModule(mod, graph);

    expect(result).toContain("@Controller()");
    // dprint may normalize quotes
    expect(result).toMatch(/@Get\(["']/);
    expect(result).toContain("/users");

    expect(result).toContain("getUsers()");
  });
});
