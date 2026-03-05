Perform a systematic, multi-pass audit of a TypeScript package. Finds duplicate code, overengineering, inconsistencies, dead code, unfinished features, bugs, logical errors, and half-baked solutions. Writes all results to disk as actionable, self-contained plans.

**Argument**: `$ARGUMENTS` — optional. Path to one or more package `src/` directories (e.g. `packages/orchestrator/src`). If none specified, audit all packages.

---

## Communication style

**Be terse in chat.** The user sees your messages while you work — don't overwhelm them.

- During Phases 0–7: output **nothing** to the user unless something fails or needs a decision. Work silently.
- After Phase 8 (plans written): present findings using the compact format in Phase 9 below.
- Never narrate what you're about to do ("Now I'll read the map files..."). Just do it.
- Never list files you're reading, tools you're running, or phases you're entering.
- If a tool fails or a file is missing, note it in one line and continue.

---

## Output directory

**ALL output goes under `audit/<package-name>/`.** Never write findings, plans, or any artifacts inside the source tree. The package name is derived from the argument path (e.g. `packages/orchestrator/src` → `orchestrator`).

```
audit/<package-name>/
  map.txt  deps.txt  imports.txt  complexity.txt  dead.txt
  findings.md  schema-match.txt  trace-boundaries.txt  logic-audit.txt
  invariants/   discovery.txt  invariants.json  tests/  README.md
  plans/        README.md  001-*.md  002-*.md  ...
```

## Critical: full-context files

Read these files **in their entirety** (never skim or chunk). Pass full content to subagents — not paths.

| File | Contains |
|---|---|
| `superhigh.txt` | Unified monorepo map: domains, schemas, modules, types, edges |
| `map.txt` | Per-module symbols, functions, types, variables, comments, deps |
| `deps.txt` | Full dependency graph — every module → its internal deps |
| `imports.txt` | All modules sorted by inbound edge count |
| `discovery.txt` | Compact function summary for invariant analysis |

## Execution discipline

1. **No subagent delegation during Phases 1–8.** You must read and analyze the code yourself. Subagents lack accumulated cross-file context. Delegation is only appropriate in Phase 10.
2. **Write findings to disk as you go.** After each analysis phase (2–7), append to `findings.md`. Format: `file:line-range severity one-line-description`.

---

## Phase 0: Generate all artifacts

Run the full supergraph stack first:

```bash
supergraph --no-anim
```

If `supergraph` is not installed: `brew install bravenewxyz/supergraph/supergraph`.

The CLI automatically adds `audit/` to `.gitignore` if not already present. If for some reason it didn't, ensure `audit/` is gitignored before proceeding.

Then focus the deep audit (Phases 1–10) on the requested packages.

## Phase 1: Read the map

Read `audit/superhigh.txt` in full, then read all three per-package map files (`map.txt`, `deps.txt`, `imports.txt`). Notation:
- `+` exported, ` ` unexported | `fn` function | `L42-55` line range
- `←` internal deps | `←ext` external deps | `━━━ module ━━━` separator

## Phase 2: Structural audit

Read `complexity.txt` and `dead.txt` in full, then analyze:

1. **Dead exports** — verify `dead.txt` against `map.txt`. Intentional or genuine dead code?
2. **Circular dependencies** — from `deps.txt`. Identify cleanest cut point.
3. **Complexity hotspots** — functions above complexity 15.
4. **Type-safety surface** — high escape-hatch scores (`any`, casts, `!.`, `@ts-ignore`).
5. **Oversized modules** — 3× median symbol count.
6. **Dependency fan-out/fan-in** — god modules and utility accumulation.

Append to `findings.md`.

## Phase 3: Deep audit (read source files)

Prioritize: (1) files flagged in Phase 2, (2) top complexity functions, (3) top escape-hatch files. For packages under 50 files, read all.

Check for: **duplicates**, **overengineering**, **inconsistencies**, **dead code**, **unfinished work** (TODO/FIXME/HACK), **bugs** (races, unsafe casts, null access, resource leaks), **error handling** (swallowed errors, missing context).

Append to `findings.md`.

## Phase 4: Cross-cutting analysis

1. **Architectural coherence** — module graph matches stated architecture?
2. **Abstraction level consistency** — mixing high-level orchestration with low-level details?
3. **Single responsibility** — unrelated imports = unrelated responsibilities?

## Phase 4b: Structural impedance

Read `## Structural Impedance` at bottom of `complexity.txt`. Three types: PURE-ADAPTER, DATA-CLUMP, TYPE-OVERLAP. Verify HIGH-confidence findings aren't doing hidden computation. Append to `findings.md`.

---

## Phase 5: Data flow trace

Read `schema-match.txt` and `trace-boundaries.txt` in full.

1. **Schema-type mismatches** — `ERROR` entries = silent data loss.
2. **Error path structure** — catch handlers returning fallback values without logging.
3. **Unsafe type assertions** — `as unknown as Type` bypassing validation.
4. **JSON roundtrip losses** — Date, Map, Set through JSON boundaries.
5. **Missing validation after deserialization**.

Append to `findings.md`.

