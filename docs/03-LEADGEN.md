# Local Lead Engine — build plan (adapted from leadgen-system-spec.md)

Decision (2026-07-14, confirmed by Peter): built INSIDE the FireLever repo in
TypeScript, not a new Python repo, and the pipeline UI is a Levi window, not a
separate Next.js app. Reason: half the spec already exists here as tested
code — prospect/enrich/score/draft agents, leads.db, the review approval
queue, and a sender with day 0/3/7 sequences, reply detection, a daily cap,
and a CAN-SPAM guard. The local engine specializes that machinery for
owner-operated trades in a metro, and Levi operates it by voice.

## Spec component -> repo mapping

| Spec | Repo reality |
|---|---|
| Orchestrator | `src/leadgen/` staged runs, idempotent by place_id + status |
| Sourcing agent (Places) | NEW: `src/leadgen/places.ts` + `source.ts` |
| Enrichment agent | NEW: leak signals w/ evidence (`enrich-local.ts`), pattern from `src/agents/enricher.ts` |
| Qualification agent | NEW: 4x25 rubric via `extract()` on FAST_MODEL |
| Outreach agent | NEW fix-spotted drafter; queue = existing review flow |
| Reply monitor | EXISTS: sender reply-check + inbox watcher; hot replies -> Levi mail events |
| Dashboard | Levi Pipeline window + voice actions |
| Data model | `src/leadgen/store.ts` in leads.db, Postgres-compatible DDL |

## Hard guardrails (from spec §6, all enforced in code)

- Human approves every outreach; the system only drafts and queues.
- Official APIs only (Places API); log request counts and estimated cost per
  run; configurable per-run call cap so a bad config cannot rack up spend.
- opt_outs checked before any draft is queued.
- CAN-SPAM fields ride every send (existing EMAIL_FOOTER guard).
- No signal without stored evidence; scores trace to evidence.

## Milestones (each runs + passes acceptance before the next)

1. **Foundation + sourcing** — metros config (`config/metros.json`), full
   data model, Places sourcing with dedup + cost log. Acceptance: Orlando
   trades config populates local_leads with real deduplicated businesses;
   rerun adds nothing; cost logged. (Mock mode for tests: `PLACES_MOCK=1`.)
2. **Enrichment + signals** — fetch site/profile, extract the five leak
   signals, evidence stored per signal. Acceptance: no signal without evidence.
3. **Qualification** — 0–100 grade, single top leak, matched offer, readable
   reasoning.
4. **Outreach drafting + approval** — fix-spotted note per qualified lead,
   opt-out check, queued for approval; wired into the existing sender on
   approve.
5. **Levi Pipeline window + voice** — stage board, grade sorting, approval by
   voice with on-screen preview (same staged-preview law as email), sourcing
   runs narrated on the reasoning rail, pipeline stats by voice.
6. **Metro expansion + hot replies** — second metro = one config entry; hot
   replies surface as Levi mail events for fast response.

## Sequencing note (from the strategy session, deliberately honored)

M1–M3 exist to make the MANUAL outreach test fast: real Orlando leads with
verified leaks and evidence on screen, notes hand-written by Peter. The
drafter (M4) earns its build only after manually-sent notes prove the message
converts. The system amplifies a proven message; it does not replace proving one.

## Needs from Peter

- `GOOGLE_PLACES_API_KEY` in .env + fly secrets (Google Cloud console ->
  enable "Places API (New)" -> create API key).
- EMAIL_FOOTER postal address in config.ts before any send (existing guard).

## AMENDMENT (2026-07-14): automatic outreach, human out of the loop

Peter's explicit decision after documented pushback (domain reputation,
personalization economics, missing emails): the original §6 "human in the
loop on all outreach / no auto send, ever" is REPLACED for the local lead
engine by policy auto-send with hard rails, all enforced in code:

- Eligible: grade >= 75, stage 'qualified', discovered email, not opted out,
  never contacted before (one outreach thread per lead, ever).
- Ramp cap: max 3 auto-sends per day (config limits.max_auto_sends_per_day).
- Emails discovered only from the business's own website (contact pages).
- CAN-SPAM: EMAIL_FOOTER (identity + postal address + opt-out) appended to
  every send; the engine REFUSES to send while the postal address
  placeholder is unset. Opt-outs honored before drafting and before sending.
- Stop-on-reply: a reply detected in the inbox moves the lead to 'replied',
  cancels any queued follow-up, and surfaces as a hot-reply event in Levi.
- Every draft and send is visible in the Pipeline window and announced on
  the activity rail; auto-sent rows record approved_by='auto-policy'.
- Kill switch: limits.auto_send=false stops the engine at the next tick.

Recommendation on record: move sending to a separate domain before scaling
past the ramp cap. The live leads.db now resides on the Fly volume; local
CLI runs must re-upload (checkpoint WAL first) or move server-side (M6).
