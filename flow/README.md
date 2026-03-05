# @devtools/flow

Universal static data flow analysis and invariant verification for TypeScript. Finds where data crosses serialization, validation, and error boundaries — then traces what breaks. Also verifies function invariants with property-based testing and symbolic execution (Z3).

Works at three levels:

1. **TypeScript types only** — resolve types at every JSON.stringify/parse, file I/O, subprocess, and type assertion boundary. Check JSON-roundtrip compatibility (Date→string, Map→{}, Function→dropped). No validation library needed.
2. **TypeScript + runtime schemas** — when Zod, Joi, Yup, or other validation libraries are present, extract their schemas, match them to TS types, and report structural mismatches that cause silent data loss.
3. **Invariant verification** — discover pure functions, generate LLM-backed invariants, run property-based tests (fast-check), and prove invariants exhaustively via Z3 symbolic execution (“CrossHair for TypeScript”).

## Quick start

```bash
# Find schema-type mismatches in a package
bun packages/flow/src/cli/schema-match.ts packages/orchestrator/src

# List all serialization/validation boundaries
bun packages/flow/src/cli/trace.ts packages/orchestrator/src --boundaries

# Full analysis: boundaries + pipelines + cascades
bun packages/flow/src/cli/trace.ts packages/orchestrator/src --full

# Trace a specific type through all pipelines
bun packages/flow/src/cli/trace.ts packages/orchestrator/src --type Handoff

# Invariant verification: discover functions, then prove invariants with Z3
bun run invariant discover packages/orchestrator/src --min-purity 0.5
bun run invariant prove packages/orchestrator/src --invariants invariants.json
# Use npx tsx for prove if Z3 WASM fails under Bun (e.g. npx tsx packages/flow/src/cli/invariant.ts prove ...)
```

## CLI

### `schema-match`

Finds runtime schema definitions, matches them to TypeScript types by convention, and diffs their shapes.

```bash
bun packages/flow/src/cli/schema-match.ts <src-dir> [options]
```

| Flag | Description |
|---|---|
| `--format text\|json` | Output format (default: `text`) |
| `--out <file>` | Write to file instead of stdout |
| `--library <name>` | Only use this extractor (default: auto-detect) |

**Example output:**

```
handoffSchema (schemas.ts:53) ↔ Handoff (core/types.ts)
  Match confidence: HIGH (Name convention: handoffSchema → Handoff)

  ✗ ERROR  verificationChecklist
    Shape mismatch: TypeScript has Array<{ criterion, passed, note? }>,
    Zod has Array<string>
    → Structured items stripped on parse

  ⚠ WARN   metrics.cacheReadTokens
    Optionality mismatch: TypeScript says required, Zod says optional
```

### `trace`

Traces data flow through serialization, validation, and error boundaries. Chains boundaries into pipelines and analyzes cascading failures.

```bash
bun packages/flow/src/cli/trace.ts <src-dir> [options]
```

| Flag | Description |
|---|---|
| `--boundaries` | List all boundaries only |
| `--full` | Full analysis: boundaries + pipelines + cascades |
| `--type <name>` | Trace a specific type through all pipelines |
| `--format text\|json` | Output format (default: `text`) |
| `--out <file>` | Write to file instead of stdout |

### `invariant`

Invariant verification: discover pure functions, generate invariants and tests, verify with fast-check, and prove with Z3 symbolic execution.

```bash
bun packages/flow/src/cli/invariant.ts <subcommand> [options]
# or from package: bun run invariant <subcommand> [options]
```

| Subcommand | Description |
|---|---|
| `discover <src-dir>` | Find testable functions (purity scoring, signature clustering). Options: `--min-purity`, `--suggest-extractions`, `--format text\|json`, `--out` |
| `generate <src-dir>` | Generate invariants (LLM) and property-based test skeletons. Options: `--invariants`, `--out`, `--model` |
| `verify <test-dir>` | Run generated tests with feedback loop and invariant refinement |
| `calibrate <corpus-dir>` | Validate against known bugs / regression corpus |
| `contracts <src-dir>` | Generate `tiny-invariant` runtime contracts from verified invariants. Options: `--invariants`, `--out` |
| `check-log <log-file>` | Check NDJSON run logs against defined invariants. Options: `--invariants` |
| `mutate <test-dir>` | Run Stryker mutation testing to measure invariant strength |
| `prove <src-dir>` | **Symbolic execution** — prove invariants exhaustively via Z3 (AST interpreter + path exploration). Options: `--invariants` (required), `--max-paths`, `--timeout`, `--json` |

**Prove (Z3):** For each function + invariant, the engine builds symbolic inputs from `ShapeType`, interprets the function body over the AST, forks at branches, and checks on every path that the postcondition cannot be violated. UNSAT on all paths ⇒ proven. SAT ⇒ counterexample. Requires `--invariants <json file>`. If Z3 WASM fails under Bun (e.g. pthreads), run with `npx tsx packages/flow/src/cli/invariant.ts prove ...`.

## Architecture

