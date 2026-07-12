// Low-latency streaming answers for the voice path (ElevenLabs Custom LLM).
// The text UI uses answer.ts (Opus + structured output + citations) for max
// quality; voice needs the first spoken word out in a few seconds or ElevenLabs
// times out the turn. On the small prod CPU each model round-trip is ~2s, so
// this path minimizes them: keyword intent routing over the conversation (no
// LLM call), one retrieval, and a single streaming answer call.
import { client } from "../llm.js";
import { getEmbedder } from "./embeddings.js";
import { search } from "./retrieval.js";
import { listItems, createItem, updateItem } from "../workspace/store.js";
import { updateEmail } from "../triage/store.js";
import { sendReply, sendEmail, replySendingConfigured } from "../triage/send.js";
import { draftReply as engineDraftReply } from "../triage/engine.js";
import { publishUiContext, UiEmail } from "../server/ui-context.js";
import { addMemory, memoryBlock } from "./memory.js";
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

// ---- action protocol ----
// The voice model can DO a small set of things, not just talk. It tags exactly
// one action at the START of its reply; the server executes it BEFORE the
// confirmation is spoken (never claim first, act first), and the model is
// forbidden from claiming actions it didn't tag.
type Action =
  | { type: "send_reply"; email_id: number; body?: string }
  | { type: "compose_email"; to: string; subject: string; body: string }
  | { type: "draft_reply"; email_id: number; guidance?: string }
  | { type: "add_task" | "add_event" | "add_note"; title: string; body?: string; at?: string }
  | { type: "complete_task"; id: number }
  | { type: "remember"; note: string };

const ACTIONS =
  " ACTIONS: When the user asks you to DO one of these things, begin your reply with exactly one action tag, then the spoken confirmation: " +
  '<<action:{"type":"send_reply","email_id":ID,"body":"..."}>> sends a reply on that email\'s thread. Omit "body" to send the unsent draft; ' +
  "include \"body\" to send what the user asked for, written as a plain warm email signed 'Peter' — you can reply on a thread any number of times, including after an earlier reply was sent. " +
  '<<action:{"type":"compose_email","to":"name@domain.com","subject":"...","body":"..."}>> sends a brand-new email to any address. ' +
  "Before compose_email, the recipient address and the gist of the message must be explicit in the conversation; if either is missing or you would be guessing the address, ask first instead of tagging. " +
  '<<action:{"type":"draft_reply","email_id":ID,"guidance":"what the user wants it to say"}>> writes a grounded draft into the Replies window for review instead of sending; use it when the user says draft or wants to review before sending. ' +
  '<<action:{"type":"add_task","title":"..."}>> likewise add_event and add_note (optional "at":"YYYY-MM-DD HH:MM", optional "body"). ' +
  '<<action:{"type":"complete_task","id":ID}>> checks a task off. ' +
  '<<action:{"type":"remember","note":"..."}>> permanently saves a fact the user corrects or confirms ' +
  "(a name, a spelling, a number, a preference); the note should state the correct fact and the wrong variant, " +
  'e.g. "The buyer entity is BDLP Enterprises LLC; OCR sometimes misreads it as BRLP". ' +
  "CALIBRATED DEFERENCE for corrections: accept and remember immediately when the correction concerns something " +
  "the documents don't cover (names, preferences, context) or where the sources genuinely conflict (OCR ambiguity). " +
  "But when the correction CONTRADICTS what the sources clearly and consistently show, do NOT remember it yet — " +
  "push back politely with the specific evidence (where it appears and what it says) and ask them to confirm. " +
  "If they then insist, remember it with both sides recorded, e.g. " +
  '"User confirms the deposit is X, though the contract consistently shows Y". Never argue past one round; the user has final say. ' +
  "The system executes the tag before your words are spoken, so phrase the confirmation as already done. " +
  "NEVER say you sent, added, completed, scheduled, or remembered anything without its action tag. For anything outside these actions, say you can't do that yet.";

// Email bodies get shown in the UI and read aloud; angle-bracketed and long
// tracking URLs (newsletter plumbing) are pure noise in both registers.
const cleanBody = (s: string) =>
  s
    .replace(/<https?:\/\/[^>]*>/g, " ")
    .replace(/https?:\/\/\S{12,}/g, "(link)")
    .replace(/\s+/g, " ")
    .trim();

