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
import { draftReply as engineDraftReply, CATEGORIES } from "../triage/engine.js";
import { previewCleanup, applyCleanup } from "../triage/cleanup.js";
import { publishUiContext, getLastIntent, setLastIntent, UiEmail } from "../server/ui-context.js";
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
  | { type: "stage_reply"; email_id: number; body: string }
  | { type: "compose_email"; to: string; subject: string; body: string }
  | { type: "draft_reply"; email_id: number; guidance?: string }
  | { type: "forward_email"; email_id: number; to: string; note?: string }
  | { type: "archive_email"; email_id: number }
  | { type: "archive_newsletters" }
  | { type: "categorize_email"; email_id: number; category: string }
  | { type: "add_task" | "add_event" | "add_note"; title: string; body?: string; at?: string }
  | { type: "complete_task"; id: number }
  | { type: "remember"; note: string }
  | { type: "show_window"; window: string }
  | { type: "set_theme"; theme: string };

const WINDOWS = ["answer", "inbox", "schedule", "tasks", "notes", "contract"];
const THEMES = ["ember", "graphite", "nebula", "signal", "ivory"];

const ACTIONS =
  " ACTIONS: When the user asks you to DO one of these things, begin your reply with exactly one action tag, then the spoken confirmation: " +
  "REPLY FLOW — replies are previewed before they leave: when the user dictates or requests a reply, stage it first with " +
  '<<action:{"type":"stage_reply","email_id":ID,"body":"the full reply, plain and warm, signed Peter"}>> — it appears on screen — then briefly say what it says and ask if you should send it. ' +
  'When they confirm (or say send the draft), <<action:{"type":"send_reply","email_id":ID}>> sends the staged/unsent draft. Never send dictated content without staging it for review first. ' +
  "You can stage and send on a thread any number of times, including after an earlier reply was sent; if they want changes, stage again with the revised body. " +
  '<<action:{"type":"draft_reply","email_id":ID,"guidance":"what the user wants it to say"}>> has me write a grounded draft for review instead (use when they want a fuller composed reply). ' +
  '<<action:{"type":"compose_email","to":"name@domain.com","subject":"...","body":"..."}>> sends a brand-new email to any address. ' +
  "Before compose_email, the recipient address and the message must be explicit in the conversation AND you must have read the gist back and gotten a yes on a previous turn; if the address is missing or you would be guessing it, ask instead of tagging. " +
  '<<action:{"type":"forward_email","email_id":ID,"to":"name@domain.com","note":"optional line to include"}>> forwards that email; the address must be explicit, ask if it is not. ' +
  '<<action:{"type":"archive_email","email_id":ID}>> archives one email (moves it out of the inbox in Gmail; reversible). ' +
  '<<action:{"type":"archive_newsletters"}>> archives all newsletter and promo clutter in one sweep. ' +
  "Deleting email is deliberately not supported, archiving is the safe reversible equivalent, offer it instead. " +
  '<<action:{"type":"categorize_email","email_id":ID,"category":"new_business|support|vendor_partner|recruiting|newsletter_spam|other"}>> re-files an email under a different category. ' +
  '<<action:{"type":"add_task","title":"..."}>> likewise add_event and add_note (optional "at":"YYYY-MM-DD HH:MM", optional "body"). ' +
  '<<action:{"type":"complete_task","id":ID}>> checks a task off. ' +
  '<<action:{"type":"show_window","window":"answer|inbox|schedule|tasks|notes|contract"}>> puts that window on screen when the user asks to see, open, switch to, or go back to it (inbox is the Replies window, notes is Prep). ' +
  '<<action:{"type":"set_theme","theme":"ember|graphite|nebula|signal|ivory"}>> switches the color theme when asked. ' +
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

