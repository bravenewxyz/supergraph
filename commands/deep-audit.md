Perform a systematic, multi-pass audit of a TypeScript package. Finds duplicate code, overengineering, inconsistencies, dead code, unfinished features, bugs, logical errors, and half-baked solutions. Writes all results to disk as actionable, self-contained plans.

**Argument**: `$ARGUMENTS` — optional. Path to one or more package `src/` directories (e.g. `packages/orchestrator/src`). If none specified, audit all packages.

---

## Output directory

**ALL output goes under `audit/<package-name>/`.** Never write findings, plans, or any artifacts inside the source tree (e.g. never inside `packages/`). The package name is derived from the argument path (e.g. `packages/orchestrator/src` → `orchestrator`). Create the directory structure if it doesn't exist.

```
audit/<package-name>/
  map.txt               # per-module symbol map (Phase 1)
  deps.txt              # full dependency graph + cycle list (Phase 1)
  imports.txt           # import frequency — modules sorted by inbound edges (Phase 1)
  complexity.txt        # per-function complexity + type-safety surface (Phase 2, 3, 4b)
  dead.txt              # orphan modules + unused exported symbols (Phase 2)
  findings.md           # accumulated findings from all phases
  schema-match.txt      # schema ↔ type mismatches (Phase 5)
  trace-boundaries.txt  # serialization boundaries (Phase 5)
  logic-audit.txt       # logic analysis: decision tables, guards, schema mismatches (Phase 6)
  invariants/           # invariant verification (Phase 7)
    discovery.txt  invariants.json  tests/  README.md
  plans/                # all plans go here, never alongside source code
    README.md  001-*.md  002-*.md  ...
```

## Critical: full-context files

These four files must be read **in their entirety** (never skim, chunk, or partially read). Every subsequent phase depends on their full content. When dispatching subagents, pass the full content in the prompt — not a path.

| File | Contains | Phase |
|---|---|---|
| `superhigh.txt` | Unified monorepo map: domains, schemas, modules, types, edges | 0 |
| `map.txt` | Per-module symbols, functions, types, variables, comments, deps | 1 |
| `deps.txt` | Full dependency graph — every module → its internal deps | 1 |
| `imports.txt` | All modules sorted by inbound edge count | 1 |
| `discovery.txt` | Compact function summary for invariant analysis | 7 |

## Execution discipline

1. **No subagent delegation during Phases 1–8.** You must read and analyze the code yourself. Subagents lack accumulated cross-file context. Delegation is only appropriate in Phase 10.
2. **Write findings to disk as you go.** After each analysis phase (2–7), append to `findings.md`. Format: file path, line range, severity (critical/high/medium/low), one-line description.

---

## Phase 0: Generate all artifacts

**Always run the full supergraph stack on the entire monorepo first:**

```bash
supergraph --no-anim
```

This discovers all packages, runs every analysis tool in parallel, and generates artifacts for every package under `audit/packages/<name>/`. It also generates `audit/superhigh.txt` and `audit/superhigh-shortcut.txt` — unified maps combining module graphs, schemas, flows, and cross-package edges. The `--no-anim` flag disables the terminal animation (meant for human use only). If `supergraph` is not installed, install it first: `brew install bravenewxyz/supergraph/supergraph`.

**Then focus the deep audit (Phases 1–10) on the requested packages.** If the user specified one or more packages, audit those. If none specified, audit all discovered packages. For multi-package audits, run each package through Phases 1–8 independently, then present all plans together in Phase 9.

All tools run in parallel; failures are non-fatal. If any tool fails, note it and continue.

## Phase 1: Read the map

**First**, read `audit/superhigh.txt` in its entirety — this is the unified view of the entire monorepo: domain blocks with schemas, all package modules, TS types, and cross-package edges. This gives you full architectural context before diving into per-package artifacts.

**Then** read all three per-package map files in full before Phase 2. Notation for `map.txt`:
- `+` exported, ` ` unexported | `fn` function | `L42-55` line range
- `←` internal deps | `←ext` external deps | `━━━ module ━━━` separator
- `// ...` = extracted code comments

