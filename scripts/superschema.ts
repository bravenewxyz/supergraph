#!/usr/bin/env bun
/**
 * superschema.ts — Complete data model catalog.
 *
 * Documents three layers of schema across the entire repo:
 *   1. Zod schemas  — runtime validation / API data shape
 *   2. Drizzle ORM  — PostgreSQL table definitions
 *   3. Redis keys   — key-value / JSON / search data store
 *
 * Config-driven via audit/config.json → superschema:
 *   zodDirs        — directories containing Zod schema .ts files
 *   drizzleFiles   — Drizzle ORM schema files (pgTable / pgEnum)
 *   redisModelDirs — directories with Redis model files (for key inference)
 *
 * Outputs:
 *   audit/datashape.txt      — full human-readable data model
 *   audit/datashape.map.txt  — compact one-line-per-schema map
 *
 * Usage: bun devtools/scripts/superschema.ts [--out <path>]
 */

import { mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Lang, parse } from "../flow/node_modules/@ast-grep/napi/index.js";
import type { SgNode } from "../flow/node_modules/@ast-grep/napi/index.js";
import { loadConfig } from "../flow/src/cli/config.js";
import { findFiles, parseRootArg, readFile } from "./utils.js";

const ROOT = parseRootArg(resolve(import.meta.dir, "../.."));

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — ZOD SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

type SS =
  | {
      kind:
        | "str"
        | "num"
        | "bool"
        | "null"
        | "undef"
        | "any"
        | "unknown"
        | "never"
        | "date";
    }
  | { kind: "uuid" | "url" | "email" | "datetime" }
  | { kind: "literal"; value: string }
  | { kind: "enum"; values: string[] }
  | { kind: "array"; element: SS }
  | { kind: "object"; fields: ZField[]; spreads: string[] }
  | { kind: "union"; members: SS[]; discriminated?: boolean }
  | { kind: "record"; key: SS; value: SS }
  | { kind: "tuple"; elements: SS[] }
  | { kind: "ref"; name: string }
  | { kind: "nullable"; inner: SS }
  | { kind: "opaque"; raw: string };

type ZField = { name: string; type: SS; optional: boolean };

type SchemaEntry = {
  name: string;
  filePath: string;
  line: number;
  shape: SS;
  compositionBase?: string;
};

// ── AST helpers ───────────────────────────────────────────────────────────────

const SKIP_TOKENS = new Set([
  "(",
  ")",
  ",",
  "[",
  "]",
  "{",
  "}",
  ";",
  "...",
  "comment",
  "line_comment",
  "block_comment",
]);

function meaningfulChildren(node: SgNode): SgNode[] {
  return node
    .children()
    .filter((c) => !SKIP_TOKENS.has(c.kind()) && !c.kind().includes("comment"));
}

function firstMeaningful(node: SgNode): SgNode | null {
  for (const c of node.children()) {
    if (!SKIP_TOKENS.has(c.kind()) && !c.kind().includes("comment")) return c;
  }
  return null;
}

function findFirstOfKind(node: SgNode, kind: string): SgNode | null {
  if (node.kind() === kind) return node;
  for (const child of node.children()) {
    const found = findFirstOfKind(child, kind);
    if (found) return found;
  }
  return null;
}

// ── Zod node parser ───────────────────────────────────────────────────────────

