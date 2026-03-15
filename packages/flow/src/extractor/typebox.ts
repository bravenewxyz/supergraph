import type { SgNode } from "@ast-grep/napi";
import type { ShapeType, ShapeField } from "../schema/shapes.js";
import { BaseSchemaExtractor } from "./base-schema-extractor.js";

export class TypeBoxExtractor extends BaseSchemaExtractor {
  readonly library = "typebox";

  readonly validationPatterns = [
    "Value.Check($SCHEMA, $DATA)",
    "Value.Decode($SCHEMA, $DATA)",
    "Value.Errors($SCHEMA, $DATA)",
  ];

  detect(source: string): boolean {
    return /from\s+["']@sinclair\/typebox["']/.test(source) || /require\(["']@sinclair\/typebox["']\)/.test(source);
  }

  protected findObjectCalls(root: SgNode): SgNode[] {
    return root.findAll({
      rule: {
        kind: "call_expression",
        has: {
          kind: "member_expression",
          regex: "^Type\\.Object$",
        },
      },
    });
  }

  protected findStandaloneSchemas(root: SgNode): Array<{ name: string; node: SgNode }> {
    const results: Array<{ name: string; node: SgNode }> = [];
    const varDecls = root.findAll({ rule: { kind: "variable_declarator" } });
    const methods = ["Array", "Union", "Enum", "Record", "Tuple", "String", "Number", "Boolean", "Optional", "Null", "Integer", "Literal"];

    for (const decl of varDecls) {
      const nameNode = decl.field("name");
      const valueNode = decl.field("value");
      if (!nameNode || !valueNode) continue;
      const text = valueNode.text();
      if (!text.startsWith("Type.")) continue;
      if (text.startsWith("Type.Object(")) continue;

      for (const method of methods) {
        if (text.startsWith(`Type.${method}(`)) {
          results.push({ name: nameNode.text(), node: valueNode });
          break;
        }
      }
    }
    return results;
  }

  resolveType(node: SgNode): { type: ShapeType; optional: boolean } {
    return this.resolveTypeBoxType(node);
  }

  resolveTypeBoxType(node: SgNode): { type: ShapeType; optional: boolean } {
    const text = node.text();

    const callName = this.getTypeBoxCallName(node);

    if (callName === "Optional") {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) {
          const r = this.resolveTypeBoxType(inner);
          return { type: r.type, optional: true };
        }
      }
    }

    const primMap: Record<string, ShapeType> = {
      String: { kind: "primitive", value: "string" },
      Number: { kind: "primitive", value: "number" },
      Boolean: { kind: "primitive", value: "boolean" },
      Integer: { kind: "primitive", value: "number" },
      Null: { kind: "primitive", value: "null" },
      Undefined: { kind: "primitive", value: "undefined" },
      Void: { kind: "primitive", value: "void" },
      Any: { kind: "primitive", value: "any" },
      Unknown: { kind: "primitive", value: "unknown" },
      Never: { kind: "primitive", value: "never" },
      BigInt: { kind: "primitive", value: "bigint" },
      Symbol: { kind: "primitive", value: "symbol" },
      Date: { kind: "date" },
      RegExp: { kind: "regex" },
    };

    if (callName) {
      const prim = primMap[callName];
      if (prim) return { type: prim, optional: false };
    }

    if (callName === "Literal") {
      const args = node.field("arguments");
      if (args) {
        const arg = this.firstMeaningfulChild(args);
        if (arg) {
          const lit = this.resolveLiteralArg(arg);
          if (lit) return lit;
        }
      }
    }

    if (callName === "Array") {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) {
          const r = this.resolveTypeBoxType(inner);
          return { type: { kind: "array", element: r.type }, optional: false };
        }
      }
    }

    if (callName === "Object") {
      const args = node.field("arguments");
      if (args) {
        const objLiteral = this.findFirstChild(args, "object");
        if (objLiteral) {
          const fields = this.extractTypeBoxObjectFields(objLiteral);
          return { type: { kind: "object", fields }, optional: false };
        }
      }
    }

    if (callName === "Union") {
      const args = node.field("arguments");
      if (args) {
        const arr = this.findFirstChild(args, "array");
        if (arr) {
          const members = this.meaningfulChildren(arr).map((c) => this.resolveTypeBoxType(c).type);
          return { type: { kind: "union", members }, optional: false };
        }
      }
    }

    if (callName === "Enum") {
      return { type: { kind: "opaque", raw: text }, optional: false };
    }

    if (callName === "Record") {
      const args = node.field("arguments");
      if (args) {
        const argNodes = this.meaningfulChildren(args);
        if (argNodes.length >= 2) {
          return {
            type: {
              kind: "record",
              key: this.resolveTypeBoxType(argNodes[0]!).type,
              value: this.resolveTypeBoxType(argNodes[1]!).type,
            },
            optional: false,
          };
        }
      }
    }

    if (callName === "Tuple") {
      const args = node.field("arguments");
      if (args) {
        const arr = this.findFirstChild(args, "array");
        if (arr) {
          const elements = this.meaningfulChildren(arr).map((c) => ({
            type: this.resolveTypeBoxType(c).type,
            optional: false,
          }));
          return { type: { kind: "tuple", elements }, optional: false };
        }
      }
    }

    if (callName === "Intersect") {
      const args = node.field("arguments");
      if (args) {
        const arr = this.findFirstChild(args, "array");
        if (arr) {
          const members = this.meaningfulChildren(arr).map((c) => this.resolveTypeBoxType(c).type);
          return { type: { kind: "intersection", members }, optional: false };
        }
      }
    }

    if (callName === "Promise") {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) {
          return {
            type: { kind: "promise", resolved: this.resolveTypeBoxType(inner).type },
            optional: false,
          };
        }
      }
    }

    if (node.kind() === "identifier") {
      return { type: { kind: "ref", name: node.text() }, optional: false };
    }

    return { type: { kind: "opaque", raw: text }, optional: false };
  }

  private getTypeBoxCallName(node: SgNode): string | null {
    if (node.kind() !== "call_expression") return null;
    const callee = node.field("function");
    if (!callee || callee.kind() !== "member_expression") return null;
    const obj = callee.field("object");
    const prop = callee.field("property");
    if (obj?.text() === "Type" && prop) return prop.text();
    return null;
  }

  /** TypeBox-specific object field extraction (delegates to resolveTypeBoxType). */
  private extractTypeBoxObjectFields(objLiteral: SgNode): ShapeField[] {
    const fields: ShapeField[] = [];
    for (const prop of objLiteral.children()) {
      if (prop.kind() !== "pair" && prop.kind() !== "property_assignment") continue;
      const key = prop.field("key");
      const value = prop.field("value");
      if (!key || !value) continue;
      const { type, optional } = this.resolveTypeBoxType(value);
      fields.push({ name: key.text(), type, optional });
    }
    return fields;
  }
}