// The model's correction channel for the deterministic router: it sees both
// the question and the data it was handed, so it is the last line of defense
// against misroutes — and it can pin the exact entity on screen.
const CTX =
  " SCREEN CONTEXT: A window on screen follows this conversation, and YOU control what it shows. If the data you " +
  "were given is the WRONG DOMAIN for the user's request (they asked about email but you got document sources, " +
  'asked about documents but got the inbox, and so on), output ONLY <<ctx:{"reroute":"inbox"}>> (or "docs" or ' +
  '"workspace") and nothing else — the system redoes the turn with the right data. Whenever your answer discusses ' +
  'one specific email from the list, you MUST start your reply with <<ctx:{"email_id":ID}>> so the screen shows ' +
  "THAT email — every time, follow-ups included; the screen may otherwise be showing a stale email from earlier.";

// Email bodies get shown in the UI and read aloud; angle-bracketed and long
// tracking URLs (newsletter plumbing) are pure noise in both registers.
const cleanBody = (s: string) =>
  s
    .replace(/<https?:\/\/[^>]*>/g, " ")
    .replace(/https?:\/\/\S{12,}/g, "(link)")
    .replace(/\s+/g, " ")
    .trim();

// Outbound sends must be idempotent: the voice pipeline delivers turns
// at-least-once (duplicate requests observed 1s apart), and a re-generated
// turn re-tags its action — without this guard that meant duplicate emails.
// Same send target within the window → refuse, truthfully.
const recentSends = new Map<string, number>();
function duplicateSend(key: string, ttlMs = 120_000): boolean {
  const now = Date.now();
  for (const [k, t] of recentSends) if (now - t > ttlMs) recentSends.delete(k);
  if (recentSends.has(key)) return true;
  recentSends.set(key, now);
  return false;
}

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
      if (duplicateSend(`${tenantId}:reply:${row.id}`))
        return "I just sent a reply on that thread moments ago, so I held this one to avoid a duplicate. If you really want another, give it a minute and ask again.";
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
      if (duplicateSend(`${tenantId}:compose:${to}`))
        return "I just sent an email to that address moments ago, so I held this one to avoid a duplicate. If you really want another, give it a minute and ask again.";
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
    if (a.type === "stage_reply") {
      const row = db
        .prepare(`SELECT id, from_addr, subject, body, received_at, status FROM inbound_emails WHERE id = ? AND tenant_id = ?`)
        .get(a.email_id, tenantId) as UiEmail | undefined;
      if (!row) return "I couldn't find that email, so nothing was staged.";
      const body = (a.body ?? "").trim();
      if (!body) return "I didn't catch what the reply should say, so nothing was staged.";
      updateEmail(row.id, { draft_reply: body, draft_confident: 1, status: "drafted", sent_at: null });
      publishUiContext(tenantId, "inbox", {
        ...row,
        body: cleanBody(row.body).slice(0, 1200),
        draft_reply: body,
        status: "drafted",
        sent_at: null,
      });
      return null;
    }
    if (a.type === "forward_email") {
      const to = (a.to ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return "I don't have a valid address to forward that to, so nothing was sent.";
      const row = db
        .prepare(`SELECT id, from_addr, subject, body, received_at FROM inbound_emails WHERE id = ? AND tenant_id = ?`)
        .get(a.email_id, tenantId) as { id: number; from_addr: string; subject: string; body: string; received_at: string | null } | undefined;
      if (!row) return "I couldn't find that email, so nothing was forwarded.";
      if (!replySendingConfigured()) return "Email sending isn't configured on the server, so nothing was forwarded.";
      if (duplicateSend(`${tenantId}:forward:${row.id}:${to}`))
        return "I just forwarded that email there moments ago, so I held this one to avoid a duplicate.";
      const note = (a.note ?? "").trim();
      await sendEmail({
        to,
        subject: /^fwd?:/i.test(row.subject) ? row.subject : `Fwd: ${row.subject}`,
        text:
          (note ? note + "\n\n" : "") +
          `---------- Forwarded message ----------\nFrom: ${row.from_addr}\nDate: ${row.received_at ?? ""}\nSubject: ${row.subject}\n\n${row.body}`,
      });
      return null;
    }
    if (a.type === "archive_email") {
      const row = db
        .prepare(`SELECT id, from_addr, subject FROM inbound_emails WHERE id = ? AND tenant_id = ?`)
        .get(a.email_id, tenantId) as { id: number } | undefined;
      if (!row) return "I couldn't find that email, so nothing was archived.";
      await applyCleanup(tenantId, [a.email_id]); // reversible Gmail archive; marks handled locally either way
      publishUiContext(tenantId, "inbox", null);
      return null;
    }
    if (a.type === "archive_newsletters") {
      const ids = previewCleanup(tenantId).map((i) => i.id);
      if (!ids.length) return "There's no newsletter clutter left to archive, the inbox is already tidy.";
      await applyCleanup(tenantId, ids);
      publishUiContext(tenantId, "inbox", null);
      return null;
    }
    if (a.type === "categorize_email") {
      if (!(CATEGORIES as readonly string[]).includes(a.category))
        return "The categories are new business, support, vendor partner, recruiting, newsletter spam, and other.";
      const row = db
        .prepare(`SELECT id, from_addr, subject, body, received_at, draft_reply, status, sent_at FROM inbound_emails WHERE id = ? AND tenant_id = ?`)
        .get(a.email_id, tenantId) as UiEmail | undefined;
      if (!row) return "I couldn't find that email, so nothing was re-filed.";
      updateEmail(row.id, { category: a.category });
      invalidateLexicon(tenantId);
      publishUiContext(tenantId, "inbox", { ...row, body: cleanBody(row.body).slice(0, 1200) });
      return null;
    }
    if (a.type === "add_task" || a.type === "add_event" || a.type === "add_note") {
      if (!a.title?.trim()) return "I didn't catch what to add, so nothing was saved.";
      const kind = a.type.slice(4);
      createItem(tenantId, kind, a.title.trim(), a.body?.trim() || undefined, a.at?.trim() || undefined);
      invalidateLexicon(tenantId); // new entity words exist now
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
    if (a.type === "show_window") {
      if (!WINDOWS.includes(a.window)) return "I don't have a window by that name.";
      publishUiContext(tenantId, a.window);
      return null;
    }
    if (a.type === "set_theme") {
      if (!THEMES.includes(a.theme)) return "The themes are ember, graphite, nebula, signal, and ivory.";
      publishUiContext(tenantId, null, undefined, a.theme);
      return null;
    }
    return "I don't know how to do that yet, so nothing happened.";
  } catch (e) {
    return "That didn't go through: " + (e instanceof Error ? e.message : "unknown error") + ". Nothing was changed.";
  }
}

