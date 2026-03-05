import { describe, expect, it } from "bun:test";
import { parseTypeScript } from "../parser/ts-structural.js";
import { extractFromFile, extractFromFiles } from "../parser/extractor.js";
import type { SymbolNode } from "../schema/nodes.js";
import type { SymbolEdge } from "../schema/edges.js";

function findNode(
  nodes: SymbolNode[],
  predicate: (n: SymbolNode) => boolean,
): SymbolNode | undefined {
  return nodes.find(predicate);
}

function findEdge(
  edges: SymbolEdge[],
  predicate: (e: SymbolEdge) => boolean,
): SymbolEdge | undefined {
  return edges.find(predicate);
}

describe("parseTypeScript", () => {
  describe("module node", () => {
    it("should create a module node for the file", () => {
      const result = parseTypeScript("", "src/utils.ts");
      const mod = findNode(result.nodes, (n) => n.kind === "module");
      expect(mod).toBeDefined();
      expect(mod!.name).toBe("src/utils");
      expect(mod!.qualifiedName).toBe("src/utils");
      expect(mod!.exported).toBe(true);
    });

    it("should strip .tsx extension for module name", () => {
      const result = parseTypeScript("", "src/App.tsx");
      const mod = findNode(result.nodes, (n) => n.kind === "module");
      expect(mod!.name).toBe("src/App");
    });
  });

  describe("function extraction", () => {
    it("should extract a simple function declaration", () => {
      const code = `function greet(name: string): string {
  return "hello " + name;
}`;
      const result = parseTypeScript(code, "src/greet.ts");
      const fn = findNode(result.nodes, (n) => n.kind === "function" && n.name === "greet");
      expect(fn).toBeDefined();
      expect(fn!.qualifiedName).toBe("src/greet.greet");
      expect(fn!.exported).toBe(false);
      expect(fn!.signature).toContain("greet");
      expect(fn!.signature).toContain("(name: string)");
      expect(fn!.body).toContain("return");
      expect(fn!.sourceRange).toBeDefined();
    });

    it("should extract an async exported function with return type", () => {
      const code = `export async function fetchUser(id: string): Promise<User> {
  return await db.get(id);
}`;
      const result = parseTypeScript(code, "src/users.ts");
      const fn = findNode(result.nodes, (n) => n.kind === "function" && n.name === "fetchUser");
      expect(fn).toBeDefined();
      expect(fn!.exported).toBe(true);
      expect(fn!.modifiers).toContain("async");
      expect(fn!.signature).toContain("fetchUser");
      expect(fn!.typeText).toContain("Promise<User>");

      // Should have a contains edge from module
      const mod = findNode(result.nodes, (n) => n.kind === "module");
      const edge = findEdge(
        result.edges,
        (e) => e.kind === "contains" && e.sourceId === mod!.id && e.targetId === fn!.id,
      );
      expect(edge).toBeDefined();
    });
  });

  describe("class extraction", () => {
    it("should extract a class with methods and properties", () => {
      const code = `export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getUser(id: string): Promise<User> {
    return this.db.get(id);
  }

  static create(): UserService {
    return new UserService(new Database());
  }
}`;
      const result = parseTypeScript(code, "src/service.ts");

      const cls = findNode(result.nodes, (n) => n.kind === "class" && n.name === "UserService");
      expect(cls).toBeDefined();
      expect(cls!.exported).toBe(true);
      expect(cls!.qualifiedName).toBe("src/service.UserService");

      // Constructor
      const ctor = findNode(result.nodes, (n) => n.kind === "method" && n.name === "constructor");
      expect(ctor).toBeDefined();
      expect(ctor!.parentId).toBe(cls!.id);
      expect(ctor!.qualifiedName).toBe("src/service.UserService.constructor");

      // getUser method
      const getUser = findNode(result.nodes, (n) => n.kind === "method" && n.name === "getUser");
      expect(getUser).toBeDefined();
      expect(getUser!.parentId).toBe(cls!.id);

      // static method
      const create = findNode(result.nodes, (n) => n.kind === "method" && n.name === "create");
      expect(create).toBeDefined();
      expect(create!.modifiers).toContain("static");

      // Contains edges from class
      const methodEdges = result.edges.filter(
        (e) => e.kind === "contains" && e.sourceId === cls!.id,
      );
      expect(methodEdges.length).toBeGreaterThanOrEqual(3); // constructor, getUser, create (+ maybe property)
    });

    it("should extract class extending another class", () => {
      const code = `class Admin extends User {
  role: string = "admin";
}`;
      const result = parseTypeScript(code, "src/admin.ts");
      const cls = findNode(result.nodes, (n) => n.kind === "class" && n.name === "Admin");
      expect(cls).toBeDefined();

      const extendsEdge = findEdge(result.edges, (e) => e.kind === "extends" && e.sourceId === cls!.id);
      expect(extendsEdge).toBeDefined();
      expect(extendsEdge!.metadata?.targetName).toBe("User");
    });

    it("should extract class implementing interface", () => {
      const code = `class MyService implements ServiceInterface, Disposable {
  dispose(): void {}
}`;
      const result = parseTypeScript(code, "src/svc.ts");
      const cls = findNode(result.nodes, (n) => n.kind === "class" && n.name === "MyService");
      expect(cls).toBeDefined();

      const implEdges = result.edges.filter(
        (e) => e.kind === "implements" && e.sourceId === cls!.id,
      );
      expect(implEdges.length).toBe(2);
      const names = implEdges.map((e) => e.metadata?.targetName);
      expect(names).toContain("ServiceInterface");
      expect(names).toContain("Disposable");
    });
  });

  describe("interface extraction", () => {
    it("should extract an interface", () => {
      const code = `export interface UserConfig {
  name: string;
  age: number;
  email?: string;
}`;
      const result = parseTypeScript(code, "src/config.ts");
      const iface = findNode(result.nodes, (n) => n.kind === "interface" && n.name === "UserConfig");
      expect(iface).toBeDefined();
      expect(iface!.exported).toBe(true);
      expect(iface!.qualifiedName).toBe("src/config.UserConfig");
      expect(iface!.signature).toBe("interface UserConfig");
      expect(iface!.body).toContain("name: string");
    });
  });

  describe("type alias extraction", () => {
    it("should extract a simple type alias", () => {
      const code = `export type UserId = string;`;
      const result = parseTypeScript(code, "src/types.ts");
      const ta = findNode(result.nodes, (n) => n.kind === "type-alias" && n.name === "UserId");
      expect(ta).toBeDefined();
      expect(ta!.exported).toBe(true);
      expect(ta!.typeText).toBe("string");
    });

    it("should extract a generic type alias", () => {
      const code = `type Result<T> = { ok: true; value: T } | { ok: false; error: Error };`;
      const result = parseTypeScript(code, "src/result.ts");
      const ta = findNode(result.nodes, (n) => n.kind === "type-alias" && n.name === "Result");
      expect(ta).toBeDefined();
      expect(ta!.body).toContain("ok: true");
    });
  });

  describe("enum extraction", () => {
    it("should extract an enum with members", () => {
      const code = `export enum Status {
  Active = "active",
  Inactive = "inactive",
  Pending = "pending",
}`;
      const result = parseTypeScript(code, "src/status.ts");
      const en = findNode(result.nodes, (n) => n.kind === "enum" && n.name === "Status");
      expect(en).toBeDefined();
      expect(en!.exported).toBe(true);
      expect(en!.qualifiedName).toBe("src/status.Status");

      // Enum members
      const members = result.nodes.filter((n) => n.kind === "enum-member" && n.parentId === en!.id);
      expect(members.length).toBeGreaterThanOrEqual(3);

      const memberNames = members.map((m) => m.name);
      expect(memberNames).toContain("Active");
      expect(memberNames).toContain("Inactive");
      expect(memberNames).toContain("Pending");
    });
  });

  describe("variable extraction", () => {
    it("should extract module-level const variables", () => {
      const code = `export const MAX_RETRIES: number = 3;
const DEFAULT_TIMEOUT = 5000;`;
      const result = parseTypeScript(code, "src/constants.ts");

      const maxRetries = findNode(result.nodes, (n) => n.name === "MAX_RETRIES");
      expect(maxRetries).toBeDefined();
      expect(maxRetries!.kind).toBe("variable");
      expect(maxRetries!.exported).toBe(true);

      const timeout = findNode(result.nodes, (n) => n.name === "DEFAULT_TIMEOUT");
      expect(timeout).toBeDefined();
      expect(timeout!.kind).toBe("variable");
      expect(timeout!.exported).toBe(false);
    });

    it("should extract arrow functions assigned to const as function kind", () => {
      const code = `export const fetchData = async (url: string): Promise<Response> => {
  return fetch(url);
};`;
      const result = parseTypeScript(code, "src/fetch.ts");
      const fn = findNode(result.nodes, (n) => n.name === "fetchData");
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe("function");
      expect(fn!.exported).toBe(true);
      expect(fn!.modifiers).toContain("async");
      expect(fn!.modifiers).toContain("const");
    });
  });

  describe("import extraction", () => {
    it("should extract named imports", () => {
      const code = `import { readFile, writeFile } from "fs/promises";`;
      const result = parseTypeScript(code, "src/io.ts");
      const mod = findNode(result.nodes, (n) => n.kind === "module");
      const importEdge = findEdge(
        result.edges,
        (e) => e.kind === "imports" && e.sourceId === mod!.id,
      );
      expect(importEdge).toBeDefined();
      expect(importEdge!.metadata?.moduleSpecifier).toBe("fs/promises");
    });

    it("should extract default imports", () => {
      const code = `import express from "express";`;
      const result = parseTypeScript(code, "src/app.ts");
      const importEdge = findEdge(result.edges, (e) => e.kind === "imports");
      expect(importEdge).toBeDefined();
      expect(importEdge!.metadata?.moduleSpecifier).toBe("express");
    });

    it("should extract namespace imports", () => {
      const code = `import * as path from "path";`;
      const result = parseTypeScript(code, "src/paths.ts");
      const importEdge = findEdge(result.edges, (e) => e.kind === "imports");
      expect(importEdge).toBeDefined();
      expect(importEdge!.metadata?.moduleSpecifier).toBe("path");
    });

    it("should detect type-only imports", () => {
      const code = `import type { User } from "./models.js";`;
      const result = parseTypeScript(code, "src/handlers.ts");
      const importEdge = findEdge(result.edges, (e) => e.kind === "imports");
      expect(importEdge).toBeDefined();
      expect(importEdge!.metadata?.typeOnly).toBe(true);
      expect(importEdge!.metadata?.moduleSpecifier).toBe("./models.js");
    });
  });

  describe("export extraction", () => {
    it("should extract re-exports", () => {
      const code = `export { foo, bar } from "./utils.js";`;
      const result = parseTypeScript(code, "src/index.ts");
      const mod = findNode(result.nodes, (n) => n.kind === "module");
      const reexportEdge = findEdge(
        result.edges,
        (e) =>
          e.kind === "imports" &&
          e.sourceId === mod!.id &&
          e.metadata?.reexport === true,
      );
      expect(reexportEdge).toBeDefined();
      expect(reexportEdge!.metadata?.moduleSpecifier).toBe("./utils.js");
    });

    it("should extract export * re-exports", () => {
      const code = `export * from "./types.js";`;
      const result = parseTypeScript(code, "src/index.ts");
      const reexportEdge = findEdge(
        result.edges,
        (e) => e.kind === "imports" && e.metadata?.reexport === true,
      );
      expect(reexportEdge).toBeDefined();
      expect(reexportEdge!.metadata?.moduleSpecifier).toBe("./types.js");
    });

    it("should mark exported declarations", () => {
      const code = `export function hello() {}
export class World {}
export interface Config {}
export type ID = string;
export enum Color { Red }`;
      const result = parseTypeScript(code, "src/exports.ts");

      const fn = findNode(result.nodes, (n) => n.name === "hello");
      expect(fn!.exported).toBe(true);

      const cls = findNode(result.nodes, (n) => n.name === "World");
      expect(cls!.exported).toBe(true);

      const iface = findNode(result.nodes, (n) => n.name === "Config");
      expect(iface!.exported).toBe(true);

      const ta = findNode(result.nodes, (n) => n.name === "ID");
      expect(ta!.exported).toBe(true);

      const en = findNode(result.nodes, (n) => n.name === "Color");
      expect(en!.exported).toBe(true);
    });

    it("should handle default export of function", () => {
      const code = `export default function main() { return 42; }`;
      const result = parseTypeScript(code, "src/main.ts");
      const fn = findNode(result.nodes, (n) => n.kind === "function" && n.name === "main");
      expect(fn).toBeDefined();
      expect(fn!.exported).toBe(true);
    });
  });

  describe("multiple declarations", () => {
    it("should extract all constructs from a complex file", () => {
      const code = `import type { Database } from "./db.js";
import { Logger } from "./logger.js";

export interface ServiceConfig {
  port: number;
  host: string;
}

export type ServiceId = string;

export const VERSION = "1.0.0";

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

export class Service {
  private config: ServiceConfig;
  private logger: Logger;

  constructor(config: ServiceConfig) {
    this.config = config;
    this.logger = new Logger();
  }

  start(): void {
    this.logger.info("Starting...");
  }
}

export function createService(config: ServiceConfig): Service {
  return new Service(config);
}
`;
      const result = parseTypeScript(code, "src/service.ts");

      // Module
      expect(findNode(result.nodes, (n) => n.kind === "module")).toBeDefined();

      // Interface
      expect(findNode(result.nodes, (n) => n.kind === "interface" && n.name === "ServiceConfig")).toBeDefined();

      // Type alias
      expect(findNode(result.nodes, (n) => n.kind === "type-alias" && n.name === "ServiceId")).toBeDefined();

      // Variable
      expect(findNode(result.nodes, (n) => n.name === "VERSION")).toBeDefined();

      // Enum
      expect(findNode(result.nodes, (n) => n.kind === "enum" && n.name === "LogLevel")).toBeDefined();

      // Class
      const svc = findNode(result.nodes, (n) => n.kind === "class" && n.name === "Service");
      expect(svc).toBeDefined();

      // Class methods
      expect(findNode(result.nodes, (n) => n.kind === "method" && n.name === "constructor")).toBeDefined();
      expect(findNode(result.nodes, (n) => n.kind === "method" && n.name === "start")).toBeDefined();

      // Function
      expect(findNode(result.nodes, (n) => n.kind === "function" && n.name === "createService")).toBeDefined();

      // Imports
      const importEdges = result.edges.filter((e) => e.kind === "imports");
      expect(importEdges.length).toBe(2);
      const specs = importEdges.map((e) => e.metadata?.moduleSpecifier);
      expect(specs).toContain("./db.js");
      expect(specs).toContain("./logger.js");

      // Type-only import
      const typeImport = importEdges.find((e) => e.metadata?.moduleSpecifier === "./db.js");
      expect(typeImport!.metadata?.typeOnly).toBe(true);
    });
  });

  describe("source ranges", () => {
    it("should have correct 0-indexed line ranges", () => {
      const code = `function foo() {
  return 1;
}

function bar() {
  return 2;
}`;
      const result = parseTypeScript(code, "src/ranges.ts");
      const foo = findNode(result.nodes, (n) => n.name === "foo" && n.kind === "function");
      expect(foo!.sourceRange).toEqual({ startLine: 0, endLine: 2 });

      const bar = findNode(result.nodes, (n) => n.name === "bar" && n.kind === "function");
      expect(bar!.sourceRange).toEqual({ startLine: 4, endLine: 6 });
    });
  });

  describe("namespace extraction", () => {
    it("should extract a namespace with members", () => {
      const code = `export namespace Utils {
  export function helper(): void {}
  export const VERSION = "1.0";
}`;
      const result = parseTypeScript(code, "src/utils.ts");
      const ns = findNode(result.nodes, (n) => n.kind === "namespace" && n.name === "Utils");
      expect(ns).toBeDefined();
      expect(ns!.exported).toBe(true);
      expect(ns!.qualifiedName).toBe("src/utils.Utils");

      // Members should be children of the namespace
      const helper = findNode(result.nodes, (n) => n.kind === "function" && n.name === "helper");
      expect(helper).toBeDefined();
      expect(helper!.parentId).toBe(ns!.id);
      expect(helper!.qualifiedName).toBe("src/utils.Utils.helper");

      const version = findNode(result.nodes, (n) => n.name === "VERSION");
      expect(version).toBeDefined();
      expect(version!.parentId).toBe(ns!.id);

      // Contains edges from namespace
      const containsEdges = result.edges.filter(
        (e) => e.kind === "contains" && e.sourceId === ns!.id,
      );
      expect(containsEdges.length).toBe(2);
    });

    it("should not duplicate namespace members as top-level symbols", () => {
      const code = `namespace Foo {
  export function bar(): void {}
}
function topLevel(): void {}`;
      const result = parseTypeScript(code, "src/ns.ts");

      const topLevel = findNode(result.nodes, (n) => n.kind === "function" && n.name === "topLevel");
      expect(topLevel).toBeDefined();

      const mod = findNode(result.nodes, (n) => n.kind === "module");
      expect(topLevel!.parentId).toBe(mod!.id);

      const bar = findNode(result.nodes, (n) => n.kind === "function" && n.name === "bar");
      expect(bar).toBeDefined();
      const ns = findNode(result.nodes, (n) => n.kind === "namespace");
      expect(bar!.parentId).toBe(ns!.id);
    });
  });

  describe("decorator extraction", () => {
    it("should extract decorators on a class", () => {
      const code = `@Controller()
@Injectable()
class AppController {}`;
      const result = parseTypeScript(code, "src/controller.ts");
      const cls = findNode(result.nodes, (n) => n.kind === "class" && n.name === "AppController");
      expect(cls).toBeDefined();
      expect(cls!.decorators).toContain("@Controller()");
      expect(cls!.decorators).toContain("@Injectable()");
    });

    it("should extract decorators on class properties", () => {
      const code = `class Service {
  @Inject()
  private db: Database;
}`;
      const result = parseTypeScript(code, "src/service.ts");
      const prop = findNode(result.nodes, (n) => n.kind === "property" && n.name === "db");
      expect(prop).toBeDefined();
      expect(prop!.decorators.length).toBeGreaterThan(0);
      expect(prop!.decorators[0]).toContain("@Inject()");
    });
  });

  describe("generics in signatures", () => {
    it("should include type parameters in function signature", () => {
      const code = `function identity<T>(x: T): T { return x; }`;
      const result = parseTypeScript(code, "src/generic.ts");
      const fn = findNode(result.nodes, (n) => n.kind === "function" && n.name === "identity");
      expect(fn).toBeDefined();
      expect(fn!.signature).toContain("<T>");
      expect(fn!.signature).toContain("identity<T>(x: T)");
    });

    it("should include constrained type parameters", () => {
      const code = `function process<T extends Record<string, unknown>>(input: T): T { return input; }`;
      const result = parseTypeScript(code, "src/constrained.ts");
      const fn = findNode(result.nodes, (n) => n.kind === "function" && n.name === "process");
      expect(fn).toBeDefined();
      expect(fn!.signature).toContain("<T extends Record<string, unknown>>");
    });

    it("should include type parameters in class signature", () => {
      const code = `export class Container<T> {
  value: T;
}`;
      const result = parseTypeScript(code, "src/container.ts");
      const cls = findNode(result.nodes, (n) => n.kind === "class" && n.name === "Container");
      expect(cls).toBeDefined();
      expect(cls!.signature).toContain("class Container<T>");
    });

    it("should include type parameters in interface signature", () => {
      const code = `export interface Repository<T> {
  find(id: string): T;
}`;
      const result = parseTypeScript(code, "src/repo.ts");
      const iface = findNode(result.nodes, (n) => n.kind === "interface" && n.name === "Repository");
      expect(iface).toBeDefined();
      expect(iface!.signature).toContain("interface Repository<T>");
    });

    it("should include type parameters in method signature", () => {
      const code = `class Mapper {
  map<U>(fn: (x: any) => U): U[] { return []; }
}`;
      const result = parseTypeScript(code, "src/mapper.ts");
      const method = findNode(result.nodes, (n) => n.kind === "method" && n.name === "map");
      expect(method).toBeDefined();
      expect(method!.signature).toContain("<U>");
    });
  });

  describe("getter/setter extraction", () => {
    it("should extract getters and setters with appropriate modifiers", () => {
      const code = `class Config {
  private _name: string = "";

  get name(): string { return this._name; }
  set name(value: string) { this._name = value; }
}`;
      const result = parseTypeScript(code, "src/config.ts");
      const cls = findNode(result.nodes, (n) => n.kind === "class" && n.name === "Config");
      expect(cls).toBeDefined();

      const methods = result.nodes.filter(
        (n) => n.kind === "method" && n.parentId === cls!.id,
      );
      const getter = methods.find((m) => m.modifiers.includes("getter"));
      const setter = methods.find((m) => m.modifiers.includes("setter"));

      expect(getter).toBeDefined();
      expect(getter!.name).toBe("name");
      expect(getter!.modifiers).toContain("getter");

      expect(setter).toBeDefined();
      expect(setter!.name).toBe("name");
      expect(setter!.modifiers).toContain("setter");
    });
  });

  describe("private field extraction", () => {
    it("should extract ES private fields with # prefix", () => {
      const code = `class Secret {
  #value: string = "hidden";
  #count: number;

  getValue(): string { return this.#value; }
}`;
      const result = parseTypeScript(code, "src/secret.ts");
      const cls = findNode(result.nodes, (n) => n.kind === "class" && n.name === "Secret");
      expect(cls).toBeDefined();

      const valueField = findNode(result.nodes, (n) => n.kind === "property" && n.name === "#value");
      expect(valueField).toBeDefined();
      expect(valueField!.parentId).toBe(cls!.id);
      expect(valueField!.modifiers).toContain("private");
      expect(valueField!.typeText).toBe("string");

      const countField = findNode(result.nodes, (n) => n.kind === "property" && n.name === "#count");
      expect(countField).toBeDefined();
      expect(countField!.modifiers).toContain("private");
    });
  });

  describe("index signature extraction", () => {
    it("should extract index signatures from interfaces", () => {
      const code = `export interface Dictionary {
  [key: string]: number;
  name: string;
}`;
      const result = parseTypeScript(code, "src/dict.ts");
      const iface = findNode(result.nodes, (n) => n.kind === "interface" && n.name === "Dictionary");
      expect(iface).toBeDefined();

      const indexProp = findNode(result.nodes, (n) => n.kind === "property" && n.name === "[index]" && n.parentId === iface!.id);
      expect(indexProp).toBeDefined();
      expect(indexProp!.signature).toContain("[key: string]: number");

      // Contains edge from interface to index signature
      const containsEdge = findEdge(
        result.edges,
        (e) => e.kind === "contains" && e.sourceId === iface!.id && e.targetId === indexProp!.id,
      );
      expect(containsEdge).toBeDefined();
    });
  });

  describe("default export detection", () => {
    it("should detect default export on function", () => {
      const code = `export default function main() { return 42; }`;
      const result = parseTypeScript(code, "src/main.ts");
      const fn = findNode(result.nodes, (n) => n.kind === "function" && n.name === "main");
      expect(fn).toBeDefined();
      expect(fn!.exported).toBe(true);
      expect(fn!.modifiers).toContain("default");
    });

    it("should detect default export on class", () => {
      const code = `export default class App {}`;
      const result = parseTypeScript(code, "src/app.ts");
      const cls = findNode(result.nodes, (n) => n.kind === "class" && n.name === "App");
      expect(cls).toBeDefined();
      expect(cls!.exported).toBe(true);
      expect(cls!.modifiers).toContain("default");
    });
  });

  describe("edge cases", () => {
    it("should handle empty file", () => {
      const result = parseTypeScript("", "src/empty.ts");
      expect(result.nodes.length).toBe(1); // just module
      expect(result.edges.length).toBe(0);
    });

    it("should handle file with only comments", () => {
      const code = `// This is a comment
/* Block comment */`;
      const result = parseTypeScript(code, "src/comments.ts");
      expect(result.nodes.length).toBe(1); // just module
    });

    it("should not extract variables nested in functions", () => {
      const code = `function outer() {
  const inner = 42;
  return inner;
}`;
      const result = parseTypeScript(code, "src/nested.ts");
      const innerVar = findNode(result.nodes, (n) => n.name === "inner");
      expect(innerVar).toBeUndefined();
    });
  });
});

describe("extractFromFile", () => {
  it("should return nodes, edges, and moduleId", () => {
    const code = `export function hello(): string { return "hi"; }`;
    const result = extractFromFile(code, "src/hello.ts");
    expect(result.moduleId).toBeTruthy();
    expect(result.nodes.length).toBeGreaterThan(0);
    const mod = result.nodes.find((n) => n.id === result.moduleId);
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe("module");
  });
});

describe("extractFromFiles", () => {
  it("should aggregate nodes and edges from multiple files", () => {
    const files = new Map<string, string>();
    files.set("src/a.ts", `export function aFunc() {}`);
    files.set("src/b.ts", `export function bFunc() {}`);

    const result = extractFromFiles(files);
    expect(result.nodes.filter((n) => n.kind === "module").length).toBe(2);
    expect(result.nodes.filter((n) => n.kind === "function").length).toBe(2);
    expect(result.moduleId).toBeTruthy();
  });
});
