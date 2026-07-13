# ADR-018: Coherence sentinel + self-healing watchdog

**Status:** Accepted (2026-07-13)

## Context

Live test, July 12 (late): the model tagged `stage_reply` with a hallucinated
`email_id: 1`, attaching a "Hi Dana, can we move our meeting to Friday" draft
to a Google Workspace billing notice — one Approve away from replying to
workspace@google.com. In the same session, "archive them" (referring to test
emails Levi had just offered to archive) fell through to the only bulk tool
that existed (`archive_newsletters`), producing a truthful but contextually
absurd "there's no newsletter clutter" reply. The user asked two questions:
can an engine guarantee context never breaks down, and can the system watch
its own logs and self-heal?

## Decision

**Coherence sentinel — invariants, not vibes.** Model attention cannot be
trusted with cross-references; deterministic server checks can. Every action
that binds conversation entities to stored objects is cross-examined before
executing, extending the ADR-017 pattern (address gate):

- *Reply/thread coherence:* a draft whose salutation names a person is
  refused if the target thread doesn't involve that person (name absent from
  sender/subject/body-head, and the sender isn't that contact's address) —
  at stage time AND at send time, so pre-guard drafts can't leak either.
- *Specific archiving:* `archive_emails {email_ids}` archives exactly what
  the user agreed to; `archive_newsletters` is restricted by prompt to the
  newsletter category so consent to one never executes as the other.
- Existing gates (address spell-back, contact conflict, gid resolution,
  duplicate-send) are part of the same layer.

**Self-healing watchdog.** The server watches its own failure signals
(stream failures, empty turns, action failures; 10-minute ring) and applies
safe remediations automatically: 3 stream failures in 5 minutes clears
derived voice caches (lexicons) once per 10 minutes. Vitals ride on
`/api/health` so a human or an agent can read them without grepping logs.
Remediations are limited to actions that cannot lose data.

**Disconnect taxonomy (client).** The SDK's disconnect reason now routes
behavior: "agent" (deliberate hang-up: silence timeout, max duration) is a
clean stop with an explanatory message — auto-reconnecting there would
reopen billed sessions forever; anything else triggers the reconnect loop.

## Consequences

- The wrong-thread class of error is structurally caught server-side; the
  model can still pick the wrong id, but the action refuses and asks.
- Watchdog remediation is deliberately shallow. Deep self-healing (reading
  fly logs, diagnosing, patching code) belongs to a scheduled operator agent
  (Claude Code cron) outside the serving process — proposed, not yet set up.
- Every sentinel refusal is a spoken question, so a false positive costs one
  clarifying turn, never a lost action.
