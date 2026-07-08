# ADR-002: RAG storage, embeddings, and retrieval strategy

**Status:** Accepted 2026-07-07 · **Slice:** 2 · **Deciders:** Peter + Claude

## Context

Slice 2 needs document ingestion, per-tenant storage with embeddings, hybrid retrieval,
and an eval harness (PRD M2/M4/M5). Constraints: $100/mo ceiling, solo operator, repo
should be clone-and-run for portfolio review.

## Decisions

1. **Storage: SQLite for everything** — `kb.db` with sqlite-vec (vector KNN) + FTS5
   (keyword/BM25), separate from the growth pipeline's `leads.db`.
   - Zero infra, $0, offline, and a reviewer can run it with `npm install` alone.
   - Tenant isolation (M5): `tenant_id` on every row; the vec0 table uses sqlite-vec
     **partition keys**, so KNN physically scans only the requesting tenant's vectors
     (verified in v0.1.9) rather than filtering after search.
   - Rejected for now: pgvector on managed Postgres (right answer for the hosted
     product; adds signup/infra with zero current users — planned for slice 5 behind
     the same retrieval interface), and dedicated vector DBs (Pinecone/Qdrant: cost
    and operational surface unjustified at thousands of chunks).
2. **Embeddings: local on-device by default** (bge-small-en-v1.5 via transformers.js,
   384-dim, normalized; BGE query prefix applied at query time). Chosen by Peter
   2026-07-07: no signup, $0, offline. `Embedder` is an interface; Voyage AI
   (`voyage-3.5-lite`) is implemented behind `EMBEDDINGS_PROVIDER=voyage` +
   `VOYAGE_API_KEY` so the eval harness can compare providers empirically. One provider
   per kb.db (dim is baked into the vec table); switching requires re-ingestion, which
   the store enforces with a clear error.
3. **Hybrid retrieval via Reciprocal Rank Fusion (RRF).** Keyword (FTS5/BM25) and
   vector (cosine) lists merged by `score = Σ 1/(rrfK + rank)`. RRF needs no score
   normalization across incomparable scales and is the standard, hard-to-beat baseline.
   The textbook `rrfK=60` measurably hurt us: it flattens rank differences, so chunks
   that were mediocre in both lists outscored a #4 hit from a single retriever. A
   parameter sweep against the golden set chose **rrfK=5, fetchMult=4** (recall@5
   86.4%, MRR 0.714 vs 84.1%/0.694 at the default). Caveat: with 44 golden queries
   each flip is worth 2.3 points, so we picked the best-MRR cell with a mechanistic
   rationale rather than the noisy grid maximum; re-sweep when the golden set grows.
   Rejected: weighted score blending (requires tuning per corpus) and rerankers
   (quality win, but adds latency/cost; revisit with eval evidence in slice 3).
4. **Chunking: heading-aware markdown blocks, ~1,400 chars target, sentence-split for
   oversized blocks, heading breadcrumb prepended to each chunk.** The breadcrumb
   gives both retrievers section context and gives citations a human-readable anchor.

## Consequences

- Everything runs on a laptop; CI can run the full eval suite without secrets.
- SQLite is single-writer: fine solo, revisit at slice 5 (hosted, concurrent tenants).
- First run downloads the ~30MB embedding model to local cache.
- The retrieval golden set (evals/retrieval.jsonl) becomes the regression gate for any
  future change to chunking, embeddings, or fusion.
