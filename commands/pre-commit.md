Pre-commit blast radius check. Analyzes staged changes to identify what you're about to break, which tests to run, and whether the commit is safe.

**Argument**: `$ARGUMENTS` — optional. "staged" (default) to check staged changes, or "unstaged" to check all working tree changes.

---

## Communication style

**Direct, actionable, fast.** This is a gate check, not an audit. The user wants a go/no-go in under 30 seconds.

- No narration. No preamble. Run the analysis and present results.
- If everything is safe: say so in one line and stop.
- If there are risks: show them clearly with specific file:line references.

---

## Requirements

This command requires the supergraph MCP server (`supergraph serve`). If MCP tools are unavailable, fall back to the static analysis method described at the bottom.

---

## Step 1: Detect what changed

Use `supergraph_detect_changes` with scope set to the argument (default: "staged").

This returns:
- Changed symbols (what was directly modified)
- Affected dependents (what downstream symbols depend on the changes)
- Risk assessment per symbol (LOW / MEDIUM / HIGH / CRITICAL)

If no changes are detected, report "No staged changes detected." and stop.

## Step 2: Assess high-risk symbols

For any symbol flagged as **HIGH** or **CRITICAL** risk by `supergraph_detect_changes`:

1. Use `supergraph_impact` on each high-risk symbol to get the full blast radius — depth groups, affected symbol count, and risk score.
2. Use `supergraph_context` on the symbol to see exactly who depends on it (incoming edges) and what it depends on (outgoing edges).

## Step 3: Present the assessment

Output in this format:

```
## Pre-commit check: <N> symbols changed, <M> dependents affected

### Risk summary
- CRITICAL: <count> (blocks commit)
- HIGH: <count> (review recommended)
- MEDIUM: <count>
- LOW: <count>

### Critical/High risk details

**<symbol-name>** · `file:line` · risk: CRITICAL
Blast radius: <N> direct dependents, <M> total at depth 3
Dependents: <list of directly affected symbols>
Why: <one-line explanation of the risk>

**<symbol-name>** · `file:line` · risk: HIGH
...

### Suggested test scope
- `bun test <path>` — covers <symbol>
- `bun test <path>` — covers <symbol>

### Recommendation
<GO / REVIEW FIRST / NO-GO>
<one-line rationale>
```

**Decision criteria:**
- **GO**: All symbols LOW/MEDIUM risk, blast radius contained.
- **REVIEW FIRST**: Any HIGH risk symbols. List what to review.
- **NO-GO**: Any CRITICAL risk symbols, or blast radius exceeds 20 direct dependents. Explain what could break.

---

## Fallback: static analysis (no MCP)

If MCP tools are unavailable:

1. Run `supergraph detect-changes --scope staged` via Bash to generate the analysis.
2. Read the output and present the same format above.
3. For blast radius details, read `.supergraph/supergraph.txt` and trace dependents manually from the module graph.
