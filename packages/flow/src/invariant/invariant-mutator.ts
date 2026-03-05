import type { MutationResult } from "./types.js";

export type MutatedInvariant = {
  kind: MutationResult["kind"];
  mutatedPostcondition: string;
};

export function mutateInvariant(postcondition: string): MutatedInvariant[] {
  const results: MutatedInvariant[] = [];
  const seen = new Set<string>();

  const add = (kind: MutatedInvariant["kind"], expr: string) => {
    const trimmed = expr.trim();
    if (trimmed && trimmed !== postcondition && !seen.has(trimmed)) {
      seen.add(trimmed);
      results.push({ kind, mutatedPostcondition: trimmed });
    }
  };

  for (const m of weaken(postcondition)) add("weaken", m);
  for (const m of strengthen(postcondition)) add("strengthen", m);
  for (const m of generalize(postcondition)) add("generalize", m);
  for (const m of specialize(postcondition)) add("specialize", m);

  return results;
}

function weaken(postcondition: string): string[] {
  const out: string[] = [];
  const inputFields = [...postcondition.matchAll(/\binput\.(\w+)/g)]
    .map((m) => m[1])
    .filter((x): x is string => x !== undefined);
  const resultFields = [...postcondition.matchAll(/\bresult\.(\w+)/g)]
    .map((m) => m[1])
    .filter((x): x is string => x !== undefined);
  const candidates = [...new Set([...inputFields, ...resultFields])];

  const guardsFor = (
    antecedent: string,
    field: string,
    prefix: "input" | "result"
  ): string[] => {
    const guardUndef = `${prefix}.${field} !== undefined`;
    const guardLen = `${prefix}.${field}.length > 0`;
    const added: string[] = [];
    if (!antecedent.includes(guardUndef)) {
      added.push(`${antecedent.trimEnd()} && ${guardUndef}`);
    }
    if (!antecedent.includes(guardLen)) {
      added.push(`${antecedent.trimEnd()} && ${guardLen}`);
    }
    return added;
  };

  const ternaryMatch = postcondition.match(
    /^(.+?)\s*\?\s*(.+?)\s*:\s*true\s*$/
  );
  if (ternaryMatch) {
    const ante = ternaryMatch[1] ?? "";
    const cons = ternaryMatch[2] ?? "";
    if (ante && cons) {
      for (const f of candidates) {
        const prefix = inputFields.includes(f) ? "input" : "result";
        for (const newAnte of guardsFor(ante, f, prefix)) {
          out.push(`${newAnte} ? ${cons} : true`);
        }
      }
    }
  }

  const orMatch = postcondition.match(/^!\s*\((.+?)\)\s*\|\|\s*(.+?)\s*$/);
  if (orMatch) {
    const ante = orMatch[1] ?? "";
    const cons = orMatch[2] ?? "";
    if (ante && cons) {
      for (const f of candidates) {
        const prefix = inputFields.includes(f) ? "input" : "result";
        for (const newAnte of guardsFor(ante, f, prefix)) {
          out.push(`!(${newAnte}) || ${cons}`);
        }
      }
    }
  }

  return out;
}

function strengthen(postcondition: string): string[] {
  const out: string[] = [];

  for (const m of postcondition.matchAll(
    /\bresult\.(\w+)\s*===\s*(?:"[^"]*"|'[^']*'|\w+)/g
  )) {
    const full = m[0];
    const field = m[1];
    const undefCheck = `result.${field} !== undefined`;
    if (postcondition.includes(undefCheck)) continue;
    const strengthened = `${full} && ${undefCheck}`;
    out.push(postcondition.replace(full, strengthened));
  }

  for (const m of postcondition.matchAll(
    /\bresult\.(\w+)\s*===\s*["'][^"']*["']/g
  )) {
    const full = m[0];
    const field = m[1];
    const typeCheck = `typeof result.${field} === "string"`;
    if (postcondition.includes(typeCheck)) continue;
    const strengthened = `${full} && ${typeCheck}`;
    out.push(postcondition.replace(full, strengthened));
  }

  return out;
}

function generalize(postcondition: string): string[] {
  const out: string[] = [];

  out.push(
    ...replaceAll(
      postcondition,
      /(\S+)\s*===\s*["']failed["']/g,
      (_, left) => `${left.trim()} !== "complete"`
    )
  );
  out.push(
    ...replaceAll(postcondition, /(\S+)\s*===\s*0\b/g, (_, left) => `${left.trim()} >= 0`)
  );
  out.push(
    ...replaceAll(postcondition, /(\S+)\s*>\s*0\b/g, (_, left) => `${left.trim()} >= 0`)
  );
  out.push(
    ...replaceAll(
      postcondition,
      /(\S+)\s*===\s*true\b/g,
      (_, left) => `${left.trim()} !== false`
    )
  );

  return out;
}

function specialize(postcondition: string): string[] {
  const out: string[] = [];

  out.push(
    ...replaceAll(
      postcondition,
      /(\S+)\s*!==\s*["']complete["']/g,
      (_, left) => `${left.trim()} === "failed"`
    )
  );
  out.push(
    ...replaceAll(postcondition, /(\S+)\s*>=\s*0\b/g, (_, left) => `${left.trim()} === 0`)
  );
  out.push(
    ...replaceAll(
      postcondition,
      /(\S+)\s*!==\s*false\b/g,
      (_, left) => `${left.trim()} === true`
    )
  );

  return out;
}

function replaceAll(
  str: string,
  re: RegExp,
  replacer: (match: string, ...groups: string[]) => string
): string[] {
  const out: string[] = [];
  const copy = str;
  const regex = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = regex.exec(copy)) !== null) {
    const replaced = replacer(m[0], ...m.slice(1));
    const before = copy.slice(0, m.index);
    const after = copy.slice(m.index + m[0].length);
    out.push(before + replaced + after);
  }
  return out;
}

