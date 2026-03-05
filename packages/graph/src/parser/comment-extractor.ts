import { parse, Lang } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";

export type CommentKind = "jsdoc" | "section" | "line" | "block";

export interface ExtractedComment {
  text: string;
  kind: CommentKind;
  line: number;
  endLine: number;
  /** Start line of the next declaration this comment is attached to, if any. */
  attachedToLine: number | null;
}

const TRIVIAL_PATTERN = /^(skip|ignore|fall\s*through|already|noop|no-op|empty|todo)$/i;

function classifyComment(text: string): CommentKind {
  if (text.startsWith("/**")) return "jsdoc";
  if (text.startsWith("//") && /^\/\/\s*[─━═]/.test(text)) return "section";
  if (text.startsWith("//")) return "line";
  return "block";
}

const DIVIDER_PATTERN = /^\/\/\s*[-─━═*=]{5,}\s*$/;

function isTrivial(text: string, kind: CommentKind): boolean {
  if (kind === "jsdoc") return false;
  if (DIVIDER_PATTERN.test(text)) return true;

  if (kind === "section") return false;

  const stripped = text
    .replace(/^\/\*+\s*|\s*\*+\/$/g, "")
    .replace(/^\/\/\s*/, "")
    .trim();

  if (stripped.length < 15) return true;
  if (TRIVIAL_PATTERN.test(stripped)) return true;
  return false;
}

function getAttachedLine(node: SgNode): number | null {
  const next = node.next();
  if (!next) return null;
  const nextKind = next.kind();
  if (nextKind === "comment") return null;
  return next.range().start.line;
}

/**
 * Extract meaningful comments from TypeScript source code.
 * Filters out trivial comments (short, mechanical) and classifies
 * the rest as jsdoc, section headers, line comments, or block comments.
 */
export function extractComments(
  code: string,
  filePath: string,
): ExtractedComment[] {
  const lang = filePath.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript;
  const tree = parse(lang, code);
  const root = tree.root();
  const commentNodes = root.findAll({ rule: { kind: "comment" } });
  const results: ExtractedComment[] = [];

  for (const node of commentNodes) {
    const text = node.text();
    const kind = classifyComment(text);
    if (isTrivial(text, kind)) continue;

    results.push({
      text,
      kind,
      line: node.range().start.line,
      endLine: node.range().end.line,
      attachedToLine: getAttachedLine(node),
    });
  }

  return results;
}
