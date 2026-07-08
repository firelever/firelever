# Enterprise AI Delivery Process

How we take an AI product from idea to production. Written for the FireLever copilot
build, but deliberately structured the way an enterprise AI program would run it, so the
artifacts double as portfolio evidence for AI architect work.

**The one rule:** every phase produces a short written artifact and ends with a gate,
a go/no-go decision recorded at the bottom of that artifact. We never skip the artifact,
but we keep each one to 1-3 pages. Process should create clarity, not paperwork.

---

## Phase overview

| # | Phase | Artifact | Gate question |
|---|-------|----------|---------------|
| 0 | Business case | BRD | Is this worth building at all? |
| 1 | Product requirements | PRD | Do we agree on what "done" looks like? |
| 2 | Data and AI feasibility | Data audit + eval plan | Can AI actually do this, and can we prove it? |
| 3 | Architecture | Architecture doc + ADRs | Do we know how we'll build it? |
| 4 | Design | Wireframes (UI surfaces only) | Do the flows make sense before code? |
| 5 | Build | Working vertical slices | Does each slice pass its evals? |
| 6 | Verification | Test + eval results, UAT notes | Would we put our name on this? |
| 7 | Launch | Runbook + rollback plan | Can we operate and undo it? |
| 8 | Operate | Monthly ops review | Is it still accurate, safe, and profitable? |

Phases 0-2 are sequential. From phase 3 on, we work in vertical slices: each slice
(e.g. "MCP server over leads.db") runs its own mini 3-7 loop.

---

## Phase 0: Business Requirements Document (BRD)

Answers *why* in business language. No technology choices belong here.

- Problem statement and who has the problem
- Stakeholders and decision-makers
- Business objectives with measurable targets (revenue, cost saved, time saved)
- Scope boundaries: what this is explicitly NOT
- Constraints: budget, timeline, regulatory, brand
- Success metrics and how they'll be measured
- Risks and assumptions
- Rough cost model (build cost + run cost per user/query)

**AI-specific additions:** an honest "why AI at all?" section (what a non-AI baseline
would look like and why it falls short), and an acceptable-error analysis: what happens
when the AI is wrong, who is harmed, and what human oversight is required.

Template: [templates/BRD.md](templates/BRD.md)

## Phase 1: Product Requirements Document (PRD)

Answers *what*. Translates the BRD into user-facing behavior.

- Personas and top user stories
- Functional requirements, prioritized MoSCoW-style (must/should/could/won't)
- Non-functional requirements: latency, availability, cost per query, data residency
- **AI behavior spec:** tone, refusal behavior, citation requirements, what the system
  must never do (e.g. invent facts about a lead, send anything without approval)
- Out-of-scope list (kept aggressively long for v1)

## Phase 2: Data audit and eval plan (the AI-specific phase)

Most enterprise AI failures trace to skipping this. Two artifacts:

**Data audit.** Inventory every data source the system will read or learn from:
where it lives, who owns it, quality, volume, PII classification, and rights (are we
allowed to use it, store it, embed it, train on it?). For customer-facing RAG this is
also where retention and tenant-isolation requirements get written down.

**Eval plan.** Before building, define how we'll measure the AI. Evals are to AI what
acceptance tests are to software: no feature ships without one.
- A golden set per capability: 25-50 real examples with expected outputs
  (e.g. queries with the doc chunks that should be retrieved; leads with
  agreed-correct scores)
- Metrics per capability: retrieval recall@k, answer faithfulness (no unsupported
  claims), scoring agreement with human judgment, cost and latency per query
- Baseline first: measure the dumbest thing that could work (keyword search, a
  one-line prompt) so improvements are provable, not vibes

**Gate:** if we can't assemble a golden set, we don't understand the task well enough
to build it.

## Phase 3: Architecture

- One architecture doc: components, data flow diagram, trust boundaries, tenancy model
- **ADRs (Architecture Decision Records):** one page per significant choice, with
  options considered and why. First candidates: vector store choice, embedding model,
  chunking strategy, single vs. multi-tenant DB, buy-vs-build for auth.
  ADRs are the highest-value portfolio artifact in this whole process: they show
  judgment, which is what architect interviews probe.
- Security and privacy review: authn/authz, secrets handling, prompt-injection surface
  (RAG content and MCP tool results are untrusted input), data deletion path
- Cost model v2: projected monthly run cost at 1, 10, 100 customers

## Phase 4: Design (only where a UI exists)

Wireframe only the surfaces humans touch: onboarding/ingestion flow, the ask-a-question
view, the review queue. Low fidelity (Excalidraw or paper) is enough; the goal is
catching flow problems, not pixel decisions. API and MCP surfaces skip this phase and
get an interface contract instead (tool names, schemas, error shapes).

## Phase 5: Build (vertical slices, eval-gated)

- Ship end-to-end thin slices, not layers: "ingest one PDF and answer one question
  with a citation" beats "the complete ingestion service"
- Every slice: code + tests + its eval running in CI + a line in the changelog
- Prompts are versioned artifacts in the repo, not strings scattered in code
- Trunk-based git with PRs even solo; the history is part of the portfolio

## Phase 6: Verification

- Automated: unit/integration tests green, eval scores at or above the targets set in
  phase 2, no regression against the previous slice's scores
- Adversarial pass: prompt-injection attempts via ingested docs, tenant-isolation
  probes, cost-blowup inputs (the 500-page PDF)
- UAT: real user (Peter, then a design partner) works a real task, notes captured

## Phase 7: Launch

- Runbook: deploy steps, env vars, how to check health, how to roll back
- Observability from day one: request logs with trace IDs, token/cost tracking per
  tenant, eval-sampled production traffic (grade 5% of real queries weekly)
- Rate limits and spend caps before the first external user

## Phase 8: Operate and govern

Monthly 30-minute review with a one-page report: usage, cost per tenant, eval drift,
incidents, customer feedback themes. Model/prompt upgrades go through phase 2's evals
before rollout. Retire features whose numbers don't justify their run cost.

---

## Governance mapping

For enterprise credibility (and interviews), each artifact maps to a recognized
framework: the BRD risk section and acceptable-error analysis map to **NIST AI RMF**
(Govern/Map), the eval plan and production sampling map to (Measure/Manage), and the
data audit covers the core of **EU AI Act** transparency and data-governance duties for
limited-risk systems. We are not chasing certification; we're building the habits.

## Cadence

- **Weekly:** 30-min review of the active slice against its gate criteria
- **Per phase:** gate decision recorded in the artifact (date, decision, who)
- All artifacts live in `docs/`, numbered in order: `01-BRD.md`, `02-PRD.md`, ...
