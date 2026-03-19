import type { SgNode } from "@ast-grep/napi";

/**
 * Walk up from `node` to find the nearest enclosing function / method and
 * return its name.  Handles function declarations, method definitions,
 * arrow functions assigned to variables, and object-literal properties.
 */
export function findEnclosingFunction(node: SgNode): string | null {
  let current = node.parent();
  while (current) {
    const kind = current.kind();
    if (kind === "function_declaration" || kind === "method_definition") {
      const nameNode = current.field("name");
      if (nameNode) return nameNode.text();
    }
    if (kind === "arrow_function" || kind === "function_expression" || kind === "function") {
      const parent = current.parent();
      if (parent?.kind() === "variable_declarator") {
        const nameNode = parent.field("name");
        if (nameNode) return nameNode.text();
      }
      if (parent?.kind() === "pair" || parent?.kind() === "property_assignment") {
        const key = parent.field("key");
        if (key) return key.text();
      }
    }
    current = current.parent();
  }
  return null;
}
