import type { ConsistencyInput, ConsistencyVerdict } from "./types.js";

export async function checkConsistency(
  input: ConsistencyInput,
  llmCheck: (prompt: string) => Promise<ConsistencyVerdict[]>
): Promise<ConsistencyVerdict[]> {
  const prompt = buildConsistencyPrompt(input);
  return llmCheck(prompt);
}

export function buildConsistencyPrompt(input: ConsistencyInput): string {
  const { func, jsdoc, inlineComments, invariants, specDescription } = input;
  const jsdocText = jsdoc ?? "None";
  const commentsText =
    inlineComments.length > 0
      ? inlineComments.join("\n")
      : "None";
  const invariantsText =
    invariants.length > 0
      ? invariants
          .map(
            (inv) =>
              `- ${inv.name}: ${inv.postcondition} (confidence: ${inv.confidence})`
          )
          .join("\n")
      : "None";
  const specText = specDescription ?? "None provided";

  return `Compare these artifacts for the function \`${func.name}\` and identify any inconsistencies.

## Code (what the code does)
\`\`\`typescript
${func.sourceText}
\`\`\`

## Documentation (what the developer intended)
JSDoc: ${jsdocText}
Inline comments: ${commentsText}

## Invariants (what should be true)
${invariantsText}

## Specification
${specText}

## Task
For each pair of artifacts, determine if they agree or disagree:
1. Code vs Documentation: Does the code behavior match what the docs describe?
2. Code vs Invariants: Does the code satisfy the stated invariants?
3. Documentation vs Invariants: Do the docs and invariants describe the same behavior?

Respond with a JSON array of verdicts. Each verdict is one of:
- { "type": "consistent", "confidence": <0-1> }
- { "type": "code-doc-mismatch", "description": "...", "evidence": "..." }
- { "type": "code-invariant-mismatch", "description": "...", "counterexample": ... }
- { "type": "doc-invariant-mismatch", "description": "...", "docSays": "...", "invariantSays": "..." }
- { "type": "all-three-disagree", "description": "..." }
`;
}

const JSDOC_RE = /\/\*\*[\s\S]*?\*\//;

export function extractJSDoc(sourceText: string): string | null {
  const match = sourceText.match(JSDOC_RE);
  if (!match) return null;
  const raw = match[0];
  const trimmed = raw
    .replace(/^\s*\/\*\*/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^\s*\*\s?/gm, "")
    .trim();
  return trimmed || null;
}

export function extractInlineComments(sourceText: string): string[] {
  const bodyStart = sourceText.indexOf("{");
  if (bodyStart < 0) return [];
  const body = sourceText.slice(bodyStart);
  const comments: string[] = [];
  const lineCommentRe = /\/\/[^\n]*/g;
  const blockCommentRe = /\/\*[\s\S]*?\*\//g;
  for (const m of body.matchAll(lineCommentRe)) {
    const text = m[0].replace(/^\/\/\s*/, "").trim();
    if (text) comments.push(text);
  }
  for (const m of body.matchAll(blockCommentRe)) {
    const raw = m[0];
    if (raw.startsWith("/**")) continue;
    const text = raw
      .replace(/^\/\*/, "")
      .replace(/\*\/$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) comments.push(text);
  }
  return comments;
}
