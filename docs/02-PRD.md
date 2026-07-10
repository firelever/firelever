# Product Requirements Document: FireLever Copilot

| | |
|---|---|
| Status | **Approved 2026-07-07** |
| Owner | Peter Peng |
| Upstream | [01-BRD.md](01-BRD.md) (approved 2026-07-07) |

## 1. Personas

- **P1 — Ops Owner (customer):** COO/ops manager at an ops-heavy SMB. Not technical.
  Wants answers from company docs and less time on inbound email. Judges the product in
  the first 10 minutes.
- **P2 — Peter (operator):** runs the FireLever pipeline daily; wants to query and
  operate it from Claude Code/Desktop instead of six npm scripts.
- **P3 — Hiring manager (audience):** evaluates the repo, architecture docs, and
  writeups. Never runs the code.

## 2. User stories (v1)

1. As P2, I can ask Claude "which drafted leads scored above 80 this week?" and get an
   answer from live pipeline data (MCP).
2. As P1, I upload a folder of company documents and within minutes ask questions and
   get answers with citations to the exact source passage (RAG).
3. As P1, when an answer isn't in my documents, the system says so instead of guessing.
4. As P1, inbound emails are classified (new business / support / vendor / spam) with a
   suggested reply grounded in my docs; nothing sends without my click.
5. As P2, I can run one command to evaluate any capability against its golden set and
   see whether a change helped or hurt.
6. As P3, I can read an ADR and eval writeup that explain why each major choice was made.

## 3. Functional requirements (MoSCoW)

**Must (v1):**
- M1. MCP server exposing pipeline data: search leads, get lead detail, pipeline stats.
  Read-only; all writes stay behind the existing human review CLI.
- M2. Document ingestion: PDF, docx, md/txt, and pasted email; chunking + embeddings
  into per-tenant storage.
- M3. Grounded Q&A: hybrid retrieval (vector + keyword), answers cite chunk sources,
  refusal when retrieval confidence is low.
- M4. Eval harness runnable locally and in CI; per-capability golden sets in-repo.
- M5. Tenant isolation enforced at the storage layer (tenant_id on every row, no
  cross-tenant query path).

**Should (v1.x):**
- S1. Inbound email triage: classify + draft grounded reply, human approval queue.
- S2. Copilot MCP server for customers (their docs, their tenant) — same tools, scoped.
- S3. Fine-tuned small model for triage classification or lead scoring, benchmarked
  against the API baseline (the writeup is a deliverable regardless of winner).

**Could:** simple web UI for Q&A and the approval queue; usage/cost dashboard per tenant.

**Won't (v1):** autonomous sending, Slack/CRM connectors, SSO, multi-language, mobile,
on-prem, model pretraining.

## 4. Non-functional requirements

| Dimension | Requirement |
|---|---|
| Latency | Q&A answer start < 5s p95; MCP tool calls < 1s p95 |
| Cost | < $0.05 per Q&A query; ingestion < $1 per 100 docs |
| Availability | Best effort pre-revenue; no data loss (daily backup of tenant stores) |
| Privacy | Per-tenant isolation (M5); delete-tenant purges all derived data incl. embeddings; no training on customer data without written consent |
| Security | Retrieved doc content and email bodies are untrusted input: never executed as instructions, injection-tested in phase 6 |
| Auditability | Every generated answer logs its retrieved chunks, prompt version, model, tokens |

## 5. AI behavior spec

- Every factual claim in an answer must be supported by a retrieved chunk; cite or omit.
- If top retrieval score is below threshold: reply "I can't find this in your documents"
  and suggest what to upload. Never fill gaps from world knowledge without labeling it.
- Drafted emails: professional, plain language, no em dashes, no invented facts about
  the recipient; unsubscribe/footer rules inherited from the growth pipeline.
- Refuse instructions that arrive inside documents or emails (prompt injection).

## 6. Build order (vertical slices)

| Slice | Delivers | Proves |
|---|---|---|
| 1 | MCP server over leads.db (M1) | MCP; immediately useful to P2 |
| 2 | Ingestion + hybrid retrieval + eval harness (M2, M4 partial, M5) | RAG foundations, measured |
| 3 | Grounded Q&A with citations + refusal (M3) + golden-set evals | The core product |
| 4 | Email triage + approval queue (S1) | Second capability on same foundation |
| 5 | Customer-facing MCP (S2) + first design partner onboarding | Productization |
| 6 | Fine-tune + benchmark writeup (S3) | Model training story |

Slices 1-6 shipped. Post-6, the product also gained OCR (ADR-007/009), adaptive
retrieval (ADR-008), a deployed tenant-authenticated web app (ADR-005), and a live
inbox watcher with attachment ingestion, ask-about-inbox, and cleanup
(ADR-010/011/012).

## 7. Levi — voice-first dashboard (amendment, 2026-07-09)

The copilot's product surface is being rebuilt to the "Levi" design (ADR-013): a
voice-first desktop dashboard with a WebGL presence orb, a stacked window stage, a
live conversation panel, five themes, and an approve/undo contract on every action.

**Scope (Peter's call — shell + real windows + voice):**
- **Real windows** (wired to existing backends): Answer (RAG + citations), Inbox
  (drafts + approve/undo), Contract redlines, Sheet analysis; Tasks/Schedule/Notes as
  stored state.
- **Voice** (M-new): browser mic → Deepgram STT → existing `answer()` → ElevenLabs
  TTS. Claude stays the brain. Latency target < 2s end-of-speech to first audio.
- **Preview stubs** (clearly labeled, non-functional): Flight, Lunch, Code PR, Slack,
  Weather/Stocks — each a real integration deferred; shown as previews so demos read
  complete without implying capability that isn't wired.

**New non-functional requirements:** voice keys server-side (browser gets short-lived
tokens); the approve/undo contract must defer the real side effect until the undo
window expires; stubs must be visibly labeled "preview."

**Build order (Levi slices):** L1 shell + themes + window stage → L2 WebGL orb + voice
states → L3 voice pipeline (STT/Claude/TTS) → L4 wire Answer + Inbox to real backends
→ L5 Tasks/Schedule/Notes + Contract/Sheet → L6 preview stubs + approve/undo polish.
Each slice is independently demoable.

## 7. Gate decision

**2026-07-07 — GO.** Decided by Peter (build approval given same day as BRD).
Slice 1 starts immediately; slice 2 requires the phase 2 data audit + eval plan
([03-data-audit-and-eval-plan.md](03-data-audit-and-eval-plan.md)).
