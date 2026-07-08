// Triage runner: ingest inbound email, classify, draft grounded replies.
//   npm run triage -- --demo                 # run on the synthetic golden set (no creds needed)
//   npm run triage -- --dir ./inbox-files    # plain-text email files (From:/Subject: headers, blank line, body)
//   npm run triage -- --imap                 # unseen messages from the Gmail inbox
// Then: npm run triage:review
import fs from "fs";
import path from "path";
import { classifyEmail, draftReply } from "./engine.js";
import { insertEmail, updateEmail } from "./store.js";

interface RawEmail {
  message_id: string;
  from_addr: string;
  subject: string;
  body: string;
  received_at: string | null;
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
  }));
}

async function fetchImapUnseen(): Promise<RawEmail[]> {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = await import("../config.js");
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error("IMAP mode needs GMAIL_USER and GMAIL_APP_PASSWORD in .env (see README)");
  }
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });
  const out: RawEmail[] = [];
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = await client.search({ seen: false });
    for (const uid of uids || []) {
      const msg = await client.fetchOne(String(uid), { envelope: true, source: true });
      if (!msg) continue;
      const source = msg.source?.toString() ?? "";
      // Plain-text extraction, good enough for triage: strip headers, prefer the
      // text/plain part when the message is multipart.
      const headerEnd = source.indexOf("\r\n\r\n");
      let body = headerEnd === -1 ? source : source.slice(headerEnd + 4);
      const plainMatch = body.match(
        /Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)(?:\r\n--|$)/i
      );
      if (plainMatch) body = plainMatch[1];
      out.push({
        message_id: msg.envelope?.messageId ?? `imap:${uid}`,
        from_addr: msg.envelope?.from?.[0]?.address ?? "unknown@unknown",
        subject: msg.envelope?.subject ?? "(no subject)",
        body: body.trim().slice(0, 8000),
        received_at: msg.envelope?.date?.toISOString() ?? null,
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
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

  let processed = 0;
  let skipped = 0;
  for (const e of emails) {
    const id = insertEmail({ tenant_id: tenantId, ...e });
    if (id === null) {
      skipped++; // already seen this message_id
      continue;
    }
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
    processed++;
  }
  console.log(`\nDone. processed=${processed} already_seen=${skipped}. Next: npm run triage:review`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
