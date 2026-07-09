# ADR-008: Adaptive retrieval — full-context, reranking, and agentic search

**Status:** Accepted 2026-07-09 · **Deciders:** Peter + Claude

## Context

Naive RAG (fixed top-k, retrieve once, answer) left a visible quality gap versus
pasting a document into Claude: on a 25-page contract, answers on a page that didn't
rank in top-k were refused even though the information was present. With 1M-token
context windows, the right architecture is adaptive, not "always retrieve."

## Decisions

Three modes, chosen automatically by corpus size (`answer()` routes):

1. **Full-context (small corpus).** When a tenant's whole corpus fits comfortably in
   context (< `FULL_CONTEXT_TOKENS`, default ~120K, estimated from stored chunk
   lengths), skip retrieval entirely and feed every chunk to Opus. Best possible
   quality — the model reads everything, like attaching the document to Claude. This
   is the path a single-contract customer hits, and it closes the "not as smart as
   Claude" gap for them directly.
2. **Reranking (large corpus RAG).** Over-fetch candidates via hybrid retrieval, then
   an LLM reranker (Haiku 4.5) re-scores them for relevance to the question and keeps
   the best. Cheap (one Haiku call), no new vendor/signup, and recovers the recall a
   fixed top-k loses. Rejected: a dedicated cross-encoder/rerank API (another
   signup/vendor; the LLM reranker is good enough and on-brand).
3. **Agentic search (large corpus).** For large corpora the model gets a
   `search_knowledge` tool (backed by reranked retrieval) and decides when and how
   many times to search before answering — retrieval-as-a-tool. Handles multi-part
   questions a single retrieval can't ("who are the seller's agents AND what's the
   price?"). Costs extra round-trips, so it's reserved for the large-corpus path, not
   the common small-doc case. This is the same "capability as a tool" idea as the MCP
   server (slice 1).

## Consequences

- The common case (one contract, an SOP set) gets full-context quality with no
  retrieval tuning to get wrong.
- Full-context pays for the whole corpus in tokens per query — fine under the size
  cap, which is exactly why the cap exists; above it, RAG's cost model takes over.
- Agentic search adds latency (multiple model turns); acceptable because it only runs
  when the corpus is too big for full-context anyway.
- Mode is overridable via `ANSWER_MODE` (full | rag | agentic) for testing and evals;
  the QA eval should run against each mode as the corpus grows.
