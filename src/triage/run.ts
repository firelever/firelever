// Triage runner: ingest inbound email, classify, draft grounded replies.
//   npm run triage -- --demo                 # run on the synthetic golden set (no creds needed)
//   npm run triage -- --dir ./inbox-files    # plain-text email files (From:/Subject: headers, blank line, body)
//   npm run triage -- --imap                 # unseen messages from the Gmail inbox
// Then: npm run triage:review
import fs from "fs";
import os from "os";
import path from "path";
import { classifyEmail, draftReply } from "./engine.js";
import { insertEmail, updateEmail } from "./store.js";
import { ingestFile } from "../rag/ingest-file.js";
import { SUPPORTED } from "../rag/extract.js";

export interface Attachment {
  filename: string;
  content: Buffer;
}

export interface RawEmail {
  message_id: string;
  from_addr: string;
  subject: string;
  body: string;
  received_at: string | null;
  attachments: Attachment[];
}

// Documents arrive attached to all kinds of mail — the user forwarding a
// settlement statement to their own inbox classifies as "other", and gating
// on business categories silently skipped it (live miss, 2026-07-13). Only
// bulk/spam senders are excluded, so marketing PDFs don't pollute the KB.
const ATTACH_SKIP_CATEGORIES = new Set(["newsletter_spam"]);
const ATTACH_MAX_BYTES = 30 * 1024 * 1024;

