// Pluggable embedding providers (ADR-002). Default: local on-device bge-small,
// no API key needed. Set EMBEDDINGS_PROVIDER=voyage + VOYAGE_API_KEY to compare.
export interface Embedder {
  name: string;
  dim: number;
  embed(texts: string[], kind: "doc" | "query"): Promise<Float32Array[]>;
}

// BGE models want this prefix on queries (not documents) for retrieval tasks.
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export const LOCAL_MODEL = "Xenova/bge-small-en-v1.5";

function localEmbedder(): Embedder {
  let extractorPromise: Promise<any> | null = null;
  const getExtractor = () => {
    extractorPromise ??= import("@huggingface/transformers").then(({ pipeline, env }) => {
      // TRANSFORMERS_CACHE points at the model baked into the image in production
      // (see Dockerfile); locally it's unset and the library uses its default cache.
      if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE;
      return pipeline("feature-extraction", LOCAL_MODEL, { dtype: "fp32" });
    });
    return extractorPromise;
  };
  return {
    name: "local-bge-small-en-v1.5",
    dim: 384,
    async embed(texts, kind) {
      const extractor = await getExtractor();
      const inputs = kind === "query" ? texts.map((t) => BGE_QUERY_PREFIX + t) : texts;
      const out: Float32Array[] = [];
      const BATCH = 16;
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const tensor = await extractor(batch, { pooling: "mean", normalize: true });
        const [rows, dim] = tensor.dims as [number, number];
        for (let r = 0; r < rows; r++) {
          out.push(new Float32Array(tensor.data.slice(r * dim, (r + 1) * dim)));
        }
      }
      return out;
    },
  };
}

function voyageEmbedder(): Embedder {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("EMBEDDINGS_PROVIDER=voyage requires VOYAGE_API_KEY");
  return {
    name: "voyage-3.5-lite",
    dim: 1024,
    async embed(texts, kind) {
      const out: Float32Array[] = [];
      const BATCH = 128;
      for (let i = 0; i < texts.length; i += BATCH) {
        const res = await fetch("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "voyage-3.5-lite",
            input: texts.slice(i, i + BATCH),
            input_type: kind === "query" ? "query" : "document",
          }),
        });
        if (!res.ok) throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
        const data = (await res.json()) as { data: { embedding: number[] }[] };
        for (const d of data.data) out.push(Float32Array.from(d.embedding));
      }
      return out;
    },
  };
}

export function getEmbedder(): Embedder {
  const provider = process.env.EMBEDDINGS_PROVIDER ?? "local";
  if (provider === "voyage") return voyageEmbedder();
  if (provider === "local") return localEmbedder();
  throw new Error(`Unknown EMBEDDINGS_PROVIDER "${provider}" (expected local | voyage)`);
}