```
src/
├── schema/       Universal IR: ShapeType, DataBoundary, Pipeline, CascadeAnalysis
├── extractor/    Pluggable type/schema extraction
│   ├── typescript.ts      TS compiler API → ShapeType (always available)
│   ├── json-roundtrip.ts  Model JSON.stringify/parse transformations
│   ├── runtime-schema.ts  RuntimeSchemaExtractor interface + registry
│   └── zod.ts             First extractor implementation
├── analysis/     Library-agnostic comparison
│   ├── shape-differ.ts    Recursive ShapeType diffing
│   └── schema-matcher.ts  Match runtime schemas to TS types
├── flow/         Pipeline engine
│   ├── boundary-detector.ts  Extensible pattern-based boundary detection
│   ├── pipeline-tracer.ts    Chain boundaries via call graph
│   └── cascade-analyzer.ts  Trace downstream effects of mismatches
├── invariant/    Invariant verification (LLM + fast-check + Z3)
│   ├── types.ts           Invariant, DiscoveredFunction, VerificationResult, etc.
│   ├── function-finder.ts Purity scoring, signature clustering, extraction hints
│   ├── arbitrary-gen.ts   ShapeType → fast-check arbitrary code
│   ├── invariant-mutator.ts Weaken/strengthen/generalize/specialize postconditions
│   ├── feedback-loop.ts   Error-guided refinement with LLM
│   ├── test-gen.ts        bun:test + fast-check test file generation
│   ├── consistency-checker.ts  Clover three-artifact consistency (code, docs, invariants)
│   ├── runtime-contracts.ts    tiny-invariant assertion generation
│   ├── log-monitor.ts     NDJSON log checking against invariants
│   ├── mutation-testing.ts    Stryker integration for invariant strength
│   └── symbolic-executor.ts    Z3-based symbolic execution (“CrossHair for TypeScript”)
└── cli/          Command-line entry points
    ├── schema-match.ts    Schema–type diff
    ├── trace.ts           Boundary/pipeline/cascade tracing
    └── invariant.ts       Invariant discover / generate / verify / prove
```

### ShapeType — the universal IR

Every extractor (TypeScript, Zod, future Joi/Yup/Arktype) reduces to the same `ShapeType` discriminated union:

```typescript
type ShapeType =
  | { kind: "primitive"; value: "string" | "number" | "boolean" | ... }
  | { kind: "array"; element: ShapeType }
  | { kind: "object"; fields: ShapeField[] }
  | { kind: "union"; members: ShapeType[] }
  | { kind: "tuple"; elements: ... }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "enum"; values: Array<string | number> }
  | { kind: "record"; key: ShapeType; value: ShapeType }
  | { kind: "map" | "set" | "date" | "regex" | "function" | "promise" | ... }
  | { kind: "ref"; name: string; resolved?: ShapeType }
  | { kind: "opaque"; raw: string }
```

This models the full TS type system including types that don't survive JSON roundtrips (`Date`, `Map`, `Set`, `Function`, `BigInt`), which is what makes the JSON-roundtrip analyzer work.

### Pluggable extractors

Implement `RuntimeSchemaExtractor` to add support for any validation library:

```typescript
interface RuntimeSchemaExtractor {
  readonly library: string;
  detect(source: string): boolean;
  readonly validationPatterns: string[];
  extract(source: string, filePath: string): RuntimeSchemaInfo[];
}

const registry = new ExtractorRegistry();
registry.register(new ZodExtractor());
// registry.register(new JoiExtractor());
// registry.register(new YupExtractor());
```

The boundary detector automatically picks up validation patterns from all registered extractors.

### Mismatch categories

Every finding is categorized for automated triage:

| Category | Meaning |
|---|---|
| `type-mismatch` | Fundamentally different types (string vs object) |
| `json-lossy` | Survives JSON but loses precision (Date → string) |
| `json-dropped` | Lost entirely through JSON (Function, Map, undefined) |
| `optionality` | Required vs optional disagreement |
| `missing-field` | Field on one side but not the other |
| `union-coverage` | Schema covers fewer union variants than the type |
| `extra-field` | Schema accepts fields the type doesn't define |

### Cascade analysis

For each mismatch or unsafe error handler, the cascade analyzer traces downstream effects:

1. **Data preservation** — does the error path keep original data, or replace it with defaults?
2. **Metric fidelity** — are actual metrics (tokens, duration) preserved or zeroed?
3. **Classification accuracy** — does retry logic correctly identify the failure mode?
4. **Visibility** — is the error logged at an appropriate level?
5. **Recovery path** — does it re-run the whole task or try a cheaper recovery?

### Invariant verification flow

1. **Discover** — Scan source for exported functions; score purity (no I/O, no mutable globals, deterministic); cluster by signature for invariant reuse.
2. **Generate** — (Optional) Use an LLM to propose invariants and generate `bun:test` + fast-check skeletons; persist invariants as JSON.
3. **Verify** — Run property-based tests; on failure, feedback loop can refine invariants (mutate + LLM).
4. **Prove** — For each path through the function, the symbolic executor builds Z3 constraints and checks that the postcondition cannot be violated (UNSAT ⇒ proven; SAT ⇒ counterexample). Supports conditionals, loops (bounded unroll), Math.*, optional chaining, nullish coalescing, template literals, and common array/string methods.

## Integration

### With `deep-audit`

The `/deep-audit` command includes a Phase 4.5 that runs `schema-match` and `trace --boundaries` automatically, adding findings to the audit output.

### With `trace` command

The `/trace` command orchestrates the CLIs with LLM reasoning for semantic analysis that static tools can't do — understanding intent, explaining cascades, and suggesting fixes.

## Dependencies

- [`@devtools/graph`](../graph) — symbol graph, AST parsing, type checker
- [`@ast-grep/napi`](https://ast-grep.github.io/) — fast AST pattern matching for Zod/boundary detection
- [`typescript`](https://www.typescriptlang.org/) — compiler API for type resolution

**Invariant verification (dev):** `fast-check` (property-based tests), `tiny-invariant` (runtime contracts), `z3-solver` (symbolic execution for `prove`). Z3 WASM may require Node (e.g. `npx tsx`) instead of Bun for `prove` on some platforms.
