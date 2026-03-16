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

**ALL output goes under `.supergraph/<package-name>/`.** Never write findings, plans, or any artifacts inside the source tree. The package name is derived from the argument path (e.g. `packages/orchestrator/src` → `orchestrator`).

```
.supergraph/<package-name>/
  map.txt  deps.txt  imports.txt  complexity.txt  dead.txt
  findings.md  schema-match.txt  trace-boundaries.txt  logic-audit.txt
  invariants/   discovery.txt  invariants.json  tests/  README.md
  plans/        README.md  001-*.md  002-*.md  ...
```

## Critical: full-context files

Read these files **in their entirety** (never skim or chunk). Pass full content to subagents — not paths.

| File | Contains |
|---|---|
| `supergraph.txt` | Unified monorepo map: domains, schemas, modules, types, edges |
| `map.txt` | Per-module symbols, functions, types, variables, comments, deps |
| `deps.txt` | Full dependency graph — every module → its internal deps |
| `imports.txt` | All modules sorted by inbound edge count |
| `discovery.txt` | Compact function summary for invariant analysis |

## Execution discipline

1. **No subagent delegation during Phases 1–8.** You must read and analyze the code yourself. Subagents lack accumulated cross-file context. Delegation is only appropriate in Phase 10.
2. **Write findings to disk as you go.** After each analysis phase (2–7), append to `findings.md` under the appropriate phase heading. See Phase 8b for the final format.

---

## Phase 0: Generate all artifacts

Run the full supergraph stack first:

```bash
supergraph --no-anim
```

If `supergraph` is not installed: `brew install bravenewxyz/supergraph/supergraph`.

The CLI automatically adds `.supergraph/` to `.gitignore` if not already present. If for some reason it didn't, ensure `.supergraph/` is gitignored before proceeding.

Then focus the deep audit (Phases 1–10) on the requested packages.

## Phase 1: Read the map

Read `.supergraph/supergraph.txt` in full, then read all three per-package map files (`map.txt`, `deps.txt`, `imports.txt`). Notation:
- `+` exported, ` ` unexported | `fn` function | `L42-55` line range
- `←` internal deps | `←ext` external deps | `━━━ module ━━━` separator

## Phase 2: Structural audit

Read `complexity.txt` and `dead.txt` in full, then analyze:

1. **Dead exports** — verify `dead.txt` against `map.txt`. Intentional or genuine dead code?
   **Known false positive patterns — do NOT report these:**
   - **Orphan modules that are CLI entry points** (contain `import.meta.main`, `process.argv`, or shebang). These have 0 inbound imports by design.
   - **Exports meant for external package consumers** (e.g. test utilities, fast-check arbitraries, public API symbols). The detector only checks internal imports.
   - **Re-export barrels** (`index.ts`) that aggregate submodule exports for the package boundary.
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

**Known false positive patterns — do NOT report these as issues:**
- **Output-building loops**: `lines.push`/`out.push`/`result.push` (unguarded) + `parts.push`/`opParts.push`/other sub-array (guarded). This is normal text rendering — always push a line, conditionally build parts.
- **DFS/accumulator**: `path.push`/`stack.push`/`visited` (unguarded) + `cycles.push`/`results.push` (guarded). Traversal always tracks state, selectively records results.
- **Type discrimination**: `implementsEdges.push` (unguarded) + `extendsEdges.push` (guarded by type check). The guard intentionally applies to only one collection.
- **Cascading operations**: `rolledBack.push` (unguarded) + `cascaded.push` (guarded). Every entry is processed, only some trigger cascades.

### 6e. Temporal ordering scan

For functions >50 lines: flag captures BEFORE mutation points where the capture is used alongside the mutation's result.

### 6f. Enforcement gap scan

Cross-reference `schema-match.txt` (`enforce=silent-ignore ⚠`) with `logic-audit.txt`.

Append to `findings.md`.

---

## Phase 7: Semantic scan

Use the discovery data (`invariants/discovery.txt` and the per-package `json/discovery.json`) to find logic bugs, contract violations, and suspicious patterns that structural analysis cannot catch.

### 7a. Load discovery data

