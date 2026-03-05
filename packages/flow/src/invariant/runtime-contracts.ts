import type {
  RuntimeContract,
  Invariant,
  DiscoveredFunction,
  FunctionParam,
} from "./types.js";

const VERIFIED_STATUSES = ["no-counterexample", "proven"] as const;

export function invariantsToContracts(
  func: DiscoveredFunction,
  invariants: Invariant[]
): RuntimeContract[] {
  const contracts: RuntimeContract[] = [];
  for (const inv of invariants) {
    if (!VERIFIED_STATUSES.includes(inv.verificationStatus as (typeof VERIFIED_STATUSES)[number])) {
      continue;
    }
    if (inv.targetFunction !== func.name || inv.targetFile !== func.filePath) {
      continue;
    }
    contracts.push({
      targetFunction: func.name,
      targetFile: func.filePath,
      position: "post",
      condition: adaptConditionForRuntime(inv.postcondition, func.params),
      message: `Invariant "${inv.name}" violated in ${func.name}: ${inv.description}`,
      enabled: true,
    });
  }
  return contracts;
}

function adaptConditionForRuntime(
  postcondition: string,
  params: FunctionParam[]
): string {
  let cond = postcondition.replace(/\bresult\b/g, "__invariantResult");
  if (params.length === 0) {
    cond = cond.replace(/\binput\b/g, "undefined");
  } else if (params.length === 1) {
    cond = cond.replace(/\binput\b/g, params[0]!.name);
  } else {
    for (const p of params) {
      const re = new RegExp(`\\binput\\.${escapeRegex(p.name)}\\b`, "g");
      cond = cond.replace(re, p.name);
    }
    cond = cond.replace(/\binput\b/g, "undefined");
  }
  return cond;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function generateContractCode(contracts: RuntimeContract[]): string {
  if (contracts.length === 0) return "";
  const pre = contracts.filter((c) => c.position === "pre" && c.enabled);
  const post = contracts.filter((c) => c.position === "post" && c.enabled);
  const lines: string[] = [];
  if (pre.length > 0) {
    lines.push("// Runtime preconditions (auto-generated from verified invariants)");
    for (const c of pre) {
      lines.push(`invariant(${c.condition}, \`${escapeMessage(c.message)}\`);`);
    }
  }
  if (post.length > 0) {
    lines.push("// Runtime postconditions (auto-generated from verified invariants)");
    for (const c of post) {
      lines.push(`invariant(${c.condition}, \`${escapeMessage(c.message)}\`);`);
    }
  }
  return lines.join("\n");
}

function escapeMessage(msg: string): string {
  return msg.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

export function generateContractImport(): string {
  return 'import invariant from "tiny-invariant";';
}

function hasInvariantImport(sourceCode: string): boolean {
  return /import\s+invariant\s+from\s+["']tiny-invariant["']/.test(sourceCode);
}

function findFunctionBody(
  sourceCode: string,
  funcName: string
): { bodyStart: number; bodyEnd: number } | null {
  const patterns = [
    new RegExp(`function\\s+${escapeRegex(funcName)}\\s*\\(`, "g"),
    new RegExp(`(?:const|let|var)\\s+${escapeRegex(funcName)}\\s*=\\s*(?:\\([^)]*\\)\\s*=>|function\\s*\\()`, "g"),
    new RegExp(`${escapeRegex(funcName)}\\s*:\\s*(?:async\\s+)?function\\s*\\(`, "g"),
    new RegExp(`${escapeRegex(funcName)}\\s*:\\s*\\([^)]*\\)\\s*=>`, "g"),
    new RegExp(`\\b${escapeRegex(funcName)}\\s*\\([^)]*\\)\\s*\\{`, "g"),
  ];
  for (const re of patterns) {
    const m = re.exec(sourceCode);
    if (m) {
      const afterMatch = m.index + m[0].length;
      const openParen = sourceCode.indexOf("(", m.index);
      let brace = sourceCode.indexOf("{", openParen);
      if (brace === -1 && sourceCode.slice(afterMatch).trimStart().startsWith("=>")) {
        const arrowBody = sourceCode.slice(afterMatch);
        const arrowMatch = arrowBody.match(/=>\s*\{/);
        if (arrowMatch) {
          brace = afterMatch + arrowMatch.index! + arrowMatch[0].indexOf("{");
        }
      }
      if (brace !== -1) {
        let depth = 1;
        let i = brace + 1;
        while (i < sourceCode.length && depth > 0) {
          const ch = sourceCode[i];
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          i++;
        }
        return { bodyStart: brace + 1, bodyEnd: i - 1 };
      }
      break;
    }
  }
  return null;
}

export function applyContracts(
  sourceCode: string,
  func: DiscoveredFunction,
  contracts: RuntimeContract[]
): string {
  if (contracts.length === 0) return sourceCode;

  const preContracts = contracts.filter((c) => c.position === "pre" && c.enabled);
  const postContracts = contracts.filter((c) => c.position === "post" && c.enabled);
  if (preContracts.length === 0 && postContracts.length === 0) return sourceCode;

  let result = sourceCode;

  if (!hasInvariantImport(result)) {
    result = generateContractImport() + "\n" + result;
  }

  const body = findFunctionBody(result, func.name);
  if (!body) return result;

  let bodyStart = body.bodyStart;
  let bodyEnd = body.bodyEnd;
  if (preContracts.length > 0) {
    const preCode = preContracts
      .map((c) => `invariant(${c.condition}, \`${escapeMessage(c.message)}\`);`)
      .join("\n");
    const insert = `\n  ${preCode}\n  `;
    result = result.slice(0, body.bodyStart) + insert + result.slice(body.bodyStart);
    bodyStart = body.bodyStart + insert.length;
    bodyEnd = body.bodyEnd + insert.length;
  }

  if (postContracts.length > 0) {
    const bodySection = result.slice(bodyStart, bodyEnd);
    const returnRegex = /return\s+([\s\S]+?)\s*;(?=\s*(?:\n|\}))/g;
    const replacements: { from: number; to: number; replacement: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = returnRegex.exec(bodySection)) !== null) {
      const returnExpr = m[1]!.trim();
      const start = bodyStart + m.index;
      const end = bodyStart + m.index + m[0].length;
      const checks = postContracts
        .map(
          (c) =>
            `invariant(${c.condition}, \`${escapeMessage(c.message)}\`);`
        )
        .join("\n  ");
      const replacement = `const __invariantResult = ${returnExpr};\n  ${checks}\n  return __invariantResult;`;
      replacements.push({ from: start, to: end, replacement });
    }
    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i]!;
      result = result.slice(0, r.from) + r.replacement + result.slice(r.to);
    }
  }

  return result;
}
