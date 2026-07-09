// Shared single-file ingestion: extract → chunk → embed → store. Used by the
// CLI (ingest.ts) and the upload API (server).
import crypto from "crypto";
import { extractText } from "./extract.js";
import { chunkText, CHUNKER_VERSION } from "./chunker.js";
import { getEmbedder } from "./embeddings.js";
import { ensureVecTable, findDocument, insertDocumentWithChunks } from "./store.js";
import path from "path";

export type IngestResult =
  | { outcome: "ingested"; chunks: number; title: string }
  | { outcome: "unchanged" }
  | { outcome: "empty" };

export interface IngestOptions {
  // Prepended before chunking so provenance rides with the document — e.g. an
  // email-received header travels into every chunk and answers "who sent this?".
  preamble?: string;
}

export async function ingestFile(
  tenantId: string,
  filePath: string,
  displayPath: string,
  opts: IngestOptions = {}
): Promise<IngestResult> {
  const embedder = getEmbedder();
  ensureVecTable(embedder.name, embedder.dim);

  const extracted = await extractText(filePath);
  const title = extracted.title;
  const text = opts.preamble ? `${opts.preamble}\n\n${extracted.text}` : extracted.text;
  const hash = crypto
    .createHash("sha256")
    .update(`${CHUNKER_VERSION}:${embedder.name}:${text}`)
    .digest("hex");
  if (findDocument(tenantId, displayPath)?.content_hash === hash) {
    return { outcome: "unchanged" };
  }
  const chunks = chunkText(text, path.basename(displayPath));
  if (!chunks.length) return { outcome: "empty" };

  const embeddings = await embedder.embed(
    chunks.map((c) => c.text),
    "doc"
  );
  insertDocumentWithChunks(
    tenantId,
    displayPath,
    title,
    hash,
    chunks.map((c, i) => ({ ...c, embedding: embeddings[i] }))
  );
  return { outcome: "ingested", chunks: chunks.length, title };
}
