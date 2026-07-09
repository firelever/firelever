# ADR-012: Ask about the inbox, and cleanup (archive-only)

**Status:** Accepted 2026-07-09 · **Deciders:** Peter + Claude

## Context

The chat only answered from uploaded documents; the classified inbox wasn't
queryable. And the system could read mail but not act on it. Two asks: query the
inbox in chat, and clean it up.

## Decisions

1. **Intent routing for Ask.** A cheap Haiku call classifies each question as
   `documents` or `inbox`; inbox questions are answered from the `inbound_emails`
   table (sender, subject, category, urgency, needs-reply, status), documents go to
   the existing adaptive answerer. Binary by design — dominant intent wins; a
   unified two-tool agentic answerer is possible later but the router is lower-risk
   and keeps the document path (and its passing eval) untouched.
2. **Inbox answers are read-only and un-cited.** They summarize structured email
   metadata, not document chunks, so there are no `[n]` citations — the UI already
   handles empty citations.
3. **Cleanup is archive-only and reversible.** Per Peter's choice: move classified
   newsletters/spam out of the INBOX (Gmail All Mail) — never delete. Recoverable in
   Gmail. Conservative target set (`newsletter_spam`); no reply-needed mail, no
   business correspondence.
4. **Propose then apply.** `GET /api/inbox/cleanup` returns what would be archived;
   `POST /api/inbox/cleanup/apply` acts only on the ids the user approved. Nothing is
   archived without an explicit click — same human-in-the-loop spirit as sending.
5. **Match by Message-ID, mark handled.** Apply looks each email up in the live inbox
   by Message-ID before moving it, and sets local status `archived` so it stops being
   proposed. Emails no longer in the inbox are marked handled without error.

## Consequences

- Chat now answers "what needs a reply?", "how many vendor pitches this week?",
  "who emailed about the contract?" — the inbox is a first-class surface, not just
  documents.
- Cleanup gives a real, safe action on the mailbox. Archive-only means a mistake
  costs nothing (un-archive in Gmail). Delete/label-rules are future scope if asked.
- Cleanup writes to Gmail, so it needs the same credentials the watcher uses; it runs
  on the always-on server.
