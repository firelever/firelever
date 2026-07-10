// Low-latency streaming answers for the voice path (ElevenLabs Custom LLM).
// The text UI uses answer.ts (Opus + structured output + citations) for max
// quality; voice needs the first spoken word out in ~1-2s or ElevenLabs times
// out the turn. So this path uses a fast model, hybrid retrieval without the
// rerank round-trip, and streams plain spoken text token-by-token.
import { client } from "../llm.js";
import { getEmbedder } from "./embeddings.js";
import { search, Hit } from "./retrieval.js";
import db from "./store.js";

const VOICE_MODEL = process.env.VOICE_MODEL ?? "claude-haiku-4-5";

// Fast Haiku rerank: pick the few passages most useful for the question. Uses
// short previews so it stays ~1s, and keeps retrieval correct without the
// Opus reranker or the full-corpus context the quality path uses.
async function pickRelevant(question: string, candidates: Hit[], topN: number): Promise<Hit[]> {
  if (candidates.length <= topN) return candidates;
  const list = candidates.map((h, i) => `[${i + 1}] ${h.text.slice(0, 240)}`).join("\n\n");
  try {
    const r = await client.messages.create({
      model: VOICE_MODEL,
      max_tokens: 40,
      system: `Return the numbers of the up to ${topN} passages most useful for answering the question, most relevant first, comma-separated (e.g. "3, 1, 7"). Question: "${question}"`,
      messages: [{ role: "user", content: list }],
    });
    const t = (r.content.find((b) => b.type === "text") as { text?: string } | undefined)?.text ?? "";
    const picked: Hit[] = [];
    const seen = new Set<number>();
    for (const m of t.matchAll(/\d+/g)) {
      const n = +m[0];
      const c = candidates[n - 1];
      if (c && !seen.has(n)) {
        seen.add(n);
        picked.push(c);
      }
      if (picked.length >= topN) break;
    }
    for (let i = 0; i < candidates.length && picked.length < topN; i++) {
      if (!seen.has(i + 1)) picked.push(candidates[i]);
    }
    return picked.slice(0, topN);
  } catch {
    return candidates.slice(0, topN);
  }
}

// One fast word of intent so we route to documents, inbox, or small talk.
async function voiceIntent(question: string): Promise<"chat" | "inbox" | "docs"> {
  try {
    const r = await client.messages.create({
      model: VOICE_MODEL,
      max_tokens: 8,
      system:
        "Classify the message as exactly one word: chat (greeting, small talk, or a question about you the assistant), inbox (about their email inbox, senders, or replies), or docs (about their uploaded documents, contracts, or files). Reply with only that one word.",
      messages: [{ role: "user", content: question }],
    });
    const t = (r.content.find((b) => b.type === "text") as { text?: string } | undefined)?.text?.toLowerCase() ?? "";
    if (t.includes("inbox")) return "inbox";
    if (t.includes("chat")) return "chat";
    return "docs";
  } catch {
    return "docs";
  }
}

const SPEAK = "Answer in one or two short, natural spoken sentences. Never use dashes or em dashes.";

// Stream a grounded spoken reply; onDelta receives text as it generates.
export async function streamVoiceReply(
  tenantId: string,
  question: string,
  onDelta: (t: string) => void | Promise<void>
): Promise<void> {
  const intent = await voiceIntent(question);
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
    const embedder = getEmbedder();
    const candidates = await search(tenantId, question, 30, embedder, "hybrid");
    const hits = await pickRelevant(question, candidates, 6);
    // Cap each passage so Haiku's input stays small (fast) even with big OCR
    // chunks; rerank already surfaced the passage that holds the answer.
    const block = hits
      .map((s, i) => `[${i + 1}] ${s.document_path}${s.heading ? " › " + s.heading : ""}\n${s.text.slice(0, 1600)}`)
      .join("\n\n");
    system =
      "You are Levi, answering out loud from the user's documents using ONLY the numbered sources. " +
      "Do not read source numbers or citation markers aloud. If the sources do not contain the answer, " +
      "say you couldn't find it in their documents. " +
      SPEAK;
    userContent = hits.length ? `<sources>\n${block}\n</sources>\n\nQuestion: ${question}` : `No sources found.\n\nQuestion: ${question}`;
  }

  const stream = client.messages.stream({
    model: VOICE_MODEL,
    max_tokens: 400,
    system,
    messages: [{ role: "user", content: userContent }],
  });
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
      await onDelta(ev.delta.text);
    }
  }
}
