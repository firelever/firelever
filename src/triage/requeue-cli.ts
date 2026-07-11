// Requeue approved-but-never-sent drafted replies back to the Replies window.
// Exists for drafts approved before approve-sends-email shipped: their status
// says approved but nothing ever went out. Resetting to 'drafted' lets the
// user approve again, which now actually sends.
//   npm run requeue -- <match>   (matches sender or subject, case-insensitive)
//   npm run requeue -- --list    (show approved-but-unsent drafts)
import db from "../rag/store.js";

const arg = process.argv.slice(2).join(" ").trim();
if (!arg) {
  console.error("Usage: npm run requeue -- <sender-or-subject match> | --list");
  process.exit(1);
}

const unsent = db
  .prepare(
    `SELECT id, tenant_id, from_addr, subject, status FROM inbound_emails
     WHERE status = 'approved' AND draft_reply IS NOT NULL AND (sent_at IS NULL OR sent_at = '')`
  )
  .all() as { id: number; tenant_id: string; from_addr: string; subject: string; status: string }[];

if (arg === "--list") {
  if (!unsent.length) console.log("No approved-but-unsent drafts.");
  for (const e of unsent) console.log(`[${e.id}] ${e.tenant_id} | ${e.from_addr} | "${e.subject}"`);
  process.exit(0);
}

const needle = arg.toLowerCase();
const hits = unsent.filter((e) => (e.from_addr + " " + e.subject).toLowerCase().includes(needle));
if (!hits.length) {
  console.log(`No approved-but-unsent draft matches "${arg}".`);
  process.exit(1);
}
for (const e of hits) {
  db.prepare(`UPDATE inbound_emails SET status = 'drafted', updated_at = datetime('now') WHERE id = ?`).run(e.id);
  console.log(`Requeued [${e.id}] ${e.from_addr} | "${e.subject}" -> drafted (back in the Replies window)`);
}
