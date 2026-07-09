// Ask-about-your-inbox (ADR-012): route a chat question to documents or the
// classified inbox, and answer inbox questions from the inbound_emails table.
// Read-only — never touches Gmail.
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, withDeadline, extract } from "../llm.js";
import { MODEL } from "../config.js";
import db from "./store.js";
import { GroundedAnswer } from "./answer.js";

const IntentSchema = z.object({
  target: z
    .enum(["documents", "inbox"])
    .describe(
      "inbox = about emails received, senders, what needs a reply, inbox cleanup; documents = about uploaded files, contracts, policies"
    ),
});

// One cheap Haiku call; defaults to documents (existing behavior) on any doubt.
export async function classifyIntent(question: string): Promise<"documents" | "inbox"> {
  try {
    const r = await extract(
      IntentSchema,
      "ask-intent",
      "Is this question about the user's email INBOX or about their uploaded DOCUMENTS?",
      question
    );
    return r.target;
  } catch {
    return "documents";
  }
}

const InboxAnswerSchema = z.object({
  answerable: z.boolean(),
  answer: z.string().describe("plain answer from the inbox data; empty when not answerable"),
});

interface Row {
  id: number;
  from_addr: string;
  subject: string;
  category: string | null;
  urgency: string | null;
  needs_reply: number | null;
  status: string;
  received_at: string | null;
  draft_confident: number | null;
}

export async function answerInbox(tenantId: string, question: string): Promise<GroundedAnswer> {
  const rows = db
    .prepare(
      `SELECT id, from_addr, subject, category, urgency, needs_reply, status, received_at, draft_confident
       FROM inbound_emails WHERE tenant_id = ? ORDER BY id DESC LIMIT 500`
    )
    .all(tenantId) as Row[];

  if (rows.length === 0) {
    return {
      answerable: false,
      answer: "",
      cited_sources: [],
      sources: [],
      mode: "inbox",
    };
  }

  const table = rows
    .map(
      (r) =>
        `[${r.id}] ${r.received_at?.slice(0, 10) ?? "?"} | from: ${r.from_addr} | "${r.subject}" | ` +
        `${r.category ?? "?"} | urgency: ${r.urgency ?? "?"} | needs_reply: ${r.needs_reply ? "yes" : "no"} | ${r.status}`
    )
    .join("\n");

  const response = await withDeadline("answer:inbox", (signal) =>
    client.messages.parse(
      {
        model: MODEL,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        system:
          "You answer questions about the user's email inbox using only the table of classified emails provided. " +
          "Categories: new_business, support, vendor_partner, recruiting, newsletter_spam, other. " +
          "Be concrete — give counts, list senders/subjects when useful. If the data does not contain the answer, set answerable to false. No em dashes.",
        messages: [
          {
            role: "user",
            content: `Inbox (${rows.length} emails):\n${table}\n\nQuestion: ${question}`,
          },
        ],
        output_config: { format: zodOutputFormat(InboxAnswerSchema) },
      },
      { signal }
    )
  );
  const parsed = response.parsed_output ?? { answerable: false, answer: "" };
  return { ...parsed, cited_sources: [], sources: [], mode: "inbox" };
}
