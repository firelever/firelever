# ADR-011: Live inbox watcher (IMAP IDLE)

**Status:** Accepted 2026-07-09 · **Deciders:** Peter + Claude

## Context

Triage was a manual CLI run against the local database. To make the inbox feature
real, it needs to run on the server, on its own, and reflect new mail quickly.

## Decisions

1. **IMAP IDLE, not polling.** Gmail pushes over an open IMAP connection the moment
   mail arrives, so triage fires within seconds — genuinely "instant" without Google
   Cloud Pub/Sub webhooks or their OAuth/infra overhead. imapflow's `exists` event
   drives a sweep.
2. **Runs inside the server process.** The watcher starts on server boot when Gmail
   creds are present (`startInboxWatcher`), sharing the single machine + SQLite volume
   (ADR-005). Watcher failures are caught and never take down the web server.
   Disable with `WATCH_INBOX=0`.
3. **Always-on machine.** A persistent IMAP connection can't survive scale-to-zero, so
   the machine runs 24/7 (`auto_stop='off'`, `min_machines_running=1`). This trades
   the near-zero idle cost for a live connection — the right call while the feature is
   in use; revert to scale-to-zero if the watcher is turned off.
4. **Don't mark mail as read.** The sweep searches unseen and relies on DB dedup (by
   message_id) so reprocessing is a cheap no-op — the user's inbox read-state is never
   touched. New emails cost an LLM classify/draft once; re-sweeps of old unseen mail
   cost only an IMAP fetch.
5. **Reconnect loop.** IDLE connections drop (server timeouts, network); the watcher
   rebuilds and re-sweeps so nothing is missed across the gap.

## Consequences

- The inbox-to-knowledge-base loop (triage + attachment ingestion, ADR-004/010) now
  runs autonomously: send an email to hello@firelever.com and a draft appears in the
  Inbox within seconds; the UI polls every 8s so it surfaces without a manual reload.
- Always-on costs a few dollars/month vs scale-to-zero. Acceptable while live.
- Gmail creds live as Fly secrets (encrypted at rest), same as the Anthropic key.
- Single-connection, single-tenant (`firelever`) for now; a multi-tenant hosted
  version would run one watcher per connected mailbox, which is a later concern.
