# ADR-020: Answer reviews with Plures

**Status:** Proposed 2026-10-30 · **Deciders:** Peter + Claude

## Context

Levi's quality is measured by golden sets (`npm run eval`, `npm run eval:qa`) that we write by
hand. Real conversations surface failures the golden sets don't have: the router picks the
wrong domain (the model's `<<ctx:{"reroute"}>>` channel catches some of these), retrieval
misses a passage, an answer leaves out what the user actually wanted, or the user asks the same
thing again because the first answer missed. None of that is captured today: `voice_turns`
keeps the question and reply, not the route, retrieval or sources.

## Decision

Every reply is sent to Plures (`POST /api/v1/turns`) with a trace from `streamVoiceReply`: the
router's intent, the model's reroute, the retrieval mode and the top sources. Plures picks the
turns worth a look (rerouted, refused, empty, no sources, asked again in the same conversation,
plus a few at random by the answer risk its oversight engine sets on the map) and our own team
grades them: was the intent right, is the answer backed by the sources, did it miss anything,
and optionally the right answer and where it is.

- **Not in the live path.** One fire and forget POST after the reply, 8 second timeout, errors
  logged and dropped. Voice latency is unchanged.
- **Team only.** Answers carry inbox mail and client contracts, so grading goes to our own
  team, never to Plures' verified people.
- **No new dependency.** A plain `fetch`, the same body as `plures.turns.log` in the SDK.
- **Off unless configured.** Needs `PLURES_API_KEY` (and optionally `PLURES_APP`, default
  `firelever`, and `PLURES_BASE_URL`).

## Consequences

- Graded turns export as lines in our own eval formats: `retrieval` as
  `{ query, doc, must_contain }` for `evals/retrieval.jsonl`, `qa` as `{ question, doc, fact }`
  or `{ question, unanswerable: true }` for `evals/qa.jsonl`, plus routing examples (router
  keywords for `routeIntent`) and missed asks (prompt changes). Real failures become regression
  tests through the gate we already run.
- Questions, answers and source snippets (300 characters each, top 8) leave the box to Plures.
  The team review link needs no account; anyone with a link can grade until they leave the team.
