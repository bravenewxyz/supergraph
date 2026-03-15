import type { SgNode } from "@ast-grep/napi";
import type { ShapeType, ShapeField } from "../schema/shapes.js";
import { BaseSchemaExtractor } from "./base-schema-extractor.js";

export class YupExtractor extends BaseSchemaExtractor {
  readonly library = "yup";

  readonly validationPatterns = [
    "$SCHEMA.validate($DATA)",
    "$SCHEMA.validateSync($DATA)",
    "$SCHEMA.isValid($DATA)",
    "$SCHEMA.isValidSync($DATA)",
    "$SCHEMA.cast($DATA)",
  ];

  /** Cached per-extract() call: whether source uses `yup.` namespace prefix. */
  private prefix = "";

  detect(source: string): boolean {
    return /from\s+["']yup["']/.test(source) || /require\(["']yup["']\)/.test(source);
  }

  override extract(source: string, filePath: string) {
    this.prefix = /import\s+(\*\s+as\s+yup|yup)\s+from\s+["']yup["']/.test(source) ? "yup" : "";
    return super.extract(source, filePath);
  }

  protected findObjectCalls(root: SgNode): SgNode[] {
    const prefix = this.prefix;
    const objectPattern = prefix
      ? { rule: { kind: "call_expression", has: { kind: "member_expression", regex: `^${prefix}\\.object$` } } }
      : { rule: { kind: "call_expression", has: { kind: "identifier", regex: "^object$" } } };

    const calls = root.findAll(objectPattern);

    if (!prefix) {
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
    const methods = ["array", "string", "number", "boolean", "date", "mixed", "tuple"];
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
    return this.resolveYupType(node, this.prefix);
  }

  resolveYupType(node: SgNode, prefix: string): { type: ShapeType; optional: boolean } {
    const text = node.text();

    const callee = node.field("function");

    // Handle chained methods like .required(), .nullable(), .optional(), .defined()
    if (callee?.kind() === "member_expression") {
      const prop = callee.field("property")?.text();

      if (prop === "optional" || prop === "notRequired") {
        const inner = callee.field("object");
        if (inner) {
          const r = this.resolveYupType(inner, prefix);
          return { type: r.type, optional: true };
        }
      }

      if (prop === "nullable") {
        const inner = callee.field("object");
        if (inner) {
          const r = this.resolveYupType(inner, prefix);
          return {
            type: { kind: "union", members: [r.type, { kind: "primitive", value: "null" }] },
            optional: r.optional,
          };
        }
      }

      // Passthrough/refinement methods
      const passthrough = [
        "required", "defined", "strict", "strip", "default",
        "transform", "test", "when", "meta", "label", "typeError",
        "oneOf", "notOneOf", "concat",
        "min", "max", "length", "email", "url", "uuid",
        "trim", "lowercase", "uppercase", "matches",
        "positive", "negative", "integer", "moreThan",
        "lessThan", "truncate", "round", "ensure",
        "noUnknown", "camelCase", "snakeCase",
        "shape",
      ];

      if (prop === "shape") {
        // yup.object().shape({...}) - extract the shape argument
        const args = node.field("arguments");
        if (args) {
          const objLiteral = this.findFirstChild(args, "object");
          if (objLiteral) {
            const fields = this.extractYupObjectFields(objLiteral, prefix);
            return { type: { kind: "object", fields }, optional: false };
          }
        }
      }

      if (prop && passthrough.includes(prop)) {
        const inner = callee.field("object");
        if (inner) return this.resolveYupType(inner, prefix);
      }
    }

    // Detect the base yup call
    const callName = this.getCallName(node, prefix);

    const primMap: Record<string, ShapeType> = {
      string: { kind: "primitive", value: "string" },
      number: { kind: "primitive", value: "number" },
      boolean: { kind: "primitive", value: "boolean" },
      bool: { kind: "primitive", value: "boolean" },
      date: { kind: "date" },
      mixed: { kind: "primitive", value: "unknown" },
    };

    if (callName) {
      const prim = primMap[callName];
      if (prim) return { type: prim, optional: false };
    }

    if (callName === "object") {
      const args = node.field("arguments");
      if (args) {
        const objLiteral = this.findFirstChild(args, "object");
        if (objLiteral) {
          const fields = this.extractYupObjectFields(objLiteral, prefix);
          return { type: { kind: "object", fields }, optional: false };
        }
      }
      return { type: { kind: "object", fields: [] }, optional: false };
    }

    if (callName === "array") {
      const args = node.field("arguments");
      if (args) {
        const inner = this.firstMeaningfulChild(args);
        if (inner) {
          const r = this.resolveYupType(inner, prefix);
          return { type: { kind: "array", element: r.type }, optional: false };
        }
      }
      return { type: { kind: "array", element: { kind: "primitive", value: "unknown" } }, optional: false };
    }

    if (callName === "tuple") {
      const args = node.field("arguments");
      if (args) {
        const arr = this.findFirstChild(args, "array");
        if (arr) {
          const elements = this.meaningfulChildren(arr).map((c) => ({
            type: this.resolveYupType(c, prefix).type,
            optional: false,
          }));
          return { type: { kind: "tuple", elements }, optional: false };
        }
      }
    }

    if (callName === "ref") {
      const args = node.field("arguments");
      if (args) {
        const arg = this.firstMeaningfulChild(args);
        if (arg) {
          const refName = arg.text().replace(/^["']|["']$/g, "");
          return { type: { kind: "ref", name: refName }, optional: false };
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

    return null;
  }

  /** Yup-specific object field extraction (delegates to resolveYupType). */
  private extractYupObjectFields(objLiteral: SgNode, prefix: string): ShapeField[] {
    const fields: ShapeField[] = [];
    for (const prop of objLiteral.children()) {
      if (prop.kind() !== "pair" && prop.kind() !== "property_assignment") continue;
      const key = prop.field("key");
      const value = prop.field("value");
      if (!key || !value) continue;
      const { type, optional } = this.resolveYupType(value, prefix);
      fields.push({ name: key.text(), type, optional });
    }
    return fields;
  }
}
