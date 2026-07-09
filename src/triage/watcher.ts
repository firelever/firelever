// Live inbox watcher (ADR-011): a persistent IMAP IDLE connection to Gmail that
// triages new mail within seconds of arrival — no polling. Runs inside the server
// process when Gmail credentials are present. Reconnects on drop.
import { GMAIL_USER, GMAIL_APP_PASSWORD } from "../config.js";
import { processEmails, RawEmail } from "./run.js";

const HOST = "imap.gmail.com";

function toRawEmail(parsed: any, uid: number): RawEmail {
  const body =
    parsed.text?.trim() ||
    (parsed.html
      ? parsed.html
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "");
  return {
    message_id: parsed.messageId ?? `imap:${uid}`,
    from_addr: parsed.from?.value?.[0]?.address ?? "unknown@unknown",
    subject: parsed.subject ?? "(no subject)",
    body: body.slice(0, 8000),
    received_at: parsed.date?.toISOString() ?? null,
    attachments: (parsed.attachments ?? [])
      .filter((a: any) => a.filename)
      .map((a: any) => ({ filename: a.filename as string, content: a.content })),
  };
}

// Fetch and triage all currently-unseen messages. DB dedup (by message_id) makes
// re-processing already-handled mail a cheap no-op, so we don't mark mail as read
// (never touch the user's inbox state).
async function sweep(client: any, tenantId: string): Promise<void> {
  const { simpleParser } = await import("mailparser");
  const uids = await client.search({ seen: false }, { uid: true });
  if (!uids || uids.length === 0) return;
  const emails: RawEmail[] = [];
  for (const uid of uids) {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) continue;
    emails.push(toRawEmail(await simpleParser(msg.source), uid));
  }
  const { processed } = await processEmails(tenantId, emails);
  if (processed > 0) console.error(`[watcher] triaged ${processed} new email(s)`);
}

export async function startInboxWatcher(tenantId: string): Promise<void> {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("[watcher] no Gmail credentials set — live inbox watcher not started");
    return;
  }
  const { ImapFlow } = await import("imapflow");

  // Reconnect loop: an IDLE connection can drop (server timeout, network); we
  // rebuild it and re-sweep so nothing is missed across the gap.
  for (;;) {
    const client = new ImapFlow({
      host: HOST,
      port: 993,
      secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      logger: false,
    });
    client.on("error", (e: any) => console.error("[watcher] imap error:", e?.message ?? e));
    try {
      await client.connect();
      await client.mailboxOpen("INBOX");
      console.error(`[watcher] connected to ${GMAIL_USER}; watching for new mail`);
      await sweep(client, tenantId); // catch up on anything already unseen

      let busy = false;
      client.on("exists", async () => {
        if (busy) return;
        busy = true;
        try {
          await sweep(client, tenantId);
        } catch (e) {
          console.error("[watcher] sweep error:", e instanceof Error ? e.message : e);
        } finally {
          busy = false;
        }
      });

      // Block until the connection closes, then fall through to reconnect.
      await new Promise<void>((resolve) => client.on("close", () => resolve()));
      console.error("[watcher] connection closed; reconnecting in 5s");
    } catch (e) {
      console.error("[watcher] connect error:", e instanceof Error ? e.message : e);
      try {
        await client.logout();
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