function parseZodNode(
  node: SgNode,
  seen: Set<string> = new Set(),
): { shape: SS; optional: boolean } {
  const kind = node.kind();

  if (kind === "identifier") {
    const name = node.text();
    if (name === "z")
      return { shape: { kind: "opaque", raw: "z" }, optional: false };
    return { shape: { kind: "ref", name }, optional: false };
  }

  if (kind !== "call_expression") {
    return {
      shape: { kind: "opaque", raw: node.text().slice(0, 40) },
      optional: false,
    };
  }

  const callee = node
    .children()
    .find((c) => c.kind() === "member_expression" || c.kind() === "identifier");
  if (!callee) return { shape: { kind: "opaque", raw: "?" }, optional: false };

  const calleeText = (callee?.text() ?? "").replace(/\s+/g, "");
  const argList = node.children().find((c) => c.kind() === "arguments");
  const args = argList ? meaningfulChildren(argList) : [];

  // ── Chained modifier calls (obj.method(args)) — only when obj !== "z" ──────
  if (callee.kind() === "member_expression") {
    const parts = callee.children();
    const obj = parts[0];
    const prop = parts[parts.length - 1]?.text();

    // Only the bare `z` identifier is "direct z" — `z.string().min(1)` is a chain
    const isDirectZ = obj?.kind() === "identifier" && obj?.text() === "z";

    if (!isDirectZ && obj && prop) {
      const inner = parseZodNode(obj, seen);

      if (prop === "optional") return { shape: inner.shape, optional: true };
      if (prop === "nullable")
        return {
          shape: { kind: "nullable", inner: inner.shape },
          optional: inner.optional,
        };
      if (prop === "default") return { ...inner, optional: true };
      if (prop === "nullish")
        return {
          shape: { kind: "nullable", inner: inner.shape },
          optional: true,
        };

      if (prop === "array") {
        return {
          shape: { kind: "array", element: inner.shape },
          optional: false,
        };
      }

      if (prop === "partial") {
        if (inner.shape.kind === "object") {
          return {
            shape: {
              kind: "object",
              fields: inner.shape.fields.map((f) => ({ ...f, optional: true })),
              spreads: inner.shape.spreads,
            },
            optional: false,
          };
        }
        return inner;
      }

      if (prop === "extend") {
        const objArg = args[0];
        if (objArg && inner.shape.kind === "object") {
          const ext = extractObjectFields(objArg, seen);
          return {
            shape: {
              kind: "object",
              fields: [...inner.shape.fields, ...ext.fields],
              spreads: [...inner.shape.spreads, ...ext.spreads],
            },
            optional: false,
          };
        }
        return inner;
      }

      if (prop === "omit") {
        const keysArg = args[0];
        if (keysArg && inner.shape.kind === "object") {
          const omitKeys = new Set(
            keysArg
              .children()
              .filter(
                (c) =>
                  c.kind() === "pair" ||
                  c.kind() === "shorthand_property_identifier_pattern",
              )
              .map(
                (c) =>
                  (c.kind() === "pair" ? c.children()[0]?.text() : c.text()) ??
                  "",
              )
              .filter(Boolean),
          );
          return {
            shape: {
              kind: "object",
              fields: inner.shape.fields.filter((f) => !omitKeys.has(f.name)),
              spreads: inner.shape.spreads,
            },
            optional: false,
          };
        }
        return inner;
      }

      if (prop === "pick") {
        const keysArg = args[0];
        if (keysArg && inner.shape.kind === "object") {
          const pickKeys = new Set(
            keysArg
              .children()
              .filter(
                (c) =>
                  c.kind() === "pair" ||
                  c.kind() === "shorthand_property_identifier_pattern",
              )
              .map(
                (c) =>
                  (c.kind() === "pair" ? c.children()[0]?.text() : c.text()) ??
                  "",
              )
              .filter(Boolean),
          );
          return {
            shape: {
              kind: "object",
              fields: inner.shape.fields.filter((f) => pickKeys.has(f.name)),
              spreads: inner.shape.spreads,
            },
            optional: false,
          };
        }
        return inner;
      }

      if (prop === "merge") {
        const otherArg = args[0];
        if (otherArg) {
          const other = parseZodNode(otherArg, seen);
          if (inner.shape.kind === "object" && other.shape.kind === "object") {
            return {
              shape: {
                kind: "object",
                fields: [...inner.shape.fields, ...other.shape.fields],
                spreads: [...inner.shape.spreads, ...other.shape.spreads],
              },
              optional: false,
            };
          }
        }
        return inner;
      }

      if (prop === "and" || prop === "or") {
        const otherArg = args[0];
        if (otherArg) {
          const other = parseZodNode(otherArg, seen);
          return {
            shape: { kind: "union", members: [inner.shape, other.shape] },
            optional: false,
          };
        }
        return inner;
      }

      // Zod type-changing shortcuts
      if (prop === "datetime")
        return { shape: { kind: "datetime" }, optional: false };

      // All remaining Zod validation / transformation methods are pass-through
      // (they don't change the data type: min, max, regex, refine, trim, etc.)
      return inner;
    }
  }

  // ── Direct z.xxx() calls ──────────────────────────────────────────────────

  // Extract method name: z.string → "string", z.object → "object"
  let method = "";
  if (callee.kind() === "member_expression") {
    const parts = callee.children();
    method = parts[parts.length - 1]?.text() ?? "";
  } else if (callee.kind() === "identifier") {
    method = callee.text();
  }

  switch (method) {
    case "string":
      return { shape: { kind: "str" }, optional: false };
    case "number":
      return { shape: { kind: "num" }, optional: false };
    case "boolean":
      return { shape: { kind: "bool" }, optional: false };
    case "null":
      return { shape: { kind: "null" }, optional: false };
    case "undefined":
      return { shape: { kind: "undef" }, optional: false };
    case "any":
      return { shape: { kind: "any" }, optional: false };
    case "unknown":
      return { shape: { kind: "unknown" }, optional: false };
    case "never":
      return { shape: { kind: "never" }, optional: false };
    case "date":
      return { shape: { kind: "date" }, optional: false };
    case "uuid":
      return { shape: { kind: "uuid" }, optional: false };
    case "url":
      return { shape: { kind: "url" }, optional: false };
    case "email":
      return { shape: { kind: "email" }, optional: false };

    case "datetime":
    case "iso": {
      // z.iso.datetime() or z.string().datetime()
      if (calleeText.includes(".iso.") || method === "iso") {
        return { shape: { kind: "datetime" }, optional: false };
      }
      return { shape: { kind: "str" }, optional: false };
    }

    case "literal": {
      const arg = args[0];
      if (!arg)
        return { shape: { kind: "opaque", raw: "literal" }, optional: false };
      const argText = arg.text().replace(/['"]/g, "");
      if (arg.kind() === "member_expression") {
        const parts = argText.split(".");
        return {
          shape: { kind: "literal", value: parts[parts.length - 1] ?? argText },
          optional: false,
        };
      }
      return { shape: { kind: "literal", value: argText }, optional: false };
    }

    case "enum": {
      const arrArg = args[0];
      if (!arrArg)
        return { shape: { kind: "opaque", raw: "enum" }, optional: false };
      const values = meaningfulChildren(arrArg)
        .filter((c) => c.kind() === "string")
        .map((c) => c.text().replace(/['"]/g, ""));
      return { shape: { kind: "enum", values }, optional: false };
    }

    case "nativeEnum": {
      const ref = args[0];
      if (ref)
        return { shape: { kind: "ref", name: ref.text() }, optional: false };
      return { shape: { kind: "opaque", raw: "nativeEnum" }, optional: false };
    }

    case "object": {
      const objArg = args[0];
      if (!objArg)
        return {
          shape: { kind: "object", fields: [], spreads: [] },
          optional: false,
        };
      const extracted = extractObjectFields(objArg, seen);
      return {
        shape: {
          kind: "object",
          fields: extracted.fields,
          spreads: extracted.spreads,
        },
        optional: false,
      };
    }

    case "array": {
      const elementArg = args[0];
      if (!elementArg)
        return {
          shape: { kind: "array", element: { kind: "unknown" } },
          optional: false,
        };
      const inner = parseZodNode(elementArg, seen);
      return {
        shape: { kind: "array", element: inner.shape },
        optional: false,
      };
    }

    case "union": {
      const arrArg = args[0];
      if (!arrArg)
        return { shape: { kind: "union", members: [] }, optional: false };
      const members = meaningfulChildren(arrArg).map(
        (m) => parseZodNode(m, seen).shape,
      );
      return { shape: { kind: "union", members }, optional: false };
    }

    case "discriminatedUnion": {
      const membersArg = args[1];
      if (!membersArg)
        return {
          shape: { kind: "union", members: [], discriminated: true },
          optional: false,
        };
      const members = meaningfulChildren(membersArg).map(
        (m) => parseZodNode(m, seen).shape,
      );
      return {
        shape: { kind: "union", members, discriminated: true },
        optional: false,
      };
    }

    case "tuple": {
      const arrArg = args[0];
      if (!arrArg)
        return { shape: { kind: "tuple", elements: [] }, optional: false };
      const elements = meaningfulChildren(arrArg).map(
        (m) => parseZodNode(m, seen).shape,
      );
      return { shape: { kind: "tuple", elements }, optional: false };
    }

    case "record": {
      const keyArg = args[0];
      const valArg = args[1];
      const key = keyArg
        ? parseZodNode(keyArg, seen).shape
        : { kind: "str" as const };
      const value = valArg
        ? parseZodNode(valArg, seen).shape
        : { kind: "unknown" as const };
      return { shape: { kind: "record", key, value }, optional: false };
    }

    case "intersection": {
      const a = args[0]
        ? parseZodNode(args[0], seen).shape
        : { kind: "unknown" as const };
      const b = args[1]
        ? parseZodNode(args[1], seen).shape
        : { kind: "unknown" as const };
      return { shape: { kind: "union", members: [a, b] }, optional: false };
    }

    case "lazy":
    case "promise": {
      const inner = args[0] ? parseZodNode(args[0], seen) : null;
      return inner ?? { shape: { kind: "unknown" }, optional: false };
    }

    case "coerce": {
      // z.coerce.string() etc. — recurse into the chain
      return { shape: { kind: "opaque", raw: "coerce" }, optional: false };
    }

    default:
      // Detect z.iso.datetime(), z.string().datetime(), etc.
      if (calleeText.includes("datetime"))
        return { shape: { kind: "datetime" }, optional: false };
      // For any other unrecognized z.* method, recurse on the receiver to get the base type
      if (callee.kind() === "member_expression") {
        const parts = callee.children();
        const rcv = parts[0];
        if (rcv) return parseZodNode(rcv, seen);
      }
      return {
        shape: { kind: "opaque", raw: calleeText.slice(0, 40) },
        optional: false,
      };
  }
}

function extractObjectFields(
  node: SgNode,
  seen: Set<string>,
): { fields: ZField[]; spreads: string[] } {
  const fields: ZField[] = [];
  const spreads: string[] = [];

  const children = node.kind() === "object" ? node.children() : node.children();
  for (const child of children) {
    const ck = child.kind();

    if (ck === "pair" || ck === "property") {
      const pairChildren = child.children();
      const keyNode = pairChildren[0];
      // Value is the last non-punctuation child (after the colon)
      const valNode = pairChildren.find(
        (c, i) => i > 0 && c.kind() !== ":" && c.kind() !== ",",
      );
      if (!keyNode || !valNode || valNode === keyNode) continue;

      const key = keyNode.text().replace(/['"]/g, "");
      const parsed = parseZodNode(valNode, seen);
      fields.push({ name: key, type: parsed.shape, optional: parsed.optional });
    } else if (ck === "spread_element") {
      const inner = firstMeaningful(child);
      if (inner) {
        const refName = extractRefName(inner);
        if (refName) spreads.push(refName);
      }
    }
  }

  return { fields, spreads };
}

function extractRefName(node: SgNode): string | null {
  if (node.kind() === "identifier") return node.text();
  if (node.kind() === "member_expression") {
    // "SchemaName.shape" or "SchemaName.required().shape" → "SchemaName"
    const text = node.text();
    return text.split(".")[0] ?? null;
  }
  if (node.kind() === "call_expression") {
    // "SchemaName.required()" → "SchemaName"
    const callee = node
      .children()
      .find(
        (c) => c.kind() === "member_expression" || c.kind() === "identifier",
      );
    if (callee) return extractRefName(callee);
  }
  return null;
}

function extractSchemas(
  source: string,
  filePath: string,
): { exported: SchemaEntry[]; all: SchemaEntry[] } {
  const exported: SchemaEntry[] = [];
  const all: SchemaEntry[] = [];

  const ast = parse(Lang.TypeScript, source);
  const root = ast.root();

  const varDecls = root.findAll({
    rule: { kind: "lexical_declaration" },
  });

  for (const decl of varDecls) {
    const isExported = decl.parent()?.kind() === "export_statement";
    const declarator = decl
      .children()
      .find((c) => c.kind() === "variable_declarator");
    if (!declarator) continue;

    const declChildren = declarator.children();
    const nameNode = declChildren[0];
    // Value is after the `=` sign (index 2+), skip the name at index 0
    const valueNode = declChildren
      .slice(2)
      .find(
        (c) =>
          c.kind() === "call_expression" ||
          c.kind() === "identifier" ||
          c.kind() === "member_expression",
      );
    if (!nameNode || !valueNode) continue;

    const name = nameNode.text();
    if (!name.endsWith("Schema") && !name.endsWith("schema")) continue;

    const line = nameNode.range().start.line + 1;
    const parsed = parseZodNode(valueNode, new Set());

    // Skip trivial "= z" artifacts
    if (
      parsed.shape.kind === "opaque" &&
      (parsed.shape as { raw: string }).raw === "z"
    )
      continue;

    const entry: SchemaEntry = { name, filePath, line, shape: parsed.shape };

    // Track composition base
    const valText = valueNode.text();
    const baseMatch = valText.match(/^(\w+Schema)\./);
    if (baseMatch) entry.compositionBase = baseMatch[1];

    all.push(entry);
    if (isExported) exported.push(entry);
  }

  return { exported, all };
}

function buildRegistry(entries: SchemaEntry[]): Map<string, SchemaEntry> {
  const reg = new Map<string, SchemaEntry>();
  for (const e of entries) {
    if (!reg.has(e.name)) reg.set(e.name, e);
  }
  return reg;
}

function resolveShape(
  shape: SS,
  registry: Map<string, SchemaEntry>,
  depth = 0,
): SS {
  if (depth > 8) return shape;

  if (shape.kind === "ref") {
    const entry = registry.get(shape.name);
    if (!entry) return shape;
    const resolved = resolveShape(entry.shape, registry, depth + 1);
    if (resolved.kind === "opaque" && (resolved as { raw: string }).raw === "z")
      return shape;
    return resolved;
  }

  if (shape.kind === "object") {
    // Resolve spreads: inline fields from referenced object schemas
    const spreadFields: ZField[] = [];
    const unresolvedSpreads: string[] = [];

    for (const spreadName of shape.spreads) {
      const entry = registry.get(spreadName);
      if (!entry) {
        unresolvedSpreads.push(spreadName);
        continue;
      }
      const resolved = resolveShape(entry.shape, registry, depth + 1);
      if (resolved.kind === "object") {
        spreadFields.push(...resolved.fields);
      } else {
        unresolvedSpreads.push(spreadName);
      }
    }

    const ownFields = shape.fields.map((f) => ({
      ...f,
      type: resolveShape(f.type, registry, depth + 1),
    }));

    // Deduplicate: last definition wins (JS spread semantics)
    const allFields = [...spreadFields, ...ownFields];
    const seenNames = new Set<string>();
    const deduped: ZField[] = [];
    for (let i = allFields.length - 1; i >= 0; i--) {
      const f = allFields[i]!;
      if (!seenNames.has(f.name)) {
        seenNames.add(f.name);
        deduped.unshift(f);
      }
    }

    return { kind: "object", fields: deduped, spreads: unresolvedSpreads };
  }

  if (shape.kind === "array") {
    return {
      kind: "array",
      element: resolveShape(shape.element, registry, depth + 1),
    };
  }
  if (shape.kind === "nullable") {
    return {
      kind: "nullable",
      inner: resolveShape(shape.inner, registry, depth + 1),
    };
  }
  if (shape.kind === "union") {
    return {
      kind: "union",
      members: shape.members.map((m) => resolveShape(m, registry, depth + 1)),
      discriminated: shape.discriminated,
    };
  }
  if (shape.kind === "record") {
    return {
      kind: "record",
      key: resolveShape(shape.key, registry, depth + 1),
      value: resolveShape(shape.value, registry, depth + 1),
    };
  }
  if (shape.kind === "tuple") {
    return {
      kind: "tuple",
      elements: shape.elements.map((e) => resolveShape(e, registry, depth + 1)),
    };
  }

  return shape;
}

function renderTypeName(shape: SS, depth = 0): string {
  switch (shape.kind) {
    case "str":
      return "string";
    case "num":
      return "number";
    case "bool":
      return "boolean";
    case "null":
      return "null";
    case "undef":
      return "undefined";
    case "any":
      return "any";
    case "unknown":
      return "unknown";
    case "never":
      return "never";
    case "date":
      return "Date";
    case "uuid":
      return "string(uuid)";
    case "url":
      return "string(url)";
    case "email":
      return "string(email)";
    case "datetime":
      return "string(datetime)";
    case "literal":
      return `"${shape.value}"`;
    case "enum":
      return shape.values.map((v) => `"${v}"`).join(" | ");
    case "array":
      return `${renderTypeName(shape.element, depth)}[]`;
    case "nullable":
      return `${renderTypeName(shape.inner, depth)} | null`;
    case "ref":
      return shape.name;
    case "opaque":
      return shape.raw;
    case "record":
      return `Record<${renderTypeName(shape.key, depth)}, ${renderTypeName(shape.value, depth)}>`;
    case "tuple":
      return `[${shape.elements.map((e) => renderTypeName(e, depth)).join(", ")}]`;
    case "object": {
      if (depth > 1)
        return `{ ${shape.fields
          .slice(0, 3)
          .map((f) => f.name)
          .join(", ")}${shape.fields.length > 3 ? ", ..." : ""} }`;
      const allFields = [...shape.fields];
      if (allFields.length === 0) return "{}";
      if (allFields.length > 5) {
        const shown = allFields.slice(0, 3).map((f) => f.name);
        return `{ ${shown.join(", ")}, +${allFields.length - 3} }`;
      }
      return `{ ${allFields.map((f) => `${f.name}${f.optional ? "?" : ""}: ${renderTypeName(f.type, depth + 1)}`).join("; ")} }`;
    }
    case "union": {
      const parts = shape.members.map((m) => renderTypeName(m, depth));
      const str = parts.join(" | ");
      if (str.length > 120 && parts.length > 3) {
        return parts.slice(0, 3).join(" | ") + ` | +${parts.length - 3}`;
      }
      return str;
    }
  }
}

// ── Path shortener ────────────────────────────────────────────────────────────

// Default path abbreviations — overridden by config.supergraph.pathSegments if present
const DEFAULT_PATH_SEGS: [string, string][] = [
  ["packages/common/auth/schemas/", "$C/auth/s/"],
  ["packages/common/auth/", "$C/auth/"],
  ["packages/common/schemas/analytics/", "$C/sch/an/"],
  ["packages/common/schemas/", "$C/sch/"],
  ["packages/common/types/", "$C/typ/"],
  ["packages/common/constants/", "$C/const/"],
  ["packages/common/", "$C/"],
  ["packages/backend/src/stable/storage/", "$BE/ss/"],
  ["packages/backend/src/stable/db/", "$BE/db/"],
  ["packages/backend/src/connectors/platforms/", "$BE/cn/plt/"],
  ["packages/backend/src/connectors/reward/", "$BE/cn/rw/"],
  ["packages/backend/src/connectors/onchain/", "$BE/cn/oc/"],
  ["packages/backend/src/connectors/auth/", "$BE/cn/au/"],
  ["packages/backend/src/connectors/", "$BE/cn/"],
  ["packages/backend/src/controllers/", "$BE/ctl/"],
  ["packages/backend/src/middlewares/", "$BE/mw/"],
  ["packages/backend/src/models/", "$BE/mdl/"],
  ["packages/backend/src/routes/v1/", "$BE/rt/v1/"],
  ["packages/backend/src/routes/", "$BE/rt/"],
  ["packages/backend/src/queues/", "$BE/q/"],
  ["packages/backend/src/worker/", "$BE/wrk/"],
  ["packages/backend/src/config/", "$BE/cfg/"],
  ["packages/backend/src/", "$BE/"],
  ["packages/internal/redis/", "$I/redis/"],
  ["packages/internal/errors/", "$I/err/"],
  ["packages/internal/middlewares/", "$I/mw/"],
  ["packages/internal/otel/", "$I/otel/"],
  ["packages/internal/fetcher/", "$I/fetch/"],
  ["packages/internal/", "$I/"],
  ["packages/auth/src/", "$AU/"],
  ["packages/analytics/src/", "$AN/"],
  ["packages/form-service/src/", "$FS/"],
  ["packages/protocol-event-processor/src/", "$PEP/"],
  ["packages/integrations/integration-base/", "$IB/"],
  ["packages/integrations/integration-guild/", "$INTG/"],
  ["packages/integrations/integration-cryptorank/", "$CR/"],
  ["packages/integrations/integration-poap/", "$POAP/"],
  ["packages/integrations/integration-score/", "$SCR/"],
  ["packages/integrations/integration-visit-link/", "$VL/"],
  ["packages/integrations/integration-world-id/", "$WID/"],
  ["packages/integrations/integration/", "$INT/"],
  ["packages/integrations/points-reward/", "$PR/"],
  ["packages/integrations/poap-telegram-bot/", "$TGBOT/"],
  ["packages/integrations/", "$INT/"],
  ["packages/frontend/app/src/", "$FE/"],
  ["packages/frontend/superadmin/src/", "$ADM/"],
  ["packages/frontend/ui-kit/src/", "$UI/"],
];

// Effective path segs — set from config if available, else defaults
let PATH_SEGS: [string, string][] = DEFAULT_PATH_SEGS;

function shortenPath(fp: string): string {
  const p = fp.replace(/\.ts$/, "");
  for (const [from, to] of PATH_SEGS) {
    if (p.startsWith(from)) return to + p.slice(from.length);
  }
  return p;
}

// ── Zod output generators ─────────────────────────────────────────────────────

function generateZodSection(
  schemas: SchemaEntry[],
  registry: Map<string, SchemaEntry>,
  _zodDirs: string[],
): { full: string; map: string } {
  const byFile = new Map<string, SchemaEntry[]>();
  for (const s of schemas) {
    const group = byFile.get(s.filePath) ?? [];
    group.push(s);
    byFile.set(s.filePath, group);
  }

  const lines: string[] = [];

  for (const [fp, entries] of byFile) {
    lines.push(`[${shortenPath(fp)}]`);
    for (const entry of entries.sort((a, b) => a.line - b.line)) {
      const resolved = resolveShape(entry.shape, registry);
      const head = `${entry.name}(L${entry.line})`;
      if (resolved.kind === "object") {
        const parts: string[] = [];
        for (const f of resolved.fields) {
          parts.push(
            `${f.name}${f.optional ? "?" : ""}:${renderTypeName(f.type)}`,
          );
        }
        for (const sp of resolved.spreads) parts.push(`...${sp}`);
        lines.push(
          parts.length ? `${head}  ${parts.join("  ")}` : `${head}  (empty)`,
        );
      } else {
        lines.push(`${head}  =${renderTypeName(resolved)}`);
      }
    }
    lines.push("");
  }

  return { full: lines.join("\n"), map: "" };
}

// ── Zod file discovery ────────────────────────────────────────────────────────

async function discoverAndExtractZod(
  dirs: string[],
): Promise<{ exported: SchemaEntry[]; all: SchemaEntry[] }> {
  const exported: SchemaEntry[] = [];
  const all: SchemaEntry[] = [];

  for (const dir of dirs) {
    const files = await findFiles(dir, /\.ts$/);
    for (const filePath of files) {
      const rel = relative(ROOT, filePath);
      if (
        rel.includes("test") ||
        rel.includes("dist/") ||
        rel.endsWith("index.ts")
      )
        continue;

      const source = await readFile(filePath);
      if (!source) continue;

      const result = extractSchemas(source, rel);
      exported.push(...result.exported);
      all.push(...result.all);
    }
  }

  return { exported, all };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — DRIZZLE / POSTGRESQL
// ═══════════════════════════════════════════════════════════════════════════════

type DrizzleColType = string; // "uuid" | "text" | "integer" | "boolean" | "timestamp" | "jsonb" | ...

type DrizzleColumn = {
  jsName: string; // TypeScript property name
  dbName: string; // Actual database column name
  type: DrizzleColType;
  tsType?: string; // .$type<T>() annotation (for jsonb)
  notNull: boolean;
  isPk: boolean;
  isUnique: boolean;
  hasDefault: boolean;
  defaultVal?: string;
  fkRef?: string; // "tableName.columnName"
};

type DrizzleEnum = {
  jsName: string;
  dbName: string;
  values: string[];
  filePath: string;
};

type DrizzleTable = {
  jsName: string;
  dbName: string;
  filePath: string;
  columns: DrizzleColumn[];
  primaryKeys: string[];
  foreignKeys: Array<{
    name?: string;
    from: string[];
    toTable: string;
    toCol?: string;
  }>;
  indices: Array<{ name: string; columns: string[]; unique?: boolean }>;
};

/**
 * Unwrap a Drizzle column chain (e.g. `uuid("col").notNull().$type<T>()`) using
 * the source text of the value node. Regex-based for robustness across multiline.
 */
function unwrapDrizzleColumn(jsName: string, valueText: string): DrizzleColumn {
  const notNull =
    /\.notNull\(\)/.test(valueText) || /\.primaryKey\(\)/.test(valueText);
  const isPk = /\.primaryKey\(\)/.test(valueText);
  const isUnique = /\.unique\(\)/.test(valueText);
  const hasDefault =
    /\.default\(/.test(valueText) || /\.defaultNow\(\)/.test(valueText);

  let defaultVal: string | undefined;
  if (/\.defaultNow\(\)/.test(valueText)) {
    defaultVal = "now()";
  } else {
    const m = valueText.match(/\.default\(([^)]+)\)/);
    if (m) defaultVal = m[1]?.trim().replace(/\s+/g, " ").slice(0, 50);
  }

  // .$type<T>() — extract between < and matching >
  let tsType: string | undefined;
  const typeIdx = valueText.indexOf(".$type<");
  if (typeIdx !== -1) {
    let depth = 0;
    let start = typeIdx + 7;
    let end = start;
    for (let i = start; i < valueText.length; i++) {
      if (valueText[i] === "<") depth++;
      else if (valueText[i] === ">") {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      }
    }
    tsType = valueText
      .slice(start, end)
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80);
  }

  // FK reference: .references(() => table.col)
  let fkRef: string | undefined;
  const fkMatch = valueText.match(
    /\.references\(\s*\(\)\s*=>\s*([^,.()]+\.[^,.()]+)/,
  );
  if (fkMatch) fkRef = fkMatch[1]?.trim();

  // Base type: first identifier followed by (
  const baseTypeMatch = valueText.match(/^\s*(\w+)\s*\(/);
  let type = baseTypeMatch?.[1] ?? "unknown";

  // Override DB column name from first string arg
  let dbName = jsName;
  const firstStringMatch = valueText.match(/^\s*\w+\s*\(\s*["']([^"']+)["']/);
  if (firstStringMatch) dbName = firstStringMatch[1]!;

  // Annotate varchar/char/numeric with length/precision
  if (type === "varchar" || type === "char") {
    const lenMatch = valueText.match(/\{\s*length\s*:\s*(\d+)/);
    if (lenMatch) type = `${type}(${lenMatch[1]})`;
  }
  if (type === "numeric") {
    const precMatch = valueText.match(
      /\{\s*precision\s*:\s*(\d+)(?:\s*,\s*scale\s*:\s*(\d+))?/,
    );
    if (precMatch)
      type = precMatch[2]
        ? `numeric(${precMatch[1]},${precMatch[2]})`
        : `numeric(${precMatch[1]})`;
  }

  return {
    jsName,
    dbName,
    type,
    tsType,
    notNull,
    isPk,
    isUnique,
    hasDefault,
    defaultVal,
    fkRef,
  };
}

/**
 * Extract table constraint info (pk, fk, index, unique) from the constraint
 * function body text — the third argument of pgTable(...).
 */
function extractTableConstraints(
  constraintText: string,
  jsName: string,
): {
  primaryKeys: string[];
  foreignKeys: Array<{
    name?: string;
    from: string[];
    toTable: string;
    toCol?: string;
  }>;
  indices: Array<{ name: string; columns: string[]; unique?: boolean }>;
} {
  const primaryKeys: string[] = [];
  const foreignKeys: Array<{
    name?: string;
    from: string[];
    toTable: string;
    toCol?: string;
  }> = [];
  const indices: Array<{ name: string; columns: string[]; unique?: boolean }> =
    [];

  // primaryKey({ columns: [table.X, table.Y] })
  const pkMatch = constraintText.match(
    /primaryKey\s*\(\s*\{[^}]*columns\s*:\s*\[([^\]]+)\]/,
  );
  if (pkMatch) {
    const cols = (pkMatch[1]?.match(/table\.(\w+)/g) ?? []).map((c) =>
      c.replace("table.", ""),
    );
    primaryKeys.push(...cols);
  }

  // foreignKey({ columns: [table.X], foreignColumns: [otherTable.Y] })
  const fkRe = /foreignKey\s*\(\s*\{([^}]+)\}/g;
  let fkMatch: RegExpExecArray | null;
  while ((fkMatch = fkRe.exec(constraintText)) !== null) {
    const body = fkMatch[1]!;
    const fromCols = (
      body.match(/columns\s*:\s*\[([^\]]+)\]/)?.[1]?.match(/table\.(\w+)/g) ??
      []
    ).map((c) => c.replace("table.", ""));
    const toRef = body
      .match(/foreignColumns\s*:\s*\[([^\]]+)\]/)?.[1]
      ?.match(/(\w+)\.(\w+)/)?.[0];
    const nameMatch = body.match(/name\s*:\s*["']([^"']+)["']/);
    if (toRef) {
      const [toTable, toCol] = toRef.split(".") as [string, string];
      foreignKeys.push({
        from: fromCols,
        toTable,
        toCol,
        name: nameMatch?.[1],
      });
    }
  }

  // index("name").on(table.X, table.Y)
  const idxRe = /index\s*\(\s*["']([^"']+)["']\s*\)/g;
  let idxMatch: RegExpExecArray | null;
  while ((idxMatch = idxRe.exec(constraintText)) !== null) {
    const idxName = idxMatch[1]!;
    const onStart = constraintText.indexOf(".on(", idxMatch.index);
    let colsText = "";
    if (onStart !== -1) {
      const onEnd = constraintText.indexOf(")", onStart + 4);
      colsText = constraintText.slice(onStart + 4, onEnd);
    }
    const cols = (colsText.match(/table\.(\w+)/g) ?? []).map((c) =>
      c.replace("table.", ""),
    );
    indices.push({ name: idxName, columns: cols });
  }

  // unique("name")
  const uqRe = /unique\s*\(\s*["']([^"']+)["']\s*\)/g;
  let uqMatch: RegExpExecArray | null;
  while ((uqMatch = uqRe.exec(constraintText)) !== null) {
    const uqName = uqMatch[1]!;
    const onStart = constraintText.indexOf(".on(", uqMatch.index);
    let colsText = "";
    if (onStart !== -1) {
      const onEnd = constraintText.indexOf(")", onStart + 4);
      colsText = constraintText.slice(onStart + 4, onEnd);
    }
    const cols = (colsText.match(/table\.(\w+)/g) ?? []).map((c) =>
      c.replace("table.", ""),
    );
    indices.push({ name: uqName, columns: cols, unique: true });
  }

  return { primaryKeys, foreignKeys, indices };
}

/**
 * Parse a single Drizzle schema file and extract all tables and enums.
 */
async function extractDrizzleFile(filePath: string): Promise<{
  tables: DrizzleTable[];
  enums: DrizzleEnum[];
}> {
  const source = await readFile(filePath);
  if (!source) return { tables: [], enums: [] };

  const rel = relative(ROOT, filePath);
  const ast = parse(Lang.TypeScript, source);
  const root = ast.root();

  const enums: DrizzleEnum[] = [];
  const tables: DrizzleTable[] = [];

  // ── Extract pgEnum declarations ────────────────────────────────────────────
  const enumDecls = root.findAll({ rule: { kind: "lexical_declaration" } });
  for (const decl of enumDecls) {
    const declarator = decl
      .children()
      .find((c) => c.kind() === "variable_declarator");
    if (!declarator) continue;

    const jsName = declarator.children()[0]?.text() ?? "";
    const valueNode = declarator
      .children()
      .find((c) => c.kind() === "call_expression");
    if (!valueNode) continue;

    const callText = valueNode.text().replace(/\s+/g, " ");
    if (!callText.startsWith("pgEnum(")) continue;

    const dbNameMatch = callText.match(/pgEnum\(\s*["']([^"']+)["']/);
    if (!dbNameMatch) continue;

    const dbName = dbNameMatch[1]!;
    const values: string[] = [];
    // Find the array argument (between first [ and its matching ])
    const arrStart = callText.indexOf("[");
    const arrEnd = callText.lastIndexOf("]");
    if (arrStart !== -1 && arrEnd !== -1) {
      const arrContent = callText.slice(arrStart + 1, arrEnd);
      values.push(
        ...(arrContent.match(/["']([^"']+)["']/g) ?? []).map((v) =>
          v.replace(/['"]/g, ""),
        ),
      );
    }

    enums.push({ jsName, dbName, values, filePath: rel });
  }

  // ── Extract pgTable declarations ───────────────────────────────────────────
  for (const decl of enumDecls) {
    const declarator = decl
      .children()
      .find((c) => c.kind() === "variable_declarator");
    if (!declarator) continue;

    const jsName = declarator.children()[0]?.text() ?? "";
    const valueNode = declarator
      .children()
      .find((c) => c.kind() === "call_expression");
    if (!valueNode) continue;

    const callText = valueNode.text();
    const callTextNorm = callText.replace(/\s+/g, " ");
    if (!callTextNorm.trimStart().startsWith("pgTable(")) continue;

    // Extract table DB name (first string argument)
    const dbNameMatch = callTextNorm.match(/pgTable\(\s*["']([^"']+)["']/);
    if (!dbNameMatch) continue;
    const dbName = dbNameMatch[1]!;

    // Find the columns object — second arg to pgTable
    const argList = valueNode.children().find((c) => c.kind() === "arguments");
    if (!argList) continue;
    const argChildren = meaningfulChildren(argList);
    const columnsArg = argChildren[1]; // second arg

    const columns: DrizzleColumn[] = [];

    if (columnsArg && columnsArg.kind() === "object") {
      for (const child of columnsArg.children()) {
        if (child.kind() !== "pair" && child.kind() !== "property") continue;
        // pair children: [property_identifier, ":", call_expression]
        const pairChildren = child.children();
        const keyNode = pairChildren[0];
        // Value is the last non-punctuation child (index 2 for pair, varies for property)
        const valNode = pairChildren.find(
          (c, i) => i > 0 && c.kind() !== ":" && c.kind() !== ",",
        );
        if (!keyNode || !valNode || valNode === keyNode) continue;

        const jsColName = keyNode.text();
        const valText = valNode.text();
        columns.push(unwrapDrizzleColumn(jsColName, valText));
      }
    }

    // Extract constraints from third arg (arrow function body)
    const constraintArg = argChildren[2];
    let primaryKeys: string[] = [];
    let foreignKeys: DrizzleTable["foreignKeys"] = [];
    let indices: DrizzleTable["indices"] = [];

    if (constraintArg) {
      const constraintText = constraintArg.text();
      const extracted = extractTableConstraints(constraintText, jsName);
      primaryKeys = extracted.primaryKeys;
      foreignKeys = extracted.foreignKeys;
      indices = extracted.indices;
    }

    // Also collect column-level PKs/FKs
    for (const col of columns) {
      if (col.isPk && !primaryKeys.includes(col.jsName))
        primaryKeys.push(col.jsName);
      if (col.fkRef) {
        const [toTable, toCol] = col.fkRef.split(".") as [string, string];
        foreignKeys.push({ from: [col.jsName], toTable, toCol });
      }
    }

    tables.push({
      jsName,
      dbName,
      filePath: rel,
      columns,
      primaryKeys,
      foreignKeys,
      indices,
    });
  }

  return { tables, enums };
}

async function extractAllDrizzle(files: string[]): Promise<{
  tables: DrizzleTable[];
  enums: DrizzleEnum[];
}> {
  const tables: DrizzleTable[] = [];
  const enums: DrizzleEnum[] = [];
  for (const f of files) {
    const result = await extractDrizzleFile(f);
    tables.push(...result.tables);
    enums.push(...result.enums);
  }
  return { tables, enums };
}

// ── Drizzle output generator ──────────────────────────────────────────────────

function generateDrizzleSection(
  tables: DrizzleTable[],
  enums: DrizzleEnum[],
): { full: string; map: string } {
  const lines: string[] = [];

  const byFile = new Map<
    string,
    { tables: DrizzleTable[]; enums: DrizzleEnum[] }
  >();
  for (const t of tables) {
    const g = byFile.get(t.filePath) ?? { tables: [], enums: [] };
    g.tables.push(t);
    byFile.set(t.filePath, g);
  }
  for (const e of enums) {
    const g = byFile.get(e.filePath) ?? { tables: [], enums: [] };
    g.enums.push(e);
    byFile.set(e.filePath, g);
  }

  for (const [fp, { tables: fileTables, enums: fileEnums }] of byFile) {
    lines.push(`[${shortenPath(fp)}]`);

    for (const en of fileEnums) {
      lines.push(`ENUM ${en.dbName}  ${en.values.join("|")}`);
    }

    for (const table of fileTables) {
      const pkStr = table.primaryKeys.length
        ? ` PK(${table.primaryKeys.join(",")})`
        : "";
      const fkStr = table.foreignKeys.length
        ? ` FK(${table.foreignKeys.map((fk) => `${fk.from.join("+")}→${fk.toTable}.${fk.toCol ?? "?"}`).join(",")})`
        : "";
      const cols = table.columns
        .map((col) => {
          let s = `${col.dbName}:${col.type}`;
          if (col.notNull) s += "!";
          if (col.hasDefault) s += `[${(col.defaultVal ?? "").slice(0, 20)}]`;
          if (col.fkRef) s += `→${col.fkRef}`;
          if (col.tsType) s += `<${col.tsType.slice(0, 30)}>`;
          return s;
        })
        .join("  ");
      const idxStr = table.indices
        .map((i) => `${i.unique ? "·uq" : "·idx"}(${i.columns.join(",")})`)
        .join(" ");
      lines.push(
        `TABLE ${table.dbName}${pkStr}${fkStr}  ${cols}${idxStr ? "  " + idxStr : ""}`,
      );
    }

    lines.push("");
  }

  return { full: lines.join("\n"), map: "" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — REDIS KEY SPACE
// ═══════════════════════════════════════════════════════════════════════════════

type RedisOp =
  | "json.set"
  | "json.get"
  | "json.del"
  | "json.arrAppend"
  | "json.numIncrBy"
  | "json.other"
  | "ft.search"
  | "ft.create"
  | "del"
  | "set"
  | "get";

type RedisKeyEntry = {
  pattern: string;
  operations: Set<RedisOp>;
  schemaHint?: string; // Inferred from .parse() or cast near this key
  sourceFiles: Set<string>;
};

type RedisFtIndex = {
  name: string;
  prefix?: string;
  sourceFile: string;
};

/**
 * Normalize a template-literal key to a readable pattern.
 * E.g. `guild:${guild.id}` → "guild:{id}"
 *      `cache:guild:${guildId}` → "cache:guild:{guildId}"
 */
function normalizeKeyPattern(template: string): string {
  return template
    .replace(/\$\{[^}]*\}/g, (expr) => {
      const inner = expr.slice(2, -1).trim();
      // Get the last property access or identifier
      const name =
        inner
          .split(/[.\[\s(]/)
          .filter(Boolean)
          .pop() ?? "id";
      return `{${name}}`;
    })
    .replace(/\s+/g, "");
}

/**
 * Scan model source files for Redis key patterns and FT index definitions.
 */
function extractRedisFromSource(
  source: string,
  filePath: string,
  keyMap: Map<string, RedisKeyEntry>,
  ftIndexes: RedisFtIndex[],
): void {
  const rel = relative(ROOT, filePath);

  // Find all redis operations with template literal keys
  // Matches: redis.json.set(`key`, ...), redis.ft.search("idx", ...), redis.del(`key`), etc.
  // Group 1: full operation (e.g. "json.set"), Group 2: key/index string
  const opRe = /redis(?:Cache)?\.([a-zA-Z.]+)\s*\(\s*[`"']([^`"'\n]+)[`"']/g;
  let m: RegExpExecArray | null;

  while ((m = opRe.exec(source)) !== null) {
    const rawOp = m[1]!.toLowerCase();
    const keyTemplate = m[2]!;

    // Only care about redis data operations
    const knownOps = [
      "json.set",
      "json.get",
      "json.del",
      "json.arrpush",
      "json.arrpop",
      "json.arrindex",
      "json.arrappend",
      "json.numincrby",
      "ft.search",
      "ft.create",
      "del",
      "set",
      "get",
      "exists",
      "expire",
    ];
    if (!knownOps.some((op) => rawOp === op || rawOp.startsWith(op))) continue;

    const fullOp = rawOp as RedisOp;

    // Skip non-key patterns (e.g. ft.search index names used positionally)
    if (fullOp.startsWith("ft.search") || fullOp.startsWith("ft.create")) {
      // This is an index name, not a key pattern
      const idxName = keyTemplate;
      if (!ftIndexes.find((i) => i.name === idxName)) {
        // Try to extract prefix from ft.create arguments
        const createRe = new RegExp(
          `ft\\.create\\s*\\(\\s*["']${idxName}["'][^)]+PREFIX[^\\[]*\\[\\s*["']([^"']+)["']`,
          "s",
        );
        const prefixMatch = source.match(createRe);
        ftIndexes.push({
          name: idxName,
          prefix: prefixMatch?.[1],
          sourceFile: rel,
        });
      }
      continue;
    }

    const pattern = normalizeKeyPattern(keyTemplate);
    const existing = keyMap.get(pattern) ?? {
      pattern,
      operations: new Set<RedisOp>(),
      sourceFiles: new Set<string>(),
    };
    existing.operations.add(fullOp);
    existing.sourceFiles.add(rel);
    keyMap.set(pattern, existing);
  }

  // Try to infer schema hints from redis.json.set(key, "$", value) → look for .parse(value) nearby
  // or `as Types["X"]` / `as X` casts near the get operations
  const schemaHintRe =
    /redis(?:Cache)?\.json\.(?:set|get)\s*\(\s*[`"']([^`"'\n]+)[`"']/g;
  while ((m = schemaHintRe.exec(source)) !== null) {
    const pattern = normalizeKeyPattern(m[1]!);
    // Look for Schema.parse or cast within 200 chars after the operation
    const context = source.slice(m.index, m.index + 400);
    const parseHint =
      context.match(/(\w+Schema)\.parse/)?.[1] ??
      context.match(/as\s+Types\["([^"]+)"\]/)?.[1] ??
      context.match(/as\s+unknown\s+as\s+Types\["([^"]+)"\]/)?.[1];
    if (parseHint) {
      const entry = keyMap.get(pattern);
      if (entry && !entry.schemaHint) {
        entry.schemaHint = parseHint.endsWith("Schema")
          ? parseHint
          : `Types["${parseHint}"]`;
      }
    }
  }
}

async function extractAllRedis(modelDirs: string[]): Promise<{
  keyMap: Map<string, RedisKeyEntry>;
  ftIndexes: RedisFtIndex[];
}> {
  const keyMap = new Map<string, RedisKeyEntry>();
  const ftIndexes: RedisFtIndex[] = [];

  for (const dir of modelDirs) {
    const files = await findFiles(dir, /\.ts$/);
    for (const f of files) {
      const source = await readFile(f);
      if (!source) continue;
      extractRedisFromSource(source, f, keyMap, ftIndexes);
    }
  }

  return { keyMap, ftIndexes };
}

// ── Redis output generator ────────────────────────────────────────────────────

function generateRedisSection(
  keyMap: Map<string, RedisKeyEntry>,
  ftIndexes: RedisFtIndex[],
): { full: string; map: string } {
  const lines: string[] = [];

  for (const entry of [...keyMap.values()].sort((a, b) =>
    a.pattern.localeCompare(b.pattern),
  )) {
    const ops = [...entry.operations].join("/");
    const schemaStr = entry.schemaHint ? `  →${entry.schemaHint}` : "";
    const filesStr = [...entry.sourceFiles].map((f) => basename(f)).join(",");
    lines.push(`${entry.pattern}  [${ops}]${schemaStr}  (${filesStr})`);
  }

  for (const idx of ftIndexes) {
    const prefixStr = idx.prefix ? ` PREFIX:"${idx.prefix}"` : "";
    lines.push(`FT  ${idx.name}${prefixStr}  (${idx.sourceFile})`);
  }

  return { full: lines.join("\n"), map: "" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — TYPESCRIPT TYPES (type aliases + interfaces)
// ═══════════════════════════════════════════════════════════════════════════════

type TSField = {
  name: string;
  type: string; // raw type text
  optional: boolean;
  readonly: boolean;
};

type TSTypeEntry = {
  name: string;
  kind: "type" | "interface";
  filePath: string;
  line: number;
  exported: boolean;
  genericParams?: string; // e.g. "<T extends string, U>"
  extends?: string[]; // interface extension list
  fields?: TSField[]; // populated for object/interface types
  body?: string; // raw body for non-object type aliases
};

/** Extract fields from an object_type or interface_body node. */
function extractTSObjectFields(bodyNode: SgNode): TSField[] {
  const fields: TSField[] = [];
  for (const child of bodyNode.children()) {
    const ck = child.kind();
    if (ck === "property_signature") {
      const ch = child.children();
      const readonly = ch.some((c) => c.kind() === "readonly");
      const optional = ch.some((c) => c.text() === "?");
      const nameNode = ch.find(
        (c) =>
          c.kind() === "property_identifier" ||
          c.kind() === "string" ||
          c.kind() === "number",
      );
      const typeAnnot = ch.find((c) => c.kind() === "type_annotation");
      if (!nameNode) continue;
      const name = nameNode.text().replace(/^['"]|['"]$/g, "");
      const type = typeAnnot
        ? typeAnnot.text().replace(/^:\s*/, "").replace(/\s+/g, " ")
        : "unknown";
      fields.push({ name, type, optional, readonly });
    } else if (ck === "method_signature") {
      // Show methods as "name(…): ReturnType"
      const sig = child.text().replace(/\s+/g, " ");
      const nameNode = child
        .children()
        .find((c) => c.kind() === "property_identifier");
      if (nameNode) {
        fields.push({
          name: nameNode.text() + "(…)",
          type: sig.replace(/^[^:]+/, "").trim(),
          optional: false,
          readonly: false,
        });
      }
    } else if (ck === "index_signature") {
      fields.push({
        name: "[index]",
        type: child.text().replace(/\s+/g, " "),
        optional: false,
        readonly: false,
      });
    }
  }
  return fields;
}

/** Parse all type aliases and interfaces from a TypeScript source file. */
function extractTSTypes(source: string, filePath: string): TSTypeEntry[] {
  const entries: TSTypeEntry[] = [];
  const ast = parse(Lang.TypeScript, source);
  const root = ast.root();

  // ── type aliases ──────────────────────────────────────────────────────────
  for (const node of root.findAll({
    rule: { kind: "type_alias_declaration" },
  })) {
    const exported = node.parent()?.kind() === "export_statement";
    const ch = node.children();
    const nameNode = ch.find((c) => c.kind() === "type_identifier");
    if (!nameNode) continue;

    const name = nameNode.text();
    const line = nameNode.range().start.line + 1;
    const genericParams = ch
      .find((c) => c.kind() === "type_parameters")
      ?.text()
      .replace(/\s+/g, " ");

    // Body: node after "="
    const eqIdx = ch.findIndex((c) => c.text() === "=");
    const bodyNode = eqIdx !== -1 ? ch[eqIdx + 1] : undefined;
    if (!bodyNode) continue;

    let fields: TSField[] | undefined;
    let body: string | undefined;

    if (bodyNode.kind() === "object_type") {
      fields = extractTSObjectFields(bodyNode);
    } else {
      body = bodyNode.text().replace(/\s+/g, " ").trim();
    }

    entries.push({
      name,
      kind: "type",
      filePath,
      line,
      exported,
      genericParams,
      fields,
      body,
    });
  }

  // ── interface declarations ────────────────────────────────────────────────
  for (const node of root.findAll({
    rule: { kind: "interface_declaration" },
  })) {
    const exported = node.parent()?.kind() === "export_statement";
    const ch = node.children();
    const nameNode = ch.find((c) => c.kind() === "type_identifier");
    if (!nameNode) continue;

    const name = nameNode.text();
    const line = nameNode.range().start.line + 1;
    const genericParams = ch
      .find((c) => c.kind() === "type_parameters")
      ?.text()
      .replace(/\s+/g, " ");

    const extendsClause = ch.find((c) => c.kind() === "extends_type_clause");
    const extendsTypes = extendsClause
      ? [
          extendsClause
            .text()
            .replace(/^extends\s+/, "")
            .replace(/\s+/g, " "),
        ]
      : [];

    const bodyNode = ch.find((c) => c.kind() === "interface_body");
    if (!bodyNode) continue;

    const fields = extractTSObjectFields(bodyNode);
    entries.push({
      name,
      kind: "interface",
      filePath,
      line,
      exported,
      genericParams,
      extends: extendsTypes,
      fields,
    });
  }

  return entries;
}

async function extractAllTSTypes(dirs: string[]): Promise<TSTypeEntry[]> {
  const all: TSTypeEntry[] = [];
  for (const dir of dirs) {
    const files = await findFiles(dir, /\.ts$/);
    for (const filePath of files) {
      const rel = relative(ROOT, filePath);
      // Skip generated declaration files and build artifacts
      if (
        rel.includes("node_modules") ||
        rel.includes("/dist/") ||
        rel.endsWith(".d.ts")
      )
        continue;

      const source = await readFile(filePath);
      if (!source) continue;

      const entries = extractTSTypes(source, rel);
      all.push(...entries);
    }
  }
  return all;
}

// ── TypeScript types output generator ────────────────────────────────────────

function generateTSTypeSection(entries: TSTypeEntry[]): {
  full: string;
  map: string;
} {
  const lines: string[] = [];

  const byFile = new Map<string, TSTypeEntry[]>();
  for (const e of entries) {
    const g = byFile.get(e.filePath) ?? [];
    g.push(e);
    byFile.set(e.filePath, g);
  }

  for (const [fp, fileEntries] of byFile) {
    lines.push(`[${shortenPath(fp)}]`);
    for (const e of fileEntries.sort((a, b) => a.line - b.line)) {
      const dot = e.exported ? "" : "·";
      const generics = e.genericParams ?? "";
      const extendsStr = e.extends?.length ? ` ext:${e.extends.join(",")}` : "";
      const kindTag = e.kind === "interface" ? "iface" : "type";
      const head = `${dot}${e.name}${generics}(L${e.line})[${kindTag}]${extendsStr}`;

      if (e.fields && e.fields.length > 0) {
        const parts = e.fields.map((f) => {
          const label =
            (f.readonly ? "ro:" : "") + f.name + (f.optional ? "?" : "");
          return `${label}:${f.type.replace(/\s+/g, " ")}`;
        });
        lines.push(`${head}  ${parts.join("  ")}`);
      } else if (e.body) {
        const body =
          e.body.length > 120 ? e.body.slice(0, 117) + "..." : e.body;
        lines.push(`${head}  =${body}`);
      } else {
        lines.push(`${head}  ={}`);
      }
    }
    lines.push("");
  }

  return { full: lines.join("\n"), map: "" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — HTML VISUALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Serialize all extracted data into a compact JSON object for the HTML viewer. */
function buildHTMLData(
  exportedSchemas: SchemaEntry[],
  registry: Map<string, SchemaEntry>,
  tables: DrizzleTable[],
  enums: DrizzleEnum[],
  keyMap: Map<string, RedisKeyEntry>,
  ftIndexes: RedisFtIndex[],
  tsTypeEntries: TSTypeEntry[],
  project: string,
): string {
  const zod = exportedSchemas.map((e) => {
    const resolved = resolveShape(e.shape, registry);
    if (resolved.kind === "object") {
      return {
        n: e.name,
        f: e.filePath,
        l: e.line,
        fields: resolved.fields.map((f) => ({
          n: f.name,
          t: renderTypeName(f.type),
          o: f.optional ? 1 : 0,
        })),
      };
    }
    return {
      n: e.name,
      f: e.filePath,
      l: e.line,
      body: renderTypeName(resolved),
    };
  });

  const sql = {
    enums: enums.map((e) => ({ n: e.dbName, f: e.filePath, vals: e.values })),
    tables: tables.map((t) => ({
      n: t.dbName,
      f: t.filePath,
      pk: t.primaryKeys,
      fk: t.foreignKeys.map((k) => ({
        from: k.from,
        to: `${k.toTable}.${k.toCol ?? "?"}`,
      })),
      cols: t.columns.map((c) => ({
        n: c.dbName,
        t: c.type,
        ...(c.tsType ? { ts: c.tsType } : {}),
        ...(c.notNull ? { nn: 1 } : {}),
        ...(c.isPk ? { pk: 1 } : {}),
        ...(c.isUnique ? { uq: 1 } : {}),
        ...(c.hasDefault ? { def: c.defaultVal ?? "" } : {}),
        ...(c.fkRef ? { fk: c.fkRef } : {}),
      })),
      idx: t.indices.map((i) => ({
        n: i.name,
        cols: i.columns,
        ...(i.unique ? { uq: 1 } : {}),
      })),
    })),
  };

  const redis = {
    keys: [...keyMap.values()]
      .sort((a, b) => a.pattern.localeCompare(b.pattern))
      .map((k) => ({
        p: k.pattern,
        ops: [...k.operations],
        ...(k.schemaHint ? { s: k.schemaHint } : {}),
        files: [...k.sourceFiles].map((f) => f.split("/").pop()!),
      })),
    idx: ftIndexes.map((i) => ({
      n: i.name,
      ...(i.prefix ? { prefix: i.prefix } : {}),
    })),
  };

  const ts = tsTypeEntries.map((e) => ({
    n: e.name,
    k: e.kind === "interface" ? 1 : 0,
    f: e.filePath,
    l: e.line,
    ...(e.exported ? {} : { int: 1 }),
    ...(e.genericParams ? { g: e.genericParams } : {}),
    ...(e.extends?.length ? { ext: e.extends } : {}),
    ...(e.fields?.length
      ? {
          fields: e.fields.map((f) => ({
            n: f.name,
            t: f.type,
            ...(f.optional ? { o: 1 } : {}),
            ...(f.readonly ? { ro: 1 } : {}),
          })),
        }
      : {}),
    ...(e.body ? { body: e.body } : {}),
  }));

  return JSON.stringify({
    project,
    generated: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
    stats: {
      zod: zod.length,
      sql: tables.length,
      redis: keyMap.size,
      ts: tsTypeEntries.length,
    },
    zod,
    sql,
    redis,
    ts,
  });
}

/** Generate a self-contained HTML visualization. */
function generateHTML(jsonData: string, project: string): string {
  // language=html
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Superschema — ${project}</title>
<style>
:root{--bg:#0d1117;--s1:#161b22;--s2:#21262d;--bd:#30363d;--tx:#e6edf3;--mu:#8b949e;--ac:#a78bfa;--str:#79c0ff;--num:#ffa657;--bool:#ff7b72;--lit:#a5d6ff;--kw:#ff7b72;--pk:#3fb950;--fk:#d29922;--idx:#58a6ff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;height:100vh;display:flex;flex-direction:column;overflow:hidden}
a{color:var(--ac);text-decoration:none}
/* ── Header ── */
#hdr{display:flex;align-items:center;gap:12px;padding:10px 18px;background:var(--s1);border-bottom:1px solid var(--bd);flex-shrink:0}
#hdr h1{font-size:15px;font-weight:600;color:var(--tx);letter-spacing:.3px}
#hdr h1 span{color:var(--ac)}
.stats{display:flex;gap:8px;margin-left:auto;flex-shrink:0}
.stat{background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:3px 10px;font-size:11px;color:var(--mu)}
.stat b{color:var(--tx)}
/* ── Tabs ── */
#tabs{display:flex;gap:2px;padding:8px 18px 0;background:var(--s1);border-bottom:1px solid var(--bd);flex-shrink:0}
.tab{padding:6px 14px;border-radius:6px 6px 0 0;border:1px solid transparent;border-bottom:none;cursor:pointer;font-size:12px;color:var(--mu);background:transparent;transition:all .15s;user-select:none}
.tab:hover{color:var(--tx);background:var(--s2)}
.tab.active{color:var(--tx);background:var(--bg);border-color:var(--bd)}
/* ── Toolbar ── */
#toolbar{display:flex;align-items:center;gap:10px;padding:8px 18px;background:var(--bg);border-bottom:1px solid var(--bd);flex-shrink:0}
#search{flex:1;max-width:380px;background:var(--s1);border:1px solid var(--bd);border-radius:6px;padding:5px 10px 5px 28px;color:var(--tx);font-size:12px;outline:none}
#search:focus{border-color:var(--ac)}
.search-wrap{position:relative;flex:1;max-width:380px}
.search-icon{position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--mu);pointer-events:none;font-size:12px}
#match-count{font-size:11px;color:var(--mu)}
#expand-all{background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:4px 10px;font-size:11px;color:var(--mu);cursor:pointer;white-space:nowrap}
#expand-all:hover{color:var(--tx)}
/* ── Content ── */
#content{flex:1;overflow-y:auto;padding:14px 18px 40px}
/* ── File group ── */
.fg{margin-bottom:8px;border:1px solid var(--bd);border-radius:8px;overflow:hidden}
.fg-hdr{display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--s1);cursor:pointer;user-select:none}
.fg-hdr:hover{background:var(--s2)}
.fg-arrow{font-size:10px;color:var(--mu);width:10px;transition:transform .15s}
.fg.open .fg-arrow{transform:rotate(90deg)}
.fg-path{font-size:11px;color:var(--mu);font-family:monospace;flex:1}
.fg-path .hl{background:#a78bfa33;border-radius:2px;color:var(--ac)}
.fg-badge{background:var(--s2);border:1px solid var(--bd);border-radius:4px;padding:1px 6px;font-size:10px;color:var(--mu)}
.fg-body{display:none}
.fg.open .fg-body{display:block}
/* ── Item card ── */
.card{padding:10px 14px;border-top:1px solid var(--bd)}
.card:first-child{border-top:none}
.card-hdr{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.item-name{font-weight:600;font-size:13px;color:var(--tx)}
.item-kw{font-size:10px;color:var(--mu);background:var(--s2);border:1px solid var(--bd);border-radius:3px;padding:1px 5px}
.item-int{font-size:10px;color:var(--mu);opacity:.7}
.line-ref{font-size:10px;color:var(--mu);margin-left:auto}
/* ── Fields table ── */
.ft{width:100%;border-collapse:collapse;font-family:"SF Mono",Consolas,monospace;font-size:11.5px}
.ft td{padding:2px 8px 2px 0;vertical-align:top;white-space:nowrap}
.ft td:first-child{width:1%;padding-right:16px}
.fn{color:#79c0ff}
.fn.opt{opacity:.7}
.fn.opt::after{content:"?";color:var(--mu)}
.fn.ro::before{content:"readonly ";color:var(--mu);font-size:10px}
.type-body{font-family:"SF Mono",Consolas,monospace;font-size:11.5px;color:var(--mu);word-break:break-all;line-height:1.5}
/* ── Type syntax colors ── */
.tc-str{color:#79c0ff}
.tc-num{color:#ffa657}
.tc-bool{color:#ff7b72}
.tc-null{color:#ff7b72;opacity:.7}
.tc-lit{color:#a5d6ff}
.tc-uuid{color:#3fb950}
.tc-url{color:#3fb950}
.tc-email{color:#3fb950}
.tc-dt{color:#3fb950}
.tc-pipe{color:var(--mu)}
.tc-arr{color:#79c0ff}
/* ── SQL specific ── */
.col-flags{display:flex;gap:4px;flex-wrap:wrap}
.badge{font-size:10px;border-radius:3px;padding:1px 5px;font-weight:500}
.b-pk{background:#3fb95020;color:#3fb950;border:1px solid #3fb95040}
.b-fk{background:#d2992220;color:#d29922;border:1px solid #d2992240}
.b-nn{background:#58a6ff18;color:#58a6ff;border:1px solid #58a6ff30}
.b-uq{background:#a78bfa20;color:#a78bfa;border:1px solid #a78bfa40}
.b-def{background:#8b949e18;color:#8b949e;border:1px solid #8b949e30}
.b-idx{background:#21262d;color:var(--mu);border:1px solid var(--bd)}
/* ── Redis ── */
.redis-table{width:100%;border-collapse:collapse;font-size:12px}
.redis-table td,.redis-table th{padding:5px 10px;border-bottom:1px solid var(--bd);vertical-align:top}
.redis-table th{color:var(--mu);font-weight:500;font-size:10px;text-transform:uppercase;letter-spacing:.5px;background:var(--s1)}
.op-badge{display:inline-block;background:var(--s2);border:1px solid var(--bd);border-radius:3px;padding:1px 5px;font-size:10px;font-family:monospace;margin:1px;color:var(--mu)}
.schema-hint{color:var(--ac);font-family:monospace;font-size:11px}
/* ── TS types ── */
.ts-ext{font-size:11px;color:var(--mu);font-family:monospace;margin-left:4px}
.ts-gen{font-size:11px;color:var(--mu);font-family:monospace}
/* ── Empty state ── */
.empty{text-align:center;color:var(--mu);padding:40px;font-size:13px}
/* ── Scrollbar ── */
#content::-webkit-scrollbar{width:6px}
#content::-webkit-scrollbar-track{background:transparent}
#content::-webkit-scrollbar-thumb{background:var(--bd);border-radius:3px}
/* ── Search highlight ── */
.hl{background:#a78bfa33;border-radius:2px}
</style>
</head>
<body>
<div id="hdr">
  <h1>⬡ Superschema <span id="proj-name"></span></h1>
  <div class="stats" id="stats-bar"></div>
</div>
<div id="tabs"></div>
<div id="toolbar">
  <div class="search-wrap">
    <span class="search-icon">🔍</span>
    <input id="search" placeholder="Search schemas, fields, types…" autocomplete="off" spellcheck="false">
  </div>
  <span id="match-count"></span>
  <button id="expand-all" onclick="expandAll()">Expand all</button>
</div>
<div id="content"></div>
<script>
const DATA = ${jsonData};

// ── State ─────────────────────────────────────────────────────────────────────
let TAB = 'zod', Q = '', allExpanded = false;

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('proj-name').textContent = DATA.project;
  renderStats();
  renderTabs();
  document.getElementById('search').addEventListener('input', e => {
    Q = e.target.value.trim().toLowerCase();
    renderContent();
  });
  renderContent();
});

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats() {
  const sb = document.getElementById('stats-bar');
  const s = DATA.stats;
  sb.innerHTML =
    stat(s.zod, 'Zod schema') +
    stat(s.sql, 'SQL table') +
    stat(s.redis, 'Redis key') +
    stat(s.ts, 'TS type');
}
function stat(n, label) {
  return '<div class="stat"><b>' + n + '</b> ' + label + (n !== 1 ? 's' : '') + '</div>';
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
const TABS = [['zod','Zod Schemas'],['sql','PostgreSQL'],['redis','Redis'],['ts','TypeScript']];
function renderTabs() {
  document.getElementById('tabs').innerHTML = TABS.map(([id, label]) =>
    '<div class="tab' + (id === TAB ? ' active' : '') + '" data-tab="' + id + '">' + label + '</div>'
  ).join('');
  document.querySelectorAll('[data-tab]').forEach(function(el) {
    el.addEventListener('click', function() { switchTab(el.getAttribute('data-tab')); });
  });
}
function switchTab(id) {
  TAB = id; allExpanded = false; Q = '';
  document.getElementById('search').value = '';
  renderTabs(); renderContent();
}

// ── Expand all ────────────────────────────────────────────────────────────────
function expandAll() {
  allExpanded = !allExpanded;
  document.querySelectorAll('.fg').forEach(el =>
    el.classList.toggle('open', allExpanded)
  );
  document.getElementById('expand-all').textContent = allExpanded ? 'Collapse all' : 'Expand all';
}
function toggleFg(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

// ── Content router ────────────────────────────────────────────────────────────
function renderContent() {
  const el = document.getElementById('content');
  if (TAB === 'zod')        el.innerHTML = renderZod();
  else if (TAB === 'sql')   el.innerHTML = renderSql();
  else if (TAB === 'redis') el.innerHTML = renderRedis();
  else                      el.innerHTML = renderTs();
  // Bind file-group toggle via data attributes (avoids quote issues in template)
  document.querySelectorAll('[data-id]').forEach(function(hdr) {
    hdr.addEventListener('click', function() { toggleFg(hdr.getAttribute('data-id')); });
  });
  updateMatchCount();
}

// ── ZOD ───────────────────────────────────────────────────────────────────────
function renderZod() {
  const items = Q ? DATA.zod.filter(s => matches(s, [s.n, ...(s.fields||[]).map(f=>f.n+' '+f.t), s.body||''])) : DATA.zod;
  if (!items.length) return '<div class="empty">No schemas match "' + esc(Q) + '"</div>';
  const byFile = groupBy(items, s => s.f);
  return [...byFile.entries()].map(([file, schemas]) => {
    const id = fgId(file);
    const cards = schemas.map(s => {
      let html = '<div class="card"><div class="card-hdr">';
      html += '<span class="item-name">' + hi(s.n) + '</span>';
      html += '<span class="line-ref">L' + s.l + '</span></div>';
      if (s.fields && s.fields.length) {
        html += '<table class="ft">' + s.fields.map(f =>
          '<tr><td class="fn' + (f.o?' opt':'') + '">' + hi(f.n) + '</td><td>' + ct(hi(f.t)) + '</td></tr>'
        ).join('') + '</table>';
      } else if (s.body) {
        html += '<div class="type-body">' + ct(hi(s.body)) + '</div>';
      }
      return html + '</div>';
    }).join('');
    return fg(id, file, schemas.length, 'schema', cards);
  }).join('');
}

// ── SQL ───────────────────────────────────────────────────────────────────────
function renderSql() {
  const allItems = [...DATA.sql.enums.map(e=>({...e,_k:'enum'})), ...DATA.sql.tables.map(t=>({...t,_k:'table'}))];
  const items = Q ? allItems.filter(i => {
    if (i._k==='enum') return matches(i,[i.n,...i.vals]);
    return matches(i,[i.n,...(i.cols||[]).map(c=>c.n+' '+c.t)]);
  }) : allItems;
  if (!items.length) return '<div class="empty">No SQL items match "' + esc(Q) + '"</div>';
  const byFile = groupBy(items, i => i.f);
  return [...byFile.entries()].map(([file, fileItems]) => {
    const id = fgId(file);
    const cards = fileItems.map(item => {
      if (item._k === 'enum') return renderEnumCard(item);
      return renderTableCard(item);
    }).join('');
    return fg(id, file, fileItems.length, 'item', cards);
  }).join('');
}
function renderEnumCard(e) {
  return '<div class="card"><div class="card-hdr">' +
    '<span class="item-name">' + hi(e.n) + '</span>' +
    '<span class="item-kw">enum</span></div>' +
    '<div class="type-body">' + e.vals.map(v => '<span class="tc-lit">"'+hi(v)+'"</span>').join(' <span class="tc-pipe">|</span> ') + '</div></div>';
}
function renderTableCard(t) {
  let html = '<div class="card"><div class="card-hdr">';
  html += '<span class="item-name">' + hi(t.n) + '</span>';
  html += '<span class="item-kw">table</span>';
  if (t.pk.length) html += '<span class="badge b-pk">PK: '+t.pk.join(', ')+'</span>';
  html += '</div>';
  html += '<table class="ft">';
  for (const c of (t.cols||[])) {
    const flags = [];
    if (c.pk) flags.push('<span class="badge b-pk">PK</span>');
    if (c.fk) flags.push('<span class="badge b-fk">→'+esc(c.fk)+'</span>');
    if (c.nn) flags.push('<span class="badge b-nn">NN</span>');
    if (c.uq) flags.push('<span class="badge b-uq">UQ</span>');
    if ('def' in c) flags.push('<span class="badge b-def">default</span>');
    const tsAnnot = c.ts ? ' <span style="color:var(--mu);font-size:10px">['+esc(c.ts.slice(0,40))+']</span>' : '';
    html += '<tr><td class="fn">' + hi(c.n) + '</td><td><span class="tc-str">'+esc(c.t)+'</span>'+tsAnnot+'</td><td><div class="col-flags">'+flags.join('')+'</div></td></tr>';
  }
  html += '</table>';
  if (t.idx && t.idx.length) {
    html += '<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">';
    for (const i of t.idx) html += '<span class="badge '+(i.uq?'b-uq':'b-idx')+'">'+(i.uq?'UNIQUE':'INDEX')+' '+esc(i.n)+'</span>';
    html += '</div>';
  }
  return html + '</div>';
}

// ── REDIS ─────────────────────────────────────────────────────────────────────
function renderRedis() {
  const keys = Q ? DATA.redis.keys.filter(k => matches(k,[k.p, k.s||'', ...k.files])) : DATA.redis.keys;
  let html = '<table class="redis-table"><thead><tr><th>Key pattern</th><th>Operations</th><th>Schema hint</th><th>Source</th></tr></thead><tbody>';
  if (!keys.length) return '<div class="empty">No Redis keys match "' + esc(Q) + '"</div>';
  for (const k of keys) {
    html += '<tr>';
    html += '<td><code style="color:var(--ac)">' + hi(k.p) + '</code></td>';
    html += '<td>' + k.ops.map(op => '<span class="op-badge">'+esc(op)+'</span>').join(' ') + '</td>';
    html += '<td>' + (k.s ? '<span class="schema-hint">'+hi(k.s)+'</span>' : '<span style="color:var(--mu)">—</span>') + '</td>';
    html += '<td style="color:var(--mu);font-size:11px">' + k.files.map(f=>esc(f)).join(', ') + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  if (DATA.redis.idx && DATA.redis.idx.length) {
    html += '<div style="margin-top:16px"><div style="font-size:11px;color:var(--mu);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">FT Indexes (RediSearch)</div>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
    for (const i of DATA.redis.idx) {
      html += '<div style="background:var(--s1);border:1px solid var(--bd);border-radius:6px;padding:6px 12px">';
      html += '<b>' + esc(i.n) + '</b>';
      if (i.prefix) html += ' <span style="color:var(--mu);font-size:11px">prefix: <code>' + esc(i.prefix) + '</code></span>';
      html += '</div>';
    }
    html += '</div></div>';
  }
  return html;
}

// ── TYPESCRIPT TYPES ──────────────────────────────────────────────────────────
function renderTs() {
  const items = Q ? DATA.ts.filter(t => matches(t,[t.n, ...(t.fields||[]).map(f=>f.n+' '+f.t), t.body||''])) : DATA.ts;
  if (!items.length) return '<div class="empty">No types match "' + esc(Q) + '"</div>';
  const byFile = groupBy(items, t => t.f);
  return [...byFile.entries()].map(([file, types]) => {
    const id = fgId(file);
    const cards = types.map(t => {
      const kw = t.k ? 'interface' : 'type';
      const gen = t.g ? '<span class="ts-gen">' + esc(t.g) + '</span>' : '';
      const ext = t.ext ? '<span class="ts-ext">extends ' + esc(t.ext.join(', ')) + '</span>' : '';
      const intTag = t.int ? '<span class="item-int">(internal)</span>' : '';
      let html = '<div class="card"><div class="card-hdr">';
      html += '<span class="item-name">' + hi(t.n) + gen + ext + '</span>';
      html += '<span class="item-kw">' + kw + '</span>' + intTag;
      html += '<span class="line-ref">L' + t.l + '</span></div>';
      if (t.fields && t.fields.length) {
        html += '<table class="ft">' + t.fields.map(f => {
          const cls = 'fn' + (f.o?' opt':'') + (f.ro?' ro':'');
          return '<tr><td class="'+cls+'">' + hi(f.n) + '</td><td>' + ct(hi(f.t)) + '</td></tr>';
        }).join('') + '</table>';
      } else if (t.body) {
        html += '<div class="type-body">' + ct(hi(t.body)) + '</div>';
      }
      return html + '</div>';
    }).join('');
    return fg(id, file, types.length, 'type', cards);
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function groupBy(arr, key) {
  const m = new Map();
  for (const item of arr) { const k = key(item); if (!m.has(k)) m.set(k, []); m.get(k).push(item); }
  return m;
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function hi(s) {
  if (!Q) return esc(s);
  // Escape regex special chars without putting $ before { in the template literal
  var q2 = Q.replace(/[.*+?^|()[\]\\\\]/g,'\\\\$&').replace(/[{}$]/g,'\\\\$&');
  try { var rx = new RegExp('(' + q2 + ')', 'gi'); return esc(s).replace(rx,'<mark class="hl">$1</mark>'); }
  catch(e) { return esc(s); }
}
function ct(s) {
  return s
    .replace(/\\bstring\\(uuid\\)\\b/g,'<span class="tc-uuid">string(uuid)</span>')
    .replace(/\\bstring\\(url\\)\\b/g,'<span class="tc-url">string(url)</span>')
    .replace(/\\bstring\\(email\\)\\b/g,'<span class="tc-email">string(email)</span>')
    .replace(/\\bstring\\(datetime\\)\\b/g,'<span class="tc-dt">string(datetime)</span>')
    .replace(/\\bstring\\b/g,'<span class="tc-str">string</span>')
    .replace(/\\bnumber\\b/g,'<span class="tc-num">number</span>')
    .replace(/\\bboolean\\b/g,'<span class="tc-bool">boolean</span>')
    .replace(/\\bnull\\b/g,'<span class="tc-null">null</span>')
    .replace(/\\bundefined\\b/g,'<span class="tc-null">undefined</span>')
    .replace(/(&quot;[^&]*&quot;)/g,'<span class="tc-lit">$1</span>')
    .replace(/ \\| /g,' <span class="tc-pipe">|</span> ');
}
function fg(id, file, count, unit, cards) {
  const autoOpen = Q || count <= 3;
  return '<div class="fg' + (autoOpen?' open':'') + '" id="' + id + '">' +
    '<div class="fg-hdr" data-id="' + id + '">' +
    '<span class="fg-arrow">▶</span>' +
    '<span class="fg-path">' + hi(file) + '</span>' +
    '<span class="fg-badge">' + count + ' ' + unit + (count!==1?'s':'') + '</span>' +
    '</div><div class="fg-body">' + cards + '</div></div>';
}
function fgId(file) {
  return 'fg_' + file.replace(/[^a-zA-Z0-9]/g,'_');
}
function matches(item, parts) {
  return parts.some(p => p && p.toLowerCase().includes(Q));
}
function updateMatchCount() {
  const cards = document.querySelectorAll('.card').length;
  const el = document.getElementById('match-count');
  el.textContent = Q ? cards + ' match' + (cards!==1?'es':'') : '';
}
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSEMBLY — Combine all sections into final output files
// ═══════════════════════════════════════════════════════════════════════════════

function assembleFull(
  project: string,
  zod: { full: string; schemaCount: number; fileCount: number },
  drizzle: { full: string; tableCount: number; enumCount: number },
  redis: { full: string; keyCount: number },
  ts: { full: string; typeCount: number; fileCount: number },
): string {
  const date = new Date().toISOString().slice(0, 10);
  const abbrevLine = PATH_SEGS.map(([from, to]) => `${to}=${from}`).join("  ");
  const lines: string[] = [
    `${project.toUpperCase()} SUPERSCHEMA | ${date}`,
    `${zod.schemaCount}z · ${drizzle.tableCount}t+${drizzle.enumCount}e · ${redis.keyCount}k · ${ts.typeCount}ts/${ts.fileCount}f`,
    "",
    "# PATH ABBREVS",
    abbrevLine,
    "",
    `# ZOD  (${zod.schemaCount} schemas / ${zod.fileCount} files)`,
    `# schema(L)  field:type  opt?:type  ...spread  =scalar`,
    zod.full,
    `# POSTGRESQL  (${drizzle.tableCount} tables · ${drizzle.enumCount} enums)`,
    `# TABLE name  PK(cols) FK(col→tbl.col)  col:type![dflt]→fkref  ·uq(col) ·idx(col)`,
    drizzle.full,
    `# REDIS  (${redis.keyCount} keys)`,
    `# key:{pattern}  [ops]  →Schema  (file)  FT=RediSearch`,
    redis.full,
    `# TYPESCRIPT  (${ts.typeCount} decl / ${ts.fileCount} files)`,
    `# ·=internal  Name<T>(L)[type/iface] ext:extends  =body  field:type  opt?:type`,
    ts.full,
  ];
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun superschema.ts [--out <path>]");
  console.log(
    "  Generates audit/superschema.txt — full data model (Zod + PostgreSQL + Redis + TS types)",
  );
  process.exit(0);
}

const outArg = args.indexOf("--out");
const outPath =
  outArg !== -1
    ? resolve(process.cwd(), args[outArg + 1]!)
    : resolve(ROOT, "audit/superschema.txt");

const cfg = await loadConfig(ROOT);

// Use config path segments if provided, otherwise keep defaults
if (cfg.supergraph.pathSegments?.length) {
  PATH_SEGS = cfg.supergraph.pathSegments as [string, string][];
}

// Resolve paths from config (fall back to legacy schemas.commonDir for zodDirs)
const zodDirs = (
  cfg.superschema.zodDirs.length
    ? cfg.superschema.zodDirs
    : cfg.schemas.commonDir
      ? [cfg.schemas.commonDir]
      : []
).map((d) => resolve(ROOT, d));

const drizzleFiles = cfg.superschema.drizzleFiles.map((f) => resolve(ROOT, f));
const redisModelDirs = cfg.superschema.redisModelDirs.map((d) =>
  resolve(ROOT, d),
);
const typeDirs = cfg.superschema.typeDirs.map((d) => resolve(ROOT, d));

const t0 = Date.now();

// ── 1. Zod ────────────────────────────────────────────────────────────────────
console.log("Extracting Zod schemas...");
const { exported: exportedSchemas, all: allSchemas } =
  await discoverAndExtractZod(zodDirs);
const registry = buildRegistry(allSchemas);
const zodSection = generateZodSection(exportedSchemas, registry, zodDirs);
console.log(
  `  ${exportedSchemas.length} exported (${allSchemas.length} total) in ${new Set(exportedSchemas.map((s) => s.filePath)).size} files`,
);

// ── 2. Drizzle ────────────────────────────────────────────────────────────────
console.log("Extracting Drizzle/PostgreSQL schema...");
const { tables, enums } = await extractAllDrizzle(drizzleFiles);
const drizzleSection = generateDrizzleSection(tables, enums);
console.log(`  ${tables.length} tables, ${enums.length} enums`);

// ── 3. Redis ──────────────────────────────────────────────────────────────────
console.log("Extracting Redis key space...");
const { keyMap, ftIndexes } = await extractAllRedis(redisModelDirs);
const redisSection = generateRedisSection(keyMap, ftIndexes);
console.log(`  ${keyMap.size} key patterns, ${ftIndexes.length} FT indexes`);

// ── 4. TypeScript types ───────────────────────────────────────────────────────
console.log("Extracting TypeScript types...");
const tsTypeEntries = await extractAllTSTypes(typeDirs);
const tsSection = generateTSTypeSection(tsTypeEntries);
const tsFileCount = new Set(tsTypeEntries.map((e) => e.filePath)).size;
console.log(
  `  ${tsTypeEntries.length} declarations across ${tsFileCount} files`,
);

// ── Assemble & write ──────────────────────────────────────────────────────────
const full = assembleFull(
  cfg.project || "project",
  {
    full: zodSection.full,
    schemaCount: exportedSchemas.length,
    fileCount: new Set(exportedSchemas.map((s) => s.filePath)).size,
  },
  {
    full: drizzleSection.full,
    tableCount: tables.length,
    enumCount: enums.length,
  },
  { full: redisSection.full, keyCount: keyMap.size },
  {
    full: tsSection.full,
    typeCount: tsTypeEntries.length,
    fileCount: tsFileCount,
  },
);

// ── 5. HTML ───────────────────────────────────────────────────────────────────
console.log("Generating HTML visualization...");
const htmlData = buildHTMLData(
  exportedSchemas,
  registry,
  tables,
  enums,
  keyMap,
  ftIndexes,
  tsTypeEntries,
  cfg.project || "project",
);
const html = generateHTML(htmlData, cfg.project || "project");
const htmlPath = outPath.replace(/\.txt$/, ".html");

if (args.includes("--json")) {
  process.stdout.write(htmlData);
} else {
  await mkdir(resolve(ROOT, "audit"), { recursive: true });
  await Promise.all([Bun.write(outPath, full), Bun.write(htmlPath, html)]);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\nDone in ${elapsed}s`);
  console.log(
    `  ${(full.length / 1024).toFixed(0)} KB → ${relative(ROOT, outPath)}`,
  );
  console.log(
    `  ${(html.length / 1024).toFixed(0)} KB → ${relative(ROOT, htmlPath)}`,
  );
}
