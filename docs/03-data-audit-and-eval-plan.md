# Phase 2: Data Audit and Eval Plan

| | |
|---|---|
| Status | **Approved for slices 1-3, 2026-07-07** — per-partner audits added at onboarding |
| Upstream | [02-PRD.md](02-PRD.md) |

## Data audit

| Source | Owner | Location | PII | Rights / notes |
|---|---|---|---|---|
| leads.db (pipeline data) | FireLever | repo root, SQLite | Contact names/emails of prospects | Ours; already governed by pipeline guardrails. MCP server exposes it read-only, local-only (stdio, no network listener). |
| FireLever internal docs (PLAN, case-study drafts) | FireLever | repo + Drive | None | Ours; first RAG corpus for slice 2/3 development. |
| Design-partner documents | Each partner | Uploaded at onboarding | Likely (staff, customers) | **Per-partner mini-audit at onboarding:** inventory, PII classification, NDA/DPA signed, deletion path verified before ingestion. No training on partner data without written consent. |
| Inbound email (triage) | Partner | Gmail/IMAP | Yes (senders) | Slice 4; processed transiently, drafts stored per-tenant. |
| Review decisions (approve/reject/edit) | FireLever | leads.db | No | Fine-tune training data for slice 6; log from day one. |

Quality notes: leads.db fields `enrichment_json` and `drafts_json` are free-form JSON
from agents; the MCP layer must parse defensively. Partner docs are assumed messy
(scans, mixed formats); v1 ingestion scopes to PDF/docx/md/txt and reports what it
skipped rather than silently dropping files.

## Eval plan

Principle: no capability ships without a golden set, a metric, and a dumb baseline to
beat. Golden sets live in `evals/` as JSONL; `npm run eval` (built in slice 2) runs any
capability locally and in CI and fails on regression against the last recorded score.

| Capability | Golden set | Metrics | Baseline to beat | Target |
|---|---|---|---|---|
| Retrieval (slice 2) | 30-50 (query → expected chunk ids) over FireLever corpus, then per-partner | recall@5, MRR | SQLite FTS keyword search | recall@5 ≥ 0.85 |
| Grounded Q&A (slice 3) | 30-50 (question → reference answer + must-cite sources), incl. 10 unanswerable questions | faithfulness (LLM-judge + monthly human spot-audit of 10), citation correctness, refusal accuracy on unanswerables | single-prompt Claude with full-corpus stuffing (small corpus makes this viable; it sets the honest bar) | faithfulness ≥ 95%, refusal ≥ 90% |
| Triage (slice 4) | 50 labeled emails (class + should-reply) | classification accuracy, draft groundedness | keyword rules | accuracy ≥ 90% |
| Lead scoring (slice 6) | Peter's review decisions accumulated in leads.db (target ≥ 200 labeled) | agreement with human accept/reject, cost/latency per lead | current Claude prompt (this is the API baseline the fine-tune must approach) | within 5% of baseline at < 20% of cost |
| Injection resistance (phase 6 gate, slices 3+) | 15-20 adversarial docs/emails (instructions embedded in content) | attack success rate | — | 0 successful instruction-following |

Slice 1 (read-only MCP server) has no generative component: it is covered by
integration tests (tool responses match direct DB queries), not evals.

MCP server hygiene note: tool descriptions and results feed other models' contexts.
Results are data, never instructions; the server must not echo lead content in a way
that claims to be a directive (relevant once partner-facing in slice 5).

## Gate decision

**2026-07-07 — GO for slices 1-3.** Slices 4-6 gates re-checked when their golden sets
exist. Design-partner ingestion blocked on the per-partner mini-audit, no exceptions.
