// Low-latency streaming answers for the voice path (ElevenLabs Custom LLM).
// The text UI uses answer.ts (Opus + structured output + citations) for max
// quality; voice needs the first spoken word out in a few seconds or ElevenLabs
// times out the turn. On the small prod CPU each model round-trip is ~2s, so
// this path minimizes them: keyword intent routing over the conversation (no
// LLM call), one retrieval, and a single streaming answer call.
import { client } from "../llm.js";
import { getEmbedder } from "./embeddings.js";
import { search } from "./retrieval.js";
import { listItems } from "../workspace/store.js";
import db from "./store.js";

const VOICE_MODEL = process.env.VOICE_MODEL ?? "claude-sonnet-5";

export interface VoiceTurn {
  role: "user" | "assistant";
  text: string;
}

// Written text and spoken text are different registers: TTS reads "St." as
// "Saint" and "@" as something odd, so the model must write words as they
// should be SAID.
const SPEAK =
  "Answer in one or two short, natural spoken sentences. Never use dashes or em dashes. " +
  "Write the reply exactly as it should be spoken aloud: expand abbreviations (write Street not St., " +
  "Avenue not Ave., Apartment not Apt.), read email addresses as 'name at domain dot com', and avoid " +
  "symbols entirely: say 'at' not @, 'and' not &, 'percent' not %, and 'dollars' for $ amounts.";

// Instant intent routing over the whole conversation, no model call. A turn
// with no strong signal of its own ("yes, go by sender") sticks with the most
// recent domain in the conversation instead of defaulting to documents.
type Intent = "chat" | "inbox" | "docs" | "workspace";
const WORKSPACE_RE = /\b(schedules?|calendars?|appointments?|meetings?|events?|tasks?|to-?dos?|notes?|reminders?)\b/;
const INBOX_RE = /\b(inbox|e-?mails?|reply|replies|senders?|unread|mailbox|triage|newsletters?|spam|messages?|inquir(y|ies)|correspondence)\b/;
const DOCS_RE = /\b(documents?|contracts?|clauses?|agreements?|pdf|files?|polic(y|ies)|sellers?|buyers?|closing|deposit|price|propert(y|ies)|street|inspection|addend(um|a)|warranty)\b/;

function strongSignal(s: string): Intent | null {
  if (WORKSPACE_RE.test(s)) return "workspace";
  if (INBOX_RE.test(s)) return "inbox";
  if (DOCS_RE.test(s)) return "docs";
  return null;
}

function routeIntent(question: string, history: VoiceTurn[]): Intent {
  const s = question.toLowerCase().trim();
  if (
    (s.split(/\s+/).length <= 2 && !strongSignal(s)) ||
    /^(hi|hey|hello|yo|sup|thanks|thank you|good (morning|afternoon|evening))\b/.test(s) ||
    /\b(who are you|what can you do|what do you do|how are you|your name)\b/.test(s)
  )
    return "chat";
  const own = strongSignal(s);
  if (own) return own;
  // No signal of its own: a follow-up. Stay in the conversation's last domain.
  for (let i = history.length - 1; i >= 0; i--) {
    const inherited = strongSignal(history[i].text.toLowerCase());
    if (inherited) return inherited;
  }
  return "docs";
}

// Preload the embedding model up front so the first real document query doesn't
// pay the cold model-load cost (~15s on the CPU box). Called on server boot.
export async function warmVoice(): Promise<void> {
  try {
    await getEmbedder().embed(["warm up"], "query");
  } catch {
    /* best effort */
  }
}

