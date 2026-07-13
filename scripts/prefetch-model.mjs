// Build-time: download the embedding model into the image cache so production has
// no runtime dependency on HuggingFace being reachable. Run by the Dockerfile.
import fs from "fs";
import { pipeline, env } from "@huggingface/transformers";
import { LOCAL_MODEL } from "../src/rag/embeddings.ts";

env.cacheDir = process.env.TRANSFORMERS_CACHE;
// When the model already ships in the build context (HuggingFace 403s
// anonymous downloads as of 2026-07-13), validate strictly from the cache —
// a miss should fail the build loudly, never reach for the network.
if (fs.existsSync(`${env.cacheDir}/${LOCAL_MODEL}/onnx/model.onnx`)) {
  env.allowRemoteModels = false;
  console.log(`Validating cached ${LOCAL_MODEL} in ${env.cacheDir} (offline)…`);
} else {
  console.log(`Prefetching ${LOCAL_MODEL} into ${env.cacheDir}…`);
}
await pipeline("feature-extraction", LOCAL_MODEL, { dtype: "fp32" });
console.log("Model cached.");
