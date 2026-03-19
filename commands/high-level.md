Read the supergraph architecture to get a high-level understanding of the entire codebase — modules, schemas, flows, and cross-package edges in one compressed view.

---

## Instructions

1. **If the supergraph MCP server is available**: Use the `supergraph_map` tool to get the compact architecture overview. This is the preferred method — it returns live, up-to-date data without needing static files on disk. After receiving the result, confirm: "Loaded architecture via supergraph MCP — [summary]." and nothing else unless the user asks a follow-up question.

2. **If MCP is not available** (tool not found or connection refused): Fall back to reading the static file. Find `.supergraph/supergraph-compact.txt` in the current project. If it doesn't exist, run `supergraph --no-anim` to generate it. Read the entire file — every line, no truncation, no skipping. Read it in chunks if needed until you have consumed all of it. After reading, confirm: "Read supergraph-compact.txt — [N] lines." and nothing else unless the user asks a follow-up question.

3. You now have the full architectural context. Answer any follow-up questions using this knowledge. **If MCP is available**, you can use additional tools for deeper exploration:
   - `supergraph_query` — find specific symbols by name or pattern
   - `supergraph_context` — get the full incoming/outgoing edge view of any symbol
   - `supergraph_impact` — assess the blast radius of any symbol
