// Build-time: download the embedding model into the image cache so production has
// no runtime dependency on HuggingFace being reachable. Run by the Dockerfile.
import { pipeline, env } from "@huggingface/transformers";
import { LOCAL_MODEL } from "../src/rag/embeddings.ts";

env.cacheDir = process.env.TRANSFORMERS_CACHE;
console.log(`Prefetching ${LOCAL_MODEL} into ${env.cacheDir}…`);
await pipeline("feature-extraction", LOCAL_MODEL, { dtype: "fp32" });
console.log("Model cached.");
