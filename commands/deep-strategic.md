Strategic codebase review using supergraph audit artifacts. Identifies feature gaps, architectural opportunities, implementation quality signals, high-leverage improvements, and frontier possibilities. Loads the full codebase into context before an interactive interview, then presents calibrated findings.

**Argument**: `$ARGUMENTS` — optional. Path to one or more package `src/` directories (e.g. `packages/orchestrator/src`). If none specified, review all packages.

---

## Model requirements

This command is designed for **Claude Opus with the 1M token context window**. The entire strategy depends on loading the full codebase — `symbols.txt` contains every symbol with tiered detail, `supergraph.txt` maps every module and cross-package edge — into context BEFORE asking the user any questions. With less context, the questions become generic. With full context, the questions become surgical — informed by actual code patterns, architectural tensions, and implementation choices the model has already seen.

If running on a smaller context model, read only `supergraph-compact.txt` and `supergraph.txt` (skip `symbols.txt`). The review will still work but will be less precise.

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

All written output goes under `.supergraph/strategic/`. For multi-package reviews, one unified brief.

```
.supergraph/strategic/
  brief.md              # Full strategic brief (human-readable)
  moves.md              # Top moves with implementation details
```

---

## Phase 0: Generate artifacts (if needed)

Check if `.supergraph/supergraph.txt` exists. If not:

```bash
supergraph --no-anim
```

If `supergraph` is not installed: `brew install bravenewxyz/supergraph/supergraph`.

---

## Phase 1: Full context load

**This is the core advantage of Opus + 1M context.** Load the entire codebase representation into context before doing anything else. No skimming, no summarizing, no shortcuts. Read every line.

The order matters — start with the architectural overview, then drill into structural data, then load the actual source code. Each layer adds depth to your understanding.

### Reading large files efficiently

The Read tool has a **25,000 token limit per call**. For large files like `symbols.txt` (often 30K-55K+ lines), you MUST use a chunked reading strategy. Here's how to do it fast:

1. **First, check the file size** — run `wc -l .supergraph/symbols.txt` via Bash to know how many lines you're dealing with.
2. **Read in large parallel batches** — use multiple Read calls in a SINGLE message, each with `offset` and `limit` parameters. This is critical for speed: 6 parallel reads complete in the same wall-clock time as 1 read.
3. **Use Bash `cat` as a fallback for very large files** — when a file exceeds Read tool limits even with chunking, use `cat -n <file> | head -n X | tail -n Y` via the Bash tool. The Bash tool has higher output limits than Read.

**Concrete strategy for `symbols.txt`:**
```
# Step 1: Get line count
Bash: wc -l .supergraph/symbols.txt

# Step 2: Read in parallel chunks of ~500 lines each (6 at a time)
# In a SINGLE message, issue all Read calls simultaneously:
Read: offset=1    limit=500
Read: offset=501  limit=500
Read: offset=1001 limit=500
Read: offset=1501 limit=500
Read: offset=2001 limit=500
Read: offset=2501 limit=500

# Step 3: Continue with next batch of 6 until done
# For a 10K line file, this takes 4 messages. For 50K lines, ~17 messages.
```

