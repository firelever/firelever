// Persistent per-tenant memory: user-confirmed facts and corrections ("the
// buyer entity is BDLP Enterprises, not BRLP"). Written when the user corrects
// Levi (remember action), injected into every answer path as authoritative
// over OCR'd document text. Survives restarts — it lives in kb.db.
import db from "./store.js";

db.exec(`
CREATE TABLE IF NOT EXISTS tenant_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function addMemory(tenantId: string, note: string): void {
  const n = note.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!n) return;
  // Skip an exact duplicate; corrections often get repeated.
  const dup = db
    .prepare(`SELECT id FROM tenant_memories WHERE tenant_id = ? AND note = ?`)
    .get(tenantId, n);
  if (dup) return;
  db.prepare(`INSERT INTO tenant_memories (tenant_id, note) VALUES (?, ?)`).run(tenantId, n);
}

export function listMemories(tenantId: string, limit = 30): string[] {
  return (
    db
      .prepare(`SELECT note FROM tenant_memories WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`)
      .all(tenantId, limit) as { note: string }[]
  ).map((r) => r.note);
}

// One block, appended to system prompts. Empty string when nothing remembered.
export function memoryBlock(tenantId: string): string {
  const notes = listMemories(tenantId);
  if (!notes.length) return "";
  return (
    " MEMORY — user-confirmed facts and corrections. These are authoritative and OVERRIDE anything the " +
    "documents or OCR text say when they conflict: " +
    notes.map((n) => `[${n}]`).join(" ")
  );
}