// ---- context engine: intent routing ----
// Three deterministic layers, all zero-latency, then a model correction
// channel (<<ctx:...>>) as the backstop for whatever they miss:
//   1. domain vocabulary ("inbox", "contract", "schedule"),
//   2. a live per-tenant LEXICON — the names actually in this tenant's world
//      (senders, document names, task words), so "what did Dana say?" routes
//      to inbox because Dana is in THIS inbox,
//   3. routed-intent memory — follow-ups stick to what the router actually
//      chose last turn, never re-parsed from prose.
// Negated mentions ("not the inbox, the contract") are masked before matching.
type Intent = "chat" | "inbox" | "docs" | "workspace";
const WORKSPACE_RE = /\b(schedules?|calendars?|appointments?|meetings?|events?|tasks?|to-?dos?|notes?|reminders?)\b/;
const INBOX_RE = /\b(inbox|e-?mails?|reply|replies|senders?|unread|mailbox|triage|newsletters?|spam|messages?|inquir(y|ies)|correspondence)\b/;
const DOCS_RE = /\b(documents?|contracts?|clauses?|agreements?|pdf|files?|polic(y|ies)|sellers?|buyers?|closing|deposit|price|propert(y|ies)|street|inspection|addend(um|a)|warranty)\b/;

// Mask "not/no/don't <phrase>" so negated domains don't count as signals.
function maskNegations(s: string): string {
  return s.replace(/\b(?:no|not|don'?t|never|stop|forget)\b(?:\s+(?:the|my|that|about|to|a))?\s+\w+/g, " ");
}

function strongSignal(s: string): Intent | null {
  if (WORKSPACE_RE.test(s)) return "workspace";
  if (INBOX_RE.test(s)) return "inbox";
  if (DOCS_RE.test(s)) return "docs";
  return null;
}

// Per-tenant lexicon of real entity words, rebuilt at most once a minute.
// This is what lets the router understand names instead of only nouns.
const GENERIC = new Set([
  "gmail", "yahoo", "outlook", "hotmail", "icloud", "google", "noreply", "no-reply", "notifications",
  "info", "hello", "support", "team", "mail", "admin", "update", "updates", "account", "workspace",
  "uploads", "docs", "images", "week", "this", "your", "with", "from", "about",
]);
interface Lexicon { inbox: Set<string>; docs: Set<string>; ws: Set<string> }
const lexCache = new Map<string, { at: number; lex: Lexicon }>();

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !GENERIC.has(w));
}

