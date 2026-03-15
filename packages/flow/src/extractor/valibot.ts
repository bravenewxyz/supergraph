import type { SgNode } from "@ast-grep/napi";
import type { ShapeType, ShapeField } from "../schema/shapes.js";
import { BaseSchemaExtractor } from "./base-schema-extractor.js";

export class ValibotExtractor extends BaseSchemaExtractor {
  readonly library = "valibot";

  readonly validationPatterns = [
    "v.safeParse($SCHEMA, $DATA)",
    "v.parse($SCHEMA, $DATA)",
    "safeParse($SCHEMA, $DATA)",
    "parse($SCHEMA, $DATA)",
  ];

  /** Cached per-extract() call: whether source uses `v.` namespace prefix. */
  private prefix = "";

  detect(source: string): boolean {
    return /from\s+["']valibot["']/.test(source) || /require\(["']valibot["']\)/.test(source);
  }

  override extract(source: string, filePath: string) {
    // Detect import style once before the base scaffold runs.
    this.prefix = /import\s+\*\s+as\s+v\s+from\s+["']valibot["']/.test(source) ? "v" : "";
    return super.extract(source, filePath);
  }

  protected override findOutermostChain(node: SgNode): SgNode {
    let current = node;
    while (true) {
      const parent = current.parent();
      if (!parent) break;
      if (parent.kind() === "call_expression") {
        const callee = parent.field("function");
        if (callee?.kind() === "member_expression" || callee?.kind() === "identifier") {
          current = parent;
          continue;
        }
      }
      break;
    }
    return current;
  }

  protected findObjectCalls(root: SgNode): SgNode[] {
    const prefix = this.prefix;
    const objectPattern = prefix
      ? { rule: { kind: "call_expression", has: { kind: "member_expression", regex: `^${prefix}\\.object$` } } }
      : { rule: { kind: "call_expression", has: { kind: "identifier", regex: "^object$" } } };

    const calls = root.findAll(objectPattern);

    if (!prefix) {
      // For non-namespace imports, verify we're calling the right `object`
      return calls.filter((call) => {
        const callee = call.field("function");
        return callee && callee.kind() === "identifier" && callee.text() === "object";
      });
    }

    return calls;
  }

  protected findStandaloneSchemas(root: SgNode): Array<{ name: string; node: SgNode }> {
    const prefix = this.prefix;
    const results: Array<{ name: string; node: SgNode }> = [];
    const varDecls = root.findAll({ rule: { kind: "variable_declarator" } });
    const methods = ["array", "union", "enum_", "enum", "record", "tuple", "string", "number", "boolean", "optional", "nullable"];
    const pat = prefix ? new RegExp(`^${prefix}\\.(${methods.join("|")})\\(`) : new RegExp(`^(${methods.join("|")})\\(`);

    for (const decl of varDecls) {
      const nameNode = decl.field("name");
      const valueNode = decl.field("value");
      if (!nameNode || !valueNode) continue;
      const text = valueNode.text();
      if (pat.test(text) && !(prefix ? text.startsWith(`${prefix}.object(`) : text.startsWith("object("))) {
        results.push({ name: nameNode.text(), node: valueNode });
      }
    }
    return results;
  }

  resolveType(node: SgNode): { type: ShapeType; optional: boolean } {
    return this.resolveValibotType(node, this.prefix);
  }

  resolveValibotType(node: SgNode, prefix: string): { type: ShapeType; optional: boolean } {
    const text = node.text();

    const callName = this.getCallName(node, prefix);

    if (callName === "optional" || callName === "nullish") {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) {
          const r = this.resolveValibotType(inner, prefix);
          return { type: r.type, optional: true };
        }
      }
    }

    if (callName === "nullable") {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) {
          const r = this.resolveValibotType(inner, prefix);
          return {
            type: { kind: "union", members: [r.type, { kind: "primitive", value: "null" }] },
            optional: r.optional,
          };
        }
      }
    }

    const passthrough = ["pipe", "transform", "brand", "readonly", "minLength", "maxLength", "minValue", "maxValue", "email", "url", "uuid", "regex", "trim", "toLowerCase", "toUpperCase", "nonEmpty"];
    if (callName && passthrough.includes(callName)) {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) return this.resolveValibotType(inner, prefix);
      }
    }

    const primMap: Record<string, ShapeType> = {
      string: { kind: "primitive", value: "string" },
      number: { kind: "primitive", value: "number" },
      boolean: { kind: "primitive", value: "boolean" },
      bigint: { kind: "primitive", value: "bigint" },
      symbol: { kind: "primitive", value: "symbol" },
      undefined: { kind: "primitive", value: "undefined" },
      null_: { kind: "primitive", value: "null" },
      void_: { kind: "primitive", value: "void" },
      any: { kind: "primitive", value: "any" },
      unknown: { kind: "primitive", value: "unknown" },
      never: { kind: "primitive", value: "never" },
      date: { kind: "date" },
    };

    if (callName) {
      const prim = primMap[callName];
      if (prim) return { type: prim, optional: false };
    }

    if (callName === "literal") {
      const args = node.field("arguments");
      if (args) {
        const arg = this.firstMeaningfulChild(args);
        if (arg) {
          const lit = this.resolveLiteralArg(arg);
          if (lit) return lit;
        }
      }
    }

    if (callName === "array") {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) {
          const r = this.resolveValibotType(inner, prefix);
          return { type: { kind: "array", element: r.type }, optional: false };
        }
      }
    }

    if (callName === "object") {
      const args = node.field("arguments");
      if (args) {
        const objLiteral = this.findFirstChild(args, "object");
        if (objLiteral) {
          const fields = this.extractValibotObjectFields(objLiteral, prefix);
          return { type: { kind: "object", fields }, optional: false };
        }
      }
    }

    if (callName === "union") {
      const args = node.field("arguments");
      if (args) {
        const arr = this.findFirstChild(args, "array");
        if (arr) {
          const members = this.meaningfulChildren(arr).map((c) => this.resolveValibotType(c, prefix).type);
          return { type: { kind: "union", members }, optional: false };
        }
      }
    }

    if (callName === "enum_" || callName === "enum") {
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

    if (callName === "record") {
      const args = node.field("arguments");
      if (args) {
        const argNodes = this.meaningfulChildren(args);
        if (argNodes.length === 1) {
          return {
            type: {
              kind: "record",
              key: { kind: "primitive", value: "string" },
              value: this.resolveValibotType(argNodes[0]!, prefix).type,
            },
            optional: false,
          };
        }
        if (argNodes.length >= 2) {
          return {
            type: {
              kind: "record",
              key: this.resolveValibotType(argNodes[0]!, prefix).type,
              value: this.resolveValibotType(argNodes[1]!, prefix).type,
            },
            optional: false,
          };
        }
      }
    }

    if (callName === "tuple") {
      const args = node.field("arguments");
      if (args) {
        const arr = this.findFirstChild(args, "array");
        if (arr) {
          const elements = this.meaningfulChildren(arr).map((c) => ({
            type: this.resolveValibotType(c, prefix).type,
            optional: false,
          }));
          return { type: { kind: "tuple", elements }, optional: false };
        }
      }
    }

    if (node.kind() === "identifier") {
      return { type: { kind: "ref", name: node.text() }, optional: false };
    }

    return { type: { kind: "opaque", raw: text }, optional: false };
  }

  private getCallName(node: SgNode, prefix: string): string | null {
    if (node.kind() !== "call_expression") return null;
    const callee = node.field("function");
    if (!callee) return null;

    if (prefix && callee.kind() === "member_expression") {
      const obj = callee.field("object");
      const prop = callee.field("property");
      if (obj?.text() === prefix && prop) return prop.text();
    }

    if (!prefix && callee.kind() === "identifier") {
      return callee.text();
    }

    if (callee.kind() === "member_expression") {
      const prop = callee.field("property");
      if (prop) return prop.text();
    }

    return null;
  }

  /** Valibot-specific object field extraction (delegates to resolveValibotType). */
  private extractValibotObjectFields(objLiteral: SgNode, prefix: string): ShapeField[] {
    const fields: ShapeField[] = [];
    for (const prop of objLiteral.children()) {
      if (prop.kind() !== "pair" && prop.kind() !== "property_assignment") continue;
      const key = prop.field("key");
      const value = prop.field("value");
      if (!key || !value) continue;
      const { type, optional } = this.resolveValibotType(value, prefix);
      fields.push({ name: key.text(), type, optional });
    }
    return fields;
  }
}
