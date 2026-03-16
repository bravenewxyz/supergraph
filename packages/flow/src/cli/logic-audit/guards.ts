// ── 2. Guard consistency scan ───────────────────────────────────────

import type { GuardInconsistency, PushSite, OpSite, AssignSite } from "./types.js";

export function scanGuardConsistency(
  source: string,
  filePath: string,
): GuardInconsistency[] {
  const lines = source.split("\n");
  const results: GuardInconsistency[] = [];

  // Find for-loops and their bodies
  const forPattern = /^\s*for\s*\(\s*(const|let|var)\s+(\w+)\s+(of|in)\s+/;
  const pushPattern = /(\w+(?:\.\w+)*)\s*\.\s*push\s*\(/;
  const ifPattern = /^\s*if\s*\(/;

  let loopStart = -1;
  let loopVar = "";
  let braceDepth = 0;
  let inLoop = false;
  let loopDepth = 0;

  const pushSites: PushSite[] = [];
  let currentIfGuard: string | null = null;
  let currentIfLine = -1;
  let ifDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const forMatch = line.match(forPattern);
    if (forMatch && !inLoop) {
      loopStart = i;
      loopVar = forMatch[2]!;
      inLoop = true;
      loopDepth = braceDepth;
      pushSites.length = 0;
      currentIfGuard = null;
    }

    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (inLoop && braceDepth <= loopDepth) {
          analyzePushSites(pushSites, loopVar, filePath, loopStart, results, lines);
          inLoop = false;
          pushSites.length = 0;
        }
        if (ifDepth > 0 && braceDepth < ifDepth) {
          currentIfGuard = null;
          ifDepth = 0;
        }
      }
    }

    if (inLoop) {
      const ifMatch = line.match(ifPattern);
      if (ifMatch) {
        const guardText = line.replace(/^\s*if\s*\(/, "").replace(/\)\s*\{?\s*$/, "").trim();
        currentIfGuard = guardText;
        currentIfLine = i;
        ifDepth = braceDepth;
      }

      const pushMatch = line.match(pushPattern);
      if (pushMatch) {
        pushSites.push({
          collection: pushMatch[1]!,
          line: i + 1,
          guard: currentIfGuard,
          guardLine: currentIfGuard ? currentIfLine + 1 : null,
        });
      }
    }
  }

  return results;
}

export function analyzePushSites(
  pushSites: PushSite[],
  loopVar: string,
  filePath: string,
  loopStart: number,
  results: GuardInconsistency[],
  sourceLines?: string[],
): void {
  if (pushSites.length < 2) return;

  const guarded = pushSites.filter((p) => p.guard !== null);
  const unguarded = pushSites.filter((p) => p.guard === null);

  if (guarded.length > 0 && unguarded.length > 0) {
    for (const g of guarded) {
      for (const u of unguarded) {
        if (g.collection !== u.collection) continue;
        const confidence = scoreGuardConfidence(
          g.collection, u.collection, sourceLines,
        );
        results.push({
          filePath,
          line: loopStart + 1,
          loopVariable: loopVar,
          guardedPush: {
            collection: g.collection,
            guard: g.guard!,
            line: g.line,
          },
          unguardedPush: {
            collection: u.collection,
            line: u.line,
          },
          message: `"${u.collection}.push()" at line ${u.line} has no guard, but "${g.collection}.push()" at line ${g.line} is guarded by "${g.guard}". Possible missing check.`,
          confidence,
        });
      }
    }
  }
}

export function scoreGuardConfidence(
  guardedCol: string,
  unguardedCol: string,
  sourceLines?: string[],
): "high" | "med" | "low" {
  if (!sourceLines) return "med";
  const guardedBase = guardedCol.split(".").pop() ?? guardedCol;
  const unguardedBase = unguardedCol.split(".").pop() ?? unguardedCol;
  const coConsumed = sourceLines.some(
    (line) => line.includes(guardedBase) && line.includes(unguardedBase),
  );
  if (coConsumed) return "high";
  let guardedUsages = 0;
  let unguardedUsages = 0;
  for (const line of sourceLines) {
    if (line.includes(guardedBase) && !line.includes(".push")) guardedUsages++;
    if (line.includes(unguardedBase) && !line.includes(".push")) unguardedUsages++;
  }
  if (guardedUsages > 0 && unguardedUsages > 0) return "med";
  return "low";
}

// ── 2b. Broad guard consistency scan ────────────────────────────────

export function scanBroadGuardConsistency(
  source: string,
  filePath: string,
): GuardInconsistency[] {
  const lines = source.split("\n");
  const results: GuardInconsistency[] = [];

  // Pattern 1: forEach/map with conditional operations
  scanForEachMapGuards(lines, filePath, results);

  // Pattern 2: Switch statements with missing cases (no default)
  scanSwitchMissingCases(lines, filePath, results);

  // Pattern 3: Parallel conditional assignments
  scanConditionalAssignments(lines, filePath, results);

  // Pattern 4: Promise.all with mixed error handling
  scanPromiseAllMixedCatch(lines, filePath, results);

  return results;
}

/**
 * Pattern 1: array.forEach / array.map with mixed guarded/unguarded operations
 * Detects: arr.forEach(item => { if (cond) doA(item); doB(item); })
 */
export function scanForEachMapGuards(
  lines: string[],
  filePath: string,
  results: GuardInconsistency[],
): void {
  const forEachPattern = /(\w+(?:\.\w+)*)\s*\.\s*(forEach|map)\s*\(\s*(?:\(?\s*(\w+))/;
  const callPattern = /(\w+(?:\.\w+)*)\s*\(/;
  const ifPattern = /^\s*if\s*\(/;

  let inCallback = false;
  let callbackStart = -1;
  let callbackVar = "";
  let braceDepth = 0;
  let callbackDepth = 0;

  let opSites: OpSite[] = [];
  let currentIfGuard: string | null = null;
  let ifDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const feMatch = line.match(forEachPattern);
    if (feMatch && !inCallback) {
      callbackStart = i;
      callbackVar = feMatch[3] ?? "";
      inCallback = true;
      callbackDepth = braceDepth;
      opSites = [];
      currentIfGuard = null;
    }

    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (inCallback && braceDepth <= callbackDepth) {
          analyzeOpSites(opSites, callbackVar, filePath, callbackStart, results);
          inCallback = false;
          opSites = [];
        }
        if (ifDepth > 0 && braceDepth < ifDepth) {
          currentIfGuard = null;
          ifDepth = 0;
        }
      }
    }

    if (inCallback) {
      const ifMatch = line.match(ifPattern);
      if (ifMatch) {
        const guardText = line.replace(/^\s*if\s*\(/, "").replace(/\)\s*\{?\s*$/, "").trim();
        currentIfGuard = guardText;
        ifDepth = braceDepth;
      }

      // Look for function calls (but skip the forEach/map itself and control-flow keywords)
      const trimmed = line.trim();
      if (!trimmed.startsWith("if") && !trimmed.startsWith("for") && !trimmed.startsWith("while") &&
          !trimmed.startsWith("//") && !trimmed.startsWith("}") && !trimmed.startsWith("{")) {
        const cm = trimmed.match(callPattern);
        if (cm && !cm[1]!.match(/\b(forEach|map|filter|reduce|console|if|for|while|switch)\b/)) {
          opSites.push({
            op: cm[1]!,
            line: i + 1,
            guard: currentIfGuard,
          });
        }
      }
    }
  }
}

export function analyzeOpSites(
  opSites: OpSite[],
  callbackVar: string,
  filePath: string,
  callbackStart: number,
  results: GuardInconsistency[],
): void {
  if (opSites.length < 2) return;

  const guarded = opSites.filter((p) => p.guard !== null);
  const unguarded = opSites.filter((p) => p.guard === null);

  if (guarded.length > 0 && unguarded.length > 0) {
    for (const g of guarded) {
      for (const u of unguarded) {
        const gBase = g.op.split(".").pop();
        const uBase = u.op.split(".").pop();
        if (gBase !== uBase) continue; // Only compare same-method operations
        if (g.op === u.op) continue;   // Skip exact same target
        results.push({
          filePath,
          line: callbackStart + 1,
          loopVariable: callbackVar,
          guardedPush: {
            collection: g.op,
            guard: g.guard!,
            line: g.line,
          },
          unguardedPush: {
            collection: u.op,
            line: u.line,
          },
          message: `"${u.op}()" at line ${u.line} has no guard, but "${g.op}()" at line ${g.line} is guarded by "${g.guard}" inside forEach/map callback. Possible missing check.`,
          confidence: "med",
        });
      }
    }
  }
}

/**
 * Pattern 2: Switch statements with missing cases
 * Detects switch on union/enum values without covering all cases and no default
 */
export function scanSwitchMissingCases(
  lines: string[],
  filePath: string,
  results: GuardInconsistency[],
): void {
  const switchPattern = /^\s*switch\s*\(\s*(\w+(?:\.\w+)*)\s*\)/;
  const casePattern = /^\s*case\s+["'](\w+)["']\s*:/;
  const defaultPattern = /^\s*default\s*:/;

  let inSwitch = false;
  let switchLine = -1;
  let switchVar = "";
  let braceDepth = 0;
  let switchDepth = 0;
  let cases: string[] = [];
  let hasDefault = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const sm = line.match(switchPattern);
    if (sm && !inSwitch) {
      switchLine = i;
      switchVar = sm[1]!;
      inSwitch = true;
      switchDepth = braceDepth;
      cases = [];
      hasDefault = false;
    }

    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (inSwitch && braceDepth <= switchDepth) {
          // Switch ended — if we have cases but no default and few cases, flag it
          if (cases.length >= 2 && !hasDefault) {
            results.push({
              filePath,
              line: switchLine + 1,
              loopVariable: switchVar,
              guardedPush: {
                collection: `case "${cases[0]}"`,
                guard: `switch(${switchVar})`,
                line: switchLine + 1,
              },
              unguardedPush: {
                collection: "default",
                line: switchLine + 1,
              },
              message: `switch(${switchVar}) at line ${switchLine + 1} handles ${cases.length} cases [${cases.join(", ")}] but has no default. Possible missing case.`,
              confidence: "low",
            });
          }
          inSwitch = false;
        }
      }
    }

    if (inSwitch) {
      const cm = line.match(casePattern);
      if (cm) cases.push(cm[1]!);
      if (defaultPattern.test(line)) hasDefault = true;
    }
  }
}

/**
 * Pattern 3: Parallel conditional assignments
 * Detects: if (cond) { a = x; } b = y; — where some assignments are guarded, others aren't
 */
export function scanConditionalAssignments(
  lines: string[],
  filePath: string,
  results: GuardInconsistency[],
): void {
  const assignPattern = /^\s*(\w+)\s*=\s*.+;/;
  const ifPattern = /^\s*if\s*\(/;

  // Scan blocks of closely-spaced assignments
  const assignSites: AssignSite[] = [];
  let currentGuard: string | null = null;
  let guardBraceDepth = 0;
  let braceDepth = 0;
  let inIfBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const ifMatch = line.match(ifPattern);
    if (ifMatch) {
      const guardText = line.replace(/^\s*if\s*\(/, "").replace(/\)\s*\{?\s*$/, "").trim();
      currentGuard = guardText;
      inIfBlock = true;
      guardBraceDepth = braceDepth;
    }

    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (inIfBlock && braceDepth <= guardBraceDepth) {
          currentGuard = null;
          inIfBlock = false;
        }
      }
    }

    const am = line.match(assignPattern);
    if (am && !line.trim().startsWith("//") && !line.trim().startsWith("const ") &&
        !line.trim().startsWith("let ") && !line.trim().startsWith("var ")) {
      assignSites.push({
        varName: am[1]!,
        line: i + 1,
        guard: currentGuard,
      });
    }
  }

  // Look for groups of assignments to related variables where some are guarded and some aren't
  // Group by proximity (within 5 lines of each other)
  for (let i = 0; i < assignSites.length; i++) {
    for (let j = i + 1; j < assignSites.length; j++) {
      const a = assignSites[i]!;
      const b = assignSites[j]!;
      if (Math.abs(a.line - b.line) > 5) continue;
      if (a.varName === b.varName) continue;

      if (a.guard !== null && b.guard === null) {
        results.push({
          filePath,
          line: a.line,
          loopVariable: "",
          guardedPush: {
            collection: `${a.varName} =`,
            guard: a.guard,
            line: a.line,
          },
          unguardedPush: {
            collection: `${b.varName} =`,
            line: b.line,
          },
          message: `Assignment to "${b.varName}" at line ${b.line} is unguarded, but assignment to "${a.varName}" at line ${a.line} is guarded by "${a.guard}". Possible missing check for parallel assignment.`,
          confidence: "low",
        });
      } else if (b.guard !== null && a.guard === null) {
        results.push({
          filePath,
          line: b.line,
          loopVariable: "",
          guardedPush: {
            collection: `${b.varName} =`,
            guard: b.guard,
            line: b.line,
          },
          unguardedPush: {
            collection: `${a.varName} =`,
            line: a.line,
          },
          message: `Assignment to "${a.varName}" at line ${a.line} is unguarded, but assignment to "${b.varName}" at line ${b.line} is guarded by "${b.guard}". Possible missing check for parallel assignment.`,
          confidence: "low",
        });
      }
    }
  }
}

