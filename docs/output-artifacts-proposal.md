# Output Artifacts Proposal

## Scope

This note reviews the artifacts emitted by a fresh `supergraph --root /Users/raz/Work/bravenewxyz/supergraph --no-anim` run and proposes a cleaner output design.

Validated inputs:

- Top-level outputs in `.supergraph/`
- Per-package text outputs in `.supergraph/packages/<pkg>/`
- Per-package raw JSON in `.supergraph/packages/<pkg>/json/`

Validation performed:

- Fresh audit run on the `supergraph` repo
- All per-package JSON files parse successfully
- All expected top-level files exist and are non-empty

## Current Artifact Set

Top-level:

- `supergraph.html`
- `pkg-graph.html`
- `supergraph.txt`
- `supergraph-compact.txt`
- `symbols.txt`
- `symbols-full.txt`
- `temporal.txt`
- `issues.txt`

Per package:

- Text: `map.txt`, `deps.txt`, `imports.txt`, `complexity.txt`, `dead.txt`, `schema-match.txt`, `contracts.txt`, `trace-boundaries.txt`, `logic-audit.txt`
- HTML: `dashboard.html`, `graph.html`
- JSON: `map.json`, `schema-match.json`, `contracts.json`, `trace-boundaries.json`, `logic-audit.json`, `discovery.json`, `taint.json`

Observed sizes from the fresh run:

- `supergraph.html`: 3685 KB
- `supergraph.txt`: 1152 KB
- `supergraph-compact.txt`: 3 KB
- `symbols.txt`: 1237 KB
- `symbols-full.txt`: 1148 KB
- `temporal.txt`: 9 KB
- `issues.txt`: 613 KB
- `pkg-graph.html`: 21 KB

## Findings

### 1. There is no explicit artifact contract

The current pipeline treats "file exists" as success, but several valid states are semantically different:

- generated with useful content
- skipped because the repo does not support that analysis
- generated with "no findings"
- failed

These states are currently collapsed together in the CLI summary.

Examples:

- `cross-lang-bridge` is reported as a successful cross-package step even when the repo has no Go bridge inputs and no artifact is written.
- `schema-match.txt` exists for all packages in this repo, but its content is only `No runtime schemas found.`

### 2. Output naming does not imply a clean detail hierarchy

The current names suggest a ladder:

- compact
- normal
- full

But the emitted files do not follow that shape consistently:

- `symbols.txt` is larger than `supergraph.txt`
- `symbols-full.txt` is almost the same size as `supergraph.txt`
- `issues.txt` is a major top-level report but is named like an auxiliary dump

This makes it hard for users and agents to know which file is the canonical entry point for a given task.

### 3. The pipeline mixes canonical data and views

Today the output tree contains both:

- canonical machine data: per-package JSON
- derived text summaries
- derived HTML views

But there is no manifest tying them together. A consumer cannot answer basic questions without re-deriving them:

- Which files are canonical?
- Which files are views over the same source data?
- Which artifacts are safe for AI context?
- Which artifacts are stale leftovers from another command?

### 4. Cleanup ownership is incomplete

The audit pipeline clears a fixed list of top-level artifacts, but not the full artifact namespace. This allows stale files to linger under `.supergraph/` when they are produced by other commands or old layouts.

Observed example:

- `.supergraph/strategic/brief.md`
- `.supergraph/strategic/moves.md`

These files are not surfaced in the main summary and are not part of the main audit cleanup set.

### 5. The summary surface is narrower than the real output tree

The current audit summary lists:

- top-level cross-package outputs
- per-package `dashboard.html`

But it omits:

- per-package `graph.html`
- all per-package JSON artifacts
- top-level auxiliary artifacts not in the hardcoded summary list

That makes the output tree look simpler than it is, while also hiding the files that are most stable for automation.

## Comparison By Intended Consumer

### Browser-first

- `supergraph.html`
- `pkg-graph.html`
- `packages/*/dashboard.html`
- `packages/*/graph.html`

Strengths:

- good for interactive exploration
- shareable as standalone files

Weaknesses:

- large
- not easily composable by tools
- validity is mostly visual, not schema-checked

### Human text / CLI

- `supergraph.txt`
- `supergraph-compact.txt`
- `issues.txt`
- `temporal.txt`
- per-package `*.txt`

Strengths:

- easy to inspect in terminal
- good for diffs and logs

Weaknesses:

- several files overlap heavily
- "no data" is represented as tiny files instead of explicit status
- naming does not map cleanly to depth or use case

### Machine / agent

- per-package `json/*.json`

Strengths:

- parseable
- closest thing to a canonical source of truth

Weaknesses:

- no top-level manifest
- no declared schemas
- not all tool outcomes are represented uniformly
- cross-package tools do not consistently emit machine-readable artifacts

## Proposal

