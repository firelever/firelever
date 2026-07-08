# ADR-004: Inbound email triage — taxonomy, grounding, and a synthetic golden set

**Status:** Accepted 2026-07-08 · **Slice:** 4 · **Deciders:** Peter + Claude

## Context

Slice 4 (PRD S1): classify inbound email, draft a reply grounded in tenant documents,
and queue everything behind human approval. Eval plan target: classification accuracy
≥ 90% against a keyword-rule baseline.

## Decisions

1. **Six-category taxonomy:** `new_business`, `support`, `vendor_partner`,
   `recruiting`, `newsletter_spam`, `other` — plus orthogonal `needs_reply` and
   `urgency` fields, because "what is it" and "must a human act" are different
   questions. Categories chosen from what a consultancy inbox actually receives;
   revisit per design partner (a logistics SMB's taxonomy will differ — taxonomy is
   config, not code, by slice 5).
2. **Drafting reuses the RAG layer.** Replies are grounded in retrieved tenant chunks
   with the same data-not-instructions injection rule as Q&A (ADR-003). The draft
   response includes which sources were used and a confidence flag for the reviewer;
   citations are reviewer-facing metadata, never rendered into the outgoing email.
3. **Approval queue mirrors the outbound one** (same interactive CLI pattern,
   `triaged → drafted → approved/rejected/ignored` statuses in SQLite). Approved
   replies are copy-pasted into Gmail manually, identical to the outbound guardrail:
   nothing sends automatically, full stop.
4. **Synthetic golden set to bootstrap.** The eval plan calls for 50 labeled real
   emails; none exist yet (the inbox is new). We bootstrap with ~24 synthetic emails
   spanning all categories, clearly marked as synthetic, and replace them with real
   labeled traffic as it arrives. Classification decisions and reviewer verdicts are
   logged to the DB from day one — that log is also the fine-tuning dataset for
   slice 6.
5. **Ingestion: IMAP polling + file mode.** IMAP (imapflow, same creds as the sender)
   for production; a `--dir`/demo mode reading plain-text email files so the pipeline
   is testable and demoable with zero credentials. Webhooks/Gmail API deferred: adds
   OAuth complexity for no benefit at current volume.

## Consequences

- Accuracy numbers on synthetic data are optimistic by construction; treat the ≥90%
  gate as provisional until ≥50 real labeled emails exist (tracked in the eval
  history as `synthetic: true`).
- The keyword baseline lives inside the eval script — if Claude can't beat regexes,
  the eval will say so, which is the point.
- Draft groundedness is not separately judged in v1 (QA faithfulness already measures
  the same mechanism); the human reviewer is the gate. Revisit if rejection reasons
  show hallucination.
