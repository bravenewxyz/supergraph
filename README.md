# supergraph

Your entire monorepo in one file.

supergraph analyzes your monorepo and generates a compact, structured text map of every module, every symbol, every cross-package edge, and every issue. One file an AI agent can read to understand your entire codebase. One file a human can grep to answer any structural question.

## Install

**Homebrew:**

```bash
brew install bravenewxyz/supergraph/supergraph
```

**Shell script** (also installs Claude Code slash commands):

```bash
curl -fsSL https://raw.githubusercontent.com/bravenewxyz/supergraph/master/install.sh | bash
```

Binaries are available for macOS (ARM64, x64) and Linux (x64).

## Usage

Run `supergraph` in any monorepo with a `packages/` directory to get a full audit:

```bash
supergraph
```

This discovers all packages, runs every analysis tool in parallel, and generates:

| File | What | Size |
|---|---|---|
| `.supergraph/supergraph.txt` | Unified map: domains, schemas, modules, types, edges | ~10KB |
| `.supergraph/supergraph-compact.txt` | Compressed version for AI context windows | ~8KB |
| `.supergraph/symbols.txt` | Every symbol with tiered detail (signatures + selective bodies) | ~2MB |
| `.supergraph/symbols-full.txt` | Every symbol with full source bodies | ~10MB |
| `.supergraph/supergraph.html` | Interactive graph visualization | |
| `.supergraph/packages/<name>/` | Per-package analysis (map, complexity, dead exports, logic audit) | |
| `.supergraph/packages/<name>/dashboard.html` | Interactive audit dashboard | |

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
supergraph aggregate                 Cross-package graph visualization
supergraph pkg-graph                 Package dependency visualization
```

All commands support `--format text|json`, `--out <file>`, and `--root <path>`.

## The output

Running `supergraph` produces `.supergraph/supergraph.txt` — a unified, domain-aware map of your entire codebase:

```
SUPERGRAPH | myapp | 2026-03-05
365mods

# PART 1 — DOMAINS

[guild]
r/guild GET /v2/guilds/:id  cache:60s
c/guild createGuild,updateGuild,deleteGuild
z/GuildSchema id:str name:str urlName:str? imageUrl:str? +8
t/guilds id:int name:varchar url_name:varchar +12

# PART 2 — PACKAGES

[core]
types [69/71]<-47 Config,UserState,AppContext,+61 | zod
utils/validation [4]<-12 validateInput,sanitize,parseDate,isValid

# PART 3 — TYPES

GuildResponse { id:num name:str urlName:str roles:Role[] +6 }
```

Domains, schemas, modules, types, and edges in one file. An agent reads it once and knows the entire architecture.

For source-level detail, `.supergraph/symbols-full.txt` contains every function body, every type definition, every signature — the complete codebase in one text file.

## Claude Code commands

The install script adds these slash commands for Claude Code:

| Command | What it does |
|---|---|
| `/deep-audit` | 10-phase systematic code audit with parallel fix execution |
| `/deep-read` | Loads `symbols-full.txt` for source-level codebase understanding |
| `/high-level` | Loads `supergraph-compact.txt` for architecture overview |
| `/init-supergraph` | Bootstrap supergraph on a new repository |

### /deep-audit

Point it at a package, it reads the full map, audits source files across 10 phases, writes findings and fix plans to disk. Say "do all" and it executes them via parallel subagents.

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
