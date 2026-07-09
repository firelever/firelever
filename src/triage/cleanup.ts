// Inbox cleanup (ADR-012): propose archivable email, then archive on approval.
// SCOPE: archive only (move out of INBOX to Gmail All Mail) — fully reversible,
// never deletes. Two steps so nothing happens without the user approving.
import db from "../rag/store.js";
import { GMAIL_USER, GMAIL_APP_PASSWORD } from "../config.js";

// What we propose to archive: classified noise that needs no reply and hasn't been
// handled or archived already. Deliberately conservative — spam and no-reply "other".
const ARCHIVE_CATEGORIES = ["newsletter_spam"];

export interface CleanupItem {
  id: number;
  from_addr: string;
  subject: string;
  category: string;
}

export function previewCleanup(tenantId: string): CleanupItem[] {
  const placeholders = ARCHIVE_CATEGORIES.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, from_addr, subject, category FROM inbound_emails
       WHERE tenant_id = ? AND category IN (${placeholders})
         AND status NOT IN ('archived', 'approved') AND message_id IS NOT NULL
       ORDER BY id DESC`
    )
    .all(tenantId, ...ARCHIVE_CATEGORIES) as CleanupItem[];
}

// Archive the given inbound_emails ids in Gmail by moving them out of INBOX.
// Returns how many were archived. Skips any not found in the live inbox.
export async function applyCleanup(tenantId: string, ids: number[]): Promise<{ archived: number }> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error("Gmail credentials not configured");
  if (ids.length === 0) return { archived: 0 };

  const rows = db
    .prepare(
      `SELECT id, message_id FROM inbound_emails
       WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(",")}) AND message_id IS NOT NULL`
    )
    .all(tenantId, ...ids) as { id: number; message_id: string }[];

  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });
  let archived = 0;
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    for (const r of rows) {
      // Find the live message by its Message-ID, then move it to All Mail (archive).
      const found = await client.search({ header: { "message-id": r.message_id } }, { uid: true });
      if (!found || found.length === 0) {
        // Not in the inbox anymore (already archived/deleted); mark handled locally.
        db.prepare(`UPDATE inbound_emails SET status='archived' WHERE id=?`).run(r.id);
        continue;
      }
      try {
        await client.messageMove(found, "[Gmail]/All Mail", { uid: true });
        db.prepare(`UPDATE inbound_emails SET status='archived' WHERE id=?`).run(r.id);
        archived++;
      } catch {
        // leave status unchanged so it can be retried
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return { archived };
}
