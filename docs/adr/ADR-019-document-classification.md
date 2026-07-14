# ADR-019: Document classification — pertains-to is a tag, not a guess

**Status:** Accepted (2026-07-13)

## Context

"Show me all documents about Ute Street" first shipped as content search:
group retrieval hits by document, keep documents scoring near the best hit.
It found the contract, MLS report, and title commitment — and missed the
Draft HUD, whose text is mostly tabular figures where the street name barely
appears. The user's verdict: "any document that pertains to Ute Street — we
should be intelligent enough to classify the data." Correct: pertains-to is
a property of the document, decidable once at ingest, not re-derivable per
query from lexical luck.

## Decision

**Classify at ingest.** After every successful ingest (email attachment,
upload, backfill), the fast model reads the document's opening chunks plus
provenance and produces `doc_type` (what it IS: purchase contract, title
commitment, settlement statement, MLS report, lease, invoice…) and `topics`
(what it PERTAINS TO: canonical property addresses plus bare street names,
deal and entity names). Stored on the `documents` row (additive migration);
a boot backfill classifies documents that predate the classifier.
Classification failures never fail the ingest — `topics` stays NULL and the
backfill retries.

**Lookup is tags first, search second.** `show_documents` includes every
document whose topics match the ask (generic location words like "street"
don't count as signal — "Ute" does), then merges in content-search results
that clear the relevance bar (best passage ≥ 50% of the top hit) for
anything unclassified. Tagged membership is authoritative: a HUD statement
belongs to its property no matter how rarely the text names it.

**Visible.** The Library window shows each document's `doc_type` as a chip;
classification announces itself on the activity rail ("Draft HUD filed:
settlement statement · 4834 Ute Street").

## Consequences

- "Everything about X" degrades gracefully: exact for classified documents,
  similarity for the rest, and the two never fight (tags win).
- Topics are free-text tags, not a property table. When the portfolio grows
  to many properties, promote topics to first-class property objects with
  canonical ids — tags are the migration path, not the end state.
- The classifier can hallucinate a detail into a tag (a rent figure read as
  a street number was observed in testing); tags feed document GROUPING,
  never spoken facts, so the blast radius is a document appearing in an
  extra group. Answers still come from retrieval over the actual text.
