Bold follow-up to `/deep-strategic`. Picks up where the strategic brief left off — reads the prior analysis, the implemented moves, and the current codebase state, then pushes into territory the initial review was too conservative to suggest. Frontier features, architectural gambits, product pivots, and the kind of moves that change what the tool IS rather than incrementally improving what it does.

**Argument**: `$ARGUMENTS` — optional. A theme or direction to bias toward (e.g. "multi-agent", "developer experience", "new analysis capabilities", "go deeper on invariants"). If omitted, the command picks the most promising frontier autonomously.

---

## Model requirements

Same as `/deep-strategic` — designed for **Claude Opus with the 1M context window**. The entire value comes from having the full codebase + the strategic brief + the implemented changes all in context simultaneously. This enables reasoning about what the codebase IS versus what it COULD BE — you can't propose a bold new direction without knowing every load-bearing wall and every dormant capability.

---

## Communication style

**Provocative, concrete, opinionated.** This is not a status report. This is "here's what I'd do if this were my project and I had one week."

- Phase 0: silent.
- Phase 1 (context load): **silent**. Load everything.
- Phase 2 (gap analysis): silent. Compare what was planned vs what was done vs what's now possible.
- Phase 3 (vision): present the bold directions. **WAIT for user reaction.**
- Phase 4 (deep design): design the chosen direction in detail.
- Phase 5 (execute or spec): implement, or write an implementation spec if the scope is too large.

**Tone rules:**
- Don't recap what `/deep-strategic` found. The user was there. Reference it, don't repeat it.
- Don't hedge. "This might be interesting" is banned. Say "Do this" or "Skip this."
- Think in capabilities, not tasks. "Add X feature" is boring. "This lets the tool do Y, which nobody else can do" is interesting.
- Name things. A bold direction needs a name. "Temporal Drift Detection" is a feature. "Show me what changed" is a capability. "The codebase has a memory" is a vision.
- Challenge the architecture. If the current structure prevents something great, say so. Propose the restructuring AND the payoff.

---

## Output directory

All written output goes under `.supergraph/strategic/`. Appends to, does not overwrite, the existing brief.

```
.supergraph/strategic/
  brief.md              # Updated with new section
  moves.md              # Updated with new moves
  frontier.md           # NEW — the bold vision document
```

---

## MCP tools (preferred)

If the supergraph MCP server is running (`supergraph serve`), use these tools for a sharper follow-up. The diff layer (Phase 1c) benefits enormously from live analysis:

| MCP Tool | Use for |
|---|---|
| `supergraph_detect_changes` | What changed since the strategic review — replaces manual git diff + static file reading |
| `supergraph_impact` | Blast radius of proposed bold directions — quantify before proposing |
| `supergraph_context` | Deep-dive into symbols that the strategic review flagged for follow-up |
| `supergraph_query` | Explore areas the user's `$ARGUMENTS` theme points to |
| `supergraph_map` | Quick architecture refresh before gap analysis |

**Integration points:**
- **Phase 1c**: Use `supergraph_detect_changes` (scope: "all") instead of manual `git diff` — it maps file changes to affected symbols and their dependents, giving you a precise picture of what shifted.
- **Phase 2a**: Use `supergraph_impact` on symbols modified by the implemented strategic moves to assess whether they achieved the intended blast radius.
- **Phase 3**: Use `supergraph_impact` on key symbols in each proposed bold direction to quantify effort and risk before presenting.
- **Phase 4**: Use `supergraph_context` on the symbols the chosen direction will touch to verify the design fits the actual dependency graph.

**Fallback**: If MCP tools are unavailable, the follow-up works entirely from static files and git commands as described below.

---

## Phase 0: Generate artifacts (if needed)

Check if `.supergraph/context/architecture-full.txt` and `.supergraph/context/symbols-brief.txt` exist. If not, run `supergraph --no-anim`. If the new files are absent but the legacy compatibility outputs exist, you may use `.supergraph/supergraph.txt` and `.supergraph/symbols.txt` as fallback inputs.

---

## Phase 1: Full context load

Load everything from the prior strategic review AND the current codebase state. The order matters — prior analysis first (so you see what was identified), then current state (so you see what changed).

### 1a. Prior analysis

Read these in order:
1. `.supergraph/strategic/brief.md` — the strategic brief from `/deep-strategic`
2. `.supergraph/strategic/moves.md` — the implementation guide
3. `.supergraph/strategic/frontier.md` — if it exists from a prior `/deep-followup`

