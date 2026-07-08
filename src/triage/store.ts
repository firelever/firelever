// Triage storage: inbound emails, classification, drafted replies, review status.
// Lives in kb.db (copilot product data), tenant-scoped like everything else there.
// Reviewer verdicts are logged permanently — they double as fine-tune training
// data for slice 6 (see ADR-004).
import db from "../rag/store.js";

db.exec(`
CREATE TABLE IF NOT EXISTS inbound_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  message_id TEXT,                 -- IMAP Message-ID when available
  from_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at TEXT,
  category TEXT,                   -- new_business | support | vendor_partner | recruiting | newsletter_spam | other
  needs_reply INTEGER,             -- 0/1
  urgency TEXT,                    -- low | normal | high
  triage_reasoning TEXT,
  draft_reply TEXT,
  draft_sources_json TEXT,         -- chunk ids the draft relied on (reviewer-facing)
  draft_confident INTEGER,         -- 0/1: drafter's own confidence flag
  status TEXT NOT NULL DEFAULT 'new',
    -- new -> triaged -> drafted -> approved | rejected | ignored; error = triage failed, retry manually
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, message_id)
);
`);

export interface InboundEmail {
  id: number;
  tenant_id: string;
  message_id: string | null;
  from_addr: string;
  subject: string;
  body: string;
  received_at: string | null;
  category: string | null;
  needs_reply: number | null;
  urgency: string | null;
  triage_reasoning: string | null;
  draft_reply: string | null;
  draft_sources_json: string | null;
  draft_confident: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export function insertEmail(e: {
  tenant_id: string;
  message_id: string | null;
  from_addr: string;
  subject: string;
  body: string;
  received_at: string | null;
}): number | null {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO inbound_emails (tenant_id, message_id, from_addr, subject, body, received_at)
       VALUES (@tenant_id, @message_id, @from_addr, @subject, @body, @received_at)`
    )
    .run(e);
  return result.changes > 0 ? (result.lastInsertRowid as number) : null;
}

export function updateEmail(id: number, fields: Partial<InboundEmail>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(
    `UPDATE inbound_emails SET ${sets}, updated_at = datetime('now') WHERE id = @id`
  ).run({ ...fields, id });
}

export function emailsByStatus(tenantId: string, status: string): InboundEmail[] {
  return db
    .prepare(
      `SELECT * FROM inbound_emails WHERE tenant_id = ? AND status = ? ORDER BY id`
    )
    .all(tenantId, status) as InboundEmail[];
}
