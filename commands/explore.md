Interactive symbol exploration. Takes a query — a symbol name, pattern, or concept — and provides a complete picture: what it is, who uses it, what it affects, and how important it is to the architecture.

**Argument**: `$ARGUMENTS` — required. A symbol name (e.g. `runAuditPipeline`), a pattern (e.g. `run*Command`), a file path (e.g. `src/commands/audit.ts`), or a concept (e.g. "the complexity analyzer").

---

## Communication style

**Conversational, thorough, structured.** This is an exploration tool — the user is trying to understand something. Give them the full picture, then offer to go deeper.

- Present results immediately. No narration of what you're about to do.
- Use the structured format below. Keep it scannable.
- After presenting, offer follow-up options.

---

## Requirements

This command requires the supergraph MCP server (`supergraph serve`). If MCP tools are unavailable, fall back to the static analysis method described at the bottom.

---

## Step 1: Find the symbol

Use `supergraph_query` with the user's argument as the search pattern.

- If the query is a specific symbol name, search for an exact match.
- If the query is a pattern (contains `*` or partial name), search with the pattern.
- If the query is a concept or description, infer likely symbol names and search for each.

If multiple results are returned, pick the most relevant one (highest import count, or most central in the graph). Mention the other matches briefly.

If no results are found, say so and suggest alternative search terms based on what you know from `supergraph_map`.

## Step 2: Get the full context

For the primary symbol found in Step 1:

1. Use `supergraph_context` to get the 360-degree view — all incoming edges (who calls/imports this) and all outgoing edges (what this calls/imports).
2. Use `supergraph_impact` to get the blast radius — BFS traversal showing depth groups, risk score, and total affected symbols.

## Step 3: Present the exploration

Output in this format:

```
## <symbol-name>

**Location**: `file:line`
**Kind**: function / type / class / variable / interface
**Exported**: yes / no
**Package**: <package-name>

### What it does
<1-3 sentences describing the symbol's purpose based on its signature, context, and position in the graph.>

### Who uses it (<N> incoming edges)
<List the direct callers/importers, grouped by package if cross-package.>
- `caller-symbol` in `file.ts` — <one-line description of how it uses this symbol>
- ...

### What it depends on (<N> outgoing edges)
<List the direct dependencies.>
- `dep-symbol` in `file.ts`
- ...

### Blast radius
- **Risk**: LOW / MEDIUM / HIGH / CRITICAL
- **Direct dependents**: <N>
- **Total affected (depth 3)**: <N>
- **Depth groups**:
  - Depth 1: <symbols>
  - Depth 2: <symbols>
  - Depth 3: <symbols>

### Architectural role
<1-2 sentences on this symbol's importance. Is it a hub? A leaf? A bridge between packages? A bottleneck?>
```

## Step 4: Offer follow-up

After presenting, offer these options:

```
Explore further?
- "context <symbol>" — deep-dive into any symbol mentioned above
- "impact <symbol>" — blast radius for a specific dependent
- "related <pattern>" — find similar symbols
```

If the user provides a follow-up, repeat Steps 1-3 for the new target.

---

## Fallback: static analysis (no MCP)

If MCP tools are unavailable:

1. Read `.supergraph/supergraph-compact.txt` and `.supergraph/supergraph.txt` to find the symbol.
2. Search for the symbol name in per-package `map.txt` and `imports.txt` files.
3. Read the source file containing the symbol.
4. Trace dependents manually from `deps.txt` and `imports.txt`.
5. Present the same format above, noting that blast radius is estimated from static files.