// Stream a grounded spoken reply; onDelta receives text as it generates.
// history is the prior conversation (most recent last), used for intent
// stickiness and so follow-up questions keep their context.
export async function streamVoiceReply(
  tenantId: string,
  question: string,
  onDelta: (t: string) => void | Promise<void>,
  history: VoiceTurn[] = []
): Promise<void> {
  const intent = routeIntent(question, history);
  const convo = history
    .slice(-6)
    .map((h) => `${h.role}: ${h.text.slice(0, 300)}`)
    .join("\n");
  const convoBlock = convo ? `Conversation so far:\n${convo}\n\n` : "";

  let system: string;
  let userContent: string;

  if (intent === "chat") {
    system =
      "You are Levi, a warm, concise voice operations copilot for FireLever. " +
      "If asked what you can do, mention answering questions about their documents, contracts, inbox, and schedule. " +
      SPEAK;
    userContent = `${convoBlock}User says: ${question}`;
  } else if (intent === "workspace") {
    const fmt = (kind: "task" | "event" | "note") =>
      listItems(tenantId, kind)
        .map(
          (i) =>
            `- ${i.title}${i.at ? ` (at ${i.at})` : ""}${i.body ? ` — ${i.body.slice(0, 120)}` : ""}${
              kind === "task" ? (i.done ? " [done]" : " [open]") : ""
            }`
        )
        .join("\n");
    const events = fmt("event");
    const tasks = fmt("task");
    const notes = fmt("note");
    const today = new Date().toISOString().slice(0, 10);
    system =
      "You are Levi, answering out loud about the user's schedule, tasks, and notes using ONLY the workspace data provided. " +
      "Be concrete about times and what's open versus done. If the data is empty for what they asked, say so plainly " +
      "and offer to add an item. " +
      SPEAK;
    userContent =
      `${convoBlock}Today's date: ${today}\n\nEvents:\n${events || "(none)"}\n\nTasks:\n${tasks || "(none)"}\n\nNotes:\n${notes || "(none)"}\n\nQuestion: ${question}`;
  } else if (intent === "inbox") {
    const rows = db
      .prepare(
        `SELECT id, from_addr, subject, body, draft_reply, category, urgency, needs_reply, status, received_at
         FROM inbound_emails WHERE tenant_id = ? ORDER BY id DESC LIMIT 200`
      )
      .all(tenantId) as {
      id: number;
      from_addr: string;
      subject: string;
      body: string;
      draft_reply: string | null;
      category: string | null;
      urgency: string | null;
      needs_reply: number | null;
      status: string;
      received_at: string | null;
    }[];
    const table = rows
      .map(
        (r) =>
          `[${r.id}] ${r.received_at?.slice(0, 10) ?? "?"} | ${r.from_addr} | "${r.subject}" | ${r.category ?? "?"} | ` +
          `urgency ${r.urgency ?? "?"} | needs_reply ${r.needs_reply ? "yes" : "no"} | ${r.status}`
      )
      .join("\n");
    // Full content for the emails the user is most likely asking about, so
    // Levi can actually read a message (or its drafted reply) aloud: the most
    // recent few, every email that has a drafted reply (those are what
    // follow-ups like "read that draft" refer to), plus any whose
    // sender/subject matches words from the conversation — the recent turns,
    // not just the current utterance, since follow-ups are mostly pronouns.
    const clean = (s: string) => s.replace(/\s+/g, " ").trim();
    const qText = [question, ...history.slice(-4).map((h) => h.text)].join(" ").toLowerCase();
    const qWords = qText.split(/[^a-z0-9@.]+/).filter((w) => w.length > 3);
    const matches = rows.filter((r) => {
      const hay = (r.from_addr + " " + r.subject).toLowerCase();
      return qWords.some((w) => hay.includes(w));
    });
    const drafted = rows.filter((r) => r.draft_reply);
    const detail = [...new Map([...rows.slice(0, 6), ...drafted.slice(0, 4), ...matches.slice(0, 5)].map((r) => [r.id, r])).values()]
      .map(
        (r) =>
          `[${r.id}] From: ${r.from_addr} | Subject: "${r.subject}" | ${r.received_at?.slice(0, 10) ?? "?"}\n` +
          `Body: ${clean(r.body).slice(0, 700) || "(empty)"}` +
          (r.draft_reply
            ? `\nLevi's drafted reply (${r.status === "drafted" ? "awaiting approval in the Replies window" : "verdict: " + r.status}): ${clean(r.draft_reply).slice(0, 400)}`
            : "")
      )
      .join("\n\n");
    system =
      "You are Levi, answering out loud about the user's email inbox using ONLY the data provided. " +
      "The table lists every email; full content follows for the recent and relevant ones. When asked to read " +
      "an email, read its body naturally, summarizing boilerplate. Some emails have a drafted reply awaiting " +
      "approval in the Replies window; mention that when relevant. If asked about an email whose body isn't " +
      "included, say you can pull it up if they name the sender. " +
      SPEAK;
    userContent = rows.length
      ? `${convoBlock}Inbox (${rows.length} emails):\n${table}\n\nFull content of recent/relevant emails:\n${detail}\n\nQuestion: ${question}`
      : `${convoBlock}The inbox is empty.\n\nQuestion: ${question}`;
  } else {
    // For terse follow-ups, enrich the retrieval query with the previous user
    // turn so hybrid search has something to bite on.
    const prevUser = [...history].reverse().find((h) => h.role === "user")?.text ?? "";
    const query = question.split(/\s+/).length < 5 && prevUser ? `${prevUser} ${question}` : question;
    const hits = await search(tenantId, query, 40, getEmbedder(), "hybrid").catch(() => []);
    const block = hits
      .map((s, i) => `[${i + 1}] ${s.document_path}${s.heading ? " › " + s.heading : ""}\n${s.text.slice(0, 800)}`)
      .join("\n\n");
    system =
      "You are Levi, answering out loud from the user's documents. Use ONLY the numbered sources; " +
      "several are irrelevant, so rely on the ones that actually answer the question and ignore the rest. " +
      "Do not read source numbers or citation markers aloud. If none of the sources contain the answer, " +
      "say you couldn't find it in their documents. " +
      SPEAK;
    userContent = hits.length
      ? `${convoBlock}<sources>\n${block}\n</sources>\n\nQuestion: ${question}`
      : `${convoBlock}No sources found.\n\nQuestion: ${question}`;
  }

  const stream = client.messages.stream({
    model: VOICE_MODEL,
    max_tokens: 400,
    thinking: { type: "disabled" }, // no thinking → fast first token for speech
    system,
    messages: [{ role: "user", content: userContent }],
  });
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
      await onDelta(ev.delta.text);
    }
  }
}
