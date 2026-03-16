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
  const elsePattern = /}\s*else\s*(if\s*\()?\s*\{?/;

  let loopStart = -1;
  let loopVar = "";
  let braceDepth = 0;
  let inLoop = false;
  let loopDepth = 0;

  const pushSites: PushSite[] = [];
  let currentIfGuard: string | null = null;
  let currentIfLine = -1;
  let ifDepth = 0;
  let inElseBranch = false;

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
      inElseBranch = false;
    }

    // Track else / else-if: when the if block closes and continues with
    // "else", the subsequent block is the negation of the original guard.
    // Mark pushes inside else branches so we can detect partition loops.
    const elseMatch = line.match(elsePattern);
    if (elseMatch && inLoop && currentIfGuard === null && ifDepth === 0) {
      // We just exited an if block (currentIfGuard was reset to null by
      // the closing brace). The "else" means the next block is the
      // negation — mark it with a sentinel guard.
      inElseBranch = true;
    }

    // Process braces AFTER checking for else (else comes after closing brace)
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
          inElseBranch = false;
        }
      }
    }

    if (inLoop) {
      const ifMatch = line.match(ifPattern);
      if (ifMatch && !elseMatch) {
        const guardText = line.replace(/^\s*if\s*\(/, "").replace(/\)\s*\{?\s*$/, "").trim();
        currentIfGuard = guardText;
        currentIfLine = i;
        inElseBranch = false;
        // Braceless single-line if: if the line has no opening brace,
        // the guard applies to this line and the next line only (to handle
        // `if (cond)\n  guarded();` patterns). After recording any push on
        // this line, set a flag to also check the next line before resetting.
        if (!line.includes("{")) {
          const pushMatch = line.match(pushPattern);
          if (pushMatch) {
            pushSites.push({
              collection: pushMatch[1]!,
              line: i + 1,
              guard: currentIfGuard,
              guardLine: currentIfLine + 1,
            });
            // Push was on the same line — reset guard now
            currentIfGuard = null;
            ifDepth = 0;
            continue;
          }
          // No push on the if-line — the guarded statement might be on
          // the next line. Keep the guard active for one more line by NOT
          // resetting here. Instead, mark it for single-line expiry: after
          // the next line is processed (and any push recorded), reset.
          ifDepth = -1; // sentinel: expire after next line
          continue;
        }
        ifDepth = braceDepth;
      }

      // Handle else/else-if: mark the guard as a negation so
      // analyzePushSites can detect partition loops.
      if (elseMatch && inLoop) {
        const elseIfMatch = line.match(/}\s*else\s+if\s*\((.+)\)\s*\{?/);
        if (elseIfMatch) {
          currentIfGuard = elseIfMatch[1]!.replace(/\)\s*\{?\s*$/, "").trim();
        } else {
          // Plain "else" — use a sentinel that marks this as the else branch
          currentIfGuard = "__else__";
        }
        currentIfLine = i;
        inElseBranch = true;
        if (line.includes("{")) {
          ifDepth = braceDepth;
        }
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

      // Braceless if expiry: the guard was set for one continuation line.
      // Now that we've processed this line (and recorded any push), reset.
      if (ifDepth === -1) {
        currentIfGuard = null;
        ifDepth = 0;
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
    // Text-rendering / output-building pattern: when an unguarded push
    // targets a "main output" collection (lines, out, output, result,
    // parts, rows, etc.) and guarded pushes target "sub-part" collections,
    // this is normal — the main output always gets a line, sub-parts are
    // conditional.  Suppress when the unguarded collection looks like a
    // primary output accumulator and the guarded one looks like a
    // sub-component being built up.
    const OUTPUT_NAMES = /^(lines|out|output|result|results|rows|parts|sections|chunks|text|buf|acc)$/i;

    for (const g of guarded) {
      for (const u of unguarded) {
        // Skip same-collection: pushing to the same array both
        // conditionally and unconditionally is normal (text rendering,
        // result accumulation). The real signal is cross-collection.
        if (g.collection === u.collection) continue;

        // Skip output-building pattern: unguarded push to a main output
        // array + guarded push to a different sub-part array is normal
        // text/data accumulation, not a guard inconsistency.
        const uBase = u.collection.split(".").pop() ?? u.collection;
        const gBase = g.collection.split(".").pop() ?? g.collection;
        if (OUTPUT_NAMES.test(uBase) && !OUTPUT_NAMES.test(gBase)) continue;

        // Both collections are output-like names — two output buffers
        // built with different conditions is normal, not a bug.
        if (OUTPUT_NAMES.test(uBase) && OUTPUT_NAMES.test(gBase)) continue;

        // Partition loop: if the guarded push is in an else/else-if branch,
        // the two pushes are mutually exclusive partitions of the loop items.
        // This is intentional — every item goes to exactly one list.
        if (g.guard === "__else__" || (g.guard && g.guardLine === u.line)) continue;

        // Map pre-population safety: if the unguarded push target involves
        // a .get() on a Map that was .set()/.has() earlier in the same
        // loop body, the access is safe.
        if (sourceLines && /\.get\s*\(/.test(u.collection)) {
          const mapVar = u.collection.replace(/\.get\s*\(.*$/, "").replace(/\.\w+$/, "") || u.collection.split(".")[0]!;
          if (isMapPrePopulated(sourceLines, mapVar, u.line - 1, loopStart)) continue;
        }

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

/** Escape a string for use in a RegExp constructor. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a Map variable is pre-populated (via .set() or .has()+.set()) between
 * scopeStart and getLine. If so, a subsequent .get() on the same Map is safe.
 */
function isMapPrePopulated(lines: string[], mapVar: string, getLine: number, scopeStart: number): boolean {
  const setPattern = new RegExp(`${escapeRegExp(mapVar)}\\.(set|has)\\s*\\(`);
  for (let i = scopeStart; i < getLine && i < lines.length; i++) {
    if (setPattern.test(lines[i]!)) return true;
  }
  return false;
}

/** Split a camelCase or PascalCase identifier into word components. */
function camelWords(name: string): string[] {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_]+/);
}

export function scoreGuardConfidence(
  guardedCol: string,
  unguardedCol: string,
  sourceLines?: string[],
): "high" | "med" | "low" {
  if (!sourceLines) return "med";
  const guardedBase = guardedCol.split(".").pop() ?? guardedCol;
  const unguardedBase = unguardedCol.split(".").pop() ?? unguardedCol;

  // DFS / accumulator pattern: names like "path", "stack", "visited",
  // "seen", "pending" are intentionally always-push accumulators that
  // track traversal state, while other collections selectively record
  // results. These are never guard bugs.
  const ACCUMULATOR_NAMES = /^(path|stack|queue|visited|seen|pending|frontier|worklist|lines|out|output|result|results|parts|sections|chunks|segments|entries|items|collected|accumulated|gathered|current|rolledBack|decorators|nodes|tables|enums)$/i;
  if (ACCUMULATOR_NAMES.test(unguardedBase)) return "low";

  // Different entity types: when the collection names share no camelCase
  // word component, they're likely tracking different entity types
  // (e.g., "nodes" vs "goDeps", "bridges" vs "unmatched"). The
  // asymmetry is intentional, not a guard bug.
  const gWords = camelWords(guardedBase);
  const uWords = camelWords(unguardedBase);
  const sharedWords = gWords.filter((w) => w.length > 2 && uWords.includes(w));
  if (sharedWords.length === 0) return "low";

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
  const elsePattern = /}\s*else\s*(if\s*\()?\s*\{?/;

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
          analyzeOpSites(opSites, callbackVar, filePath, callbackStart, results, lines);
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
      const elseMatch = line.match(elsePattern);
      const ifMatch = line.match(ifPattern);
      if (ifMatch && !elseMatch) {
        const guardText = line.replace(/^\s*if\s*\(/, "").replace(/\)\s*\{?\s*$/, "").trim();
        currentIfGuard = guardText;
        // Braceless single-line if — guard applies to this + next line
        if (!line.includes("{")) {
          ifDepth = -1; // sentinel: expire after next line
          continue;
        }
        ifDepth = braceDepth;
      }

      // Handle else/else-if
      if (elseMatch && inCallback) {
        currentIfGuard = "__else__";
        if (line.includes("{")) ifDepth = braceDepth;
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

      // Braceless if expiry
      if (ifDepth === -1) {
        currentIfGuard = null;
        ifDepth = 0;
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
  sourceLines?: string[],
): void {
  if (opSites.length < 2) return;

  const guarded = opSites.filter((p) => p.guard !== null);
  const unguarded = opSites.filter((p) => p.guard === null);

  const OUTPUT_NAMES = /^(lines|out|output|result|results|rows|parts|sections|chunks|text|buf|acc)$/i;

  if (guarded.length > 0 && unguarded.length > 0) {
    for (const g of guarded) {
      for (const u of unguarded) {
        const gBase = g.op.split(".").pop();
        const uBase = u.op.split(".").pop();
        if (gBase !== uBase) continue; // Only compare same-method operations
        if (g.op === u.op) continue;   // Skip exact same target

        // Skip output-building pattern (see analyzePushSites)
        const uTarget = u.op.split(".").slice(0, -1).pop() ?? u.op;
        const gTarget = g.op.split(".").slice(0, -1).pop() ?? g.op;
        if (OUTPUT_NAMES.test(uTarget) && !OUTPUT_NAMES.test(gTarget)) continue;

        // Both targets are output-like — not a bug
        if (OUTPUT_NAMES.test(uTarget) && OUTPUT_NAMES.test(gTarget)) continue;

        // Partition: guarded op is in an else branch
        if (g.guard === "__else__") continue;

        // Collect-all pattern: targets starting with "all" (e.g.,
        // allFunctions.push vs allAdapters.push) are intentionally
        // collecting everything of different types.
        if (/^all[A-Z]/.test(uTarget) && /^all[A-Z]/.test(gTarget)) continue;

        // Map pre-population safety: if the unguarded op is a .get() on a
        // Map that was .set()/.has() earlier in the same callback, the
        // .get() is safe (the key is guaranteed to exist).
        if (sourceLines && /\.get\s*\(/.test(u.op)) {
          const mapVar = u.op.replace(/\.get\s*\(.*$/, "").replace(/\.\w+$/, "") || u.op.split(".")[0]!;
          if (isMapPrePopulated(sourceLines, mapVar, u.line - 1, callbackStart)) continue;
        }

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
 * Detects Promise.all where some promises have .catch() and some don't (mixed error handling)
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
    // Skip matches inside comments (line starts with //, *, or /*)
    const matchLine = source.slice(0, match.index).split("\n").length - 1;
    const lineContent = lines[matchLine]?.trimStart() ?? "";
    if (lineContent.startsWith("//") || lineContent.startsWith("*") || lineContent.startsWith("/*")) continue;

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
