// Send an approved drafted reply via Gmail SMTP (same creds as the watcher).
// Human approval is the guardrail: this is only ever called from the verdict
// endpoint after the user clicks Approve — nothing sends autonomously (BRD).
import nodemailer from "nodemailer";
import { GMAIL_APP_PASSWORD, GMAIL_USER, SEND_AS } from "../config.js";

export function replySendingConfigured(): boolean {
  return !!GMAIL_USER && !!GMAIL_APP_PASSWORD;
}

export async function sendReply(email: {
  from_addr: string;
  subject: string;
  draft_reply: string;
  message_id?: string | null;
}): Promise<void> {
  if (!replySendingConfigured()) throw new Error("Gmail credentials not configured");
  const smtp = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  await smtp.sendMail({
    from: `Peter at FireLever <${SEND_AS}>`,
    to: email.from_addr,
    subject: /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`,
    text: email.draft_reply,
    // Thread the reply under the original message when we know its ID.
    inReplyTo: email.message_id ?? undefined,
    references: email.message_id ?? undefined,
  });
}
