// Low-latency streaming answers for the voice path (ElevenLabs Custom LLM).
// The text UI uses answer.ts (Opus + structured output + citations) for max
// quality; voice needs the first spoken word out in a few seconds or ElevenLabs
// times out the turn. On the small prod CPU each model round-trip is ~2s, so
// this path minimizes them: a keyword intent heuristic (no LLM), one hybrid
// retrieval, and a single streaming answer call over a wide-but-truncated
// candidate set (so the answer passage is included without a rerank round-trip).
import { client } from "../llm.js";
import { getEmbedder } from "./embeddings.js";
import { search } from "./retrieval.js";
import db from "./store.js";

// Sonnet reads the sources for the spoken answer — enough comprehension to
// handle nuance (e.g. "who represents the seller" = the listing agent, not a
// lawyer) while still fast with thinking off. Haiku is the fallback override.
const VOICE_MODEL = process.env.VOICE_MODEL ?? "claude-sonnet-5";
const SPEAK = "Answer in one or two short, natural spoken sentences. Never use dashes or em dashes.";

// Instant intent routing — no model call. Errs toward documents, the common case.
function routeIntent(q: string): "chat" | "inbox" | "docs" {
  const s = q.toLowerCase().trim();
  if (/\b(inbox|e-?mails?|reply|replies|sender|unread|mailbox|triage)\b/.test(s)) return "inbox";
  if (
    s.split(/\s+/).length <= 2 ||
    /^(hi|hey|hello|yo|sup|thanks|thank you|good (morning|afternoon|evening))\b/.test(s) ||
    /\b(who are you|what can you do|what do you do|how are you|your name)\b/.test(s)
  )
    return "chat";
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
export async function streamVoiceReply(
  tenantId: string,
  question: string,
  onDelta: (t: string) => void | Promise<void>
): Promise<void> {
  const intent = routeIntent(question);
  let system: string;
  let userContent: string;

  if (intent === "chat") {
    system =
      "You are Levi, a warm, concise voice operations copilot for FireLever. " +
      "If asked what you can do, mention answering questions about their documents, contracts, and inbox. " +
      SPEAK;
    userContent = question;
  } else if (intent === "inbox") {
    const rows = db
      .prepare(
        `SELECT from_addr, subject, category, urgency, needs_reply, status, received_at
         FROM inbound_emails WHERE tenant_id = ? ORDER BY id DESC LIMIT 200`
      )
      .all(tenantId) as {
      from_addr: string;
      subject: string;
      category: string | null;
      urgency: string | null;
      needs_reply: number | null;
      status: string;
      received_at: string | null;
    }[];
    const table = rows
      .map(
        (r) =>
          `${r.received_at?.slice(0, 10) ?? "?"} | ${r.from_addr} | "${r.subject}" | ${r.category ?? "?"} | ` +
          `urgency ${r.urgency ?? "?"} | needs_reply ${r.needs_reply ? "yes" : "no"} | ${r.status}`
      )
      .join("\n");
    system =
      "You are Levi, answering out loud about the user's email inbox using ONLY the table provided. " +
      "Give concrete counts and names. If the table does not answer it, say you don't see that in the inbox. " +
      SPEAK;
    userContent = rows.length
      ? `Inbox (${rows.length} emails):\n${table}\n\nQuestion: ${question}`
      : `The inbox is empty.\n\nQuestion: ${question}`;
  } else {
    // One retrieval, one answer call. A wide candidate set (top 24) keeps recall
    // high so the answer passage is present; short previews keep Haiku's input
    // small and fast, and it picks the relevant sources itself.
    const hits = await search(tenantId, question, 40, getEmbedder(), "hybrid").catch(() => []);
    const block = hits
      .map((s, i) => `[${i + 1}] ${s.document_path}${s.heading ? " › " + s.heading : ""}\n${s.text.slice(0, 800)}`)
      .join("\n\n");
    system =
      "You are Levi, answering out loud from the user's documents. Use ONLY the numbered sources; " +
      "several are irrelevant, so rely on the ones that actually answer the question and ignore the rest. " +
      "Do not read source numbers or citation markers aloud. If none of the sources contain the answer, " +
      "say you couldn't find it in their documents. " +
      SPEAK;
    userContent = hits.length ? `<sources>\n${block}\n</sources>\n\nQuestion: ${question}` : `No sources found.\n\nQuestion: ${question}`;
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
