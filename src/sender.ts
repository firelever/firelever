// Sending agent: delivers approved sequences via Gmail and manages follow-ups.
//
// Rules (run daily via `npm run send` or the launchd job):
//   - Only leads with status 'approved' or 'in_sequence' AND a recipient email are touched.
//   - Before sending anything to a lead, check the Gmail inbox for a reply from
//     that address. Reply found -> status 'replied', sequence stops permanently.
//   - Day 0 sends immediately; day 3 / day 7 send once that many days have
//     passed since day 0 and no reply has arrived. After day 7 -> 'sequence_done'.
//   - Hard daily send cap as a deliverability safety valve.
//
// Requires in .env: GMAIL_USER, GMAIL_APP_PASSWORD (Google Account -> Security ->
// 2-Step Verification -> App passwords). Also set EMAIL_FOOTER's postal address
// in config.ts first — the sender refuses to run with the placeholder in place.
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import db, { Lead } from "./db.js";
import { DAILY_SEND_CAP, EMAIL_FOOTER, GMAIL_APP_PASSWORD, GMAIL_USER, SEND_AS } from "./config.js";

interface SequenceEmail {
  day: number;
  subject: string;
  body: string;
}

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso + "Z").getTime()) / 86_400_000;
}

async function repliedSince(imap: ImapFlow, fromEmail: string, sinceIso: string): Promise<boolean> {
  const uids = await imap.search({ from: fromEmail, since: new Date(sinceIso + "Z") });
  return Array.isArray(uids) && uids.length > 0;
}

async function main() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("sender: GMAIL_USER / GMAIL_APP_PASSWORD not set in .env — nothing sent.");
    process.exit(1);
  }
  if (EMAIL_FOOTER.includes("SET YOUR BUSINESS MAILING ADDRESS")) {
    console.error("sender: fill in the postal address in EMAIL_FOOTER (src/config.ts) first — CAN-SPAM requires it. Nothing sent.");
    process.exit(1);
  }

  const leads = db
    .prepare(`SELECT * FROM leads WHERE status IN ('approved','in_sequence')`)
    .all() as Lead[];

  const actionable = leads.filter((l) => {
    const email = l.drafts_json ? JSON.parse(l.drafts_json).to_email : null;
    return typeof email === "string" && email.includes("@");
  });
  const skipped = leads.length - actionable.length;
  if (skipped > 0) console.log(`sender: ${skipped} lead(s) skipped (no recipient email set — use npm run set-email)`);
  if (actionable.length === 0) {
    console.log("sender: nothing to do.");
    return;
  }

  const smtp = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  const imap = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });
  await imap.connect();
  await imap.mailboxOpen("INBOX");

  let sentToday = 0;
  try {
    for (const lead of actionable) {
      if (sentToday >= DAILY_SEND_CAP) {
        console.log(`sender: daily cap of ${DAILY_SEND_CAP} reached, stopping.`);
        break;
      }
      const seq = JSON.parse(lead.drafts_json!) as { to_email: string; emails: SequenceEmail[] };
      const sent = db
        .prepare(`SELECT day, sent_at FROM sends WHERE lead_id = ? ORDER BY day`)
        .all(lead.id) as { day: number; sent_at: string }[];
      const firstSend = sent.find((s) => s.day === 0);

      // Reply check gates every step after day 0
      if (firstSend && (await repliedSince(imap, seq.to_email, firstSend.sent_at))) {
        db.prepare(`UPDATE leads SET status='replied', updated_at=datetime('now') WHERE id=?`).run(lead.id);
        console.log(`✉︎  ${lead.company}: REPLY received — sequence stopped. Draft a response!`);
        continue;
      }

      const next = seq.emails.find((e) => !sent.some((s) => s.day === e.day));
      if (!next) {
        db.prepare(`UPDATE leads SET status='sequence_done', updated_at=datetime('now') WHERE id=?`).run(lead.id);
        console.log(`   ${lead.company}: sequence complete, no reply.`);
        continue;
      }
      if (next.day > 0 && (!firstSend || daysSince(firstSend.sent_at) < next.day)) {
        console.log(`   ${lead.company}: day ${next.day} not due yet.`);
        continue;
      }

      await smtp.sendMail({
        from: `Peter at FireLever <${SEND_AS}>`,
        to: seq.to_email,
        subject: next.subject,
        text: `${next.body}\n\n${EMAIL_FOOTER}`,
      });
      db.prepare(`INSERT INTO sends (lead_id, day, to_email, subject) VALUES (?,?,?,?)`).run(
        lead.id, next.day, seq.to_email, next.subject
      );
      db.prepare(`UPDATE leads SET status='in_sequence', updated_at=datetime('now') WHERE id=?`).run(lead.id);
      sentToday++;
      console.log(`→  ${lead.company}: sent day-${next.day} email to ${seq.to_email}`);
    }
  } finally {
    await imap.logout();
  }
  console.log(`sender: done, ${sentToday} email(s) sent.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