### 1b. Current codebase state

Use the same chunked parallel reading strategy as `/deep-strategic`:
1. `.supergraph/context/architecture-full.txt` — full module graph
2. `.supergraph/context/symbols-brief.txt` — every symbol with tiered detail (use parallel chunked reads)
3. Root `package.json`, `README.md`, `CLAUDE.md`

### 1c. Diff layer — what changed since the strategic review

This is critical.

**If MCP is available**: Use `supergraph_detect_changes` with scope "all" to get a structured view of what changed — it maps file diffs to affected symbols and their downstream dependents. This is far more useful than raw `git diff --stat` because it tells you what the changes MEAN in terms of the architecture, not just which files were touched.

**Then (or if MCP is unavailable)** run:
```bash
git log --oneline -20
git diff HEAD~5 --stat
```

Read any files that changed significantly since the strategic brief was written. Focus on:
- New files (capabilities added)
- Modified hub modules (architecture shifted)
- New sections in output files (supergraph.txt, symbols.txt)
- New tool integrations in `src/commands/audit.ts`

### 1d. Per-package analysis data

Read the JSON analysis outputs that the pipeline now generates:
- `.supergraph/raw/packages/*/logic-audit.json` — decision gaps, guard issues
- `.supergraph/raw/packages/*/discovery.json` — invariant candidates, pure functions, hubs, duplicates
- `.supergraph/raw/packages/*/taint.json` — taint analysis results
- `.supergraph/raw/packages/*/map.json` — module graph (skim for structure)

These tell you what the tool finds when it analyzes ITSELF. Self-referential insights are gold — they show both the tool's power and its blind spots.

---

## Phase 2: Gap analysis (silent)

Before saying anything, answer these questions internally:

### 2a. Implementation review
- Which moves from the strategic brief were implemented? How well?
- Did the implementation reveal anything unexpected?
- Are there second-order effects — did implementing X make Y suddenly possible or obviously necessary?

### 2b. Capability frontier
- What can the tool do NOW that it couldn't before the strategic moves?
- What's the most impressive thing the tool could demonstrate to a skeptic in 30 seconds?
- What analysis capability is 80% built but not wired up?
- What would make someone say "I didn't know static analysis could do THAT"?

### 2c. Architectural constraints
- What bold feature is blocked by the current architecture?
- Where does the layering prevent something interesting?
- Is there a module that's doing too much or too little?
- What would break if the tool needed to handle 10x larger codebases? 100x?

### 2d. Competitive moat
- What does supergraph do that no other tool does?
- How deep is that moat? Could someone replicate it in a weekend?
- What would DEEPEN the moat — make the unique capabilities harder to replicate?

### 2e. The "what if" questions
- What if the tool ran continuously instead of on-demand?
- What if the output format was an API instead of text files?
- What if multiple supergraph instances could share findings?
- What if the tool could MODIFY code, not just analyze it?
- What if the analysis survived across commits — building institutional memory?

---

## Phase 3: Present bold directions

Output 3-5 **named directions** — not incremental improvements, but capability-level changes that would redefine what the tool is. Each direction should feel slightly uncomfortable — if it's obviously safe, it's not bold enough.

### Format

```
## Frontier Directions

I've reviewed the strategic brief, the implemented moves, and the current state.
<1-2 sentences on what the implemented moves unlocked or revealed.>

### Direction 1: <Name> — <one-line pitch>

<2-3 sentences on what this IS and why it matters.>

**What it enables**: <the capability, stated as what the USER can do>
**What it requires**: <honest assessment of effort and risk>
**Why now**: <what makes this possible/urgent given current state>
**Moat depth**: <how hard this would be for someone else to replicate>

### Direction 2: <Name> — <one-line pitch>
...

### Direction 3: <Name> — <one-line pitch>
...
```

### Direction quality bar

Each direction MUST:
- **Name a capability nobody else has.** "Better error messages" is not a direction. "The tool that finds bugs in your decision logic before they reach production" is.
- **Build on existing strengths.** Don't propose something that ignores the ShapeType algebra, the decision-table engine, or the invariant system. Those are the foundations.
- **Have a concrete first step.** Vague directions die. Each one needs a "you could start with THIS FILE and THIS FUNCTION" anchor.
- **Address a real problem.** Not a hypothetical. Name a scenario where a developer would need this, today.
- **Be achievable by a solo dev in 1-2 weeks.** Directions that require a team of 10 for a year are fantasies. Ambitious-but-feasible is the sweet spot.

