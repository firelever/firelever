# ADR-010: Email attachment ingestion with provenance

**Status:** Accepted 2026-07-09 · **Deciders:** Peter + Claude

## Context

Triage read only email body text; document attachments (contracts, NDAs, SOPs
clients email in) were dropped. The knowledge base only grew by manual upload. This
is the one-directional gap: triage read from the knowledge base but never fed it.

## Decisions

1. **Ingest supported attachments during triage.** PDF/docx/md/txt attachments on
   inbound email are extracted (mailparser already provides the bytes) and pushed
   through the same ingestion path as manual uploads — including OCR for scans.
2. **Attach provenance as a preamble.** Each ingested attachment is prefixed with a
   header (from / subject / date / a note from the email body) before chunking, so
   the context travels into every chunk. The copilot can then answer "who sent us the
   NDA and when?" as well as what's inside it — verified in test. Documents are stored
   under `email/<sender-domain>/<filename>` so their source is visible and they're
   easy to find or remove.
3. **Gate to genuine correspondence.** Only emails classified `new_business`,
   `support`, or `vendor_partner` contribute attachments — never `newsletter_spam` or
   `recruiting` — so marketing PDFs and mass-mail don't pollute the knowledge base or
   the answer sources.
4. **Reuse existing safety.** Attachment content is untrusted (prompt-injection
   surface); the answer/OCR prompts already treat all document content as data, not
   instructions. Size-capped at 30MB per attachment.

## Consequences

- The knowledge base now grows from the inbox automatically: a client emails a signed
  contract and it becomes queryable without a manual upload. This is the loop that
  makes the product feel like it watches the business, not just a folder you fill.
- Auto-ingest trades some control for magic. Mitigations: the spam/recruiting gate,
  the visible `email/<sender>/` path, and the surfaced "added to knowledge base" note
  in the Inbox. A stricter per-attachment approval queue is the next step if a design
  partner wants tighter control (byte storage + an approve endpoint) — deferred until
  asked.
- Only runs when triage runs. Making triage live (Gmail creds on the server + a
  scheduled job) is the separate, still-pending step that turns this from a manual
  command into an always-on feature.
