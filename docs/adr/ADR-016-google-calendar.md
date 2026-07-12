# ADR-016: Google Calendar — Levi books real meetings

**Status:** Accepted (2026-07-12)

## Context

Voice test, July 12: "schedule a meeting with Dana Tuesday at 1 PM" landed only
in Levi's local workspace store; "did you add a Google meeting to it?" exposed
that Levi cannot touch the user's actual calendar or create Meet links. A
scheduling copilot that schedules into a private notebook fails the product's
core promise (voice replaces mouse and keyboard).

## Decision

**Integration.** `src/calendar/google.ts` talks to the Calendar v3 REST API
directly (no SDK dependency — four endpoints, plain fetch). Auth is OAuth2
with a long-lived refresh token minted once by `npm run gcal-auth` (loopback
redirect flow); `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
`GOOGLE_REFRESH_TOKEN` configure it, and when unset every path degrades to the
local store with Levi saying so plainly.

**Capabilities.** Create (with duration, Google Meet link via
`conferenceData.createRequest`, and invitees), reschedule/move, rename, extend,
add-Meet-to-existing (`update_event`), and cancel (`cancel_event`;
`sendUpdates=all` notifies attendees, and Google's trash keeps it recoverable
~30 days — the calendar analog of archive-not-delete). Invitees must be
explicit addresses from the conversation; Levi asks rather than guesses
(same rule as compose_email).

**Id mapping.** The voice model sees Google events as `[g1]…[gN]` in the
schedule listing; a per-tenant map (rebuilt on every listing) resolves them to
real event ids, so a stale reference misses loudly instead of hitting the
wrong event.

**Truth discipline (ADR-015 applies).** Calendar mutations return
server-authored spoken confirmations built from Google's response ("Booked.
Meeting with Dana, Tuesday July 14 at 1 PM, with a Google Meet link, on your
Google Calendar."), replacing the model's own claim. Times are spoken, never
read as ISO strings. Activity events stream to the reasoning rail.

**Surfaces.** The workspace voice branch lists the next 14 days of the real
calendar alongside local items; `/api/workspace/event` merges Google events
(synthetic ids ≥ 1,000,000, display-only) into the Schedule window.

## Consequences

- "Tuesday at 1 PM" is interpreted in the calendar's own timezone (fetched
  from the primary calendar, cached).
- Local workspace events remain for note-like scheduling and as the fallback
  when the calendar isn't connected; the model is told which is which.
- Also in this change: duplicate voice-turn delivery no longer double-posts
  activity events (5s same-kind+label dedupe on the ui-event bus).