/**
 * Pattern 4: Promise.all with mixed error handling
 * Detects: Promise.all([a.catch(...), b, c.catch(...)]) where some have .catch and some don't
 */
export function scanPromiseAllMixedCatch(
  lines: string[],
  filePath: string,
  results: GuardInconsistency[],
): void {
  const source = lines.join("\n");
  // Match Promise.all([ ... ]) spans — simple heuristic on single or multi-line
  const promiseAllRe = /Promise\.all\s*\(\s*\[([^\]]*)\]\s*\)/gs;
  let match: RegExpExecArray | null;

  while ((match = promiseAllRe.exec(source)) !== null) {
    const inner = match[1]!;
    const lineOffset = source.slice(0, match.index).split("\n").length;
    const args = splitTopLevelComma(inner);

    const withCatch: string[] = [];
    const withoutCatch: string[] = [];

    for (const arg of args) {
      const trimmed = arg.trim();
      if (!trimmed) continue;
      if (/\.catch\s*\(/.test(trimmed)) {
        withCatch.push(trimmed);
      } else {
        withoutCatch.push(trimmed);
      }
    }

    if (withCatch.length > 0 && withoutCatch.length > 0) {
      const firstWithCatch = withCatch[0]!.slice(0, 40);
      const firstWithout = withoutCatch[0]!.slice(0, 40);
      results.push({
        filePath,
        line: lineOffset,
        loopVariable: "",
        guardedPush: {
          collection: firstWithCatch,
          guard: ".catch()",
          line: lineOffset,
        },
        unguardedPush: {
          collection: firstWithout,
          line: lineOffset,
        },
        message: `Promise.all at line ${lineOffset}: ${withCatch.length} promise(s) have .catch() but ${withoutCatch.length} don't. Mixed error handling may cause unhandled rejections.`,
        confidence: "med",
      });
    }
  }
}

/** Split a string by commas at the top level (not inside parens/brackets) */
export function splitTopLevelComma(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}
