import type { SgNode } from "@ast-grep/napi";
import type { ShapeType, ShapeField } from "../schema/shapes.js";
import { BaseSchemaExtractor } from "./base-schema-extractor.js";

export class ArkTypeExtractor extends BaseSchemaExtractor {
  readonly library = "arktype";

  readonly validationPatterns = [
    "$SCHEMA($DATA)",
    "$SCHEMA.assert($DATA)",
  ];

  detect(source: string): boolean {
    return /from\s+["']arktype["']/.test(source) || /require\(["']arktype["']\)/.test(source);
  }

  protected findObjectCalls(_root: SgNode): SgNode[] {
    // ArkType doesn't use a distinct "object" call pattern like z.object().
    // All type() calls are found via findStandaloneSchemas instead.
    return [];
  }

  protected findStandaloneSchemas(root: SgNode): Array<{ name: string; node: SgNode }> {
    const results: Array<{ name: string; node: SgNode }> = [];
    const varDecls = root.findAll({ rule: { kind: "variable_declarator" } });

    for (const decl of varDecls) {
      const nameNode = decl.field("name");
      const valueNode = decl.field("value");
      if (!nameNode || !valueNode) continue;

      const typeCall = this.findTypeCall(valueNode);
      if (!typeCall) continue;

      results.push({ name: nameNode.text(), node: typeCall });
    }

    return results;
  }

  resolveType(node: SgNode): { type: ShapeType; optional: boolean } {
    const shape = this.resolveArkTypeArg(node);
    return { type: shape, optional: false };
  }

  private findTypeCall(node: SgNode): SgNode | null {
    if (node.kind() === "call_expression") {
      const callee = node.field("function");
      if (callee?.kind() === "identifier" && callee.text() === "type") {
        return node;
      }
      if (callee?.kind() === "member_expression") {
        const obj = callee.field("object");
        if (obj) {
          const inner = this.findTypeCall(obj);
          if (inner) return node;
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
    if (node.kind() === "object") {
      const fields = this.extractArkObjectFields(node);
      return { kind: "object", fields };
    }

    if (node.kind() === "string" || node.kind() === "template_string") {
      const raw = node.text().replace(/^["'`]|["'`]$/g, "");
      return this.parseArkTypeString(raw);
    }

    if (node.kind() === "array") {
      const members = this.meaningfulChildren(node).map((c) => this.resolveArkValue(c));
      if (members.length === 1) return members[0]!;
      return { kind: "union", members };
    }

    return { kind: "opaque", raw: node.text() };
  }

  private parseArkTypeString(raw: string): ShapeType {
    const trimmed = raw.trim();

    if (trimmed.endsWith("[]")) {
      const inner = trimmed.slice(0, -2);
      return { kind: "array", element: this.parseArkTypeString(inner) };
    }

    if (trimmed.includes("|")) {
      const members = trimmed.split("|").map((s) => this.parseArkTypeString(s.trim()));
      return { kind: "union", members };
    }

    if (trimmed.includes("&")) {
      const members = trimmed.split("&").map((s) => this.parseArkTypeString(s.trim()));
      return { kind: "intersection", members };
    }

    const base = trimmed.endsWith("?") ? trimmed.slice(0, -1) : trimmed;

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

    const strLitMatch = base.match(/^'([^']*)'$/);
    if (strLitMatch) return { kind: "literal", value: strLitMatch[1]! };

    if (/^-?\d+(\.\d+)?$/.test(base)) return { kind: "literal", value: Number(base) };

    if (base === "true") return { kind: "literal", value: true };
    if (base === "false") return { kind: "literal", value: false };

    return { kind: "opaque", raw };
  }

  /** ArkType-specific object field extraction (handles "name?" keys). */
  private extractArkObjectFields(objLiteral: SgNode): ShapeField[] {
    const fields: ShapeField[] = [];
    for (const prop of objLiteral.children()) {
      if (prop.kind() !== "pair" && prop.kind() !== "property_assignment") continue;
      const key = prop.field("key");
      const value = prop.field("value");
      if (!key || !value) continue;

      let fieldName = key.text();
      let optional = false;

      if (fieldName.endsWith("?")) {
        fieldName = fieldName.slice(0, -1);
        optional = true;
      }
      const cleanName = fieldName.replace(/^["']|["']$/g, "");
      if (cleanName.endsWith("?")) {
        fieldName = cleanName.slice(0, -1);
        optional = true;
      } else {
        fieldName = cleanName || fieldName;
      }

      const type = this.resolveArkValue(value);

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
}