## Phase 2: Structural audit (map + tool outputs)

Read `complexity.txt` and `dead.txt` in full, then analyze the map files.

1. **Dead exports** — verify `dead.txt` findings against `map.txt`. Intentional orphans (test helpers, future features) or genuine dead code?
2. **Circular dependencies** — from `deps.txt` `## Circular Dependencies` section. For each cycle: identify the cleanest cut point.
3. **Complexity hotspots** — functions above complexity 15 from `complexity.txt` → priority for Phase 3.
4. **Type-safety surface** — files with high escape-hatch scores (`any`, casts, `!.`, `@ts-ignore`) from `complexity.txt` → scrutinize in Phase 3.
5. **Oversized modules** — 3× the median symbol count → candidate for splitting.
6. **Dependency fan-out** — `deps.txt` rows with many `→` targets (god module?).
7. **Dependency fan-in** — top of `imports.txt` = imported everywhere → utility or unrelated concerns accumulating.

Append to `findings.md` under `## Phase 2: Structural audit`.

## Phase 3: Deep audit (read source files)

Prioritize: (1) files flagged in Phase 2, (2) top complexity functions, (3) top escape-hatch files, (4) remaining by symbol count. For packages under 50 files, read all. Track which files you've read.

For each file, check:

**3a. Duplicates** — near-duplicate functions, repeated patterns, multiple implementations of the same algorithm.
**3b. Overengineering** — abstractions with one implementation, config options never varied, generics instantiated with one type, passthrough wrappers.
**3c. Inconsistencies** — mixed patterns (callbacks vs promises, throw vs return-error), naming, parameter ordering.
**3d. Dead code** — exported but never imported, commented-out code, unreachable branches, unused params/imports.
**3e. Unfinished** — TODO/FIXME/HACK/XXX, stub implementations, missing branches, error handling that just logs.
**3f. Bugs** — off-by-one, race conditions, unsafe casts, null access without guards, unhandled rejections, resource leaks, shared mutable state without sync. Also note candidates for Phase 6 logic bug patterns (decision table gaps, guard inconsistencies, temporal ordering issues).
**3g. Error handling** — swallowed errors, missing context in messages, inconsistent propagation, missing try/catch.

Append to `findings.md` under `## Phase 3: Deep audit`.

## Phase 4: Cross-cutting analysis

1. **Architectural coherence** — does the module graph match stated architecture? Shortcuts through internal APIs?
2. **Abstraction level consistency** — modules mixing high-level orchestration with low-level details?
3. **Single responsibility** — unrelated imports = unrelated responsibilities?

Append to `findings.md` under `## Phase 4: Cross-cutting analysis`.

## Phase 4b: Structural impedance analysis

Read `## Structural Impedance` at bottom of `complexity.txt`. If absent, no findings above threshold. Three types:

- **PURE-ADAPTER** — ≥70% direct field mapping. Fix: change consumer's param type to accept upstream type, delete adapter.
- **DATA-CLUMP** — ≥3 fields extracted from same source. Fix: accept the source type directly.
- **TYPE-OVERLAP** — Jaccard field-name similarity ≥0.70. Fix: unify into one type.

For each HIGH-confidence finding: verify it isn't doing hidden computation (coercion, defaults, wrapping). Only confirmed pure adapters are real findings.

Append to `findings.md` under `## Phase 4b: Structural impedance`. These go into plan execution position 6 (infrastructure/deduplication).

---

## Phase 5: Data flow trace

Read ENTIRE `schema-match.txt` and `trace-boundaries.txt`. If missing, note it and continue.

1. **Schema-type mismatches** — `ERROR` entries = runtime schema diverges from TS type → silent data loss.
2. **Error path structure** — check error handler kind, fallback value, and log level. Catch handlers returning fallback values without logging = silent data loss.
3. **Unsafe type assertions** — `as unknown as Type` bypassing validation.
4. **JSON roundtrip losses** — Date, Map, Set, Function, BigInt through JSON boundaries.
5. **Missing validation after deserialization** — file-read/json-deserialize without nearby schema-validate.

