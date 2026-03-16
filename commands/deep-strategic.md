Strategic codebase review using supergraph audit artifacts. Identifies feature gaps, architectural opportunities, implementation quality signals, high-leverage improvements, and frontier possibilities. Loads the full codebase into context before an interactive interview, then presents calibrated findings.

**Argument**: `$ARGUMENTS` — optional. Path to one or more package `src/` directories (e.g. `packages/orchestrator/src`). If none specified, review all packages.

---

## Model requirements

This command is designed for **Claude Opus with the 1M token context window**. The entire strategy depends on loading the full codebase — every symbol, every function body, every audit artifact — into context BEFORE asking the user any questions. With less context, the questions become generic. With full context, the questions become surgical — informed by actual code patterns, architectural tensions, and implementation choices the model has already seen.

If running on a smaller context model, skip Phase 1c (symbols-full.txt) and Phase 1d (source files). The review will still work but will be less precise.

---

## Communication style

**Conversational, direct, honest.** This is a strategic dialogue, not a report dump.

- Phase 0 (artifact generation): silent.
- Phase 1 (context load): **silent**. This is the longest phase. Load everything without output.
- Phase 2 (interview): ask questions — informed by what you've already read. **WAIT for answers.**
- Phase 3 (analysis): silent.
- Phase 4 (presentation): present findings in a structured, opinionated format.
- Never pad with filler. Say what you mean. If something is genius, say so. If something is pointless, say so.
- Never narrate what you're about to do. Just do it.

---

## Output directory

All written output goes under `audit/strategic/`. For multi-package reviews, one unified brief.

```
audit/strategic/
  brief.md              # Full strategic brief (human-readable)
  moves.md              # Top moves with implementation details
```

---

## Phase 0: Generate artifacts (if needed)

Check if `audit/supergraph.txt` exists. If not:

```bash
supergraph --no-anim
```

If `supergraph` is not installed: `brew install bravenewxyz/supergraph/supergraph`.

---

## Phase 1: Full context load

**This is the core advantage of Opus + 1M context.** Load the entire codebase representation into context before doing anything else. No skimming, no summarizing, no shortcuts. Read every line.

The order matters — start with the architectural overview, then drill into structural data, then load the actual source code. Each layer adds depth to your understanding.

### 1a. Architecture layer (read first)

Read these files in their entirety:

1. `audit/supergraph-compact.txt` — the 30,000-foot view: domains, module counts, import ranks
2. `audit/supergraph.txt` — unified map: all domains, all modules, all cross-package edges
3. Every package's `deps.txt` — full dependency graphs
4. Every package's `imports.txt` — modules ranked by how many others depend on them

After this layer you understand the skeleton: what talks to what, what's central, what's peripheral.

### 1b. Analysis layer (read second)

For each package, read in full:

1. `map.txt` — every module with its symbols, functions, types, comments
2. `complexity.txt` — complexity hotspots, nesting depth, type-safety escape hatches, structural impedance
3. `dead.txt` — orphan modules, unused exports
4. `logic-audit.txt` — decision tables, guard consistency, exhaustiveness gaps, status functions
5. `trace-boundaries.txt` — serialization boundaries, error handlers, JSON roundtrips (read first 300 lines if file exceeds 25K tokens; the most important boundaries are listed first)
6. `invariants/discovery.txt` — function signatures, repeated patterns, hub functions, signature inconsistencies, cross-boundary type drift
7. `findings.md` — if `/deep-audit` was run previously, read its findings

After this layer you understand the health: where the code is strong, where it's fragile, where it's dead.

### 1c. Source layer (read third — this is what 1M context enables)

Read `audit/symbols-full.txt` in its entirety. This file contains **every function body in the codebase** — the actual source code, not just signatures. Read it in chunks using offset/limit if needed, but read ALL of it.

This is the layer that transforms the review from "structural observations" to "I've read your code." Without it, you're guessing at intent from signatures. With it, you can see:
- Whether a complex function is doing something clever or just poorly structured
- Whether dead exports are abandoned features or intentional public API
- Whether repeated patterns are copy-paste debt or intentional specialization
- What the code actually does vs what the architecture suggests it should do

