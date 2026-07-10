// Workspace store (Levi L5): per-tenant tasks, schedule events, and notes.
// Simple persisted CRUD in kb.db — the real backing for the Tasks/Schedule/Notes
// windows (no external calendar/task integrations; this is first-party state).
import db from "../rag/store.js";

db.exec(`
CREATE TABLE IF NOT EXISTS workspace_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- task | event | note
  title TEXT NOT NULL,
  body TEXT,                     -- note body, or event location/detail
  done INTEGER NOT NULL DEFAULT 0,
  at TEXT,                       -- event time (ISO or "HH:MM"), null for tasks/notes
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ws_tenant_kind ON workspace_items(tenant_id, kind);
`);

export interface WorkspaceItem {
  id: number;
  tenant_id: string;
  kind: "task" | "event" | "note";
  title: string;
  body: string | null;
  done: number;
  at: string | null;
  created_at: string;
}

export function listItems(tenantId: string, kind: string): WorkspaceItem[] {
  return db
    .prepare(
      `SELECT * FROM workspace_items WHERE tenant_id = ? AND kind = ?
       ORDER BY CASE WHEN at IS NULL THEN 1 ELSE 0 END, at, id`
    )
    .all(tenantId, kind) as WorkspaceItem[];
}

export function createItem(
  tenantId: string,
  kind: string,
  title: string,
  body?: string,
  at?: string
): WorkspaceItem {
  const id = db
    .prepare(`INSERT INTO workspace_items (tenant_id, kind, title, body, at) VALUES (?, ?, ?, ?, ?)`)
    .run(tenantId, kind, title, body ?? null, at ?? null).lastInsertRowid as number;
  return db.prepare(`SELECT * FROM workspace_items WHERE id = ?`).get(id) as WorkspaceItem;
}

export function updateItem(
  tenantId: string,
  id: number,
  fields: Partial<Pick<WorkspaceItem, "title" | "body" | "done" | "at">>
): boolean {
  const keys = Object.keys(fields);
  if (keys.length === 0) return false;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  const res = db
    .prepare(`UPDATE workspace_items SET ${sets} WHERE id = @id AND tenant_id = @tenant`)
    .run({ ...fields, id, tenant: tenantId });
  return res.changes > 0;
}

export function deleteItem(tenantId: string, id: number): boolean {
  return db.prepare(`DELETE FROM workspace_items WHERE id = ? AND tenant_id = ?`).run(id, tenantId).changes > 0;
}
