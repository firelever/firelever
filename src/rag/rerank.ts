// LLM reranker (ADR-008): re-score hybrid-retrieval candidates for relevance to
// the question with Haiku 4.5, keeping the best. One cheap call; recovers recall
// that a fixed top-k drops. Falls back to the original order on any parse failure.
import { z } from "zod";
import { extract } from "../llm.js";
import { Hit } from "./retrieval.js";

const RankSchema = z.object({
  ranked: z
    .array(z.number().int())
    .describe("candidate numbers, most relevant first; omit clearly irrelevant ones"),
});

export async function rerank(question: string, candidates: Hit[], topN: number): Promise<Hit[]> {
  if (candidates.length <= topN) return candidates;
  const list = candidates
    .map((h, i) => `[${i + 1}] ${h.document_path}${h.heading ? " › " + h.heading : ""}\n${h.text.slice(0, 300)}`)
    .join("\n\n");
  try {
    const { ranked } = await extract(
      RankSchema,
      "rerank",
      `Rank these candidate passages by how well they help answer the question. Return their numbers, most relevant first. Question: "${question}"`,
      list
    );
    const seen = new Set<number>();
    const ordered: Hit[] = [];
    for (const n of ranked) {
      const c = candidates[n - 1];
      if (c && !seen.has(n)) {
        seen.add(n);
        ordered.push(c);
      }
    }
    // Backfill any candidates the reranker omitted, preserving original order.
    for (let i = 0; i < candidates.length; i++) {
      if (!seen.has(i + 1)) ordered.push(candidates[i]);
    }
    return ordered.slice(0, topN);
  } catch {
    return candidates.slice(0, topN);
  }
}
