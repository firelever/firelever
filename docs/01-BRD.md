# Business Requirements Document: FireLever Copilot

| | |
|---|---|
| Status | **Approved 2026-07-07** |
| Owner | Peter Peng |
| Date | 2026-07-07 |
| Reviewers | — |

## 1. Problem statement

Ops-heavy SMBs ($5M-$500M revenue: logistics, legal, real estate, insurance, healthcare
admin, professional services) run on knowledge trapped in SOPs, contracts, email threads,
and the heads of a few senior staff. Answering "how do we handle X" costs interruptions
and errors; onboarding new staff is slow; inbound email triage eats hours daily. These
companies want AI but lack anyone who can evaluate or build it, which is also FireLever's
consulting wedge.

Secondary problem (ours): FireLever needs a credible product demo that generates leads,
and Peter needs production RAG, MCP, and model fine-tuning work for AI architect roles.

## 2. Business objectives

- **O1:** Live product used weekly by 3 design-partner SMBs by 2026-09-30.
- **O2:** First paid revenue (audit offer or subscription) by 2026-10-31.
- **O3:** ≥2 consulting discovery calls sourced by the product by 2026-10-31.
- **O4:** Portfolio complete by 2026-09-15: shipped RAG system, published MCP server,
  and a fine-tuning eval writeup, all public.

## 3. Why AI (and the non-AI baseline)

Baseline: a shared drive plus full-text search (Google Drive, Notion). SMBs already have
this and still ask each other questions, because keyword search can't answer "what's our
escalation policy when a carrier misses a pickup twice?" from three documents at once,
and it can't draft a reply to an inbound email. Grounded generation over their own
documents is the capability gap; general chatbots without their data hallucinate answers.

## 4. Acceptable error analysis

- **Wrong answer with citation:** user can check the source; tolerable at low rates.
  Target: ≥95% answer faithfulness on the golden set; every claim cited.
- **Wrong answer without citation:** not acceptable; the system must refuse instead.
- **Drafted email errors:** no external send without human approval, ever (inherits the
  existing FireLever guardrail).
- **Data leakage between tenants:** zero tolerance; isolation tested adversarially
  before any second customer onboards.

## 5. Stakeholders

| Role | Person | Involvement |
|---|---|---|
| Sponsor / decision-maker | Peter | Gate decisions, all outbound approvals |
| Builder | Peter + Claude | Everything else |
| Target users | Ops managers / owners at design-partner SMBs | UAT, feedback |
| Affected third parties | Design partners' customers (email recipients), their staff (PII in docs) | Privacy, accuracy |

## 6. Scope

**In scope (v1):**
1. Document ingestion + grounded Q&A with citations (RAG) over a tenant's files
2. MCP server exposing the same capabilities (usable from Claude Desktop/Code) — also
   the internal version over FireLever's own leads.db as slice #1
3. Inbound email triage: classify + draft reply grounded in tenant docs, human approves
4. Fine-tuned small model for one narrow capability (lead scoring or triage
   classification), benchmarked against the frontier-API baseline

**Explicitly out of scope (v1):** mobile apps, SSO/SAML, integrations beyond email +
file upload (no Slack/CRM connectors yet), autonomous sending of anything, multi-language,
on-prem deployment, model pretraining.

## 7. Constraints

- **Budget:** run-cost ceiling $100/mo pre-revenue (free tiers + one small GPU rental
  for fine-tuning, est. $20-50 one-time). Confirmed 2026-07-07.
- **Timeline:** portfolio-ready by mid-September 2026 (job application season).
- **Regulatory:** CAN-SPAM on anything outbound (existing guardrail); customer docs may
  contain PII, so CCPA/GDPR-grade handling: per-tenant isolation, deletion on request,
  no training on customer data without written consent.
- **Brand:** product failures reflect on the consultancy; nothing ships to a design
  partner without passing its evals.

## 8. Success metrics

| Metric | Baseline | 90-day target | How measured |
|---|---|---|---|
| Retrieval recall@5 on golden set | keyword search score | ≥0.85 | eval harness in CI |
| Answer faithfulness | — | ≥95% | LLM-judge + spot audit |
| Weekly active design partners | 0 | 3 | usage logs |
| Discovery calls sourced | 0 | ≥2 | CRM tag |
| Cost per query | — | <$0.05 | token accounting |
| Fine-tune vs. API on chosen task | API score | within 5% at <20% cost | eval writeup |

## 9. Risks and assumptions

| # | Risk / assumption | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Can't recruit 3 design partners | Med | High | Source from existing outbound pipeline; audit offer as hook |
| R2 | SMB docs too messy for good retrieval | Med | Med | Data audit per partner before onboarding; scope v1 to PDFs/docx/email |
| R3 | Prompt injection via ingested docs or email | High (attempts) | High | Treat all retrieved content as untrusted; adversarial pass in phase 6 |
| R4 | Solo-builder time split with job hunt | High | Med | Vertical slices; each slice is independently demo-able |
| R5 | Fine-tune underperforms and feels "wasted" | Med | Low | The eval writeup is the deliverable either way |
| A1 | Design partners will grant doc access under NDA | — | — | Validate with first partner conversation |

## 10. Cost model (rough)

Build: nights-and-weekends, ~8 weeks of slices. Run (pre-revenue): Postgres+pgvector
free tier, embeddings ~$1-5/mo at partner volumes, generation ~$10-30/mo, fine-tune
one-time ~$20-50 GPU rental. Revenue test 🔶: paid "AI Readiness Audit" at $99-499
one-time and/or copilot subscription ~$99-299/mo per SMB.

**Pricing hypothesis (decided 2026-07-07):** audit-first. $299 one-time AI Readiness
Audit as the entry offer; $199/mo copilot subscription offered to audit customers
afterward. Validate with the first design partners.

**Product-surface amendment (2026-07-09):** the copilot is being rebuilt to the
voice-first "Levi" dashboard (ADR-013, PRD §7). This raises the product's demo and
sales ceiling and adds two run-cost lines — voice (Deepgram STT + ElevenLabs TTS,
per-minute) and an always-on frontend. Voice is metered to the copilot surface;
budget impact monitored against the $100/mo ceiling, revisited if a design partner
uses voice heavily.

## 11. Gate decision

**2026-07-07 — GO.** Decided by Peter. Open items resolved: first revenue 2026-10-31,
budget ceiling $100/mo, audit-first pricing ($299 audit → $199/mo subscription).
Proceed to phase 1 (PRD).
