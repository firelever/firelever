# FireLever Growth Engine

Lead-gen agent pipeline for [firelever.com](https://firelever.com). Four agents — Prospector, Enricher, Scorer, Drafter — feed a human review queue. **Nothing is ever sent automatically**; approved emails are sent manually from Gmail (free-tier phase).

See [PLAN.md](PLAN.md) for the full growth strategy. The pipeline is growing into
**FireLever Copilot** (RAG + MCP + fine-tuned model for ops-heavy SMBs) — see
[docs/PROCESS.md](docs/PROCESS.md) for the delivery process and
[docs/01-BRD.md](docs/01-BRD.md) / [docs/02-PRD.md](docs/02-PRD.md) for requirements.

## Setup

```sh
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or `ant auth login`
```

## Daily loop

```sh
npm run pipeline   # prospect, enrich, score, draft (~10 new leads/run; needs API credits)
npm run review     # approve / reject each draft interactively
npm run set-email  # attach a manually sourced recipient email to a lead
npm run send       # send due emails + follow-ups, stop sequences on reply (Gmail)
npm run dashboard  # regenerate dashboard.html from leads.db
npm run digest     # pipeline status snapshot in the terminal
```

## RAG: ingestion, retrieval, evals

The copilot's retrieval layer (slice 2) lives in [src/rag/](src/rag/): per-tenant
document ingestion into SQLite (sqlite-vec for vectors, FTS5 for keywords) with local
on-device embeddings (bge-small, no API key) and hybrid search fused via tuned RRF.
See [ADR-002](docs/adr/ADR-002-rag-storage-and-embeddings.md).

```sh
npm run ingest -- --tenant firelever PLAN.md README.md docs   # extract → chunk → embed → store
npm run search -- --tenant firelever "how many emails per day" # poke retrieval manually
npm run eval                                                   # golden-set evals + regression gate
```

Retrieval quality is measured, not vibed: [evals/retrieval.jsonl](evals/retrieval.jsonl)
holds golden queries; `npm run eval` reports recall@5 and MRR for keyword-only,
vector-only, and hybrid, records history, and fails on regression. Current: hybrid
86.4% recall@5 / 0.714 MRR vs the keyword baseline.

Grounded Q&A (slice 3) sits on top: `npm run ask -- --tenant firelever "question"`
answers with a citation after every claim and refuses when the corpus lacks the answer
([ADR-003](docs/adr/ADR-003-grounded-answering.md)). `npm run eval:qa` grades a
24-question golden set (16 answerable, 8 unanswerable) with an LLM judge plus
programmatic citation checks. Current (2026-07-08): refusal 100%, faithfulness 100%,
citation accuracy 100%, correctness 93.3%; 1 of 16 wrongly refused, traced to a known
retrieval miss on the PRD latency table, not an answering bug.

## Copilot server + web UI

Slice 5a ([ADR-005](docs/adr/ADR-005-hosted-api-and-ui.md)): a tenant-authenticated
HTTP API (Hono) over the RAG and triage stack, plus a customer-facing web interface —
grounded Q&A with expandable citations, document upload, and the triage review queue —
styled to the firelever.com brand.

```sh
npm run tenant -- create acme "Acme Freight"   # mints a flv_ API key (shown once)
npm run serve                                  # http://localhost:8787
```

Auth: per-tenant bearer keys, SHA-256 at rest, constant-time compare. Every route is
tenant-scoped; the growth pipeline (leads.db) is not exposed. Nothing sends email —
approving a triage draft only marks it approved.

## Email triage

Slice 4 ([ADR-004](docs/adr/ADR-004-email-triage.md)): inbound email is classified
(new business / support / vendor / recruiting / spam / other) and anything needing a
response gets a reply drafted from the knowledge base — grounded in retrieved sources,
with a low-confidence flag when the corpus lacks an answer. Nothing sends
automatically; approved drafts are copy-pasted into Gmail.

```sh
npm run triage -- --demo        # synthetic emails, no credentials needed
npm run triage -- --imap        # unseen Gmail messages (GMAIL_* in .env)
npm run triage:review           # approve / reject / ignore each draft
npm run eval:triage             # classification accuracy vs keyword baseline
```

Current eval (synthetic 24-email golden set, to be replaced with real labeled
traffic): 100% classification accuracy vs 83.3% keyword baseline, including a
prompt-injection email correctly filed as spam.

## MCP server

`npm run mcp` starts a read-only [MCP](https://modelcontextprotocol.io) server over
`leads.db` (tools: `search_leads`, `get_lead`, `pipeline_stats`). [.mcp.json](.mcp.json)
registers it for Claude Code automatically — open this repo and ask things like
"which approved leads scored above 80?". All writes (approve/reject/send) stay in the
human review CLI by design; see
[ADR-001](docs/adr/ADR-001-mcp-server-over-leads-db.md).

## Sending (Gmail free tier)

`npm run send` delivers approved sequences and manages day 0/3/7 follow-ups. Before a reply
check and every follow-up it searches the Gmail inbox via IMAP; a reply stops the sequence
and flags the lead. Setup:

1. Google Account &gt; Security &gt; 2-Step Verification &gt; App passwords: create one.
2. Add to `.env`: `GMAIL_USER=you@gmail.com` and `GMAIL_APP_PASSWORD=...`
3. Put your business mailing address in `EMAIL_FOOTER` (src/config.ts). The sender refuses
   to run until it's set (CAN-SPAM).
4. Optional daily automation: `cp scripts/com.firelever.sender.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.firelever.sender.plist`

## Dashboard

`npm run dashboard` writes `dashboard.html` (a self-contained snapshot of the pipeline),
which is published as a shareable web page for the team after each batch.

Leads live in `leads.db` (SQLite). Statuses: `new → enriched → scored → drafted → approved/rejected`, with `parked` for leads scoring below the threshold in [src/config.ts](src/config.ts).

## Guardrails

- Human approves every outbound message; approved emails are sent manually.
- All personalization must come from Enricher research — agents are instructed never to invent facts.
- ICP and scoring threshold are configured in [src/config.ts](src/config.ts).