### After presenting

Use **AskUserQuestion** to let the user pick which direction(s) to explore. Provide options:
- Each direction as an option
- "Combine N directions" if two are complementary
- Include a "(Recommended)" suffix on the one you think has the highest leverage

**WAIT for the user's response before proceeding.**

---

## Phase 4: Deep design

For the chosen direction(s), produce a detailed design document. This is not a plan — it's an architecture. It should be specific enough that someone could implement it from the document alone.

### Design document structure

```markdown
# <Direction Name>

## Vision
<What the user experiences when this is done. Not features — outcomes.>

## Architecture
<How it fits into the existing module graph. Which layers it touches.
Draw ASCII diagrams if the data flow is non-obvious.>

## Key Abstractions
<New types, interfaces, or modules needed. Show actual TypeScript signatures.>

## Implementation Sequence
<Ordered steps, each self-contained and testable. Each step produces a working state.>

## What Breaks
<Honest list of things that get harder, slower, or more complex.
Every architectural change has costs — name them.>

## Success Criteria
<How you'd know this worked. Concrete, measurable.>

## First Commit
<The exact files to create/modify for the first working increment.
Line-level specificity. This is what you'd implement in the next hour.>
```

### Design quality bar

- **Every type signature must compile.** Don't hand-wave — write real TypeScript.
- **Every module path must exist or be clearly marked as new.** Reference the module index from `symbols.txt`.
- **Every dependency must be justified.** If the design introduces a new external dependency, explain why existing tools can't do it.
- **The first commit must be < 200 lines.** If it's bigger, you haven't found the right decomposition.

---

## Phase 5: Execute or spec

Based on scope:

### If the first commit is implementable now (< 200 lines, no architectural risk):
1. Implement it directly
2. Run `bun typecheck` to verify
3. Run `bun test --recursive` if tests exist
4. Run `supergraph --no-anim` to verify the pipeline still works (use `bun src/index.ts --no-anim` if the binary is stale)
5. Present the diff and what it enables

### If the direction requires more than one session:
1. Write `.supergraph/strategic/frontier.md` with the full design document
2. Update `.supergraph/strategic/moves.md` with the new moves (append, don't replace)
3. Implement ONLY the first commit
4. Present what's done and what's next

Launch agents in parallel for independent work. Serialize work that touches the same files.

---

## Important principles

Everything from `/deep-strategic` applies, plus:

1. **Bold does not mean reckless.** Bold means "this changes what the tool can do." Reckless means "this might break everything." Bold ideas should have safe first steps.

2. **The best ideas feel slightly wrong at first.** If a direction makes you think "that's not what this tool is for" — examine that reaction. The tool's identity is not fixed. The best products evolve beyond their original conception.

3. **Compound capabilities beat isolated features.** A direction that combines the invariant system WITH the decision-table engine WITH the taint tracker is more valuable than one that extends any of them individually. Look for combinations that create emergent capabilities.

4. **The user's other projects are context.** If the user has other codebases (visible in the working directory structure or mentioned in conversation), consider how supergraph could serve those codebases better. The tool should grow toward its users' actual needs.

5. **Name the 10x version.** For each direction, briefly describe what the 10x version would look like — not to build it now, but to ensure the first step points in the right direction. A first step that leads to a dead end is worse than no step at all.

6. **Implementation is the test of ideas.** Don't just design — build. Even a 50-line proof of concept demonstrates more than a 5-page spec. When in doubt, write code.

7. **Self-analysis is a superpower.** Supergraph can analyze itself. Any new capability should be demonstrated on the supergraph codebase first. "Here's what this finds in YOUR code" is the most convincing demo possible.

8. **The output format IS the product.** Supergraph's value is in what it writes to disk. A brilliant analysis engine with a bad output format is useless. Every direction should consider: what does this look like in `supergraph.txt`?

9. **Think about the AI agent reading the output.** Supergraph's primary consumer is Claude Code (or similar AI agents) reading `supergraph.txt` and `symbols.txt` as context. Bold directions should make those files MORE useful to an AI agent — more actionable, more precise, more surprising.

10. **Leave breadcrumbs for the next `/deep-followup`.** Each session should plant seeds that the next session can pick up. Write your frontier.md as if future-you will read it cold. Name the ideas you considered but didn't pursue, and explain why — so the next session doesn't waste time rediscovering them.
