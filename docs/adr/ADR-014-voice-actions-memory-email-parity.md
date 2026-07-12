# ADR-014: Voice action protocol, persistent memory, and email parity

**Date:** 2026-07-11 · **Status:** accepted · **Owner:** Peter

## Context

Live testing of the Levi voice agent surfaced a family of failures with one
root cause: the voice brain could *talk about* the workspace but not *act on*
it, and nothing constrained its claims to reality.

Observed defect classes:
1. **Status hallucination** — claimed a drafted reply "already went out" when
   approval had only ever set a status flag; nothing had been sent.
2. **Capability hallucination** — said "sending it now" for an action it had
   no mechanism to perform (a fresh reply on an already-answered thread).
3. **Sycophantic memory** — accepted any correction blindly, letting a wrong
   correction override the documents forever.
4. **Prose-driven UI** — client keyword-scanning of the assistant's own
   sentences ("one thing worth a note…") yanked unrelated windows forward.

## Decision

**1. Action protocol (act-then-confirm).** The voice model may tag exactly one
structured action at the start of a reply (`<<action:{...}>>`). The server
parses the tag out of the token stream, executes it, and only then releases
the spoken confirmation; failures replace the confirmation entirely. The
prompt contract forbids claiming any action without its tag and requires
declining anything outside the action set. Actions dispatch to the same
functions the UI windows use — one capability layer, two frontends.

Action set: `send_reply` (reply on any thread, any number of times, dictated
body or unsent draft), `compose_email` (new thread; recipient + gist must be
explicit in conversation, never guessed), `draft_reply` (grounded draft into
the Replies window for review, with spoken guidance), `add_task` /
`add_event` / `add_note`, `complete_task`, `remember`.

**2. Ground truth over claims.** Outbound email state lives in `sent_at`, set
only after SMTP succeeds. The prompt may only assert "sent" for emails marked
sent; "approved" is a verdict, not a delivery. This generalizes: every claim
Levi makes about a side effect must be backed by a recorded fact.

**3. Persistent memory with calibrated deference.** `tenant_memories` stores
user corrections/confirmed facts; a memory block is injected into every answer
path (voice and text) as authoritative over OCR text. Corrections the sources
genuinely conflict on (BDLP/BRLP) or don't cover are accepted immediately;
corrections that contradict clear, consistent evidence get exactly one
evidence-citing pushback, then are stored recording both sides if the user
insists. The user has final say; Levi never argues past one round.

**4. Brain-driven UI context.** The voice pipeline publishes per-turn UI
context (window + entity, e.g. the email under discussion with body and reply
state) to an in-memory bus; the frontend polls and follows. Only the brain's
published intent and the user's own words may route windows — assistant prose
is never keyword-scanned.

## Consequences

- Voice approval is the human-in-the-loop for sends it explicitly dictates;
  the Replies window approval path remains for triage-drafted mail. Both paths
  record `sent_at`.
- Misheard addresses are the main compose risk; mitigated by the
  explicit-recipient rule (ask, don't guess). A confirmation read-back for
  never-before-seen addresses is a candidate hardening.
- Deferred: forwarding, outbound attachments, an outbound log table for
  composed sends, memory editing UI (CLI exists: `npm run memory`).