If `symbols-full.txt` doesn't exist or is empty, fall back to `audit/symbols.txt` (which has tiered detail: full bodies for important functions, signatures for the rest).

### 1d. Project context (read fourth)

1. Root `package.json` — name, description, scripts, dependencies
2. Root `README.md` or `CLAUDE.md` if they exist
3. Per-package `package.json` files
4. Any `CLAUDE.md` files in packages

### 1e. Verify completeness

Before proceeding, you should have:
- The full module graph in your head
- Every function's complexity score and nesting depth
- Every dead export and orphan module
- Every logic audit warning
- The actual source code of every function
- The project's stated purpose and dependencies

If any critical file is missing, note it in one line and continue with what you have.

---

## Phase 2: Strategic interview

**You've now read the entire codebase.** Your questions should reflect this.

Do NOT ask generic questions. Ask questions that are **informed by what you've already seen in the code**. Reference specific patterns, modules, or architectural decisions when relevant.

Output this to the user, then **STOP and WAIT** for their response. Adapt the questions based on what you observed in Phase 1 — add specificity, drop questions that the code already answers, add questions about tensions or surprises you noticed:

```
I've loaded the full codebase — <N> modules, <M> functions, <L> lines across <P> packages.

Before I synthesize, I need to understand your intent.
Answer what resonates, skip what doesn't:

1. **What is this?** Elevator pitch — who uses it and why?

2. **Where are you taking it?** What does the next major milestone look like?
   (shipping to users / internal tool / open source / research prototype / selling it)

3. **What keeps you up at night?** What feels fragile, slow, or wrong?
   What would you fix if you had infinite time?

4. **What are you proud of?** What's the part you'd show another engineer?

5. **What's the constraint?** Solo dev? Team? Time-boxed? Funding?
   This changes what "good advice" looks like dramatically.

6. **What would mass adoption require?** If 1000 people tried to use this
   tomorrow, what would break first?
```

**Critical: augment the generic questions with specific observations.** For example:

- If you noticed a module with 75 submodules: "I see `core/` has 75 modules — is this the heart of the system or has it become a dumping ground?"
- If you noticed a cluster of dead exports: "There are 43 unused exports in `invariant/` — abandoned experiment or planned public API?"
- If you noticed an impressive implementation: "The symbolic executor uses Z3 for formal verification — is this a differentiator you're investing in or a research spike?"
- If you noticed architectural tension: "The `operations/` layer has a full CRDT-style merge engine but no persistence layer beyond NDJSON — is distributed operation a goal?"

Add 1-3 of these specific observations as additional questions numbered 7+.

### Follow-up rounds (as many as needed)

After each user response, assess your **confidence level** across these dimensions:

| Dimension | What you need to know |
|---|---|
| **Intent** | What they're building, for whom, and why |
| **Direction** | Where it's going next — what "done" looks like |
| **Priorities** | What matters most vs what's negotiable |
| **Constraints** | What limits the solution space (time, team, money, tech) |
| **Blind spots** | What they don't realize about their own codebase |

**Keep asking follow-up questions until you are genuinely confident you can produce a strategic review that the user would find non-obvious and actionable.** There is no limit on rounds. Two rounds is typical. Five is fine if the project is complex or the user's answers reveal deeper tensions worth exploring.

Guidelines for follow-ups:

- **If an answer is vague**, ask for specifics. "You said it feels fragile — which part? The federation layer? The agent lifecycle? The schema extraction?"
- **If an answer surprises you** given what you've read in the code, say so and ask why. "You say federation is the priority, but the federation module has the fewest tests of any domain — is that intentional or a gap you're aware of?"
- **If an answer conflicts with another answer**, probe the tension. "You want mass adoption but you're a solo dev — which would you sacrifice: scope or polish?"
- **If the user reveals something that changes your analysis**, acknowledge it. "That changes things — if this is internal-only, half my concerns about error messages disappear."
- **If the user skips questions**, respect that — it tells you something. Don't re-ask. But you can ask *different* questions that approach the same information from another angle.
- **If you're confident**, say so and proceed. Don't ask questions for the sake of asking. "I have what I need — proceeding to analysis."