Read `invariants/discovery.txt` in full. It contains:
- **Signature inconsistencies** — functions with the same name in different files but different signatures. Focus on exported functions in related domains.
- **Repeated patterns** — groups of 3+ structurally identical functions. These are abstraction candidates.
- **Hub functions** — called by 10+ others. Breaking changes here have high blast radius.

### 7b. Semantic function pair analysis

For each **signature inconsistency** (same name, different signatures):
1. Read both function bodies from source
2. Determine: are they intentionally different (different layers/domains) or accidentally diverged (copy-paste drift)?
3. If they're in the same domain and both exported — flag as a naming collision that confuses callers

For each **repeated pattern group** with 5+ members:
1. Read 2-3 representative function bodies
2. Assess: is this boilerplate that should be a generic helper? Or is the repetition intentional (each function handles domain-specific edge cases)?
3. If a generic helper would work — flag as a refactoring opportunity with a suggested abstraction

### 7c. Contract compatibility scan

Read the discovery JSON (`json/discovery.json`). For functions that appear to form caller→callee chains (based on name patterns like `createTask` → `validateTask` → `saveTask`):
1. Check return type of caller against parameter type of callee
2. Look for optionality mismatches: function A returns `T | null`, function B expects `T`
3. Look for error contract mismatches: function A throws on invalid input, function B returns null

### 7d. Suspicious pattern detection

Scan function bodies in the discovery data for:
- **Error swallowing**: `catch (e) { }` or `catch { return fallback }` without logging
- **Inconsistent null handling**: some functions in a module check for null, others don't
- **Mixed async patterns**: `await` mixed with `.then()` callbacks in the same function
- **Hardcoded values**: magic numbers, hardcoded URLs, embedded credentials

Append verified findings to `findings.md`.

---

## Phase 8: Write results

**Most important phase.** Re-read `findings.md` in full.

### 8a. Claim verification

Re-read exact file+line for each finding. Drop stale claims. Cross-check all `⚠` from Phase 6 tools.

### 8b. Write the final findings.md

Replace `findings.md` with the final, verified version. This is the human-readable audit report. Use this exact structure:

```markdown
# Audit: <package-name>

<file-count> files · <line-count> lines · <date>

---

## Summary

<N> issues: <critical-count> critical, <high-count> high, <medium-count> medium, <low-count> low

---

## Issues

### Critical

**#1** · `pipeline.ts:42-55`
Race condition in concurrent queue drain — `processQueue()` reads `queue.length`
before acquiring the lock, so two concurrent calls can both enter the drain loop.

**#2** · `auth.ts:80-92`
Hardcoded JWT secret in fallback path — when `process.env.JWT_SECRET` is unset,
falls back to `"development"` string even in production.

### High

**#3** · `parser.ts:120`
Swallowed error in catch block — `parseConfig()` catches all errors and returns
`{}`, silently hiding malformed config files.

**#4** · `cache.ts:55-70`
Missing TTL on session cache — entries are never evicted, causing unbounded
memory growth under sustained load.

### Medium

**#5** · `utils.ts:12`
Dead export: `unusedHelper` — exported but not imported anywhere in the codebase.

**#6** · `types.ts:30-45`
Type overlap: `UserResponse` and `UserData` share 8/10 fields — consolidate
into a single type.

### Low

**#7** · `logger.ts:8`
Inconsistent log level: uses `console.warn` here but `logger.warn` everywhere else.

---

## Phase notes

Brief notes on what each phase found, for context. Not every phase needs notes —
only include phases that produced findings or notable observations.

### Phase 2: Structural audit
- 2 circular dependencies detected (see #8, #9)
- `orchestrator.ts` has 3× median symbol count — splitting candidate

### Phase 5: Data flow trace
- 3 JSON roundtrip losses in event serialization (#11, #12, #13)

### Phase 6: Logic analysis
- 1 decision table gap with confirmed VERDICT (#1)
```

