# CLAUDE.md

## Project overview

supergraph is a monorepo analysis CLI that generates structured text maps of codebases. It is a TypeScript project built with Bun, compiled to standalone binaries for distribution.

## Build and run

```bash
bun install              # install dependencies
bun run src/index.ts     # run CLI in development
bun run build            # compile standalone binary
```

## Project structure

- `src/index.ts` — CLI entry point and subcommand router
- `src/commands/` — individual command implementations (map, complexity, dead-exports, etc.)
- `packages/scripts/` — cross-package pipeline scripts (aggregate, superhigh, pkg-graph)
- `commands/` — Claude Code slash command markdown files
- `serve.ts` — static file server for the web UI

## Key commands

### Analysis commands

Run `supergraph` with no arguments for the full pipeline, or use individual subcommands:

```
supergraph map <src-dir>        # build semantic graph
supergraph complexity <src-dir> # cyclomatic complexity
supergraph dead-exports <src-dir>
supergraph aggregate            # cross-package visualization
```

### Query commands

These query the dependency graph interactively (requires a prior `supergraph map` run or cached graph):

```
supergraph impact <symbol>       # blast radius — BFS through dependents, risk scoring
supergraph detect-changes        # git diff → changed symbols → affected scope
supergraph context <symbol>      # all incoming/outgoing edges for a symbol
```

All query commands support `--format text|json`. The graph is cached at `.supergraph/graph-cache.json` for fast reloads.

### MCP Server

`supergraph serve` starts an MCP (Model Context Protocol) server over stdio. It exposes these tools:

- `supergraph_context` — 360-degree symbol view
- `supergraph_impact` — blast radius analysis
- `supergraph_detect_changes` — pre-commit change scope
- `supergraph_query` — raw graph queries
- `supergraph_map` — rebuild the graph

To use the MCP server in this project, add to `.mcp.json`:

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

## Output directory

All generated artifacts go to `.supergraph/` in the target repo root. This directory is typically gitignored.

## Testing

There is no formal test suite. Verify changes by running individual commands against a test monorepo.
