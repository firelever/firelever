// Retrieval eval harness (PRD M4, eval plan in docs/03).
//   npm run eval            — run golden set, print metrics, record history
// A query counts as a hit if a top-5 chunk contains `must_contain` (and comes from
// `doc` when specified). Reports keyword-only (the baseline to beat), vector-only,
// and hybrid. Exits 1 if hybrid recall@5 regresses vs the last recorded run.
import fs from "fs";
import path from "path";
import { getEmbedder } from "./embeddings.js";
import { search } from "./retrieval.js";
import { getMeta } from "./store.js";

const K = 5;
const TARGET_RECALL = 0.85;
const TENANT = process.env.EVAL_TENANT ?? "firelever";
const EVALS_DIR = path.join(process.cwd(), "evals");
const GOLDEN = path.join(EVALS_DIR, "retrieval.jsonl");
const HISTORY = path.join(EVALS_DIR, "history.jsonl");

interface GoldenEntry {
  query: string;
  must_contain: string;
  doc?: string;
}

const METHODS = ["keyword", "vector", "hybrid"] as const;

async function main() {
  const golden: GoldenEntry[] = fs
    .readFileSync(GOLDEN, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const embedder = getEmbedder();

  const results: Record<string, { recall: number; mrr: number; misses: string[] }> = {};
  for (const method of METHODS) {
    let hits = 0;
    let mrrSum = 0;
    const misses: string[] = [];
    for (const g of golden) {
      const found = await search(TENANT, g.query, K, embedder, method);
      // Collapse whitespace on both sides: source markdown soft-wraps lines, so a
      // golden phrase may span a "word\n  word" break inside a chunk.
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
      const needle = norm(g.must_contain);
      const rank = found.findIndex(
        (h) => norm(h.text).includes(needle) && (!g.doc || h.document_path.endsWith(g.doc))
      );
      if (rank >= 0) {
        hits++;
        mrrSum += 1 / (rank + 1);
      } else {
        misses.push(g.query);
      }
    }
    results[method] = {
      recall: hits / golden.length,
      mrr: mrrSum / golden.length,
      misses,
    };
  }

  console.log(`\nRetrieval eval — ${golden.length} queries, k=${K}, tenant=${TENANT}, provider=${getMeta("embedding_provider")}\n`);
  console.log(`method    recall@${K}   MRR`);
  for (const m of METHODS) {
    const r = results[m];
    console.log(`${m.padEnd(9)} ${(r.recall * 100).toFixed(1).padStart(6)}%   ${r.mrr.toFixed(3)}`);
  }
  if (results.hybrid.misses.length) {
    console.log(`\nHybrid misses (${results.hybrid.misses.length}):`);
    results.hybrid.misses.forEach((q) => console.log(`  - ${q}`));
  }

  const target = results.hybrid.recall >= TARGET_RECALL;
  console.log(`\nTarget recall@${K} ≥ ${TARGET_RECALL * 100}%: ${target ? "PASS" : "FAIL"}`);

  // Regression gate against last recorded run (same provider only).
  let previous: number | undefined;
  if (fs.existsSync(HISTORY)) {
    const runs = fs
      .readFileSync(HISTORY, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter((r) => r.provider === getMeta("embedding_provider"));
    previous = runs.at(-1)?.hybrid_recall;
  }
  fs.appendFileSync(
    HISTORY,
    JSON.stringify({
      at: new Date().toISOString(),
      provider: getMeta("embedding_provider"),
      queries: golden.length,
      k: K,
      keyword_recall: results.keyword.recall,
      vector_recall: results.vector.recall,
      hybrid_recall: results.hybrid.recall,
      hybrid_mrr: results.hybrid.mrr,
    }) + "\n"
  );

  if (previous !== undefined && results.hybrid.recall < previous) {
    console.error(
      `REGRESSION: hybrid recall@${K} ${(results.hybrid.recall * 100).toFixed(1)}% < previous ${(previous * 100).toFixed(1)}%`
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
