# ADR-007: OCR for scanned PDFs via rasterize + vision transcription

**Status:** Accepted 2026-07-08 · **Deciders:** Peter + Claude

## Context

The ICP (law firms, real estate, freight) lives on scanned PDFs — contracts,
signed agreements, deal packages. These have no text layer, so pdf-parse extracts
nothing and the copilot can only refuse. OCR closes the gap between "documents"
and "the documents customers actually have."

## Decisions

1. **Trigger OCR only as a fallback.** Text-layer extraction (pdf-parse) runs first;
   OCR fires only when the result is sparse (< 100 chars/page average). Native text
   PDFs stay fast and free; scans get the expensive path. No wasted vision calls on
   documents that already have text.
2. **Rasterize with mupdf (WASM), not a system binary.** mupdf renders pages to PNG
   in pure Node — works identically on the dev Mac and in the Docker image with no
   `apt`/`brew` dependency (poppler/tesseract would need both). ~150 DPI is enough
   for transcription without bloating tokens.
3. **Transcribe with Claude vision on Haiku 4.5, not Tesseract.** Haiku reads messy
   scans, handwriting, and tables far better than Tesseract, needs no model files or
   native deps, and is cheap (~$0.01-0.03/page) — transcription doesn't need Opus.
   One image per page, concatenated. Rejected: Tesseract (lower quality on real
   scans, native dep), cloud OCR APIs (another signup/vendor).
4. **Hard page cap with a logged warning.** OCR caps at `OCR_MAX_PAGES` (default 30);
   beyond that it transcribes the first N and logs what it skipped. No silent
   truncation — a partially-OCR'd doc says so.
5. **Still in-request for now.** At design-partner volume a multi-page OCR upload
   taking tens of seconds is acceptable. Moving ingestion to a queue is already the
   documented next step (ADR-005) and becomes necessary if a partner bulk-uploads
   scans.

## Consequences

- A 30-page scanned contract costs ~$0.30-0.90 to ingest once and is then free to
  query. Reasonable, but the per-page cost means OCR is metered by the page cap, not
  unbounded.
- Upload latency for scanned PDFs jumps from ~1s to tens of seconds; the UI shows an
  indexing spinner, but a very large scan could approach client timeouts — the queue
  migration is the real fix.
- Handwriting and stamps transcribe imperfectly; the citation still points at the
  source page so a human can verify, consistent with the grounding contract.