// Returns a spoken failure sentence, or null when the action succeeded.
async function executeAction(tenantId: string, a: Action): Promise<string | null> {
  try {
    if (a.type === "send_reply") {
      const row = db
        .prepare(
          `SELECT id, from_addr, subject, body, received_at, draft_reply, status, message_id, sent_at FROM inbound_emails
           WHERE id = ? AND tenant_id = ?`
        )
        .get(a.email_id, tenantId) as
        | (UiEmail & { message_id: string | null })
        | undefined;
      if (!row) return "I couldn't find that email, so nothing was sent.";
      const dictated = (a.body ?? "").trim();
      // Without new content, only an unsent draft can go out — resending an
      // already-sent draft verbatim is always a mistake. With dictated content,
      // replying again on the thread is exactly what the user asked for.
      if (!dictated && row.sent_at) return "That draft already went out earlier. Tell me what the new reply should say and I'll send it.";
      const body = dictated || (row.draft_reply ?? "").trim();
      if (!body) return "There's no draft on that email yet. Tell me what to say, or ask me to draft one.";
      if (!replySendingConfigured()) return "Email sending isn't configured on the server, so nothing was sent.";
      await sendReply({ from_addr: row.from_addr, subject: row.subject, draft_reply: body, message_id: row.message_id });
      const sentAt = new Date().toISOString();
      updateEmail(row.id, { status: "approved", sent_at: sentAt, draft_reply: body });
      publishUiContext(tenantId, "inbox", { ...row, body: cleanBody(row.body).slice(0, 1200), draft_reply: body, status: "approved", sent_at: sentAt });
      return null;
    }
    if (a.type === "compose_email") {
      const to = (a.to ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return "I don't have a valid email address for that, so nothing was sent.";
      const body = (a.body ?? "").trim();
      if (!body) return "I didn't catch what the email should say, so nothing was sent.";
      if (!replySendingConfigured()) return "Email sending isn't configured on the server, so nothing was sent.";
      await sendEmail({ to, subject: (a.subject ?? "").trim() || "(no subject)", text: body });
      return null;
    }
    if (a.type === "draft_reply") {
      const row = db
        .prepare(
          `SELECT id, from_addr, subject, body, received_at, category, urgency, status, sent_at, draft_reply FROM inbound_emails
           WHERE id = ? AND tenant_id = ?`
        )
        .get(a.email_id, tenantId) as
        | (UiEmail & { category: string | null; urgency: string | null })
        | undefined;
      if (!row) return "I couldn't find that email, so nothing was drafted.";
      const d = await engineDraftReply(
        tenantId,
        row.from_addr,
        row.subject,
        row.body,
        {
          category: (row.category as any) ?? "other",
          needs_reply: true,
          urgency: (row.urgency as any) ?? "normal",
          reasoning: "user requested a reply by voice",
        },
        a.guidance?.trim() || undefined
      );
      updateEmail(row.id, {
        draft_reply: d.reply,
        draft_confident: d.confident ? 1 : 0,
        draft_sources_json: JSON.stringify(d.used_sources.map((n) => d.sources[n - 1]?.document_path).filter(Boolean)),
        status: "drafted",
        sent_at: null, // fresh draft awaiting a fresh approval
      });
      publishUiContext(tenantId, "inbox", {
        id: row.id,
        from_addr: row.from_addr,
        subject: row.subject,
        received_at: row.received_at,
        body: cleanBody(row.body).slice(0, 1200),
        draft_reply: d.reply,
        status: "drafted",
        sent_at: null,
      });
      return null;
    }
    if (a.type === "add_task" || a.type === "add_event" || a.type === "add_note") {
      if (!a.title?.trim()) return "I didn't catch what to add, so nothing was saved.";
      const kind = a.type.slice(4);
      createItem(tenantId, kind, a.title.trim(), a.body?.trim() || undefined, a.at?.trim() || undefined);
      publishUiContext(tenantId, kind === "task" ? "tasks" : kind === "event" ? "schedule" : "notes");
      return null;
    }
    if (a.type === "complete_task") {
      const ok = updateItem(tenantId, a.id, { done: 1 });
      if (ok) publishUiContext(tenantId, "tasks");
      return ok ? null : "I couldn't find that task, so nothing was checked off.";
    }
    if (a.type === "remember") {
      if (!a.note?.trim()) return "I didn't catch what to remember, so nothing was saved.";
      addMemory(tenantId, a.note);
      return null;
    }
    return "I don't know how to do that yet, so nothing happened.";
  } catch (e) {
    return "That didn't go through: " + (e instanceof Error ? e.message : "unknown error") + ". Nothing was changed.";
  }
}

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
  const MEM = memoryBlock(tenantId);

  let system: string;
  let userContent: string;

  if (intent === "chat") {
    system =
      "You are Levi, a warm, concise voice operations copilot for FireLever. " +
      "If asked what you can do, mention answering questions about their documents, contracts, inbox, and schedule. " +
      SPEAK +
      ACTIONS +
      MEM;
    userContent = `${convoBlock}User says: ${question}`;
  } else if (intent === "workspace") {
    const fmt = (kind: "task" | "event" | "note") =>
      listItems(tenantId, kind)
        .map(
          (i) =>
            `- [id ${i.id}] ${i.title}${i.at ? ` (at ${i.at})` : ""}${i.body ? ` — ${i.body.slice(0, 120)}` : ""}${
              kind === "task" ? (i.done ? " [done]" : " [open]") : ""
            }`
        )
        .join("\n");
    const events = fmt("event");
    const tasks = fmt("task");
    const notes = fmt("note");
    const today = new Date().toISOString().slice(0, 10);
    // Surface the specific workspace window under discussion. Only the user's
    // own words pick the window — assistant prose ("worth a note...") must not.
    const wsText = question.toLowerCase();
    const lastUserText = [...history].reverse().find((h) => h.role === "user")?.text.toLowerCase() ?? "";
    const pick = (s: string) =>
      /\b(tasks?|to-?dos?|check(ed)? off|reminders?)\b/.test(s) ? "tasks" : /\bnotes?\b/.test(s) ? "notes" : /\b(schedules?|calendars?|appointments?|meetings?|events?)\b/.test(s) ? "schedule" : null;
    publishUiContext(tenantId, pick(wsText) ?? pick(lastUserText) ?? "schedule");
    system =
      "You are Levi, answering out loud about the user's schedule, tasks, and notes using ONLY the workspace data provided. " +
      "Be concrete about times and what's open versus done. If the data is empty for what they asked, say so plainly " +
      "and offer to add an item. " +
      SPEAK +
      ACTIONS +
      MEM;
    userContent =
      `${convoBlock}Today's date: ${today}\n\nEvents:\n${events || "(none)"}\n\nTasks:\n${tasks || "(none)"}\n\nNotes:\n${notes || "(none)"}\n\nQuestion: ${question}`;
  } else if (intent === "inbox") {
    const rows = db
      .prepare(
        `SELECT id, from_addr, subject, body, draft_reply, category, urgency, needs_reply, status, sent_at, received_at
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
      sent_at: string | null;
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
    const clean = cleanBody;
    // Generic inbox vocabulary must not entity-match emails ("reply" would
    // match every no-reply@ sender). Only distinctive words count.
    const STOP = new Set([
      "reply", "replies", "email", "emails", "mail", "inbox", "sender", "senders", "message", "messages",
      "need", "needs", "read", "open", "show", "tell", "about", "what", "which", "that", "this", "have",
      "drafted", "draft", "drafts", "send", "sent", "newsletter", "newsletters", "spam", "from", "subject",
      "please", "want", "wanna", "check", "look", "there", "they", "them", "were", "does", "with",
    ]);
    const qText = [question, ...history.slice(-4).map((h) => h.text)].join(" ").toLowerCase();
    const qWords = qText
      .split(/[^a-z0-9@.]+/)
      .map((w) => w.replace(/^[.@]+|[.@]+$/g, "")) // dots stay for fly.io, not sentence punctuation
      .filter((w) => w.length > 3 && !STOP.has(w));
    const matches = rows.filter((r) => {
      const hay = (r.from_addr + " " + r.subject).toLowerCase();
      return qWords.some((w) => hay.includes(w));
    });
    const drafted = rows.filter((r) => r.draft_reply);
    // Surface the email under discussion in the inbox window, content included.
    // Only when something actually matches — never fall back to "most recent
    // email", which surfaces a random newsletter out of context.
    const focus = matches[0] ?? drafted.find((r) => r.status === "drafted") ?? null;
    publishUiContext(
      tenantId,
      "inbox",
      focus
        ? {
            id: focus.id,
            from_addr: focus.from_addr,
            subject: focus.subject,
            received_at: focus.received_at,
            body: clean(focus.body).slice(0, 1200),
            draft_reply: focus.draft_reply,
            status: focus.status,
            sent_at: focus.sent_at,
          }
        : null
    );
    const detail = [...new Map([...rows.slice(0, 6), ...drafted.slice(0, 4), ...matches.slice(0, 5)].map((r) => [r.id, r])).values()]
      .map(
        (r) =>
          `[${r.id}] From: ${r.from_addr} | Subject: "${r.subject}" | ${r.received_at?.slice(0, 10) ?? "?"}\n` +
          `Body: ${clean(r.body).slice(0, 700) || "(empty)"}` +
          (r.draft_reply
            ? `\nLevi's drafted reply (${
                r.sent_at
                  ? `SENT on ${r.sent_at.slice(0, 10)}`
                  : r.status === "drafted"
                    ? "awaiting approval in the Replies window"
                    : `verdict ${r.status} but NOT sent — never claim it was sent`
              }): ${clean(r.draft_reply).slice(0, 400)}`
            : "")
      )
      .join("\n\n");
    system =
      "You are Levi, answering out loud about the user's email inbox using ONLY the data provided. " +
      "The table lists every email; full content follows for the recent and relevant ones. When asked to read " +
      "an email, read its body naturally, summarizing boilerplate. Some emails have a drafted reply awaiting " +
      "approval in the Replies window; mention that when relevant. A reply left the building ONLY if it is " +
      "marked SENT with a date; a verdict of approved does not mean it was sent, so never claim or imply an " +
      "unsent reply went out. If asked about an email whose body isn't included, say you can pull it up if " +
      "they name the sender. " +
      SPEAK +
      ACTIONS +
      MEM;
    userContent = rows.length
      ? `${convoBlock}Inbox (${rows.length} emails):\n${table}\n\nFull content of recent/relevant emails:\n${detail}\n\nQuestion: ${question}`
      : `${convoBlock}The inbox is empty.\n\nQuestion: ${question}`;
  } else {
    publishUiContext(tenantId, "answer");
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
      "The documents are scanned, so OCR can misread names and numbers (letters like R and D are commonly " +
      "confused). When MEMORY confirms a reading, always use it. When sources disagree on a name or number " +
      "and MEMORY is silent, prefer the reading that appears most consistently, mention the discrepancy " +
      "briefly, and if the user confirms which is right, remember it. " +
      SPEAK +
      ACTIONS +
      MEM;
    userContent = hits.length
      ? `${convoBlock}<sources>\n${block}\n</sources>\n\nQuestion: ${question}`
      : `${convoBlock}No sources found.\n\nQuestion: ${question}`;
  }

  // Track whether any speech left the server: a failure before the first word
  // can be retried transparently; after that, the error must surface.
  let emitted = false;
  const emit = async (t: string) => {
    emitted = true;
    await onDelta(t);
  };

  const runOnce = async (): Promise<void> => {
    const stream = client.messages.stream({
      model: VOICE_MODEL,
      max_tokens: 400,
      thinking: { type: "disabled" }, // no thinking → fast first token for speech
      system,
      messages: [{ role: "user", content: userContent }],
    });

    // Action-aware streaming: when the reply opens with an action tag, hold the
    // stream, execute the action FIRST, then let the confirmation speak. On
    // failure, speak the failure instead of the model's premature confirmation.
    const HEAD = "<<action:";
    let mode: "detect" | "collect" | "pass" = "detect";
    let buf = "";
    for await (const ev of stream) {
      if (ev.type !== "content_block_delta" || ev.delta.type !== "text_delta") continue;
      const t = ev.delta.text;
      if (mode === "pass") {
        await emit(t);
        continue;
      }
      buf += t;
      if (mode === "detect") {
        if (buf.length < HEAD.length) {
          if (HEAD.startsWith(buf)) continue; // still could be a tag
          mode = "pass";
          await emit(buf);
          buf = "";
          continue;
        }
        if (buf.startsWith(HEAD)) mode = "collect";
        else {
          mode = "pass";
          await emit(buf);
          buf = "";
          continue;
        }
      }
      if (mode === "collect") {
        const end = buf.indexOf(">>");
        if (end < 0) {
          if (buf.length > 1500) {
            // runaway tag; bail out and just speak it
            mode = "pass";
            await emit(buf);
            buf = "";
          }
          continue;
        }
        const raw = buf.slice(HEAD.length, end);
        const rest = buf.slice(end + 2).replace(/^\s+/, "");
        buf = "";
        mode = "pass";
        let failure: string | null = "I couldn't make sense of that request, so nothing happened.";
        try {
          failure = await executeAction(tenantId, JSON.parse(raw) as Action);
        } catch {
          /* failure message stands */
        }
        if (failure) {
          await emit(failure);
          return; // suppress the model's now-false confirmation
        }
        if (rest) await emit(rest);
      }
    }
    if (buf && mode !== "pass") await emit(buf); // stream ended mid-detect
  };

  try {
    await runOnce();
  } catch (e) {
    if (emitted) throw e; // partial speech already out — don't double-speak
    await new Promise((r) => setTimeout(r, 600));
    await runOnce(); // one transparent retry for transient API failures
  }
}
