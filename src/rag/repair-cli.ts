// One-off repair for chunks ingested from PDFs with a corrupt text layer
// (broken font map dropped every lowercase "n" as a newline: "and" -> "a\nd",
// "Contract" -> "Co\ntract"). Restores the glyph, resyncs the external-content
// FTS index, and re-embeds the repaired chunks so vector search works again.
//   npm run repair -- <tenant-id> <doc-path-substring> [--dry]
import db from "./store.js";
import { getEmbedder } from "./embeddings.js";

const [tenant, docLike, flag] = process.argv.slice(2);
if (!tenant || !docLike) {
  console.error("Usage: npm run repair -- <tenant-id> <doc-path-substring> [--dry]");
  process.exit(1);
}
const dry = flag === "--dry";

// A newline BETWEEN two lowercase letters inside a word is the dropped "n";
// real line breaks in extracted PDFs land after spaces/punctuation/numbers.
const repair = (t: string) => t.replace(/([a-z])\n(?=[a-z])/g, "$1n");

const rows = db
  .prepare(
    `SELECT c.id, c.text FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.tenant_id = ? AND d.path LIKE ?`
  )
  .all(tenant, `%${docLike}%`) as { id: number; text: string }[];

const changed = rows.map((r) => ({ ...r, fixed: repair(r.text) })).filter((r) => r.fixed !== r.text);
console.log(`${rows.length} chunks in scope, ${changed.length} corrupted`);
if (changed.length) {
  const sample = changed[0];
  const i = sample.text.indexOf("\n", 40);
  console.log(`sample before: ${JSON.stringify(sample.text.slice(i - 20, i + 20))}`);
  console.log(`sample after:  ${JSON.stringify(sample.fixed.slice(i - 20, i + 20))}`);
}
if (dry || !changed.length) process.exit(0);

const run = async () => {
  const embedder = getEmbedder();
  const vectors = await embedder.embed(changed.map((c) => c.fixed), "doc");
  const ftsDel = db.prepare(`INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', ?, ?)`);
  const ftsIns = db.prepare(`INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)`);
  const upd = db.prepare(`UPDATE chunks SET text = ? WHERE id = ?`);
  const vecDel = db.prepare(`DELETE FROM vec_chunks WHERE chunk_id = ?`);
  const vecIns = db.prepare(`INSERT INTO vec_chunks (chunk_id, tenant_id, embedding) VALUES (?, ?, ?)`);
  const tx = db.transaction(() => {
    changed.forEach((c, i) => {
      ftsDel.run(c.id, c.text); // FTS delete needs the OLD text (external content)
      upd.run(c.fixed, c.id);
      ftsIns.run(c.id, c.fixed);
      vecDel.run(BigInt(c.id)); // vec0 requires integer-typed primary keys
      vecIns.run(BigInt(c.id), tenant, Buffer.from(vectors[i].buffer));
    });
  });
  tx();
  console.log(`repaired ${changed.length} chunks: text + FTS + embeddings`);
};
void run();