---

## Phase 6: Focused logic analysis

Read `logic-audit.txt` in full. It has sections for: cross-representation mismatches, decision tables, guard consistency, broad guard consistency, exhaustiveness gaps, and status functions.

### 6a–6b. Decision pipeline scan

For each `⚠` in Decision Tables: read the cited function, check variable definitions, read automated verdict lines (`Gap:`, `REACHABLE:`, `CONTRAST:`, `VERDICT:`). Full VERDICT + unintentional → high-severity.

### 6c. Cross-representation scan

Compare Zod schema fields with TS type fields. Report where 2+ representations disagree.

### 6d. Guard consistency scan

Review both standard and broad guard warnings. `⚠high` = always investigate.

### 6e. Temporal ordering scan

For functions >50 lines: flag captures BEFORE mutation points where the capture is used alongside the mutation's result.

### 6f. Enforcement gap scan

Cross-reference `schema-match.txt` (`enforce=silent-ignore ⚠`) with `logic-audit.txt`.

Append to `findings.md`.

---

## Phase 7: Invariant verification

### 7a–b. Discover and generate

Read `invariants/discovery.txt`. Select top 10–15 functions by purity score (≥0.7). Trace each step by step. Write invariants to `invariants/invariants.json`.

### 7c–e. Test and analyze

Generate tests, run them, analyze failures. Real bug or wrong invariant? Max 2 refinement rounds.

### 7f–g. Report

Write `invariants/README.md` with counts and tables. Append likely bugs to `findings.md`.

---

## Phase 8: Write results

**Most important phase.** Re-read `findings.md` in full.

### 8a. Claim verification

Re-read exact file+line for each finding. Drop stale claims. Cross-check all `⚠` from Phase 6 tools.

### 8b. Number every issue

Assign a sequential integer ID to every verified finding, starting at 1. This is the **master issue list**. Write it to `findings.md` as the final version, replacing any earlier content. Format:

```
1. critical file.ts:42-55 — Race condition in concurrent queue drain
2. high    file.ts:80     — Swallowed error in catch block
3. medium  other.ts:12    — Dead export: unusedHelper
...
```

Sort by severity (critical → high → medium → low), then by file path. The number is stable — it's how the user refers to issues from now on.

### 8c. Grouped plans

Group findings into **1–12 plans** as coherent work sessions. Each plan references issues by their number. Order: Security → Correctness → Data integrity → Concurrency → Core pipeline → Infrastructure → Polish → Large refactors.

Write to `audit/<package-name>/plans/`.

### 8d. Plan format

```markdown
# <Title>

**Effort**: small (< 1hr) | medium (1-4hr) | large (4hr+)
**Scope**: list of files
**Issues**: #3, #7, #12
**Depends on**: plan numbers or `none`

## Changes
For each issue number: what's wrong, then concrete fix instructions with code snippets where non-obvious.

## Checklist
- [ ] <step>  ...  - [ ] Run tests: `bun test <paths>`
```

### 8e. Plan index

Write `plans/README.md`:

| # | Plan | Effort | Issues | Depends on |
|---|------|--------|--------|------------|

---

## Phase 9: Present to user

Output **only this** — nothing else:

```
<package-name>: <file-count> files, <line-count> lines — <N> issues found

 #  | sev      | location        | description
----|----------|-----------------|--------------------------------------------
 1  | critical | file.ts:42-55   | Race condition in concurrent queue drain
 2  | high     | file.ts:80      | Swallowed error in catch block
 3  | medium   | other.ts:12     | Dead export: unusedHelper
 ...

I can fix <X> of these now. Which issues? (numbers, ranges like 1-5, or "all")
```

Show the **full numbered issue list** from `findings.md`. Every issue gets one row.

**Choosing what to offer**: count how many issues are small/medium effort to fix (based on your assessment during Phase 3–7). Offer to fix that number. For example: "I can fix 14 of these now." Don't offer to fix issues that require major architectural changes, external service changes, or decisions only the user can make — but do include them in the list so the user sees them.

---

## Phase 10: Execute (on user request)

The user responds with issue numbers. Parse their input:
- Individual numbers: `1, 3, 7`
- Ranges: `1-5`
- Mixed: `1-3, 7, 12-15`
- `all` = every issue you offered to fix

### 10a. Group selected issues into execution batches

Map selected issue numbers back to plans. If only some issues from a plan are selected, create a scoped version of that plan with just those issues. Issues touching the same files MUST be serialized.

### 10b. Dispatch agents in waves

Launch one `subagent_type: "generalPurpose"` Task per batch with: the relevant plan content (with issue numbers), full `map.txt` content, instruction to execute all checklist items. **Max 4 agents per wave.** Plans sharing files go in separate waves.

### 10c. After completion

Verify all agents succeeded. Run typecheck + tests. Present:

```
Done. <N>/<M> issues fixed.

 #  | status
----|--------
 1  | fixed
 3  | fixed
 7  | failed — type error in result
```

If any failed, offer to retry or skip.

---

**Important**: Be concrete and specific. Every finding must cite file path and line range. Only report verified issues.
