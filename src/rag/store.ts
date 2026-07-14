// Knowledge-base storage: documents + chunks in SQLite, keyword index via FTS5,
// vectors via sqlite-vec. Separate DB from the growth pipeline's leads.db.
// Tenant isolation (PRD M5): tenant_id on every row; vec0 uses a partition key so
// KNN only scans the requesting tenant's vectors. See docs/adr/ADR-002.
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import { fileURLToPath } from "url";

// Default to the repo root locally; KB_DB_PATH points at the mounted volume in
// production (see fly.toml).
const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.KB_DB_PATH ?? path.join(here, "..", "..", "kb.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
sqliteVec.load(db);

db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  content_hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, path)
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  seq INTEGER NOT NULL,
  heading TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id');
`);

// Additive migration: document classification (ADR-019) — what a document IS
// and what it PERTAINS TO, tagged at ingest so "everything about Ute Street"
// is an exact lookup. ADD COLUMN throws if the column exists; that's fine.
for (const [col, type] of [
  ["doc_type", "TEXT"],
  ["topics", "TEXT"], // JSON array of properties/entities/deals
] as const) {
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN ${col} ${type}`);
  } catch {
    /* column already exists */
  }
}

export function getMeta(key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// One embedding provider per kb.db: the vector dimension is baked into the vec table.
export function ensureVecTable(provider: string, dim: number): void {
  const existing = getMeta("embedding_provider");
  if (existing && existing !== provider) {
    throw new Error(
      `kb.db was ingested with provider "${existing}" but "${provider}" is configured. ` +
        `Delete kb.db and re-ingest to switch providers.`
    );
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
       chunk_id integer primary key,
       tenant_id text partition key,
       embedding float[${dim}]
     )`
  );
  setMeta("embedding_provider", provider);
  setMeta("embedding_dim", String(dim));
}

export interface DocumentRow {
  id: number;
  tenant_id: string;
  path: string;
  title: string | null;
  content_hash: string;
  ingested_at: string;
}

export function findDocument(tenantId: string, docPath: string): DocumentRow | undefined {
  return db
    .prepare(`SELECT * FROM documents WHERE tenant_id = ? AND path = ?`)
    .get(tenantId, docPath) as DocumentRow | undefined;
}

// FTS5 content tables need the old text at delete time to unindex it.
export function deleteDocumentData(documentId: number): void {
  const rows = db
    .prepare(`SELECT id, text FROM chunks WHERE document_id = ?`)
    .all(documentId) as { id: number; text: string }[];
  const ftsDelete = db.prepare(
    `INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', ?, ?)`
  );
  const vecDelete = db.prepare(`DELETE FROM vec_chunks WHERE chunk_id = ?`);
  for (const r of rows) {
    ftsDelete.run(r.id, r.text);
    vecDelete.run(BigInt(r.id));
  }
  db.prepare(`DELETE FROM chunks WHERE document_id = ?`).run(documentId);
}

export interface ChunkInput {
  heading: string | null;
  text: string;
  embedding: Float32Array;
}

export const insertDocumentWithChunks = db.transaction(
  (
    tenantId: string,
    docPath: string,
    title: string | null,
    contentHash: string,
    chunks: ChunkInput[]
  ): number => {
    const existing = findDocument(tenantId, docPath);
    if (existing) {
      deleteDocumentData(existing.id);
      db.prepare(`DELETE FROM documents WHERE id = ?`).run(existing.id);
    }
    const docId = db
      .prepare(
        `INSERT INTO documents (tenant_id, path, title, content_hash) VALUES (?, ?, ?, ?)`
      )
      .run(tenantId, docPath, title, contentHash).lastInsertRowid as number;
    const insChunk = db.prepare(
      `INSERT INTO chunks (tenant_id, document_id, seq, heading, text) VALUES (?, ?, ?, ?, ?)`
    );
    const insFts = db.prepare(`INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)`);
    const insVec = db.prepare(
      `INSERT INTO vec_chunks (chunk_id, tenant_id, embedding) VALUES (?, ?, ?)`
    );
    chunks.forEach((c, seq) => {
      const chunkId = insChunk.run(tenantId, docId, seq, c.heading, c.text)
        .lastInsertRowid as number;
      insFts.run(chunkId, c.text);
      insVec.run(BigInt(chunkId), tenantId, Buffer.from(c.embedding.buffer));
    });
    return docId;
  }
);

export default db;
