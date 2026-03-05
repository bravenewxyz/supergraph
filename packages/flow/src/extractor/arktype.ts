import { parse, Lang } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import type {
  RuntimeSchemaExtractor,
  RuntimeSchemaInfo,
} from "./runtime-schema.js";
import type { ShapeType, ShapeField } from "../schema/shapes.js";

export class ArkTypeExtractor implements RuntimeSchemaExtractor {
  readonly library = "arktype";

  readonly validationPatterns = [
    "$SCHEMA($DATA)",
    "$SCHEMA.assert($DATA)",
  ];

  detect(source: string): boolean {
    return /from\s+["']arktype["']/.test(source) || /require\(["']arktype["']\)/.test(source);
  }

  extract(source: string, filePath: string): RuntimeSchemaInfo[] {
    const tree = parse(Lang.TypeScript, source);
    const root = tree.root();
    const schemas: RuntimeSchemaInfo[] = [];

    // ArkType uses `type({ ... })` calls
    // Find variable declarations where value is a type(...) call
    const varDecls = root.findAll({ rule: { kind: "variable_declarator" } });

    for (const decl of varDecls) {
      const nameNode = decl.field("name");
      const valueNode = decl.field("value");
      if (!nameNode || !valueNode) continue;

      const typeCall = this.findTypeCall(valueNode);
      if (!typeCall) continue;

      const name = nameNode.text();
      const shape = this.resolveArkTypeArg(typeCall);

      schemas.push({
        name,
        library: "arktype",
        filePath,
        line: typeCall.range().start.line + 1,
        shape,
        raw: typeCall.text(),
      });
    }

    return schemas;
  }

  private findTypeCall(node: SgNode): SgNode | null {
    // Check if this node is a call_expression with callee `type`
    if (node.kind() === "call_expression") {
      const callee = node.field("function");
      if (callee?.kind() === "identifier" && callee.text() === "type") {
        return node;
      }
      // Check for chained calls like type({...}).or({...})
      if (callee?.kind() === "member_expression") {
        const obj = callee.field("object");
        if (obj) {
          const inner = this.findTypeCall(obj);
          if (inner) return node; // return the outer chain
        }
      }
    }
    return null;
  }

  private resolveArkTypeArg(callNode: SgNode): ShapeType {
    const args = callNode.field("arguments");
    if (!args) return { kind: "opaque", raw: callNode.text() };

    const arg = this.firstMeaningfulChild(args);
    if (!arg) return { kind: "opaque", raw: callNode.text() };

    return this.resolveArkValue(arg);
  }

  private resolveArkValue(node: SgNode): ShapeType {
    // Object literal: type({ name: "string", age: "number" })
    if (node.kind() === "object") {
      const fields = this.extractObjectFields(node);
      return { kind: "object", fields };
    }

    // String literal: type("string"), type("number"), type("string[]"), etc.
    if (node.kind() === "string" || node.kind() === "template_string") {
      const raw = node.text().replace(/^["'`]|["'`]$/g, "");
      return this.parseArkTypeString(raw);
    }

    // Array expression: type(["string", "number"]) => union
    if (node.kind() === "array") {
      const members = this.meaningfulChildren(node).map((c) => this.resolveArkValue(c));
      if (members.length === 1) return members[0]!;
      return { kind: "union", members };
    }

    return { kind: "opaque", raw: node.text() };
  }

  private parseArkTypeString(raw: string): ShapeType {
    // Handle common ArkType string definitions
    const trimmed = raw.trim();

    // Array shorthand: "string[]", "number[]"
    if (trimmed.endsWith("[]")) {
      const inner = trimmed.slice(0, -2);
      return { kind: "array", element: this.parseArkTypeString(inner) };
    }

    // Union: "string | number"
    if (trimmed.includes("|")) {
      const members = trimmed.split("|").map((s) => this.parseArkTypeString(s.trim()));
      return { kind: "union", members };
    }

    // Intersection: "string & number"
    if (trimmed.includes("&")) {
      const members = trimmed.split("&").map((s) => this.parseArkTypeString(s.trim()));
      return { kind: "intersection", members };
    }

    // Optional marker
    const isOptional = trimmed.endsWith("?");
    const base = isOptional ? trimmed.slice(0, -1) : trimmed;

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
      Date: { kind: "date" },
      RegExp: { kind: "regex" },
      integer: { kind: "primitive", value: "number" },
    };

    const prim = primMap[base];
    if (prim) return prim;

    // String literals like "'hello'"
    const strLitMatch = base.match(/^'([^']*)'$/);
    if (strLitMatch) return { kind: "literal", value: strLitMatch[1]! };

    // Number literals
    if (/^-?\d+(\.\d+)?$/.test(base)) return { kind: "literal", value: Number(base) };

    if (base === "true") return { kind: "literal", value: true };
    if (base === "false") return { kind: "literal", value: false };

    return { kind: "opaque", raw };
  }

  private extractObjectFields(objLiteral: SgNode): ShapeField[] {
    const fields: ShapeField[] = [];
    for (const prop of objLiteral.children()) {
      if (prop.kind() !== "pair" && prop.kind() !== "property_assignment") continue;
      const key = prop.field("key");
      const value = prop.field("value");
      if (!key || !value) continue;

      let fieldName = key.text();
      let optional = false;

      // ArkType uses "name?" as key for optional fields
      if (fieldName.endsWith("?")) {
        fieldName = fieldName.slice(0, -1);
        optional = true;
      }
      // Also detect string key with question mark
      const cleanName = fieldName.replace(/^["']|["']$/g, "");
      if (cleanName.endsWith("?")) {
        fieldName = cleanName.slice(0, -1);
        optional = true;
      } else {
        fieldName = cleanName || fieldName;
      }

      const type = this.resolveArkValue(value);

      // Check if the string value ends with ? for optional
      if (value.kind() === "string" || value.kind() === "template_string") {
        const valText = value.text().replace(/^["'`]|["'`]$/g, "");
        if (valText.endsWith("?")) {
          optional = true;
        }
      }

      fields.push({ name: fieldName, type, optional });
    }
    return fields;
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
