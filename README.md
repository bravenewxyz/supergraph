# supergraph

Your entire monorepo in one file.

supergraph analyzes your monorepo and generates a compact, structured text map of every module, every symbol, every cross-package edge, and every issue. One file an AI agent can read to understand your entire codebase. One file a human can grep to answer any structural question.

It also provides interactive query commands — blast radius analysis, change detection, and symbol context lookups — backed by a persistent graph cache and an MCP server for AI tool integration.

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

### Query commands

Query the dependency graph interactively. These commands use the graph built by `supergraph map` (cached automatically — see [Graph cache](#graph-cache)).

```
supergraph impact <symbol>           Blast radius analysis
supergraph detect-changes            Pre-commit change scope analysis
supergraph context <symbol>          360° symbol view (all edges in/out)
```

#### `supergraph impact <symbol>`

Walk the dependency graph outward from a symbol via BFS. Shows every downstream consumer, grouped by depth, with a risk score.

```bash
supergraph impact createGuild --depth 5 --format json
```

| Flag | Default | Description |
|---|---|---|
| `--direction up\|down\|both` | `down` | Traversal direction (dependents, dependencies, or both) |
| `--depth <n>` | `3` | Max traversal depth |
| `--format text\|json` | `text` | Output format |

Example output:

```
Impact: createGuild
Risk: high (14 dependents across 3 packages)

Depth 1:
  → useCreateGuild        hooks/useCreateGuild.ts
  → createGuildAction     actions/guild.ts

Depth 2:
  → CreateGuildForm       components/CreateGuildForm.tsx
  → GuildSetupWizard      components/GuildSetupWizard.tsx

Depth 3:
  → CreatePage            pages/create.tsx
```

#### `supergraph detect-changes`

Reads the current git diff, resolves changed symbols, and walks the graph to find all affected dependents. Use it pre-commit to understand the scope of your changes.

```bash
supergraph detect-changes --scope packages/core --format json
```

| Flag | Default | Description |
|---|---|---|
| `--scope <dir>` | `.` | Limit analysis to a directory |
| `--compare <ref>` | `HEAD` | Git ref to diff against |
| `--format text\|json` | `text` | Output format |

Example output:

```
Changed symbols: 3
  ~ validateInput         utils/validation.ts (modified)
  + parseAmount           utils/validation.ts (added)
  - sanitizeHtml          utils/validation.ts (removed)

Affected dependents: 12
  Risk: medium

  useFormValidation       hooks/useFormValidation.ts
  SettingsForm            components/SettingsForm.tsx
  ... +10 more
```

#### `supergraph context <symbol>`

Show all incoming and outgoing edges for a symbol, grouped by relationship type (import, call, type reference, etc.).

```bash
supergraph context GuildResponse --format json
```

| Flag | Default | Description |
|---|---|---|
| `--format text\|json` | `text` | Output format |

Example output:

```
Context: GuildResponse (types/guild.ts)

Incoming (7):
  import  useGuild              hooks/useGuild.ts
  import  GuildCard             components/GuildCard.tsx
  import  guildApi              api/guild.ts
  typeref GuildListResponse     types/responses.ts
  ... +3 more

Outgoing (2):
  import  Role                  types/role.ts
  import  RequirementConfig     types/requirements.ts
```

### Graph cache

The dependency graph is cached to `.supergraph/graph-cache.json` after the first build. Subsequent `impact`, `detect-changes`, and `context` commands reload from cache instead of re-parsing the entire codebase. The cache is invalidated automatically when source files change. To force a rebuild:

```bash
supergraph map <src-dir>   # rebuilds the graph and updates the cache
```

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

## MCP Server

supergraph includes a built-in [Model Context Protocol](https://modelcontextprotocol.io/) server, exposing graph queries as tools that AI agents can call directly.

Start the server:

```bash
supergraph serve
```

### Available tools

| Tool | Description |
|---|---|
| `supergraph_context` | 360° symbol view — all incoming/outgoing edges |
| `supergraph_impact` | Blast radius analysis — downstream dependents with risk scoring |
| `supergraph_detect_changes` | Git diff → affected symbols → dependent scope |
| `supergraph_query` | Raw graph query (filter by package, type, edge kind) |
| `supergraph_map` | Rebuild the graph for a source directory |

### Configuration

Add to `.mcp.json` in your project root (works with Claude Code, Cursor, and other MCP clients):

```json
{
  "mcpServers": {
    "supergraph": {
      "command": "supergraph",
      "args": ["serve"]
    }
  }
}
```

The server uses stdio transport by default. Once configured, your AI agent can call tools like `supergraph_impact` or `supergraph_context` directly during a conversation.

## Supported languages

- TypeScript/JavaScript (primary)
- Go (map, complexity, dead-exports)

---

Built by [bravenew.xyz](https://bravenew.xyz)
