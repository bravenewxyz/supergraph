import { parse, Lang } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import type {
  RuntimeSchemaExtractor,
  RuntimeSchemaInfo,
} from "./runtime-schema.js";
import type { ShapeType, ShapeField } from "../schema/shapes.js";

export class ZodExtractor implements RuntimeSchemaExtractor {
  readonly library = "zod";

  readonly validationPatterns = [
    "$SCHEMA.safeParse($DATA)",
    "$SCHEMA.parse($DATA)",
  ];

  detect(source: string): boolean {
    return /from\s+["']zod["']/.test(source) || /require\(["']zod["']\)/.test(source);
  }

  extract(source: string, filePath: string): RuntimeSchemaInfo[] {
    const tree = parse(Lang.TypeScript, source);
    const root = tree.root();
    const schemas: RuntimeSchemaInfo[] = [];

    const objectCalls = root.findAll({
      rule: {
        kind: "call_expression",
        has: {
          kind: "member_expression",
          regex: "^z\\.object$",
        },
      },
    });

    for (const call of objectCalls) {
      const outermost = this.findOutermostChain(call);
      const name = this.resolveSchemaName(outermost);
      const { type } = this.resolveZodType(outermost);

      schemas.push({
        name: name ?? `anonymous_${call.range().start.line + 1}`,
        library: "zod",
        filePath,
        line: call.range().start.line + 1,
        shape: type,
        raw: outermost.text(),
      });
    }

    const standaloneSchemas = this.findStandaloneSchemas(root);
    for (const { name, node } of standaloneSchemas) {
      const already = schemas.some((s) => s.name === name);
      if (already) continue;

      const { type } = this.resolveZodType(node);
      if (type.kind === "opaque") continue;

      schemas.push({
        name,
        library: "zod",
        filePath,
        line: node.range().start.line + 1,
        shape: type,
        raw: node.text(),
      });
    }

    return schemas;
  }

  private findOutermostChain(node: SgNode): SgNode {
    let current = node;
    while (true) {
      const parent = current.parent();
      if (!parent) break;
      if (parent.kind() === "call_expression") {
        const callee = parent.field("function");
        if (callee?.kind() === "member_expression") {
          current = parent;
          continue;
        }
      }
      break;
    }
    return current;
  }

  private findStandaloneSchemas(
    root: SgNode,
  ): Array<{ name: string; node: SgNode }> {
    const results: Array<{ name: string; node: SgNode }> = [];

    const varDecls = root.findAll({
      rule: { kind: "variable_declarator" },
    });

    for (const decl of varDecls) {
      const nameNode = decl.field("name");
      const valueNode = decl.field("value");
      if (!nameNode || !valueNode) continue;

      const text = valueNode.text();
      if (!text.startsWith("z.")) continue;
      if (text.startsWith("z.object(")) continue;

      const name = nameNode.text();
      if (
        text.startsWith("z.array(") ||
        text.startsWith("z.union(") ||
        text.startsWith("z.enum(") ||
        text.startsWith("z.record(") ||
        text.startsWith("z.tuple(") ||
        text.startsWith("z.string(") ||
        text.startsWith("z.number(") ||
        text.startsWith("z.boolean(")
      ) {
        results.push({ name, node: valueNode });
      }
    }

    return results;
  }

  private resolveSchemaName(node: SgNode): string | null {
    let current = node.parent();
    while (current) {
      if (current.kind() === "variable_declarator") {
        const nameNode = current.field("name");
        if (nameNode) return nameNode.text();
      }
      if (
        current.kind() === "pair" ||
        current.kind() === "property_assignment"
      ) {
        const key = current.field("key");
        if (key) return key.text();
      }
      current = current.parent();
    }
    return null;
  }

  resolveZodType(node: SgNode): { type: ShapeType; optional: boolean } {
    const text = node.text();

    const callee = node.field("function");
    if (callee?.kind() === "member_expression") {
      const prop = callee.field("property")?.text();

      if (
        prop === "optional" ||
        prop === "default" ||
        prop === "nullish"
      ) {
        const inner = callee.field("object");
        if (inner) {
          const r = this.resolveZodType(inner);
          return { type: r.type, optional: true };
        }
      }

      if (prop === "nullable") {
        const inner = callee.field("object");
        if (inner) {
          const r = this.resolveZodType(inner);
          return {
            type: {
              kind: "union",
              members: [r.type, { kind: "primitive", value: "null" }],
            },
            optional: r.optional,
          };
        }
      }

      const passthrough = [
        "describe", "transform", "refine", "superRefine",
        "strict", "passthrough", "strip", "pipe", "brand",
        "readonly", "catch", "min", "max", "length",
        "email", "url", "uuid", "regex", "trim",
        "toLowerCase", "toUpperCase", "int", "positive",
        "negative", "nonnegative", "nonpositive", "finite",
        "safe", "multipleOf", "gte", "gt", "lte", "lt",
        "nonempty",
      ];
      if (prop && passthrough.includes(prop)) {
        const inner = callee.field("object");
        if (inner) return this.resolveZodType(inner);
      }
    }

    const primMap: Record<string, ShapeType> = {
      string: { kind: "primitive", value: "string" },
      number: { kind: "primitive", value: "number" },
      boolean: { kind: "primitive", value: "boolean" },
      bigint: { kind: "primitive", value: "bigint" },
      symbol: { kind: "primitive", value: "symbol" },
      undefined: { kind: "primitive", value: "undefined" },
      null: { kind: "primitive", value: "null" },
      void: { kind: "primitive", value: "void" },
      any: { kind: "primitive", value: "any" },
      unknown: { kind: "primitive", value: "unknown" },
      never: { kind: "primitive", value: "never" },
      date: { kind: "date" },
    };

    const primMatch = text.match(/^z\.(\w+)\s*\(/);
    if (primMatch) {
      const zodMethod = primMatch[1]!;
      const prim = primMap[zodMethod];
      if (prim) return { type: prim, optional: false };
    }

    if (text.startsWith("z.literal(")) {
      const args = node.field("arguments");
      if (args) {
        const arg = this.firstMeaningfulChild(args);
        if (arg) {
          const argText = arg.text();
          if (arg.kind() === "string" || arg.kind() === "template_string") {
            return { type: { kind: "literal", value: argText.replace(/^["'`]|["'`]$/g, "") }, optional: false };
          }
          if (arg.kind() === "number") {
            return { type: { kind: "literal", value: Number(argText) }, optional: false };
          }
          if (argText === "true" || argText === "false") {
            return { type: { kind: "literal", value: argText === "true" }, optional: false };
          }
        }
      }
    }

    if (text.startsWith("z.array(")) {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) {
          const r = this.resolveZodType(inner);
          return { type: { kind: "array", element: r.type }, optional: false };
        }
      }
    }

    if (/^z\.object\s*\(/.test(text)) {
      const args = node.field("arguments");
      if (args) {
        const objLiteral = this.findFirstChild(args, "object");
        if (objLiteral) {
          const fields = this.extractObjectFields(objLiteral);
          return { type: { kind: "object", fields }, optional: false };
        }
      }
    }

    if (text.startsWith("z.union(")) {
      const args = node.field("arguments");
      if (args) {
        const arr = this.findFirstChild(args, "array");
        if (arr) {
          const members = this.meaningfulChildren(arr).map(
            (c) => this.resolveZodType(c).type,
          );
          return { type: { kind: "union", members }, optional: false };
        }
      }
    }

    if (text.startsWith("z.enum(")) {
      const args = node.field("arguments");
      if (args) {
        const arr = this.findFirstChild(args, "array");
        if (arr) {
          const values = this.meaningfulChildren(arr)
            .filter((c) => c.kind() === "string")
            .map((c) => c.text().replace(/^["']|["']$/g, ""));
          return { type: { kind: "enum", values }, optional: false };
        }
      }
    }

    if (text.startsWith("z.record(")) {
      const args = node.field("arguments");
      if (args) {
        const argNodes = this.meaningfulChildren(args);
        if (argNodes.length === 1) {
          return {
            type: {
              kind: "record",
              key: { kind: "primitive", value: "string" },
              value: this.resolveZodType(argNodes[0]!).type,
            },
            optional: false,
          };
        }
        if (argNodes.length >= 2) {
          return {
            type: {
              kind: "record",
              key: this.resolveZodType(argNodes[0]!).type,
              value: this.resolveZodType(argNodes[1]!).type,
            },
            optional: false,
          };
        }
      }
    }

    if (text.startsWith("z.tuple(")) {
      const args = node.field("arguments");
      if (args) {
        const arr = this.findFirstChild(args, "array");
        if (arr) {
          const elements = this.meaningfulChildren(arr).map((c) => ({
            type: this.resolveZodType(c).type,
            optional: false,
          }));
          return { type: { kind: "tuple", elements }, optional: false };
        }
      }
    }

    if (text.startsWith("z.map(")) {
      const args = node.field("arguments");
      if (args) {
        const argNodes = this.meaningfulChildren(args);
        if (argNodes.length >= 2) {
          return {
            type: {
              kind: "map",
              key: this.resolveZodType(argNodes[0]!).type,
              value: this.resolveZodType(argNodes[1]!).type,
            },
            optional: false,
          };
        }
      }
    }

    if (text.startsWith("z.set(")) {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) {
          return {
            type: { kind: "set", element: this.resolveZodType(inner).type },
            optional: false,
          };
        }
      }
    }

    if (text.startsWith("z.promise(")) {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) {
          return {
            type: {
              kind: "promise",
              resolved: this.resolveZodType(inner).type,
            },
            optional: false,
          };
        }
      }
    }

    if (text.startsWith("z.function(")) {
      return {
        type: {
          kind: "function",
          params: [],
          returnType: { kind: "primitive", value: "unknown" },
        },
        optional: false,
      };
    }

    if (node.kind() === "identifier") {
      return { type: { kind: "ref", name: node.text() }, optional: false };
    }

    return { type: { kind: "opaque", raw: text }, optional: false };
  }

  private extractObjectFields(objLiteral: SgNode): ShapeField[] {
    const fields: ShapeField[] = [];
    for (const prop of objLiteral.children()) {
      if (
        prop.kind() !== "pair" &&
        prop.kind() !== "property_assignment"
      ) {
        continue;
      }
      const key = prop.field("key");
      const value = prop.field("value");
      if (!key || !value) continue;
      const { type, optional } = this.resolveZodType(value);
      fields.push({ name: key.text(), type, optional });
    }
    return fields;
  }

  private findFirstChild(node: SgNode, kind: string): SgNode | null {
    for (const child of node.children()) {
      if (child.kind() === kind) return child;
      const found = this.findFirstChild(child, kind);
      if (found) return found;
    }
    return null;
  }

  private firstMeaningfulChild(node: SgNode): SgNode | null {
    const skip = new Set<string>(["(", ")", ",", "[", "]", "{", "}"]);
    for (const child of node.children()) {
      if (!skip.has(child.kind() as string)) return child;
    }
    return null;
  }

  private meaningfulChildren(node: SgNode): SgNode[] {
    const skip = new Set<string>(["(", ")", ",", "[", "]", "{", "}"]);
    return node.children().filter((c) => !skip.has(c.kind() as string));
  }
}