**The quality of the strategic review is directly proportional to the quality of this conversation.** Rushing to Phase 3 with shallow understanding produces generic advice. Taking the time to truly understand produces advice the user couldn't have reached alone.

---

## Phase 3: Deep strategic analysis

Work silently. Using the full codebase context AND the user's answers, analyze across these dimensions.

### 3a. Architecture-intent alignment

Does the code structure match what the user says they're building?

- **Over-built areas**: sophisticated abstractions serving simple use cases. Cross-reference `complexity.txt` hotspots with `imports.txt` — high complexity + low import count = possible over-engineering. But now you can verify by reading the actual function bodies from Phase 1c.
- **Under-built areas**: critical paths with minimal structure. Cross-reference user's stated priorities with module sizes and test coverage.
- **Phantom features**: code that implies features the user didn't mention. You've read the source — you can see functions that are implemented but never called, APIs that are built but never exposed.
- **Missing foundations**: features the user wants that have no architectural support. You know every module and every type — you can see exactly what's missing.

### 3b. Leverage analysis

Identify highest-leverage changes — small modifications with outsized impact:

- **Hub functions** (from `discovery.txt`) — functions called by 10+ others. You've read their bodies — are they well-written? A bug here affects everything.
- **Near-complete features** — dead exports that suggest 80%-done work. You've seen the implementations — how close are they really?
- **Abstraction opportunities** — repeated patterns from `discovery.txt`. You've read the actual function bodies — are these truly duplicative or intentionally specialized?
- **Dependency bottlenecks** — modules with extreme fan-in. You've seen their implementations — are they robust enough for their importance?
- **Trivial wins** — things that take <1hr and make a visible difference. You've seen the code — you know exactly what to suggest.

### 3c. Quality gradient

Map which parts are production-grade vs prototype-grade. Unlike a structural-only review, you've read the source:

- Complexity hotspots → you can distinguish inherent complexity (the problem is hard) from accidental complexity (the code is tangled)
- Type-safety escape hatches → you can see whether each `as` cast is hiding a real bug or working around a library limitation
- Error handling → you've read the catch blocks. Are they logging, swallowing, or propagating?
- Test coverage → you've seen which modules have test files and which don't

### 3d. Frontier opportunities

Think beyond incremental improvement. You have the complete source — use it:

- What would a **10x version** of this look like?
- Are there **emerging patterns** (in the broader ecosystem) this codebase is positioned to adopt?
- Is there **latent capability** — things the architecture could do that nobody's asked it to? You've read every function — you can see capabilities that aren't exposed.
- Would **removing** something create more value than adding something?
- Are there **genius implementations** hiding in plain sight — code that solves a hard problem elegantly? Call these out specifically with file:line references. They're the foundation to build on.

### 3e. Honest maturity assessment

Rate each package:
- **Maturity**: prototype → functional → production → polished
- **Coherence**: scattered → organized → focused → elegant
- **Momentum**: stalled → maintaining → growing → accelerating

### 3f. Best-practice deviations (calibrated)

Only flag deviations that **actually matter** given the user's stated context. A solo dev building a prototype doesn't need enterprise error handling. A team shipping to production does. Filter ruthlessly based on Phase 2 answers.

### 3g. Correlation insights

Cross-cut the data for non-obvious connections:
- Modules with high complexity AND high import count = fragile load-bearing code
- Modules with many dead exports AND recent activity = active churn in wrong direction
- Hub functions with no test coverage = highest-risk code in the codebase
- Cross-package edges that pass through serialization boundaries = data integrity risk
- Functions where `discovery.txt` reports signature inconsistencies = API drift between layers

---

## Phase 4: Write strategic brief

Write `audit/strategic/brief.md`:

