// Durable conversation history (ADR-017). Every voice turn lands here, so
// past conversations survive the session and can later be embedded into the
// existing vector store for semantic recall ("what did we decide about
// Midwest Freight?"). Exact identifiers (addresses, names) do NOT live here —
// they belong to tenant_contacts, where matching is exact, not similar.
import db from "../rag/store.js";

db.exec(`
CREATE TABLE IF NOT EXISTS voice_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  question TEXT NOT NULL,
  reply TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function logTurn(tenantId: string, question: string, reply: string): void {
  const q = question.trim().slice(0, 2000);
  const r = reply.trim().slice(0, 4000);
  if (!q || !r) return;
  // The voice pipeline delivers turns at-least-once; don't log the replay.
  const dup = db
    .prepare(`SELECT id FROM voice_turns WHERE tenant_id = ? AND question = ? AND at > datetime('now', '-15 seconds')`)
    .get(tenantId, q);
  if (dup) return;
  db.prepare(`INSERT INTO voice_turns (tenant_id, question, reply) VALUES (?, ?, ?)`).run(tenantId, q, r);
}
