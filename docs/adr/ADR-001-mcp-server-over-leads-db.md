# ADR-001: Read-only stdio MCP server over leads.db

**Status:** Accepted 2026-07-07 · **Slice:** 1 · **Deciders:** Peter + Claude

## Context

Slice 1 exposes the growth pipeline (leads.db, SQLite) to MCP clients (Claude Code,
Claude Desktop) so the operator can query pipeline state conversationally. It is also
the first public MCP artifact for the portfolio.

## Decision

1. **Official TypeScript SDK (`@modelcontextprotocol/sdk`), stdio transport.**
   The server runs locally, spawned by the client; no port, no auth surface, no
   network exposure of prospect PII. HTTP transport is deferred to slice 5 when a
   hosted, tenant-scoped server is actually needed.
2. **Read-only tools.** `search_leads`, `get_lead`, `pipeline_stats`. No tool mutates
   the database.
3. **Curated tools, not raw SQL.** No `run_sql` tool: a malicious or confused prompt
   upstream could exfiltrate or mutate anything. Named tools with typed parameters keep
   the blast radius enumerable.

## Alternatives considered

- **Write tools (approve/reject drafts via MCP):** rejected for v1. Approval is the
  human gate the whole pipeline's safety story rests on; moving it into a surface where
  an LLM is in the loop weakens the "nothing sends without a human" guarantee. Revisit
  only with an explicit confirmation-prompt design.
- **`run_sql(query)` read-only tool:** more flexible, but SQLite has no true read-only
  statement guarantee worth trusting from generated SQL (ATTACH, pragmas), and schema
  knowledge would live in prompts instead of code. Rejected.
- **HTTP transport now:** premature; adds auth, hosting, and PII-in-transit concerns
  with zero current users. Deferred.

## Consequences

- Zero-config for the operator: one entry in `.mcp.json`, spawned on demand.
- Slice 5 (customer-facing, hosted, tenant-scoped) will be a separate server sharing
  the tool layer, not an evolution of this one's transport.
- Defensive JSON parsing required: `enrichment_json` / `drafts_json` are agent-written
  free-form fields (see data audit).
