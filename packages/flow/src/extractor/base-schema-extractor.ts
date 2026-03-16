import { parse, Lang } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import type {
  RuntimeSchemaExtractor,
  RuntimeSchemaInfo,
} from "./types.js";
import type { ShapeType, ShapeField } from "../schema/shapes.js";

/**
 * Shared AST utilities and extraction scaffold for runtime-schema extractors.
 *
 * Each validation library subclass provides:
 *   - library name, detection regex, validation patterns
 *   - `findObjectCalls()` to locate primary schema declarations
 *   - `findStandaloneSchemas()` for non-object schema declarations
 *   - `resolveType()` to map an AST node to a ShapeType
 */
export abstract class BaseSchemaExtractor implements RuntimeSchemaExtractor {
  abstract readonly library: string;
  abstract readonly validationPatterns: string[];

  abstract detect(source: string): boolean;

  /**
   * Find the primary "object schema" call nodes in the AST root.
   * Returns raw call_expression nodes (before walking up to outermost chain).
   */
  protected abstract findObjectCalls(root: SgNode): SgNode[];

  /**
   * Find standalone (non-object) schema declarations.
   */
  protected abstract findStandaloneSchemas(
    root: SgNode,
    source: string,
  ): Array<{ name: string; node: SgNode }>;

  /**
   * Resolve an AST node to a ShapeType for this library.
   */
  abstract resolveType(node: SgNode): { type: ShapeType; optional: boolean };

  // ── extraction scaffold ──────────────────────────────────────────────

  extract(source: string, filePath: string): RuntimeSchemaInfo[] {
    const tree = parse(Lang.TypeScript, source);
    const root = tree.root();
    const schemas: RuntimeSchemaInfo[] = [];

    const objectCalls = this.findObjectCalls(root);
    for (const call of objectCalls) {
      const outermost = this.findOutermostChain(call);
      const name = this.resolveSchemaName(outermost);
      const { type } = this.resolveType(outermost);

      schemas.push({
        name: name ?? `anonymous_${call.range().start.line + 1}`,
        library: this.library,
        filePath,
        line: call.range().start.line + 1,
        shape: type,
        raw: outermost.text(),
      });
    }

    const standaloneSchemas = this.findStandaloneSchemas(root, source);
    for (const { name, node } of standaloneSchemas) {
      if (schemas.some((s) => s.name === name)) continue;
      const { type } = this.resolveType(node);
      if (type.kind === "opaque") continue;

      schemas.push({
        name,
        library: this.library,
        filePath,
        line: node.range().start.line + 1,
        shape: type,
        raw: node.text(),
      });
    }

    return schemas;
  }

  // ── shared AST helpers ───────────────────────────────────────────────

  /** Walk up call-expression chains (e.g. z.object({}).optional()). */
  protected findOutermostChain(node: SgNode): SgNode {
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

  /** Walk ancestors to find the variable / property name for a schema expression. */
  protected resolveSchemaName(node: SgNode): string | null {
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

  /** Extract ShapeField[] from an object literal node using this.resolveType. */
  protected extractObjectFields(objLiteral: SgNode): ShapeField[] {
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
      const { type, optional } = this.resolveType(value);
      fields.push({ name: key.text(), type, optional });
    }
    return fields;
  }

  /** Depth-first search for first child of a given kind. */
  protected findFirstChild(node: SgNode, kind: string): SgNode | null {
    for (const child of node.children()) {
      if (child.kind() === kind) return child;
      const found = this.findFirstChild(child, kind);
      if (found) return found;
    }
    return null;
  }

  /** First non-punctuation child. */
  protected firstMeaningfulChild(node: SgNode): SgNode | null {
    for (const child of node.children()) {
      if (!SKIP_KINDS.has(child.kind() as string)) return child;
    }
    return null;
  }

  /** All non-punctuation children. */
  protected meaningfulChildren(node: SgNode): SgNode[] {
    return node.children().filter((c) => !SKIP_KINDS.has(c.kind() as string));
  }

  // ── common literal helpers ───────────────────────────────────────────

  /** Resolve a literal argument node to a ShapeType. */
  protected resolveLiteralArg(
    argNode: SgNode,
  ): { type: ShapeType; optional: boolean } | null {
    const argText = argNode.text();
    if (argNode.kind() === "string" || argNode.kind() === "template_string") {
      return {
        type: { kind: "literal", value: argText.replace(/^["'`]|["'`]$/g, "") },
        optional: false,
      };
    }
    if (argNode.kind() === "number") {
      return { type: { kind: "literal", value: Number(argText) }, optional: false };
    }
    if (argText === "true" || argText === "false") {
      return { type: { kind: "literal", value: argText === "true" }, optional: false };
    }
    return null;
  }
}

const SKIP_KINDS = new Set<string>(["(", ")", ",", "[", "]", "{", "}"]);