Append to `findings.md` under `## Phase 5: Data flow trace`.

---

## Phase 6: Focused logic analysis

Read ENTIRE `logic-audit.txt`. If missing, perform 6b–6e manually without tool pre-computation.

### 6a. Read the logic audit output

The file has four sections:

1. **Cross-representation mismatches** — Zod vs TS type field optionality disagreements.
2. **Decision tables** — condition→outcome rows for status-determining functions. `⚠` lines = suspicious AND-gated conditions. The tool emits `Gap:`, `REACHABLE:`, `CONTRAST:`, `VERDICT:`/`VERDICT (unconfirmed):` under each. Priority review targets for 6b — read the verdict before tracing manually.
3. **Guard consistency** — `⚠high` = always investigate; `med` = verify manually.
4. **Status functions** — reference list sorted by branch count.

Verify each finding against source before adding to your issue list.

### 6b. Decision pipeline scan

For each `⚠` in Decision Tables:

1. Read the cited function and flagged row.
2. Read variable definitions (tool expands one level).
3. Is the suppression intentional and documented, or an oversight?
4. **Read automated verdict lines**:
   - `→ Gap:` — concrete scenario. `→ REACHABLE:` — failure leaf is a param (no manual trace needed). `→ CONTRAST:` — gate is sole differentiator. `→ VERDICT:` — decide intentional or bug. `→ VERDICT (unconfirmed):` — must trace manually.
   - Full VERDICT + unintentional/undocumented → **high-severity**. Intentional without docs → **low-severity**. Unconfirmed → trace using gap scenario.
5. Manually check: does `summary`/other output fields present misleading success in the gap scenario? If yes → separate finding.

For status functions WITHOUT decision tables (branch count <3), skim manually for the same pattern.

### 6c. Cross-representation scan

For each Zod schema: (1) list fields with optionality, (2) compare with TS type, (3) check `prompts/`/`*-prompt.ts` for mandatory/optional mentions, (4) check runtime enforcement, (5) report where 2+ representations disagree. Cross-reference with Phase 5.

### 6d. Guard consistency scan

For loops populating 2+ collections: extract guard conditions, compare across collections, flag mismatched pairs (one guarded, one not).

### 6e. Temporal ordering scan (manual)

For functions >50 lines with multiple stages:

1. Identify capture points (variable snapshots) and mutation points (build checks, validation calls, state-changing operations).
2. Flag captures BEFORE mutation points where the capture is used alongside the mutation's result in output construction.
3. **Anomaly consequence test**: trace the full output object for the anomalous scenario (nonzero exit, build error). If output presents success despite anomaly → high-severity.

### 6f. Enforcement gap scan

Cross-reference `schema-match.txt` (`enforce=silent-ignore ⚠`) with `logic-audit.txt` cross-rep section. For each gap: does the runtime behavior when the field is missing match the prompt's stated intent? Lenient parsing = medium-severity. Silent wrong behavior = high-severity.

Append to `findings.md` under `## Phase 6: Focused logic analysis`.

---

## Phase 7: Invariant verification

### 7a. Read discovery output

Read ENTIRE `invariants/discovery.txt`. Select **top 10–15 functions by purity score** (≥0.7). Prioritize overlap with Phase 3f/Phase 6 flagged functions.

### 7b. Generate invariants

For each function, trace step by step: (1) parameter binding with types/ranges, (2) branch points with failure signals, (3) outputs with path conditions, (4) derive postconditions as TS boolean expressions.

Format as JSON array in `audit/<package-name>/invariants/invariants.json`:
```json
{ "name": "kebab-name", "targetFunction": "fn", "targetFile": "path.ts",
  "description": "...", "postcondition": "expr using input and result",
  "severity": "critical|high|medium", "confidence": 0.0 }
```

Use previously verified invariants from similar functions (shared signature hashes) as in-context examples.

### 7c. Consistency check

Compare code behavior, JSDoc, and generated invariants for each function. Flag mismatches (code-doc = likely doc or code bug; code-invariant = fast-check will catch).

### 7d. Generate and run tests

