// Ask-about-your-inbox (ADR-012): route a chat question to documents or the
// classified inbox, and answer inbox questions from the inbound_emails table.
// Read-only — never touches Gmail.
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, withDeadline, extract } from "../llm.js";
import { MODEL, FAST_MODEL } from "../config.js";
import db from "./store.js";
import { GroundedAnswer } from "./answer.js";

const IntentSchema = z.object({
  target: z
    .enum(["documents", "inbox", "chat"])
    .describe(
      "chat = greetings, small talk, thanks, or questions about Levi itself (who are you, what can you do, can you hear me); inbox = about emails received, senders, what needs a reply, inbox cleanup; documents = about uploaded files, contracts, policies"
    ),
});

// One cheap Haiku call; defaults to documents (existing behavior) on any doubt.
export async function classifyIntent(question: string): Promise<"documents" | "inbox" | "chat"> {
  try {
    const r = await extract(
      IntentSchema,
      "ask-intent",
      "Classify what this message is about: the user's email INBOX, their uploaded DOCUMENTS, or CHAT (a greeting, small talk, or a question about Levi the assistant itself).",
      question,
      FAST_MODEL
    );
    return r.target;
  } catch {
    return "documents";
  }
}

// Conversational Levi: greetings, small talk, and questions about the assistant.
// No retrieval — a short, warm spoken reply. Always answerable.
export async function answerChat(question: string): Promise<GroundedAnswer> {
  const system =
    "You are Levi, a warm, concise voice-first operations copilot for FireLever. " +
    "You help this user with their uploaded documents and contracts, their email inbox, " +
    "drafting grounded replies, reviewing contracts for risky clauses, and keeping tasks and " +
    "schedule. Reply in one or two short, natural spoken sentences. Be friendly and direct. " +
    "If asked what you can do, name a few of those abilities. If asked whether you can be heard " +
    "or about your voice, confirm warmly that you speak your answers aloud. " +
    "Never use dashes or em dashes in your reply.";
  try {
    const res = await withDeadline("chat", (signal) =>
      client.messages.create(
        {
          model: MODEL,
          max_tokens: 200,
          system,
          messages: [{ role: "user", content: question }],
        },
        { signal }
      )
    );
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join(" ")
      .trim();
    return {
      answerable: true,
      answer: text || "Hey, I'm Levi. Ask me about your documents, inbox, or a contract.",
      cited_sources: [],
      sources: [],
      mode: "chat",
    };
  } catch {
    return {
      answerable: true,
      answer: "Hey, I'm Levi. Ask me about your documents, your inbox, or a contract and I'll answer out loud.",
      cited_sources: [],
      sources: [],
      mode: "chat",
    };
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
