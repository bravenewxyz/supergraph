# supergraph

Your entire monorepo in one file.

supergraph analyzes your monorepo and generates a compact, structured text map of every module, every symbol, every cross-package edge, and every issue. One file an AI agent can read to understand your entire codebase. One file a human can grep to answer any structural question.

## Install

```bash
# curl (also installs /deep-audit for Claude Code)
curl -fsSL https://raw.githubusercontent.com/bravenewxyz/supergraph/master/install.sh | bash

# or homebrew
brew install bravenewxyz/supergraph
```

Binaries are available for macOS (ARM64, x64) and Linux (x64).

## Usage

Run `supergraph` in any monorepo with a `packages/` directory to get a full audit:

```bash
supergraph
```

This discovers all packages, runs every analysis tool in parallel, and generates:

- `audit/packages/<name>/` — per-package text + JSON results
- `audit/packages/<name>/dashboard.html` — interactive audit dashboard
- `audit/supergraph.txt` — cross-package module graph
- `audit/supergraph.html` — interactive graph visualization
- `audit/pkg-graph.html` — package dependency visualization

### Individual commands

Run a single tool against any source directory:

```
supergraph map <src-dir>             Semantic graph (map.txt, deps.txt, imports.txt)
supergraph complexity <src-dir>      Per-function cyclomatic complexity
supergraph dead-exports <src-dir>    Unused export detection
supergraph schema-match <src-dir>    Runtime schema vs TypeScript type mismatches
supergraph trace <src-dir>           Data flow through serialization boundaries
supergraph logic-audit <src-dir>     Decision-logic bug detection
supergraph contracts <be-src-dir>    FE/BE contract verification
supergraph invariant discover <dir>  Invariant discovery + property-based testing
supergraph aggregate                 Cross-package supergraph visualization
supergraph pkg-graph                 Package dependency visualization
```

All commands support `--format text|json`, `--out <file>`, and `--root <path>`.

## The output

Running `supergraph` produces `audit/supergraph.txt` — a structured, compressed map of your entire module graph:

```
MYAPP SUPERGRAPH | 2026-03-05
365m · 852ie · 209xe

# PACKAGES  (short=npm,modules)
core=@myapp/core,14m  api=@myapp/api,23m  ui=@myapp/ui,85m

# MODULES
# path [exp(/total)]<-importers symbols | ext-deps

[core]
types [69/71]<-47 Config,UserState,AppContext,+61 | zod
utils/validation [4]<-12 validateInput,sanitize,parseDate,isValid

[api]
routes/auth [3/8]<-2 login,logout,refresh | express,jsonwebtoken
    | @myapp/core

# CROSS-PACKAGE DEPENDENCIES
api/routes/auth -> core/types core/utils/validation
ui/components/login -> core/types api/client
```

~500 lines for a full monorepo. Every module shows exported vs total symbols, importer count, symbol names, and external dependencies. Cross-package edges are listed explicitly.

## /deep-audit

The install script adds `/deep-audit` as a Claude Code slash command — a 10-phase systematic code audit:

0. **Generate artifacts** — runs all supergraph tools
1. **Read the map** — loads all generated artifacts
2. **Structural audit** — dead exports, circular deps, complexity hotspots
3. **Deep audit** — reads source files, checks for bugs and overengineering
4. **Cross-cutting analysis** — architectural coherence, SRP violations
5. **Data flow trace** — schema-type mismatches, unsafe assertions
6. **Logic analysis** — decision table gaps, guard consistency
7. **Invariant verification** — property-based testing of pure functions
8. **Write plans** — groups findings into actionable plans with file+line citations
9. **Present and execute** — dispatches fixes via parallel subagents

```
/deep-audit packages/core/src
```

## Supported languages

- TypeScript/JavaScript (primary)
- Go (map, complexity, dead-exports)

---

Built by [bravenew.xyz](https://bravenew.xyz)