```bash
bun packages/flow/src/cli/invariant.ts generate $ARGUMENTS --invariants audit/<package-name>/invariants/invariants.json --out-dir audit/<package-name>/invariants/tests/
bun test audit/<package-name>/invariants/tests/
```

### 7e. Analyze failures

For each failure: read counterexample, trace function → **real bug** or **wrong invariant**? If too strong → weaken, re-run (max 2 rounds). Still fails + should hold → likely bug.

### 7f. Write report

Write `audit/<package-name>/invariants/README.md` with: package name, function/invariant/verified/bug/inconclusive counts, consistency analysis table (Function|Code-Doc|Code-Invariant|Doc-Invariant|Verdict), likely bugs table (Function|Invariant|Severity|Confidence|Counterexample|Refinements), verified invariants table (Function|Invariant|Status|Confidence|Iterations).

### 7g. Feed into findings

Append to `findings.md` under `## Phase 7: Invariant verification`. Likely bugs = high-severity. Consistency mismatches = medium. Verified invariants do NOT go in findings.

---

## Phase 8: Write results

**Most important phase.** Re-read `findings.md` in full — it is your single source of truth.

### 8a. Claim verification

1. Re-read exact file+line for each finding. Drop stale claims (fixed/shifted code). Update line ranges.
2. **Cross-check tool findings**: every `⚠` from Phase 6 tools must have a corresponding `findings.md` entry. Uninvestigated `⚠` findings are blind spots — go back and investigate now.

### 8b. Grouped plans

Group findings into **1–12 plans** representing coherent dev work sessions (not one plan per issue). Group by: same files/subsystem, shared root cause, natural refactoring absorption, issue category (security, races, dead code, etc.). Include findings from all phases.

Write all plans to `audit/<package-name>/plans/`. Name: `001-security-hardening.md`, `002-critical-correctness.md`, etc. Prefix IS execution order.

### 8c. Execution ordering

1. Security → 2. Crash-level correctness → 3. Data integrity/validation → 4. Concurrency/races → 5. Core pipeline → 6. Infrastructure/deduplication → 7. Polish → 8. Large refactors last.

### 8d. Plan format

```markdown
# <Title>

**Effort**: small (< 1hr) | medium (1-4hr) | large (4hr+)
**Scope**: list of files
**Depends on**: plan numbers or `none`

## Overview
2-3 sentences.

## Issues
For each: file path, line number(s), what's wrong (1-2 sentences).

## Changes
Concrete per-file instructions with code snippets where non-obvious.

## Checklist
- [ ] <step>  ...  - [ ] Verify no lint errors  - [ ] Run tests: `bun test <paths>`
```

### 8e. Plan index

Write `plans/README.md`: one-line scope, then table only:

| # | Plan | Effort | Issues | Depends on |
|---|------|--------|--------|------------|

**Depends on** determines parallel execution eligibility.

### 8f. Guidelines

Every issue cites file+line range. Each checklist fully resolves all plan issues. No summary file.

---

## Phase 9: Present to user

1. One line: what was audited (package, file count, line count).
2. Show the plans table from `plans/README.md`.
3. Tell user they can pick plans or say "do all."

---

## Phase 10: Execute all plans (on user request)

Dispatch plans via agents when user says "do all" / "execute all" / "go" / "ready."

### 10a. Build execution graph and dispatch in waves

Plans can run in parallel when: (1) all dependencies satisfied, (2) scopes don't overlap. Plans sharing files MUST be serialized.

Execute in waves. Each wave: eligible plans with non-overlapping scopes. Launch one `subagent_type: "generalPurpose"` Task per plan with: full plan content, full `map.txt` content, instruction to execute all checklist items, instruction to verify with `bun run typecheck` + tests. **Max 4 agents per wave.**

### 10b. Between waves and after completion

Between waves: verify all agents succeeded, fix blockers before continuing. After all waves: run `bun run typecheck` and `bun test`, present summary of successes, issues, and overall health.

---

**Important**: Be concrete and specific. Every finding must cite file path and line range. Only report verified issues. Read more files if needed before reporting.
