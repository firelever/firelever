# ADR-009: OCR fidelity — high-res model, DPI, and legibility flags

**Status:** Accepted 2026-07-09 · **Deciders:** Peter + Claude

## Context

A real scanned contract produced OCR misreads (a party name "Peng" transcribed as
"Burg", divergent entity names across pages). The copilot then reported these as a
"party-name inconsistency" — a false alarm caused by OCR noise, not a real contract
defect. On legal documents, transcription errors in names/numbers are high-stakes.

## Decisions

1. **OCR on Opus 4.8, not Haiku.** Haiku's vision caps near 1568px, so the previous
   150 DPI was already at its ceiling — more DPI wouldn't help because Haiku
   downscales. Opus 4.8 has high-resolution vision (up to 2576px) and can use the
   detail. Ingestion is one-time; accuracy on names/numbers is worth the higher
   per-page cost (~$0.05-0.08/page vs ~$0.02). Configurable via `OCR_MODEL`.
2. **Render at 220 DPI** (`OCR_DPI`) — ~2400px on a letter page, within Opus's 2576px
   window, so the model sees near-full detail without wasted over-rendering.
3. **Per-page legibility flag.** Each OCR'd page returns `clear | partial | poor` via
   structured output. Pages that aren't `clear` are tagged in the indexed text
   ("scanned, OCR may contain errors in names/numbers").
4. **Answers hedge on low-confidence sources.** The answer system prompt instructs the
   model to treat names/numbers from flagged pages as possibly misread, prefer values
   that agree across sources, and flag apparent discrepancies as "verify" rather than
   asserting them — so OCR noise no longer masquerades as a contract defect.

## Consequences

- Ingesting a scanned contract costs more (~$1.5-2.5 for a 25-page doc) and takes
  longer; acceptable for a one-time, accuracy-critical operation. The size cap and
  page cap still bound it.
- Legibility is the model's self-assessment, not ground truth; it reduces false
  confidence but does not eliminate OCR error. Citations to the source page remain
  the ultimate check.
- Prompt version bumped so the eval log distinguishes pre/post-fidelity answers.