```markdown
# Strategic Brief: <project-name>

<N> packages · <files> files · <lines> lines · <date>

## Verdict
<2-3 sentences. The honest take — where this project is and where it could go.>

## Top Moves
Ranked by leverage (impact / effort). Each with:
1. **Title** — what to do
2. **Why** — why it matters given stated intent
3. **How** — concrete first step (not vague — cite exact files, functions, line ranges)
4. **Effort** — S (<1hr) / M (1-4hr) / L (4hr+)
5. **Package(s)** affected

## Strengths Worth Protecting
What's working well. Specific — cite modules, patterns, design choices, exact functions.

## Concerns Worth Addressing
Things that will bite if not addressed. Ranked by urgency. Cite specific code.

## Wild Cards
Non-obvious possibilities. Things the architecture enables that nobody asked for.
Genius implementations worth extending. Unexpected opportunities.

## Package Maturity
Per-package assessment with key insight.

## Detailed Findings
Full findings organized by dimension (architecture alignment, leverage,
quality gradient, frontier opportunities, correlations).
```

Write `audit/strategic/moves.md`:

```markdown
# Top Moves — Implementation Guide

For each move from the brief, provide:
- Exact files to modify (with line ranges from symbols-full.txt)
- Code-level description of changes
- Dependencies between moves
- What to test after
```

---

## Phase 5: Present to user

Output the findings directly in chat using this format:

```
# <project-name>: Strategic Review

<N> packages · <files> files · <lines> lines

## Verdict
<2-3 sentences>

## Top moves (ranked by leverage)

 #  | move                        | effort  | pkg        | why
----|-----------------------------| --------|------------|----------------------------------
 1  | <title>                     | <S/M/L> | <pkg>      | <one-line rationale>
 ...

## Strengths
- <bullet points — specific, cite code>

## Concerns
- <bullet points — ranked by urgency>

## Wild cards
- <bullet points — the interesting stuff>

## Package maturity

 pkg       | maturity     | coherence    | momentum     | key insight
-----------|--------------|--------------|--------------|---------------------------
 <name>    | <rating>     | <rating>     | <rating>     | <one-line>

---

Full brief: audit/strategic/brief.md
Implementation guide: audit/strategic/moves.md

Want me to implement any of the top moves?
```

---

## Phase 6: Execute (on user request)

The user picks moves by number. For each:

1. Read the implementation details from `moves.md`
2. You already have the source in context from Phase 1c — reference it directly
3. Implement the change
4. Run tests
5. Report what changed

Launch agents in parallel for independent moves. Serialize moves that touch the same files.

---

## Important principles

1. **Honesty over diplomacy.** If something is over-engineered, say so. If something is brilliant, say so. Don't hedge with "could potentially maybe consider."

2. **Context is everything.** A prototype doesn't need production patterns. A production system doesn't need research flexibility. Let Phase 2 answers calibrate everything.

3. **Leverage over completeness.** Don't list 50 improvements. Find the 5 that matter most.

4. **Concrete over abstract.** "Refactor the pipeline" is useless. "Split `evalExpr` (complexity 88, symbolic-executor.ts:361) into `evalBinaryExpr`, `evalCallExpr`, `evalMemberExpr` — unlocks individual testing" is useful. You have the source — cite it.

5. **Show your reasoning.** "This is over-engineered" is opinion. "6 abstraction layers for a feature used in 2 places" is evidence. You've read the code — prove your claims.

6. **Respect what's there.** Code that exists and works has value. Don't recommend rewrites when targeted improvements would do.

7. **Think in systems, not files.** Interesting insights come from cross-cutting analysis — how modules interact, where data flows break down, where abstractions leak. You have the full graph AND the full source — use both.

8. **Surface genius.** Most code reviews only find problems. Actively look for clever solutions, elegant abstractions, and smart design choices. Call them out with exact file:line references. They're the foundation to build on.

9. **Be specific about "what would break."** When identifying concerns, say exactly what would fail and under what conditions. You've read the implementation — you can be precise.

10. **Your questions reveal your understanding.** The Phase 2 interview is your chance to show the user you've actually read their code. Generic questions waste the 1M context advantage. Specific questions — referencing real modules, real patterns, real tensions — build trust and surface the information you actually need.
