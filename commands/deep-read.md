Read the symbols-full.txt file to get a comprehensive, source-level understanding of every module, function, type, and class in the codebase — including full function bodies, signatures, and cross-package edges.

**Argument**: `$ARGUMENTS` — optional. A module path, function name, or keyword to focus on (e.g. `auth`, `parser/incremental`, `rollback`). If provided, read the full file but prioritize answering about the specified topic. If omitted, read everything and await questions.

---

## Instructions

1. Find `.supergraph/context/symbols-source.txt` in the current project. If that file does not exist, use the legacy compatibility output `.supergraph/symbols-full.txt`. If neither exists, run `supergraph --no-anim` to generate it.
2. Read the entire file — every line, no truncation, no skipping. It can be large (5-15MB). Read it in chunks using offset/limit parameters until you have consumed all of it.
3. After reading, confirm: "Read symbols-source.txt — [N] lines, [M] modules." and nothing else unless the user asks a follow-up question or provided an argument.
4. If the user provided an argument, immediately answer about that topic using the full context you just loaded.
5. You now have complete source-level context for the entire codebase. Use it to answer implementation questions, trace call chains, explain algorithms, find bugs, or suggest refactors with high precision.

## When to use this vs /high-level

- `/high-level` loads `context/architecture-compact.txt` (~8KB) — architecture overview, module names, import counts. Fast. Good for "how is this organized?" questions.
- `/deep-read` loads `context/symbols-source.txt` (~10MB) — every function body, every type definition, every signature. Slower but complete. Good for "how does X work?", "what calls Y?", "is there a bug in Z?" questions.