Rules for this file:
- Every issue gets a **#N** ID, sequential starting at 1
- Sort by severity: critical → high → medium → low
- Each issue: **bold number** · `file:lines` on first line, then 1–3 lines of plain English explanation — what's wrong and why it matters. No jargon-only descriptions.
- The "Phase notes" section at the bottom provides context but is optional per phase
- The number is stable — it's how the user refers to issues from now on

**Multi-package numbering**: When auditing multiple packages, use a **single global issue counter** across all packages. The first package starts at #1; the second package continues from where the first left off. Each per-package `findings.md` uses the same global numbers. This way the user can refer to any issue by a single unambiguous number (e.g. "#14") without needing to specify the package. In Phase 9, present a single unified table across all packages.

### 8c. Grouped plans

Group findings into **1–12 plans** as coherent work sessions. Each plan references issues by their number. Order: Security → Correctness → Data integrity → Concurrency → Core pipeline → Infrastructure → Polish → Large refactors.

Write to `.supergraph/<package-name>/plans/`.

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

### 9a. Fixability triage

Before presenting, classify every issue into one of two buckets:

- **Fixable** — you can write the code change right now with high confidence it's correct. This includes: dead code removal, adding missing switch cases, replacing unsafe casts, swapping API calls, type refactors, adding validation, fixing logic bugs, and complexity refactors (splitting large functions).
- **Excluded** — you cannot or should not fix it autonomously. Assign a reason from this list:
  - `needs-research` — requires investigating an external API, library internals, or runtime behavior you don't have docs for
  - `design-decision` — multiple valid approaches; the user needs to choose (e.g., portability strategy, abstraction style)
  - `upstream` — the root cause is in a dependency or external system, not this codebase
  - `harmless` — technically an issue but has no practical impact and "fixing" it risks breaking things (e.g., barrel self-import cycles)
  - `standard-pattern` — follows an established TypeScript/language idiom that isn't worth changing (e.g., exhaustive switch `as never`)

**Be aggressive about what you can fix.** If a function is complex but self-contained, you can split it. If a cast is unsafe, you can add a type guard. If an API is Bun-specific, you can swap it for `fs/promises`. Default to "fixable" unless there's a concrete reason you can't.

### 9b. Output format

Output **only this** — nothing else:

For a **single package**:
```
<package-name>: <file-count> files, <line-count> lines — <N> issues found (<fixable-count> fixable)

## Fixable

 #  | sev      | location        | description
----|----------|-----------------|--------------------------------------------
 1  | critical | file.ts:42-55   | Race condition in concurrent queue drain
 3  | medium   | other.ts:12     | Dead export: unusedHelper
 ...

## Excluded

 #  | sev      | location        | reason           | description
----|----------|-----------------|------------------|---------------------------
 2  | medium   | graph.ts:10-14  | upstream         | Graphology CJS/ESM interop cast
 5  | low      | logic.ts:8      | harmless         | Self-import barrel cycle
 ...

Which issues to fix? (numbers, ranges like 1-5, or "all")
```

For **multiple packages**, add a `pkg` column to both tables:
```
3 packages audited: 126 files, 39,931 lines — 43 issues found (31 fixable)

## Fixable

 #  | pkg     | sev      | location              | description
----|---------|----------|-----------------------|-----------------------------
 1  | flow    | high     | sym-executor.ts:545   | Swallowed error in Z3 fallback
 ...

## Excluded

 #  | pkg     | sev      | location              | reason           | description
----|---------|----------|-----------------------|------------------|------------------
 9  | graph   | medium   | graph-store.ts:10-14  | upstream         | Graphology CJS/ESM cast
 ...

Which issues to fix? (numbers, ranges like 1-5, or "all")
```

Show **every issue** from `findings.md` in one of the two tables. Numbers are **globally unique across all packages** — no restarting at 1 per package. The "Fixable" table contains only issues you will fix if asked. The "Excluded" table shows everything else with a short reason.

---

## Phase 10: Execute (on user request)

The user responds with issue numbers. Parse their input:
- Individual numbers: `1, 3, 7`
- Ranges: `1-5`
- Mixed: `1-3, 7, 12-15`
- `all` = every issue in the **Fixable** table

If the user requests an excluded issue by number, explain why it was excluded and ask if they want you to attempt it anyway.

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
