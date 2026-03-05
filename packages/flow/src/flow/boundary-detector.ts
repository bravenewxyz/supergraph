import { parse, Lang } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type {
  BoundaryKind,
  DataBoundary,
  ErrorPathInfo,
} from "../schema/boundaries.js";
import type { ExtractorRegistry } from "../extractor/runtime-schema.js";
import { collectSourceFiles } from "../extractor/typescript.js";

export interface BoundaryPattern {
  kind: BoundaryKind;
  patterns: string[];
  library?: string;
}

const BUILTIN_PATTERNS: BoundaryPattern[] = [
  {
    kind: "json-serialize",
    patterns: ["JSON.stringify($DATA)"],
  },
  {
    kind: "json-deserialize",
    patterns: ["JSON.parse($DATA)"],
  },
  {
    kind: "file-write",
    patterns: [
      "writeFileSync($PATH, $DATA)",
      "writeFile($PATH, $DATA)",
      "Bun.write($PATH, $DATA)",
    ],
  },
  {
    kind: "file-read",
    patterns: [
      "readFileSync($PATH)",
      "readFile($PATH)",
    ],
  },
  {
    kind: "subprocess-spawn",
    patterns: ["Bun.spawn($$$)", "Bun.spawnSync($$$)"],
  },
  {
    kind: "http-send",
    patterns: ["fetch($URL)"],
  },
];

const TYPE_ASSERTION_PATTERN = "$EXPR as $TYPE";

export interface BoundaryDetectorOptions {
  srcDir: string;
  extractorRegistry?: ExtractorRegistry;
  additionalPatterns?: BoundaryPattern[];
  includeTypeAssertions?: boolean;
}

export async function detectBoundaries(
  options: BoundaryDetectorOptions,
): Promise<DataBoundary[]> {
  const {
    srcDir,
    extractorRegistry,
    additionalPatterns = [],
    includeTypeAssertions = true,
  } = options;

  const allPatterns: BoundaryPattern[] = [...BUILTIN_PATTERNS, ...additionalPatterns];

  if (extractorRegistry) {
    for (const { library, patterns } of extractorRegistry.allValidationPatterns()) {
      allPatterns.push({ kind: "schema-validate", patterns, library });
    }
  }

  const files = await collectSourceFiles(srcDir);
  const boundaries: DataBoundary[] = [];

  for (const filePath of files) {
    const source = await readFile(filePath, "utf-8");
    const tree = parse(Lang.TypeScript, source);
    const root = tree.root();
    const relPath = relative(srcDir, filePath);

    for (const bp of allPatterns) {
      for (const pattern of bp.patterns) {
        const matches = root.findAll({ rule: { pattern } });
        for (const match of matches) {
          const range = match.range();
          const funcCtx = findEnclosingFunction(match);

          boundaries.push({
            kind: bp.kind,
            filePath: relPath,
            line: range.start.line + 1,
            column: range.start.column,
            functionContext: funcCtx ?? "<module>",
            raw: truncate(match.text(), 200),
            inputType: null,
            outputType: null,
            runtimeSchema: bp.kind === "schema-validate"
              ? { library: bp.library ?? "unknown", schemaName: extractSchemaName(match), shape: { kind: "opaque", raw: "" }, source: "runtime-schema" }
              : null,
            errorHandler: analyzeErrorPath(match, source),
          });
        }
      }
    }

    if (includeTypeAssertions) {
      const assertions = root.findAll({ rule: { pattern: TYPE_ASSERTION_PATTERN } });
      for (const match of assertions) {
        if (isTrivialAssertion(match)) continue;

        const range = match.range();
        const funcCtx = findEnclosingFunction(match);
        const isDoubleCast = match.text().includes("as unknown as ") || match.text().includes("as any as ");

        boundaries.push({
          kind: "type-assertion",
          filePath: relPath,
          line: range.start.line + 1,
          column: range.start.column,
          functionContext: funcCtx ?? "<module>",
          raw: truncate(match.text(), 200),
          inputType: null,
          outputType: null,
          runtimeSchema: null,
          errorHandler: isDoubleCast
            ? {
                kind: "throw",
                fallbackValue: null,
                logLevel: "none",
                line: range.start.line + 1,
              }
            : null,
        });
      }
    }
  }

  return boundaries;
}

function findEnclosingFunction(node: SgNode): string | null {
  let current = node.parent();
  while (current) {
    const kind = current.kind();
    if (
      kind === "function_declaration" ||
      kind === "method_definition"
    ) {
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

function extractSchemaName(node: SgNode): string {
  const text = node.text();
  const match = text.match(/^(\w+)\.\w+Parse\(/) ?? text.match(/^(\w+)\.parse\(/) ?? text.match(/^(\w+)\.validate\(/);
  return match?.[1] ?? "unknown";
}

function analyzeErrorPath(
  boundaryNode: SgNode,
  _source: string,
): ErrorPathInfo | null {
  let current = boundaryNode.parent();
  while (current) {
    if (current.kind() === "try_statement") {
      const handler = current.field("handler");
      if (handler) {
        const body = handler.field("body");
        if (!body) return null;
        const bodyText = body.text();

        const returnNodes = body.findAll({ rule: { kind: "return_statement" } });
        const fallbackValue = returnNodes[0]
          ? truncate(returnNodes[0].text().replace(/^return\s+/, ""), 120)
          : null;

        let logLevel: ErrorPathInfo["logLevel"] = "none";
        const logMatch = bodyText.match(/logger\.(\w+)|console\.(\w+)/);
        if (logMatch) {
          const level = logMatch[1] ?? logMatch[2];
          if (level === "error" || level === "warn" || level === "info" || level === "debug") {
            logLevel = level;
          }
        }

        return {
          kind: "catch",
          fallbackValue,
          logLevel,
          line: handler.range().start.line + 1,
        };
      }
    }

    // Check for safeParse .success check
    if (current.kind() === "if_statement") {
      const condition = current.field("condition");
      if (condition) {
        const condText = condition.text();
        if (
          condText.includes(".success") ||
          condText.includes("safeParse") ||
          condText.includes(".ok")
        ) {
          const consequence = current.field("consequence");
          const alternative = current.field("alternative");

          const failBranch = condText.startsWith("!")
            ? consequence
            : alternative;

          if (failBranch) {
            const branchText = failBranch.text();
            const returnNodes = failBranch.findAll({ rule: { kind: "return_statement" } });
            const fallbackValue = returnNodes[0]
              ? truncate(returnNodes[0].text().replace(/^return\s+/, ""), 120)
              : null;

            return {
              kind: "validation-failure",
              fallbackValue,
              logLevel: /logger\.(error|warn)/.test(branchText) ? "warn" : "none",
              line: failBranch.range().start.line + 1,
            };
          }
        }
      }
    }

    current = current.parent();
  }

  return null;
}

function isTrivialAssertion(node: SgNode): boolean {
  const text = node.text();
  return (
    text.endsWith("as const") ||
    text.endsWith("as string") ||
    text.endsWith("as number") ||
    text.endsWith("as boolean") ||
    /as\s+\w+\[\]$/.test(text)
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}