### 1. Introduce a manifest as the single contract

Add:

- `.supergraph/index.json`

Each artifact should be registered with:

- `id`
- `scope`: `repo` or `package`
- `producer`
- `format`: `html`, `txt`, `json`, `md`
- `status`: `generated`, `skipped`, `empty`, `failed`
- `path`
- `bytes`
- `summary`
- `inputs`
- `generatedAt`

This turns artifact validity into structured metadata instead of inference from file presence.

### 2. Separate canonical data from views

Use a stable layout:

- `.supergraph/index.json`
- `.supergraph/raw/...`
- `.supergraph/views/...`
- `.supergraph/context/...`

Suggested mapping:

- canonical machine data:
  - `.supergraph/raw/packages/<pkg>/map.json`
  - `.supergraph/raw/packages/<pkg>/logic-audit.json`
  - `.supergraph/raw/packages/<pkg>/trace-boundaries.json`
  - `.supergraph/raw/repo/cross-lang-bridge.json`
- human/browser views:
  - `.supergraph/views/supergraph.html`
  - `.supergraph/views/pkg-graph.html`
  - `.supergraph/views/packages/<pkg>/dashboard.html`
  - `.supergraph/views/packages/<pkg>/graph.html`
- AI/context artifacts:
  - `.supergraph/context/architecture-compact.txt`
  - `.supergraph/context/architecture-full.txt`
  - `.supergraph/context/findings.txt`
  - `.supergraph/context/temporal.txt`
  - `.supergraph/context/symbols-brief.txt`
  - `.supergraph/context/symbols-source.txt`

This does not require deleting the current files immediately; aliases or compatibility symlinks can bridge the migration.

### 3. Make status explicit for "no data" and "not applicable"

Do not encode these states only as tiny text files.

Rules:

- `skipped`: analysis not applicable to this repo or package
- `empty`: analysis ran, but produced no findings
- `generated`: contentful artifact written
- `failed`: analysis errored

Examples:

- `cross-lang-bridge` on a non-Go repo should register as `skipped` with reason `no bridge inputs found`
- `schema-match` on a package with no runtime schemas should register as `skipped` or `empty`, not only emit a 25-byte text file

### 4. Rename the top-level text outputs around intent, not legacy

Recommended logical names:

- `architecture-full.txt` instead of `supergraph.txt`
- `architecture-compact.txt` instead of `supergraph-compact.txt`
- `symbols-brief.txt` instead of `symbols.txt`
- `symbols-source.txt` instead of `symbols-full.txt`
- `findings.txt` instead of `issues.txt`

Reason:

- names become monotonic by purpose
- "brief/full/source" describes detail more clearly than current labels
- "findings" is clearer than "issues" because some items are warnings or opportunities, not only bugs

### 5. Treat per-package JSON as first-class public outputs

Today per-package JSON exists but is effectively an internal implementation detail.

It should instead be:

- declared in the manifest
- consistently named
- optionally schema-versioned

Add `meta` to each JSON artifact:

- `tool`
- `schemaVersion`
- `generatedAt`
- `package`
- `sourceDir`

### 6. Make the audit summary manifest-driven

Instead of hardcoding specific artifact names, the CLI summary should read the manifest and show:

- generated artifacts
- skipped artifacts with reason
- empty artifacts
- failed artifacts

That fixes current mismatches such as:

- a tool reported as successful even when it produced no file
- generated files that exist but are hidden from the summary

### 7. Define a small set of blessed entrypoints

Users should not need to understand the whole artifact tree.

Recommended entrypoints:

- browser entry: `views/supergraph.html`
- package browser entry: `views/packages/<pkg>/dashboard.html`
- terminal entry: `context/architecture-compact.txt`
- findings entry: `context/findings.txt`
- machine entry: `index.json`

Everything else should be documented as either raw data or secondary view material.

## Suggested Migration Plan

### Phase 1: Contract and visibility

- add `.supergraph/index.json`
- register every emitted artifact
- include `status` and `reason`
- make the CLI summary read from the manifest

### Phase 2: Namespace cleanup

- move new outputs under `raw/`, `views/`, and `context/`
- keep current legacy paths as compatibility outputs
- clean only artifacts owned by the active manifest

### Phase 3: Naming cleanup

- add new intent-based filenames
- keep legacy names for one release window
- update MCP and docs to prefer the new names

### Phase 4: Schema and validation

- add `schemaVersion` to JSON outputs
- validate generated JSON against lightweight schemas
- add an internal `supergraph validate-outputs` command

## Recommended First Implementation

If only one improvement is made now, it should be the manifest.

That single change would solve most of the current ambiguity:

- artifact validity becomes explicit
- skipped vs empty becomes visible
- stale and hidden files are easier to detect
- the CLI summary stops drifting from the real output tree
- MCP and future automation get a stable discovery surface
