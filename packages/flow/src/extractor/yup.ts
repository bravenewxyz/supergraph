import { parse, Lang } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import type {
  RuntimeSchemaExtractor,
  RuntimeSchemaInfo,
} from "./runtime-schema.js";
import type { ShapeType, ShapeField } from "../schema/shapes.js";

export class YupExtractor implements RuntimeSchemaExtractor {
  readonly library = "yup";

  readonly validationPatterns = [
    "$SCHEMA.validate($DATA)",
    "$SCHEMA.validateSync($DATA)",
    "$SCHEMA.isValid($DATA)",
    "$SCHEMA.isValidSync($DATA)",
    "$SCHEMA.cast($DATA)",
  ];

  detect(source: string): boolean {
    return /from\s+["']yup["']/.test(source) || /require\(["']yup["']\)/.test(source);
  }

  extract(source: string, filePath: string): RuntimeSchemaInfo[] {
    const tree = parse(Lang.TypeScript, source);
    const root = tree.root();
    const schemas: RuntimeSchemaInfo[] = [];

    // Detect import style: `import * as yup from 'yup'` or `import yup from 'yup'` or `import { object, string } from 'yup'`
    const usesNamespace = /import\s+(\*\s+as\s+yup|yup)\s+from\s+["']yup["']/.test(source);
    const prefix = usesNamespace ? "yup" : "";

    // Find yup.object(...) or object(...) calls
    const objectPattern = prefix
      ? { rule: { kind: "call_expression", has: { kind: "member_expression", regex: `^${prefix}\\.object$` } } }
      : { rule: { kind: "call_expression", has: { kind: "identifier", regex: "^object$" } } };

    const objectCalls = root.findAll(objectPattern);

    for (const call of objectCalls) {
      if (!prefix) {
        const callee = call.field("function");
        if (!callee || callee.kind() !== "identifier" || callee.text() !== "object") continue;
      }

      const outermost = this.findOutermostChain(call);
      const name = this.resolveSchemaName(outermost);
      const { type } = this.resolveYupType(outermost, prefix);

      schemas.push({
        name: name ?? `anonymous_${call.range().start.line + 1}`,
        library: "yup",
        filePath,
        line: call.range().start.line + 1,
        shape: type,
        raw: outermost.text(),
      });
    }

    // Find standalone schemas
    const standaloneSchemas = this.findStandaloneSchemas(root, prefix);
    for (const { name, node } of standaloneSchemas) {
      if (schemas.some((s) => s.name === name)) continue;
      const { type } = this.resolveYupType(node, prefix);
      if (type.kind === "opaque") continue;

      schemas.push({
        name,
        library: "yup",
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

  private findStandaloneSchemas(root: SgNode, prefix: string): Array<{ name: string; node: SgNode }> {
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

  private resolveSchemaName(node: SgNode): string | null {
    let current = node.parent();
    while (current) {
      if (current.kind() === "variable_declarator") {
        const nameNode = current.field("name");
        if (nameNode) return nameNode.text();
      }
      if (current.kind() === "pair" || current.kind() === "property_assignment") {
        const key = current.field("key");
        if (key) return key.text();
      }
      current = current.parent();
    }
    return null;
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
            const fields = this.extractObjectFields(objLiteral, prefix);
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
          const fields = this.extractObjectFields(objLiteral, prefix);
          return { type: { kind: "object", fields }, optional: false };
        }
      }
      // yup.object() with no args (shape will be added via .shape())
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
      // array() with no schema arg => unknown[]
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

  private extractObjectFields(objLiteral: SgNode, prefix: string): ShapeField[] {
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
