// Retrieval: keyword (FTS5/BM25), vector (sqlite-vec KNN), and hybrid via
// Reciprocal Rank Fusion (ADR-002). All paths are tenant-scoped.
import db from "./store.js";
import { Embedder } from "./embeddings.js";

export interface Hit {
  chunk_id: number;
  document_path: string;
  heading: string | null;
  text: string;
  score: number;
}

interface RankedId {
  chunk_id: number;
  rank: number; // 1-based
}

function hydrate(ids: { chunk_id: number; score: number }[]): Hit[] {
  const get = db.prepare(
    `SELECT c.id, c.heading, c.text, d.path FROM chunks c
     JOIN documents d ON d.id = c.document_id WHERE c.id = ?`
  );
  return ids.map(({ chunk_id, score }) => {
    const row = get.get(chunk_id) as { id: number; heading: string | null; text: string; path: string };
    return { chunk_id, document_path: row.path, heading: row.heading, text: row.text, score };
  });
}

// FTS5 MATCH has its own query syntax; quote each term and OR them so natural
// language questions don't need every word to hit (BM25 still ranks best overlap first).
function toFtsQuery(query: string): string | null {
  const terms = query.toLowerCase().match(/[a-z0-9]+/g);
  if (!terms?.length) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

export function keywordSearchIds(tenantId: string, query: string, k: number): RankedId[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ? AND c.tenant_id = ?
       ORDER BY bm25(chunks_fts) LIMIT ?`
    )
    .all(fts, tenantId, k) as { chunk_id: number }[];
  return rows.map((r, i) => ({ chunk_id: r.chunk_id, rank: i + 1 }));
}

export async function vectorSearchIds(
  tenantId: string,
  query: string,
  k: number,
  embedder: Embedder
): Promise<RankedId[]> {
  const [qvec] = await embedder.embed([query], "query");
  const rows = db
    .prepare(
      `SELECT chunk_id FROM vec_chunks
       WHERE embedding MATCH ? AND tenant_id = ? AND k = ?
       ORDER BY distance`
    )
    .all(Buffer.from(qvec.buffer), tenantId, k) as { chunk_id: number | bigint }[];
  return rows.map((r, i) => ({ chunk_id: Number(r.chunk_id), rank: i + 1 }));
}

// Fusion knobs, tuned against evals/retrieval.jsonl (see evals/history.jsonl).
// Smaller rrfK sharpens the reward for a top rank in either list, so a strong
// single-retriever hit isn't drowned by chunks that are mediocre in both.
export interface FusionOptions {
  rrfK: number;
  fetchMult: number; // over-fetch factor per list before fusing
}
export const DEFAULT_FUSION: FusionOptions = { rrfK: 5, fetchMult: 4 };

function rrfMerge(
  lists: RankedId[][],
  k: number,
  rrfK: number
): { chunk_id: number; score: number }[] {
  const scores = new Map<number, number>();
  for (const list of lists) {
    for (const { chunk_id, rank } of list) {
      scores.set(chunk_id, (scores.get(chunk_id) ?? 0) + 1 / (rrfK + rank));
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([chunk_id, score]) => ({ chunk_id, score }));
}

export async function search(
  tenantId: string,
  query: string,
  k: number,
  embedder: Embedder,
  method: "keyword" | "vector" | "hybrid" = "hybrid",
  fusion: FusionOptions = DEFAULT_FUSION
): Promise<Hit[]> {
  const fetchK = method === "hybrid" ? k * fusion.fetchMult : k;
  const lists: RankedId[][] = [];
  if (method !== "vector") lists.push(keywordSearchIds(tenantId, query, fetchK));
  if (method !== "keyword") lists.push(await vectorSearchIds(tenantId, query, fetchK, embedder));
  const merged = rrfMerge(lists, k, fusion.rrfK);
  return hydrate(merged);
}