**Key rules:**
- ALWAYS issue multiple Read calls in the SAME message for parallel execution
- Use 500-line chunks — this stays safely under the 25K token limit for most code
- If a chunk hits the token limit, reduce chunk size to 300 lines
- For the module index section at the top of `symbols.txt`, use larger chunks (it's denser but lower tokens-per-line)
- Do NOT narrate each read. Read silently, then proceed.

### 1a. Architecture layer (read first)

Read `.supergraph/supergraph.txt` in its entirety — the unified map of all domains, all modules, all cross-package edges, import counts, and external dependencies. This file is usually small enough for a single Read call.

After this layer you understand the skeleton: what talks to what, what's central, what's peripheral.

### 1b. Source layer (read second — this is what 1M context enables)

Read `.supergraph/symbols.txt` in its entirety using the chunked parallel strategy above. This is the single most important file. It contains **every symbol in the codebase** with tiered detail: full function bodies for high-importance functions, signatures and types for everything else, cross-package edges, and import/export relationships.

This is the layer that transforms the review from "structural observations" to "I've read your code." Without it, you're guessing at intent from module names. With it, you can see:
- What every function actually does — signatures, bodies, return types
- How modules relate — import counts, dependency edges, cross-package connections
- Whether dead exports are abandoned features or intentional public API
- Whether repeated patterns are copy-paste debt or intentional specialization
- The actual type shapes and data structures flowing through the system

If `symbols.txt` doesn't exist, fall back to reading per-package `map.txt` files instead.

### 1c. Project context (read third)

1. Root `package.json` — name, description, scripts, dependencies
2. Root `README.md` or `CLAUDE.md` if they exist
3. Per-package `package.json` files
4. Any `CLAUDE.md` files in packages
5. If `/deep-audit` was run previously, read each package's `findings.md`

### 1d. Verify completeness

Before proceeding, you should have:
- The full module graph in your head
- Every function's signature and the bodies of high-importance functions
- Cross-package edges and dependency relationships
- The project's stated purpose and dependencies

Do NOT read per-package debug/analysis files (`complexity.txt`, `dead.txt`, `logic-audit.txt`, `trace-boundaries.txt`, `discovery.txt`) during this phase. Those are for `/deep-audit`. The strategic review works from `symbols.txt` and `supergraph.txt` — the unified views that capture everything worth knowing in a format designed for exactly this kind of holistic analysis.

If any critical file is missing, note it in one line and continue with what you have.

---

## Phase 2: Synthesize and present opportunities

**You've now read the entire codebase.** This phase is NOT a generic interview. You already know what the code does, how it's structured, and where the tensions are. Your job is to synthesize that understanding into concrete observations and opportunities, then check alignment with the user.

### 2a. Synthesis (silent)

Before saying anything, form your own answers to these questions from the code alone:
- What is this project trying to be? (The code tells you — module names, type shapes, API surface, README)
- What's the strongest part? (Hub modules with clean abstractions, elegant algorithms, well-tested code)
- What's the weakest part? (High complexity, dead exports, missing tests, orphaned abstractions)
- What are the 3-5 highest-leverage moves? (Things that would have outsized impact for the effort)
- What surprised you? (Unexpected sophistication, unexpected gaps, architectural tensions)

### 2b. Present your read (output to user)

Output a brief synthesis of what you've seen as a text message. This shows you've done the work and frames the questions that follow.

The format should be:

```
I've loaded the full codebase — <N> modules, <M> functions across <P> packages.

**Here's what I see:**

<2-4 sentences describing what this project IS based on the code. Not the README —
what the code actually does. Name specific modules, patterns, and capabilities.>

**What stands out:**

- <Specific strength — cite module/pattern>
- <Specific tension or gap — cite evidence>
- <Specific opportunity — concrete, not vague>
```

### 2c. Ask targeted questions via AskUserQuestion

Immediately after the synthesis text, use the **AskUserQuestion tool** to ask 2-4 targeted questions. This is critical — it uses the IDE's built-in question UI where the user can select from options you suggest. You're not asking open-ended questions; you're proposing what you already think and letting the user curate.

**Each question MUST:**
- Reference something specific you observed in the code
- Provide 2-4 concrete options that reflect your best guesses
- Put your recommended option first with "(Recommended)" suffix
- The user can always select "Other" to provide custom input

**Example AskUserQuestion call:**

```json
{
  "questions": [
    {
      "question": "The invariant module has Z3 symbolic execution and property-based test generation but nothing imports it yet. What's the intent?",
      "header": "Invariant",
      "options": [
        { "label": "Next frontier (Recommended)", "description": "This is where I'm heading — wire it into CI and make it a differentiator" },
        { "label": "Completed experiment", "description": "It proved the concept, but I'm not investing more here" },
        { "label": "On hold", "description": "Valuable but not a priority right now" }
      ],
      "multiSelect": false
    },
    {
      "question": "I see 3 areas that could use investment. Which matters most right now?",
      "header": "Priority",
      "options": [
        { "label": "Test coverage", "description": "Thorough in schema/ but absent in operations/ and coordination/" },
        { "label": "API surface cleanup", "description": "42 routes, some with overlapping concerns — tighten before more users" },
        { "label": "Performance", "description": "Several O(n²) patterns in the graph traversal code" }
      ],
      "multiSelect": true
    },
    {
      "question": "What's the deployment context?",
      "header": "Context",
      "options": [
        { "label": "Solo dev, shipping (Recommended)", "description": "Move fast, pragmatic advice, skip enterprise patterns" },
        { "label": "Small team", "description": "Need conventions and guardrails for collaboration" },
        { "label": "Open source library", "description": "Public API stability and docs matter" },
        { "label": "Internal tool", "description": "Works-for-us is good enough" }
      ],
      "multiSelect": false
    }
  ]
}
```

**Key principles:**
- **Lead with YOUR synthesis as text**, then ask questions via AskUserQuestion. The user hired you to think, not to ask what they think.
- **Every question must reference something specific from the code.** No "what keeps you up at night?" — instead, "The merger does git push in a catch-free block (actuator/merger:L796) — does this ever fail in practice?"
- **Propose answers in the options.** The options ARE your analysis. The user is curating your thinking, not doing your thinking for you. If you noticed dead exports, don't ask "are there dead exports?" — propose "These 43 dead exports are: (a) abandoned experiment, (b) planned public API, (c) cleanup debt."
- **2-4 questions max.** You already know 90% of what you need from the code. The questions fill the remaining 10%.
- **Do NOT ask what the project is.** You just read it. If you can't tell what it is from the code, that itself is a finding worth reporting.

### 2d. Follow-up (one round max)

After the user responds:

- If their answers change your analysis, adjust silently and proceed.
- If they selected "Other" with custom text, incorporate that signal.
- If something contradicts what you see in the code, you may ask ONE more AskUserQuestion with 1-2 clarifying questions. Then proceed regardless.
- **Proceed to Phase 3 immediately.** Don't ask questions for the sake of asking.

---

## Phase 3: Deep strategic analysis

Work silently. Using the full codebase context AND the user's answers, analyze across these dimensions.

### 3a. Architecture-intent alignment

Does the code structure match what the user says they're building?

- **Over-built areas**: sophisticated abstractions serving simple use cases. In `symbols.txt`, look for modules with high symbol counts but low import counts (←N) — lots of code that nothing uses.
- **Under-built areas**: critical paths with minimal structure. Cross-reference user's stated priorities with what you see in the module index.
- **Phantom features**: code that implies features the user didn't mention. You've read the symbols — you can see functions that are exported but never imported, APIs that are built but never exposed.
- **Missing foundations**: features the user wants that have no architectural support. You know every module and every type — you can see exactly what's missing.

### 3b. Leverage analysis

Identify highest-leverage changes — small modifications with outsized impact:

- **Hub modules** — modules with high ←N importer counts in `symbols.txt`. These are load-bearing walls. Improving them has blast radius.
- **Near-complete features** — exported functions with real implementations that nothing imports yet. You've seen the bodies — how close are they to being useful?
- **Abstraction opportunities** — similar function signatures across modules visible in `symbols.txt`. Are these truly duplicative or intentionally specialized?
- **Dependency bottlenecks** — modules imported by many others. Are they robust enough for their importance?
- **Trivial wins** — things that take <1hr and make a visible difference. You've seen the code — you know exactly what to suggest.

### 3c. Quality gradient

Map which parts are production-grade vs prototype-grade. You've read the symbols — use what you know:

- Large function bodies in `symbols.txt` → you can distinguish inherent complexity (the problem is hard) from accidental complexity (the code is tangled)
- `as` casts visible in function bodies → are they hiding real bugs or working around library limitations?
- Error handling visible in function bodies → are catch blocks logging, swallowing, or propagating?
- Test modules visible in the module index → which domains have test coverage and which don't?

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

Cross-cut what you've read for non-obvious connections:
- Modules with large symbol counts AND high import counts = fragile load-bearing code
- Modules with many exports but few importers = potential over-engineering or abandoned work
- High-fan-in modules with no test modules nearby = highest-risk code in the codebase
- Cross-package edges visible in `supergraph.txt` = integration points worth scrutinizing
- Similar function names across packages with different signatures = API drift between layers

---

## Phase 4: Write strategic brief

Write `.supergraph/strategic/brief.md`:

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

Write `.supergraph/strategic/moves.md`:

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

Full brief: .supergraph/strategic/brief.md
Implementation guide: .supergraph/strategic/moves.md

Want me to implement any of the top moves?
```

---

## Phase 6: Execute (on user request)

The user picks moves by number. For each:

1. Read the implementation details from `moves.md`
2. You already have the source in context from Phase 1b — reference it directly
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

10. **Lead with synthesis, not questions.** Phase 2 is your chance to show the user you've actually read their code. Don't ask "what is this?" — tell them what you see, then ask the 3-5 things the code can't tell you. Generic questions waste the 1M context advantage and the user's time. Every question must reference a specific module, pattern, or tension you observed.
