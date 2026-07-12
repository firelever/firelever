# ADR-015: Live activity stream — the screen performs the conversation

**Status:** Accepted (2026-07-12)

## Context

Two incidents converged on the same root cause.

First, Levi reported "I've swept all the newsletter and promo clutter into the
archive" while the user's Gmail inbox looked unchanged. Investigation showed the
sweep did land (stale Gmail client view), but it exposed a genuine lie-vector:
`applyCleanup` marked emails `archived` locally whenever the IMAP search could
not find them, and Gmail's per-message `HEADER Message-ID` search is unreliable
(returns empty with no error). The model's spoken confirmation was generated
text, never checked against what the server actually did. Separately,
`categorize_email` only wrote a local DB column — invisible in Gmail, so from
the user's seat the action never happened.

Second, the user kept having to ask what Levi was doing. A voice interface that
hides its reasoning forces the user to interrogate it; that is the mouse and
keyboard problem wearing a headset.

## Decision

1. **Ground truth or nothing.** `applyCleanup` now fetches every INBOX envelope
   in one pass and matches Message-IDs in code (no per-message IMAP search). An
   email's status becomes `archived` only when the Gmail move happened; an
   email not found is counted and marked `archive_missing`, never claimed.
   `applyCleanup` returns `{archived, missing}`.

2. **Server speaks the counts.** For count-bearing actions (archive single,
   archive sweep, categorize), `executeAction` returns a server-authored
   sentence built from the real result ("Done. I archived 9 newsletters in
   Gmail. 2 I couldn't find..."), and the tag state machine emits it INSTEAD of
   the model's confirmation — the same replacement path failures already use.
   The model can no longer invent a success narrative for bulk actions.

3. **Categories become Gmail labels.** `labelInGmail` copies the message into
   the `FireLever/<category>` mailbox over IMAP (Gmail labels are mailboxes),
   so a categorization is visible where the user actually reads mail. If the
   label cannot be applied, Levi says exactly that.

4. **Live activity stream.** The voice brain publishes typed events to the
   ui-context bus at every real step: `route` (what was heard, where it
   routed), `search`/`sources` (query, passage count, documents), `action`
   (running) and `result` (truthful outcome), `note` (entity focused), and
   `speak` (each sentence as it streams). Events carry a monotonic id; the bus
   keeps the last 30; session start clears them.

5. **The screen performs the conversation.** The frontend renders the stream
   as choreography, not a log: a LIVE REASONING rail where steps slide in as
   they execute (pulsing while running, green/amber on outcome), a caption
   under the orb showing the sentence Levi is speaking right now, a shimmer
   sweep across the focused card while a search runs, and a border glow while
   an action executes. Events can only be emitted by server code that did the
   thing, so the visuals are as honest as the counts feeding them.

## Consequences

- Levi physically cannot claim a bulk outcome the server didn't verify; the
  spoken sentence and the on-screen result event come from the same counts.
- The reasoning rail turns silent latency (search, IMAP round-trips) into
  visible progress, which matters at voice pace.
- Polling stays at 800ms; events batch per turn and the client staggers their
  animation, so the feed reads as real-time without a socket. SSE remains an
  easy upgrade if finer sync is ever needed.
- `archive_missing` emails are excluded from future sweep proposals to avoid
  retry loops; a manual re-triage can resurface them.