function lexiconFor(tenantId: string): Lexicon {
  const hit = lexCache.get(tenantId);
  if (hit && Date.now() - hit.at < 60_000) return hit.lex;
  const lex: Lexicon = { inbox: new Set(), docs: new Set(), ws: new Set() };
  try {
    const emails = db
      .prepare(`SELECT from_addr, subject, body FROM inbound_emails WHERE tenant_id = ? ORDER BY id DESC LIMIT 300`)
      .all(tenantId) as { from_addr: string; subject: string; body: string }[];
    for (const e of emails) {
      tokens(e.from_addr).forEach((t) => lex.inbox.add(t));
      tokens(e.subject).forEach((t) => lex.inbox.add(t));
      // sender names usually live in the first line of real emails ("Hi, I'm Dana...")
      tokens(e.body.slice(0, 200)).forEach((t) => lex.inbox.add(t));
    }
    const docs = db.prepare(`SELECT path, title FROM documents WHERE tenant_id = ?`).all(tenantId) as {
      path: string;
      title: string | null;
    }[];
    for (const d of docs) {
      tokens(d.path.split("/").pop() ?? "").forEach((t) => lex.docs.add(t));
      tokens(d.title ?? "").forEach((t) => lex.docs.add(t));
    }
    for (const kind of ["task", "event", "note"] as const) {
      for (const i of listItems(tenantId, kind)) tokens(i.title).forEach((t) => lex.ws.add(t));
    }
  } catch {
    /* lexicon is best-effort */
  }
  lexCache.set(tenantId, { at: Date.now(), lex });
  return lex;
}

// Exported for the action layer: entity words changed (new task, new draft),
// so the lexicon should refresh on the next turn.
function invalidateLexicon(tenantId: string): void {
  lexCache.delete(tenantId);
}

