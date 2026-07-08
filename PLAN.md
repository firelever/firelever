# FireLever Growth Engine — Plan

**Goal:** Build an AI agent swarm that generates qualified leads for FireLever.com (AI agent design/build/deploy consultancy for established companies).

**Strategic frame:** FireLever sells AI agents. The growth swarm we build here is itself the product demo — every prospect conversation can open with "this outreach was researched and drafted by the same kind of system we'd build for you." Dogfooding is the marketing.

**Reality check:** High-ticket B2B consulting deals close through trust, not volume. The swarm's job is to multiply Peter's reach and keep the pipeline full — a human stays in the loop on every outbound touch. No mass spam; 20 highly-researched touches beat 2,000 generic ones and protect the domain's sender reputation.

---

## Phase 0 — Foundation (Week 1)

Before any agents run, we need rails:

1. **Define the ICP (ideal customer profile).** First-pass hypothesis to refine:
   - Established SMBs / mid-market ($5M–$500M revenue) in ops-heavy industries (logistics, legal, real estate, insurance, healthcare admin, professional services)
   - Buying signals: hiring for "AI" or automation roles, recent funding, leadership talking about AI on LinkedIn, manual-process pain visible in job posts
   - Buyer personas: CEO/COO at SMBs, VP Ops / Head of Innovation at mid-market
2. **CRM + pipeline tracking.** Start lightweight: Attio or HubSpot Free. Every lead the swarm touches gets logged with source, score, and status.
3. **Outbound infrastructure.**
   - Buy 2–3 secondary domains (e.g., firelever.io, tryfirelever.com) for cold email — never send cold from firelever.com
   - Set up mailboxes + 2–3 week warmup (Instantly.ai or Smartlead handle warmup + sending)
   - SPF/DKIM/DMARC on all sending domains
4. **Site conversion basics.**
   - Analytics (Plausible or GA4) + form/booking tracking
   - Add a Cal.com "Book a 20-min agent audit" CTA — a concrete low-friction offer beats "let's talk"
   - Consider a lead magnet: free "AI Agent Readiness Audit" (the audit itself can be agent-assisted — more dogfooding)

**Decision needed from Peter:** budget for data tools (Apollo ~$50–100/mo, Clay ~$150+/mo, sending tool ~$40–100/mo) vs. scrappy free-tier start.

## Phase 1 — Outbound Swarm MVP (Weeks 1–2, runs while domains warm up)

Build with the **Claude Agent SDK** (fits the brand; the code doubles as portfolio). Pipeline of agents, human approval gate before anything sends:

| Agent | Job | Trigger |
|---|---|---|
| **Prospector** | Finds companies matching ICP via signals: job posts mentioning manual processes/AI, funding news, tech stack signals | Daily cron |
| **Enricher** | Identifies decision-makers, verifies emails (Apollo/Hunter), gathers company context | On new prospect |
| **Scorer** | Ranks leads 1–100 on fit + timing signals; only ≥70 advances | On enrichment |
| **Outreach drafter** | Writes a genuinely personalized 3-email sequence referencing the company's specific situation and a concrete agent use-case FireLever could build for them | On qualified lead |
| **Review queue** | Daily digest to Peter: approve / edit / reject each draft. Nothing sends without approval. | Daily |
| **Follow-up tracker** | Watches replies, drafts responses, nudges on no-reply per sequence schedule, books calls via Cal.com link | Continuous |

Storage: SQLite to start. Orchestration: scheduled tasks (cron) + a simple review UI (or even a daily email/Slack digest).

**Target throughput:** 15–25 new qualified, researched prospects/day drafted; Peter spends ~20 min/day approving.

## Phase 2 — Inbound + Authority Engine (Weeks 3–4)

Cold outbound gets meetings; authority closes them.

1. **Content agent.** Weekly output, human-edited before publishing:
   - 3–4 LinkedIn posts (Peter's voice: real build stories, agent architecture lessons, "what actually works" contrarian takes)
   - 1 SEO article/wk targeting buyer-intent queries ("AI agent development company", "hire AI agent developers", "AI agent consulting", vertical-specific: "AI agents for logistics")
2. **Case-study agent.** Turns each project (including this swarm) into a written case study + LinkedIn thread. "How we built our own lead-gen swarm" is post #1.
3. **Inbound triage agent.** Watches hello@firelever.com: classifies inquiries, enriches the sender, drafts replies, proposes calendar slots, flags hot leads to Peter immediately.
4. **Directory/listing sweep.** Get listed where buyers search: Clutch, G2 (services), Upwork/Toptal enterprise if desired, relevant "AI agency" directories.

## Phase 3 — Scale + Intelligence (Month 2+)

- **Pipeline dashboard:** weekly agent-generated report — leads sourced, contacted, reply rate, meetings booked, by segment. Kill what doesn't convert.
- **Signal expansion:** intent data, LinkedIn engagement monitoring (who engages with Peter's posts → auto-enrich → outreach), lookalike sourcing from closed deals.
- **Referral/partner agent:** tracks past contacts and network, drafts periodic check-ins, identifies partnership targets (dev shops, fractional CTOs, PE ops teams who can refer).
- **A/B testing:** subject lines, offers (audit vs. workshop vs. teardown), verticals.

## Guardrails (non-negotiable)

- Human approves every outbound message — quality and compliance (CAN-SPAM: real identity, physical address, working unsubscribe).
- Cold volume capped (~50/day/mailbox max once warmed); watch bounce + spam-complaint rates.
- Never send cold from the primary domain.
- All personalization claims must be verifiable facts the Enricher found — no hallucinated flattery.

## KPIs

| Metric | 30-day target | 90-day target |
|---|---|---|
| Qualified prospects sourced | 300 | 1,200 |
| Outbound sequences approved/sent | 200 | 900 |
| Reply rate | ≥5% | ≥8% (better targeting) |
| Discovery calls booked | 8–12 | 40+ |
| Proposals out | 3–5 | 15 |
| Closed clients | 1 | 3–5 |

## Immediate next steps

1. Peter confirms ICP hypothesis + tool budget
2. Buy secondary domains, start mailbox warmup (longest lead time — do first)
3. Scaffold the agent pipeline repo in this folder (Claude Agent SDK + SQLite + cron)
4. Ship Prospector + Enricher first; review first batch of 25 leads together to calibrate the Scorer