// Ingest an email's document attachments into the knowledge base, tagged with
// provenance (who sent it, when, about what) so the copilot can answer
// "who sent us the contract?" as well as what's inside it.
async function ingestAttachments(
  tenantId: string,
  email: RawEmail,
  category: string
): Promise<string[]> {
  if (ATTACH_SKIP_CATEGORIES.has(category) || email.attachments.length === 0) return [];
  const domain = email.from_addr.split("@")[1] ?? "unknown";
  const preamble =
    `[Received via email]\n` +
    `From: ${email.from_addr}\n` +
    `Subject: ${email.subject}\n` +
    `Date: ${email.received_at ?? "unknown"}\n` +
    `Email note: ${email.body.slice(0, 300)}`;
  const added: string[] = [];
  for (const att of email.attachments) {
    const name = path.basename(att.filename || "attachment");
    const ext = path.extname(name).toLowerCase();
    if (!SUPPORTED.includes(ext) || att.content.length > ATTACH_MAX_BYTES) continue;
    const tmp = path.join(os.tmpdir(), `flv-att-${Date.now()}-${name}`);
    fs.writeFileSync(tmp, att.content);
    try {
      const r = await ingestFile(tenantId, tmp, `email/${domain}/${name}`, { preamble });
      if (r.outcome === "ingested" || r.outcome === "unchanged") added.push(name);
    } catch (e) {
      console.error(`    attachment failed (${name}): ${e instanceof Error ? e.message : e}`);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
  return added;
}

function parseEmailFile(filePath: string): RawEmail {
  const raw = fs.readFileSync(filePath, "utf8");
  const headerEnd = raw.indexOf("\n\n");
  const headers = raw.slice(0, headerEnd === -1 ? 0 : headerEnd);
  const body = headerEnd === -1 ? raw : raw.slice(headerEnd + 2);
  const get = (name: string) =>
    headers.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? "";
  return {
    message_id: `file:${path.basename(filePath)}`,
    from_addr: get("From") || "unknown@unknown",
    subject: get("Subject") || "(no subject)",
    body: body.trim(),
    received_at: null,
    attachments: [],
  };
}

function loadDemoEmails(): RawEmail[] {
  const golden = fs
    .readFileSync(path.join(process.cwd(), "evals", "triage.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return golden.slice(0, 5).map((g: any, i: number) => ({
    message_id: `demo:${i}`,
    from_addr: g.from,
    subject: g.subject,
    body: g.body,
    received_at: null,
    attachments: [],
  }));
}

export async function fetchImapUnseen(): Promise<RawEmail[]> {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = await import("../config.js");
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error("IMAP mode needs GMAIL_USER and GMAIL_APP_PASSWORD in .env (see README)");
  }
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });
  client.on("error", (e: any) => console.error("[triage] imap error:", e?.message ?? e));
  const out: RawEmail[] = [];
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = await client.search({ seen: false });
    for (const uid of uids || []) {
      const msg = await client.fetchOne(String(uid), { source: true });
      if (!msg || !msg.source) continue;
      // Real MIME parsing: handles multipart, base64/quoted-printable transfer
      // encodings, and HTML-only messages.
      const parsed = await simpleParser(msg.source);
      const body =
        parsed.text?.trim() ||
        (parsed.html ? parsed.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
      out.push({
        message_id: parsed.messageId ?? `imap:${uid}`,
        from_addr: parsed.from?.value?.[0]?.address ?? "unknown@unknown",
        subject: parsed.subject ?? "(no subject)",
        body: body.slice(0, 8000),
        received_at: parsed.date?.toISOString() ?? null,
        attachments: (parsed.attachments ?? [])
          .filter((a) => a.filename)
          .map((a) => ({ filename: a.filename as string, content: a.content })),
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

// Backfill: re-fetch recent already-triaged emails from Gmail and ingest any
// document attachments that were skipped (by the old category gate, an
// outage, or a crash mid-triage). Runs once at server boot; attachments_json
// doubles as the "scanned" marker so each email is fetched at most once.
export async function backfillAttachments(tenantId: string): Promise<number> {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = await import("../config.js");
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return 0;
  const db = (await import("../rag/store.js")).default;
  const rows = db
    .prepare(
      `SELECT id, message_id, category FROM inbound_emails
       WHERE tenant_id = ? AND message_id IS NOT NULL AND attachments_json IS NULL
         AND COALESCE(category, 'other') NOT IN ('newsletter_spam')
       ORDER BY id DESC LIMIT 40`
    )
    .all(tenantId) as { id: number; message_id: string; category: string | null }[];
  if (!rows.length) return 0;

  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });
  // An ImapFlow 'error' event with no listener crashes the whole Node
  // process (took the server down on 2026-07-13); never leave one unhandled.
  client.on("error", (e: any) => console.error("[backfill] imap error:", e?.message ?? e));
  let ingested = 0;
  await client.connect();
  // All Mail sees archived messages too; map the recent tail by Message-ID.
  const lock = await client.getMailboxLock("[Gmail]/All Mail");
  try {
    const st = await client.status("[Gmail]/All Mail", { messages: true });
    const from = Math.max(1, (st.messages ?? 1) - 300);
    const byMid = new Map<string, number>();
    for await (const m of client.fetch(`${from}:*`, { envelope: true, uid: true })) {
      if (m.envelope?.messageId) byMid.set(m.envelope.messageId, m.uid);
    }
    for (const r of rows) {
      const uid = byMid.get(r.message_id);
      if (uid === undefined) continue; // older than the tail; next boot won't retry it forever
      try {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const raw: RawEmail = {
          message_id: r.message_id,
          from_addr: parsed.from?.value?.[0]?.address ?? "unknown@unknown",
          subject: parsed.subject ?? "(no subject)",
          body: (parsed.text ?? "").slice(0, 8000),
          received_at: parsed.date?.toISOString() ?? null,
          attachments: (parsed.attachments ?? [])
            .filter((a) => a.filename)
            .map((a) => ({ filename: a.filename as string, content: a.content })),
        };
        const added = await ingestAttachments(tenantId, raw, r.category ?? "other");
        updateEmail(r.id, { attachments_ingested: added.length, attachments_json: JSON.stringify(added) });
        if (added.length) {
          ingested += added.length;
          console.log(`[backfill] ${added.length} attachment(s) from "${raw.subject.slice(0, 50)}": ${added.join(", ")}`);
        }
      } catch (e) {
        console.error(`[backfill] email ${r.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  if (ingested) console.log(`[backfill] done: ${ingested} attachment(s) added to the knowledge base`);
  return ingested;
}

// Process a batch of emails: dedup-insert, classify, draft, ingest attachments.
// Shared by the CLI (main) and the live inbox watcher (watcher.ts).
export async function processEmails(
  tenantId: string,
  emails: RawEmail[]
): Promise<{ processed: number; skipped: number }> {
  let processed = 0;
  let skipped = 0;
  for (const e of emails) {
    const id = insertEmail({ tenant_id: tenantId, ...e });
    if (id === null) {
      skipped++; // already seen this message_id
      continue;
    }
    // One bad email must not kill the run: mark it and move on. 'error' rows
    // stay visible in the DB for diagnosis and manual retry.
    try {
      const c = await classifyEmail(e.from_addr, e.subject, e.body);
      updateEmail(id, {
        category: c.category,
        needs_reply: c.needs_reply ? 1 : 0,
        urgency: c.urgency,
        triage_reasoning: c.reasoning,
        status: "triaged",
      });
      console.log(`  ${c.category.padEnd(15)} ${c.urgency.padEnd(6)} reply=${c.needs_reply}  ${e.subject}`);

      if (c.needs_reply && c.category !== "newsletter_spam") {
        const d = await draftReply(tenantId, e.from_addr, e.subject, e.body, c);
        updateEmail(id, {
          draft_reply: d.reply,
          draft_sources_json: JSON.stringify(
            d.used_sources.map((n) => d.sources[n - 1]?.document_path).filter(Boolean)
          ),
          draft_confident: d.confident ? 1 : 0,
          status: "drafted",
        });
      }

      // Pull document attachments into the knowledge base, with provenance.
      const added = await ingestAttachments(tenantId, e, c.category);
      if (added.length) {
        updateEmail(id, {
          attachments_ingested: added.length,
          attachments_json: JSON.stringify(added),
        });
        console.log(`    + ${added.length} attachment(s) added to knowledge base: ${added.join(", ")}`);
      }
      processed++;
    } catch (err) {
      updateEmail(id, { status: "error" });
      console.error(`  ERROR          ${e.subject}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { processed, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : (args[i + 1] ?? true);
  };
  const tenantId = (flag("--tenant") as string) ?? "firelever";

  let emails: RawEmail[];
  if (args.includes("--demo")) {
    emails = loadDemoEmails();
  } else if (flag("--dir")) {
    const dir = flag("--dir") as string;
    emails = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".txt") || f.endsWith(".eml"))
      .map((f) => parseEmailFile(path.join(dir, f)));
  } else if (args.includes("--imap")) {
    emails = await fetchImapUnseen();
  } else {
    console.error("Usage: npm run triage -- --demo | --dir <path> | --imap  [--tenant <id>]");
    process.exit(1);
  }

  const { processed, skipped } = await processEmails(tenantId, emails);
  console.log(`\nDone. processed=${processed} already_seen=${skipped}. Next: npm run triage:review`);
}

// Only run the CLI when invoked directly, not when imported by the watcher.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
