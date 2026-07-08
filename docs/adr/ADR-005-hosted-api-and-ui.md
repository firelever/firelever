# ADR-005: Hosted API, tenant auth, and the customer web UI

**Status:** Accepted 2026-07-08 · **Slice:** 5a · **Deciders:** Peter + Claude

## Context

Slices 1-4 run on Peter's laptop behind CLIs. Design partners are ops managers, not
Claude Desktop users: they need a URL. Slice 5a turns the RAG + triage stack into a
tenant-authenticated HTTP service with a thin web interface (chat with citations,
document upload, triage review queue).

## Decisions

1. **One Hono service serves API + static UI.** Hono over Express: tiny, typed,
   web-standard Request/Response (portable to edge runtimes later), no middleware
   sprawl. The UI is a single self-contained HTML file with vanilla JS — no React, no
   build step. The product surface is three panels; a frontend framework would be
   scaffolding in search of a problem. Revisit when a partner asks for something a
   framework earns.
2. **Auth: per-tenant bearer keys, hashed at rest.** `flv_` + 32 hex chars, generated
   by a CLI, SHA-256 stored in a `tenants` table, constant-time compare. No OAuth/SSO
   in v1 (PRD "won't"); magic links deferred until there's a second user per tenant.
   Keys are shown once at creation, revocable by row deletion.
3. **Storage stays SQLite at deploy** (Fly.io volume, single machine). The Postgres
   migration triggers ADR-002 anticipated are unchanged: concurrent-writer pressure,
   multi-machine deploy, or a partner requiring managed backups. Until one fires,
   pgvector would be infra for its own sake.
4. **Write endpoints match the guardrails.** The API exposes ask/upload/list and
   triage review verdicts. Verdicts on drafts are the one write a customer performs;
   approval still only marks status — sending stays manual. No endpoint mutates the
   growth pipeline (leads.db is not exposed here at all; that stays the internal
   stdio MCP server's job).
5. **MCP-over-HTTP deferred to 5b.** The SDK's streamable HTTP transport can mount on
   this same service; the web UI is the higher-leverage surface for actual partners,
   so it ships first. The stdio MCP server remains the demo of that capability.
6. **UI design is deliberate, not default.** Warm paper background, graphite ink,
   ember accent (FireLever), serif display over system sans, citation chips that
   expand to the source passage. Explicitly avoiding the generic-AI look (default
   framework fonts, purple gradients) — the interface is part of the pitch.

## Consequences

- Uploads run ingestion in-request; fine at partner volumes, queue it if a partner
  uploads hundreds of files at once.
- Single SQLite writer means one Fly machine, no horizontal scaling — acceptable
  until it isn't, and the trigger is documented above.
- The security bar rises: bearer keys over TLS, tenant checks on every query
  (partition keys + WHERE clauses), and the phase 6 adversarial pass must run against
  this surface before partner #1 uploads anything sensitive.
