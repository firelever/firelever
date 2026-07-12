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
         AND status NOT IN ('archived', 'approved', 'archive_missing') AND message_id IS NOT NULL
       ORDER BY id DESC`
    )
    .all(tenantId, ...ARCHIVE_CATEGORIES) as CleanupItem[];
}

async function gmailClient() {
  const { ImapFlow } = await import("imapflow");
  return new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });
}

// Map every message currently in INBOX by Message-ID, in one fetch. Per-message
// IMAP HEADER searches proved unreliable against Gmail (empty results with no
// error), and a missed search once let the system mark mail "archived" that was
// still sitting in the inbox. Envelope matching removes that failure mode.
async function inboxUidsByMessageId(client: any): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for await (const m of client.fetch("1:*", { envelope: true, uid: true })) {
    if (m.envelope?.messageId) map.set(m.envelope.messageId, m.uid);
  }
  return map;
}

// Archive the given inbound_emails ids in Gmail by moving them out of INBOX.
// GROUND TRUTH RULE: status becomes 'archived' ONLY when the Gmail move actually
// happened. A message not in the inbox is reported as missing and marked
// 'archive_missing' — never silently claimed as archived. The returned counts
// are what Levi speaks, so they must be the truth.
export async function applyCleanup(
  tenantId: string,
  ids: number[]
): Promise<{ archived: number; missing: number }> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error("Gmail credentials not configured");
  if (ids.length === 0) return { archived: 0, missing: 0 };

  const rows = db
    .prepare(
      `SELECT id, message_id FROM inbound_emails
       WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(",")}) AND message_id IS NOT NULL`
    )
    .all(tenantId, ...ids) as { id: number; message_id: string }[];

  const client = await gmailClient();
  let archived = 0;
  let missing = 0;
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const inbox = await inboxUidsByMessageId(client);
    for (const r of rows) {
      const uid = inbox.get(r.message_id);
      if (uid === undefined) {
        missing++;
        db.prepare(`UPDATE inbound_emails SET status='archive_missing' WHERE id=?`).run(r.id);
        continue;
      }
      try {
        await client.messageMove(String(uid), "[Gmail]/All Mail", { uid: true });
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
  console.log(`[cleanup] archived=${archived} missing=${missing} of ${rows.length}`);
  return { archived, missing };
}

// Apply a real Gmail label for a category. Over IMAP, Gmail labels are
// mailboxes: copying a message into "FireLever/<label>" applies the label while
// the message stays in the inbox. Returns true only if the label landed.
export async function labelInGmail(tenantId: string, emailId: number, label: string): Promise<boolean> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return false;
  const row = db
    .prepare(`SELECT message_id FROM inbound_emails WHERE id = ? AND tenant_id = ? AND message_id IS NOT NULL`)
    .get(emailId, tenantId) as { message_id: string } | undefined;
  if (!row) return false;
  const client = await gmailClient();
  const mailbox = `FireLever/${label.replace(/[^a-z0-9_ -]/gi, "")}`;
  let ok = false;
  await client.connect();
  try {
    await client.mailboxCreate(mailbox).catch(() => {
      /* already exists */
    });
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uid = (await inboxUidsByMessageId(client)).get(row.message_id);
      if (uid !== undefined) {
        await client.messageCopy(String(uid), mailbox, { uid: true });
        ok = true;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  console.log(`[cleanup] label "${mailbox}" on email ${emailId}: ${ok ? "applied" : "not in inbox"}`);
  return ok;
}