function routeIntent(tenantId: string, question: string, history: VoiceTurn[]): Intent {
  const raw = question.toLowerCase().trim();
  const s = maskNegations(raw);
  if (
    (raw.split(/\s+/).length <= 2 && !strongSignal(s)) ||
    /^(hi|hey|hello|yo|sup|thanks|thank you|good (morning|afternoon|evening))\b/.test(raw) ||
    /\b(who are you|what can you do|what do you do|how are you|your name)\b/.test(raw)
  )
    return "chat";
  // Layer 1: explicit domain vocabulary (negations masked).
  const own = strongSignal(s);
  if (own) return own;
  // Layer 2: the tenant's own entities. Score each domain by distinct hits.
  const lex = lexiconFor(tenantId);
  const qTokens = tokens(s);
  const score = (set: Set<string>) => qTokens.filter((t) => set.has(t)).length;
  const scores: [Intent, number][] = [
    ["inbox", score(lex.inbox)],
    ["docs", score(lex.docs)],
    ["workspace", score(lex.ws)],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  if (scores[0][1] > 0 && scores[0][1] > scores[1][1]) return scores[0][0];
  // Layer 3: what did we actually route last turn? (Server-side memory, with
  // a history re-scan only as the cold-restart fallback.)
  const last = getLastIntent(tenantId);
  if (last === "inbox" || last === "docs" || last === "workspace") return last;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue; // never route on assistant prose
    const inherited = strongSignal(maskNegations(history[i].text.toLowerCase()));
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
  history: VoiceTurn[] = [],
  forced?: Intent // set on a model-requested reroute; never recurses twice
): Promise<void> {
  const intent = forced ?? routeIntent(tenantId, question, history);
  if (intent !== "chat") setLastIntent(tenantId, intent);
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
      CTX +
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
      CTX +
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
    const wordsOf = (s: string) =>
      s
        .toLowerCase()
        .split(/[^a-z0-9@.]+/)
        .map((w) => w.replace(/^[.@]+|[.@]+$/g, "")) // dots stay for fly.io, not sentence punctuation
        .filter((w) => w.length > 3 && !STOP.has(w));
    // The current question outweighs conversation residue: an entity named NOW
    // beats one mentioned two turns ago.
    const qNow = wordsOf(question);
    const qPast = wordsOf(history.slice(-4).map((h) => h.text).join(" "));
    const qWords = [...new Set([...qNow, ...qPast])];
    const scored = rows
      .map((r) => {
        // Names usually live in the body's opening lines ("Hi, I'm Dana..."),
        // not the sender address or subject — match against all three.
        const hay = (r.from_addr + " " + r.subject + " " + r.body.slice(0, 250)).toLowerCase();
        let score = 0;
        for (const w of new Set(qNow)) if (hay.includes(w)) score += 2;
        for (const w of new Set(qPast)) if (hay.includes(w)) score += 1;
        return { r, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score); // rows are newest-first, sort is stable → recency tiebreak
    const matches = scored.map((x) => x.r);
    const drafted = rows.filter((r) => r.draft_reply);
    // Surface the email under discussion, content included. "The latest email"
    // is an explicit recency reference; otherwise only a real entity match or
    // a pending draft may focus — never a silent most-recent fallback.
    const wantsLatest = /\b(last|latest|newest|most recent)\b/.test(question.toLowerCase());
    const focus = (wantsLatest ? rows[0] : null) ?? matches[0] ?? drafted.find((r) => r.status === "drafted") ?? null;
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
      CTX +
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
      CTX +
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

  // The reply stream is multiplexed: it may open with up to two structured
  // tags — <<action:{...}>> (do something) and/or <<ctx:{...}>> (fix the
  // routing or pin an entity on screen) — followed by speech. Tags are parsed
  // out and executed BEFORE any speech is released; a ctx reroute aborts the
  // turn so it can re-run against the right data.
  let reroute: Intent | null = null;
  let acted = false; // an action executed — this turn must never be regenerated

  const runOnce = async (): Promise<void> => {
    const stream = client.messages.stream({
      model: VOICE_MODEL,
      max_tokens: 400,
      thinking: { type: "disabled" }, // no thinking → fast first token for speech
      system,
      messages: [{ role: "user", content: userContent }],
    });

    const HEADS = ["<<action:", "<<ctx:"];
    let mode: "detect" | "collect" | "pass" = "detect";
    let buf = "";
    let tagsSeen = 0;

    // Returns "stop" when the turn must end (action failure spoken, or reroute).
    const handleTag = async (kind: string, raw: string): Promise<"stop" | "go"> => {
      if (kind === "action") {
        acted = true; // side effects may occur from here — no turn regeneration
        let failure: string | null = "I couldn't make sense of that request, so nothing happened.";
        try {
          failure = await executeAction(tenantId, JSON.parse(raw) as Action);
        } catch {
          /* failure message stands */
        }
        if (failure) {
          await emit(failure);
          return "stop"; // suppress the model's now-false confirmation
        }
        return "go";
      }
      // ctx: routing correction / entity focus. Malformed ctx is ignored.
      try {
        const c = JSON.parse(raw) as { reroute?: string; email_id?: number; window?: string };
        // Rerouting to the domain we're already in is meaningless — ignore it
        // (a stop here produced silent turns: reroute → re-run → ignored tag →
        // empty reply → "Brain returned no response").
        if (c.reroute && c.reroute !== intent && !forced && !emitted && ["inbox", "docs", "workspace"].includes(c.reroute)) {
          reroute = c.reroute as Intent;
          return "stop";
        }
        if (typeof c.email_id === "number") {
          const row = db
            .prepare(
              `SELECT id, from_addr, subject, body, received_at, draft_reply, status, sent_at FROM inbound_emails
               WHERE id = ? AND tenant_id = ?`
            )
            .get(c.email_id, tenantId) as UiEmail | undefined;
          if (row) publishUiContext(tenantId, "inbox", { ...row, body: cleanBody(row.body).slice(0, 1200) });
        } else if (c.window && WINDOWS.includes(c.window)) {
          publishUiContext(tenantId, c.window);
        }
      } catch {
        /* ignore malformed ctx */
      }
      return "go";
    };

    const feed = async (t: string): Promise<"stop" | "go"> => {
      if (mode === "pass") {
        await emit(t);
        return "go";
      }
      buf += t;
      // Loop: one delta can complete a tag AND begin the next (or the speech).
      for (;;) {
        if (mode === "detect") {
          const full = HEADS.find((h) => buf.startsWith(h));
          if (full) {
            mode = "collect";
          } else if (HEADS.some((h) => h.startsWith(buf))) {
            return "go"; // still a possible tag prefix; wait for more
          } else {
            mode = "pass";
            const out = buf;
            buf = "";
            if (out) await emit(out);
            return "go";
          }
        }
        // collect
        const head = HEADS.find((h) => buf.startsWith(h))!;
        const end = buf.indexOf(">>");
        if (end < 0) {
          if (buf.length > 1500) {
            // runaway tag; bail out and just speak it
            mode = "pass";
            const out = buf;
            buf = "";
            await emit(out);
          }
          return "go";
        }
        const kind = head.slice(2, head.length - 1); // "action" | "ctx"
        const raw = buf.slice(head.length, end);
        buf = buf.slice(end + 2).replace(/^\s+/, "");
        tagsSeen++;
        if ((await handleTag(kind, raw)) === "stop") return "stop";
        if (tagsSeen >= 2) {
          mode = "pass";
          const out = buf;
          buf = "";
          if (out) await emit(out);
          return "go";
        }
        mode = "detect";
        if (!buf) return "go";
        // else: loop again — buf may already hold the next tag or the speech
      }
    };

    for await (const ev of stream) {
      if (ev.type !== "content_block_delta" || ev.delta.type !== "text_delta") continue;
      if ((await feed(ev.delta.text)) === "stop") {
        try {
          (stream as any).controller?.abort?.();
        } catch {
          /* stream may already be done */
        }
        return;
      }
    }
    if (buf && (mode as string) !== "pass") await emit(buf); // stream ended mid-detect (mode mutates inside feed)
  };

  try {
    await runOnce();
  } catch (e) {
    if (emitted) throw e; // partial speech already out — don't double-speak
    if (acted) {
      // The action already happened; regenerating the turn would replay it
      // (this exact path double-sent an email). Confirm truthfully instead.
      await emit("That went through, but I glitched while wrapping up. The action is done.");
      return;
    }
    await new Promise((r) => setTimeout(r, 600));
    await runOnce(); // one transparent retry for transient API failures
  }

  // Model-requested reroute: the deterministic router picked the wrong domain
  // and the model could tell from the data. Re-run once with the right one.
  if (reroute && !emitted) {
    await streamVoiceReply(tenantId, question, onDelta, history, reroute);
  }
}
