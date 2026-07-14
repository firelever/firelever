// Low-latency streaming answers for the voice path (ElevenLabs Custom LLM).
// The text UI uses answer.ts (Opus + structured output + citations) for max
// quality; voice needs the first spoken word out in a few seconds or ElevenLabs
// times out the turn. On the small prod CPU each model round-trip is ~2s, so
// this path minimizes them: keyword intent routing over the conversation (no
// LLM call), one retrieval, and a single streaming answer call.
import { client } from "../llm.js";
import { getEmbedder } from "./embeddings.js";
import { search } from "./retrieval.js";
import { listItems, createItem, updateItem, deleteItem } from "../workspace/store.js";
import {
  calendarConfigured,
  calendarTimeZone,
  listEvents,
  createEvent,
  updateEvent,
  cancelEvent,
  rememberGids,
  resolveGid,
} from "../calendar/google.js";
import { updateEmail } from "../triage/store.js";
import { sendReply, sendEmail, replySendingConfigured } from "../triage/send.js";
import { draftReply as engineDraftReply, CATEGORIES } from "../triage/engine.js";
import { previewCleanup, applyCleanup, labelInGmail } from "../triage/cleanup.js";
import { publishUiContext, publishUiDocs, publishUiEvent, getLastIntent, setLastIntent, UiEmail } from "../server/ui-context.js";
import { addMemory, memoryBlock } from "./memory.js";
import { upsertContact, contactByName, contactsBlock, isKnownAddress } from "./contacts.js";
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
  "symbols entirely: say 'at' not @, 'and' not &, 'percent' not %, and 'dollars' for $ amounts. " +
  "NUMBERS: never put a comma inside a number (write 288000 dollars or 288 thousand dollars, never 288,000 — " +
  "the voice pauses at the comma). House numbers, street numbers, unit numbers, and zip codes are read digit " +
  "by digit: write them with spaces, so 4834 Ute Street becomes '4 8 3 4 Ute Street'.";

// ---- action protocol ----
// The voice model can DO a small set of things, not just talk. It tags exactly
// one action at the START of its reply; the server executes it BEFORE the
// confirmation is spoken (never claim first, act first), and the model is
// forbidden from claiming actions it didn't tag.
type Action =
  | { type: "send_reply"; email_id: number; body?: string }
  | { type: "stage_reply"; email_id: number; body: string }
  | { type: "compose_email"; to: string; subject: string; body: string; contact_name?: string }
  | { type: "send_email" }
  | { type: "draft_reply"; email_id: number; guidance?: string }
  | { type: "forward_email"; email_id: number; to: string; note?: string }
  | { type: "archive_email"; email_id: number }
  | { type: "archive_emails"; email_ids: number[] }
  | { type: "archive_newsletters" }
  | { type: "categorize_email"; email_id: number; category: string }
  | { type: "add_task" | "add_event" | "add_note"; title: string; body?: string; at?: string; duration_minutes?: number; meet?: boolean; invite?: string[]; contact_name?: string }
  | { type: "update_event"; id?: string | number; match?: string; title?: string; at?: string; duration_minutes?: number; meet?: boolean; invite?: string[]; contact_name?: string }
  | { type: "cancel_event"; id?: string | number; match?: string }
  | { type: "complete_task"; id: number }
  | { type: "remember"; note: string }
  | { type: "show_documents"; match?: string }
  | { type: "show_window"; window: string }
  | { type: "set_theme"; theme: string };

const WINDOWS = ["answer", "inbox", "schedule", "tasks", "notes", "contract", "library"];
const THEMES = ["ember", "graphite", "nebula", "signal", "ivory"];

const ACTIONS =
  " ACTIONS: When the user asks you to DO one of these things, begin your reply with exactly one action tag, then the spoken confirmation: " +
  "REPLY FLOW — replies are previewed before they leave: when the user dictates or requests a reply, stage it first with " +
  '<<action:{"type":"stage_reply","email_id":ID,"body":"the full reply, plain and warm, signed Peter"}>> — it appears on screen — then briefly say what it says and ask if you should send it. ' +
  'When they confirm (or say send the draft), <<action:{"type":"send_reply","email_id":ID}>> sends the staged/unsent draft. Never send dictated content without staging it for review first. ' +
  "You can stage and send on a thread any number of times, including after an earlier reply was sent; if they want changes, stage again with the revised body. " +
  '<<action:{"type":"draft_reply","email_id":ID,"guidance":"what the user wants it to say"}>> has me write a grounded draft for review instead (use when they want a fuller composed reply). ' +
  "COMPOSE FLOW — brand-new emails are previewed before they leave, exactly like replies: " +
  '<<action:{"type":"compose_email","to":"name@domain.com","subject":"...","body":"...","contact_name":"Dana"}>> STAGES the new email on screen without sending; the recipient address must be explicit in the conversation or in CONTACTS, ask if it is missing or you would be guessing. ' +
  'Always include "contact_name" with the person\'s name when the recipient is a person — the system remembers their address for next time. ' +
  "ADDRESS GATE: any dictated address not already in CONTACTS makes the system spell it back and ask before acting (voice mishears spellings). When the user confirms it's right, tag the SAME action again with the SAME address and it will go through; if they correct the spelling, tag with the corrected address instead. " +
  'After staging, briefly say what it says and ask if you should send it. When they confirm, <<action:{"type":"send_email"}>> sends the staged email. Nothing ever goes out on compose_email alone. ' +
  '<<action:{"type":"forward_email","email_id":ID,"to":"name@domain.com","note":"optional line to include"}>> forwards that email; the address must be explicit, ask if it is not. ' +
  '<<action:{"type":"archive_email","email_id":ID}>> archives one email (moves it out of the inbox in Gmail; reversible). ' +
  '<<action:{"type":"archive_emails","email_ids":[ID,ID]}>> archives SPECIFIC emails by their ids — use this when the user agrees to archive particular emails you named (test mail, receipts, notifications). ' +
  '<<action:{"type":"archive_newsletters"}>> archives ONLY the newsletter and promo category in one sweep; never use it for other emails. ' +
  "Deleting email is deliberately not supported, archiving is the safe reversible equivalent, offer it instead. " +
  '<<action:{"type":"categorize_email","email_id":ID,"category":"new_business|support|vendor_partner|recruiting|newsletter_spam|other"}>> re-files an email under a different category. ' +
  '<<action:{"type":"add_task","title":"..."}>> likewise add_event and add_note (optional "at":"YYYY-MM-DD HH:MM", optional "body"). ' +
  'CALENDAR: when Google Calendar is connected, add_event books a REAL calendar event — include "at" with an explicit date AND time (ask if you only have one of them), optional "duration_minutes" (default 30), ' +
  '"meet":true to attach a Google Meet video link, and "invite":["addr@domain.com"] ONLY when the address is explicit in the conversation or CONTACTS; never guess an invitee\'s email, ask for it. Include "contact_name" when inviting a person. ' +
  '<<action:{"type":"update_event","id":"g2","at":"YYYY-MM-DD HH:MM","duration_minutes":45,"title":"...","meet":true,"invite":["addr@domain.com"],"contact_name":"Dana"}>> reschedules, moves, renames, extends, adds a Meet link, or FIXES THE GUEST LIST of an existing event — "invite" replaces the guests entirely (use it to correct a wrong invite address); include only the fields being changed. ' +
  'Use the [gN] id shown in the schedule for Google Calendar events, or the numeric [id N] for local ones; if you have NOT seen a schedule listing this conversation, pass "match":"words from the event title" instead of an id and the system finds it. ' +
  '<<action:{"type":"cancel_event","id":"g2"}>> cancels an event; invitees are notified and it is recoverable from the calendar trash, so it is safe. ' +
  '<<action:{"type":"complete_task","id":ID}>> checks a task off. ' +
  '<<action:{"type":"show_documents","match":"Ute Street"}>> pulls the document LIBRARY onto the screen — all documents when "match" is omitted, or only the documents whose CONTENT relates to the match phrase (use it when the user asks to see their documents, or everything about a property, deal, or person). ' +
  '<<action:{"type":"show_window","window":"answer|inbox|schedule|tasks|notes|contract|library"}>> puts that window on screen when the user asks to see, open, switch to, or go back to it (inbox is the Inbox window, notes is Prep, library is Documents). ' +
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
  '"workspace") and nothing else — the system redoes the turn with the right data. Contract people and terms ' +
  "(sellers, buyers, listing agents, brokers, prices, deposits, closings) live in the DOCUMENTS: if you were " +
  'given the inbox for one of those, reroute to "docs" instead of saying the inbox lacks it. If the user is asking about ' +
  "their documents but the provided sources do not contain the answer, do NOT give up: output ONLY " +
  '<<ctx:{"search":"a better search query naming the document and the thing sought"}>> and nothing else — the ' +
  "system searches again and redoes the turn (one retry; if the retried sources still lack it, say so plainly). " +
  'Whenever your answer discusses ONE specific email from the list, you MUST start your reply with ' +
  '<<ctx:{"email_id":ID}>> so the screen shows THAT email — every time, follow-ups included; the screen may ' +
  "otherwise be showing a stale email from earlier. But when your answer is an OVERVIEW of several emails " +
  "(what's in the inbox, what needs replies, what to clean up), do NOT pin any single one — the screen shows " +
  "the inbox list, which is right for an overview.";

// Attached-document names ride along everywhere an email is shown or given
// to the model: attachments are the core artifact, never a footnote.
const attachmentsOf = (json: string | null | undefined): string[] | undefined => {
  try {
    const a = JSON.parse(json ?? "null");
    return Array.isArray(a) && a.length ? a : undefined;
  } catch {
    return undefined;
  }
};

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

// Staged new emails (compose preview parity with replies): compose_email
// stages here and on screen; only a confirmed send_email actually sends.
// Sent this way, nothing outbound ever skips the preview.
const stagedComposes = new Map<string, { to: string; subject: string; body: string; at: number; contactName?: string }>();
const STAGED_TTL_MS = 15 * 60 * 1000;

// Every branch tells the model what day it is — in the calendar's timezone
// when one is connected. Without this, a turn routed through the inbox branch
// once booked "tomorrow" as a date from the model's training era (June 2025).
async function todayLine(): Promise<string> {
  let tz = "UTC";
  if (calendarConfigured()) tz = await calendarTimeZone().catch(() => "UTC");
  const d = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: tz });
  return `Today is ${d}${tz !== "UTC" ? ` (${tz} time)` : ""}.`;
}

// Resolve which calendar event an action refers to: a [gN] id from a listing,
// or a "match" phrase scored against upcoming event titles. Returns the gid,
// or a spoken question when it genuinely can't tell.
async function findCalendarTarget(
  tenantId: string,
  ref: string,
  match: string | undefined
): Promise<{ gid: string } | { ask: string }> {
  if (/^g\d+$/.test(ref)) {
    const gid = resolveGid(tenantId, ref);
    if (gid) return { gid };
  }
  const evs = await listEvents(60);
  rememberGids(tenantId, evs);
  if (evs.length === 0) return { ask: "There's nothing on your Google Calendar in the next two months, so I have no event to change." };
  if (evs.length === 1) return { gid: evs[0].gid }; // only one event: "that meeting" is unambiguous
  const words = tokens(match ?? "");
  if (words.length) {
    const scored = evs
      .map((e) => ({ e, score: words.filter((w) => e.title.toLowerCase().includes(w)).length }))
      .sort((a, b) => b.score - a.score);
    if (scored[0].score > 0 && scored[0].score > (scored[1]?.score ?? 0)) return { gid: scored[0].e.gid };
  }
  const names = evs.slice(0, 3).map((e) => `${e.title} on ${spokenWhen(e.start.replace("T", " "))}`).join("; ");
  return { ask: `I see a few upcoming: ${names}. Which one do you mean?` };
}

// COHERENCE SENTINEL for replies: a reply written for one person must never
// land on another sender's thread. A "Hi Dana" draft was once staged onto a
// Google billing notice (the model hallucinated email_id 1) — one Approve
// from replying to workspace@google.com. The salutation is cross-examined
// against the target thread before anything is staged or sent.
function replyThreadMismatch(
  tenantId: string,
  draftBody: string,
  row: { from_addr: string; subject: string; body: string }
): string | null {
  const m = draftBody.trim().match(/^(?:hi|hello|hey|dear)[ ,]+([a-z][a-z'-]+)/i);
  if (!m) return null;
  const name = m[1];
  const hay = (row.from_addr + " " + row.subject + " " + row.body.slice(0, 400)).toLowerCase();
  if (new RegExp(`\\b${name.toLowerCase()}\\b`).test(hay)) return null; // thread involves them
  const contact = contactByName(tenantId, name);
  if (contact && row.from_addr.toLowerCase().includes(contact.email)) return null;
  return (
    `Hold on: that reply is written for ${name}, but the thread I was about to put it on is from ` +
    `${row.from_addr.replace("@", " at ")}, subject "${row.subject.slice(0, 50)}". That looks like the wrong thread, ` +
    `so I haven't staged anything. Which email should this reply go on?`
  );
}

// Speak an address the way a careful human confirms one: the local part
// letter by letter, symbols named, the domain in words. "metapd@gmail.com"
// becomes "m, e, t, a, p, d, at gmail dot com".
function spellEmail(email: string): string {
  const [local, domain] = email.toLowerCase().split("@");
  const spelled = [...(local ?? "")]
    .map((ch) => (ch === "." ? "dot" : ch === "_" ? "underscore" : ch === "-" ? "dash" : ch === "+" ? "plus" : ch))
    .join(", ");
  return `${spelled}, at ${(domain ?? "").replace(/\./g, " dot ")}`;
}

// THE ADDRESS GATE. Voice dictation cannot distinguish "metapd" from
// "metapetey", so no first-time address is ever used on faith:
//  - on file (any contact) -> pass silently, it was confirmed once already;
//  - conflicts with this person's known address -> name both, ask which;
//  - brand new -> spell it back letter by letter and ask.
// The question arms a short-lived pending slot; when the user confirms and
// the model re-tags the action with the SAME address, it passes. A corrected
// address starts a fresh round. Deterministic — not left to model attention.
const pendingAddress = new Map<string, { email: string; at: number }>();
const PENDING_TTL_MS = 3 * 60 * 1000;

function addressGate(tenantId: string, contactName: string | undefined, email: string): string | null {
  const e = email.trim().toLowerCase();
  const pending = pendingAddress.get(tenantId);
  if (pending && pending.email === e && Date.now() - pending.at < PENDING_TTL_MS) {
    pendingAddress.delete(tenantId); // user heard the spell-back and confirmed
    return null;
  }
  if (isKnownAddress(tenantId, e)) return null;
  const known = contactName?.trim() ? contactByName(tenantId, contactName) : null;
  pendingAddress.set(tenantId, { email: e, at: Date.now() });
  if (known)
    return `Hold on: I have ${known.name} at ${known.email.replace("@", " at ")} from before, but this time I heard ${spellEmail(e)}. Which one should I use?`;
  return `That address is new to me, and spellings are easy to mishear, so let me read it back: ${spellEmail(e)}. Did I get every letter right?`;
}

// Server-truth confirmations are spoken by TTS, so dates must be said the way
// a person says them: "Tuesday July 14 at 1 PM", never "2026-07-14 13:00".
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function spokenWhen(at: string): string {
  const m = at.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return at;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  let h = +m[4];
  const min = +m[5];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} at ${h}${min ? ":" + String(min).padStart(2, "0") : ""} ${ap}`;
}

// Short present-tense label for the activity feed while an action executes.
function actionLabel(a: Action): string {
  switch (a.type) {
    case "send_reply": return `Sending reply on email ${a.email_id}`;
    case "stage_reply": return `Staging reply for review`;
    case "compose_email": return `Staging new email to ${a.to}`;
    case "send_email": return `Sending staged email`;
    case "draft_reply": return `Drafting a reply`;
    case "forward_email": return `Forwarding email to ${a.to}`;
    case "archive_email": return `Archiving email in Gmail`;
    case "archive_emails": return `Archiving ${(a.email_ids ?? []).length} emails in Gmail`;
    case "archive_newsletters": return `Sweeping newsletters to archive`;
    case "categorize_email": return `Filing as ${a.category?.replace(/_/g, " ")}`;
    case "add_task": return `Adding task`;
    case "add_event": return calendarConfigured() ? `Booking on Google Calendar` : `Adding event`;
    case "add_note": return `Adding note`;
    case "update_event": return `Updating calendar event`;
    case "cancel_event": return `Cancelling event`;
    case "complete_task": return `Checking off task`;
    case "remember": return `Saving to memory`;
    case "show_documents": return a.match ? `Finding documents about ${a.match}` : `Opening the document library`;
    case "show_window": return `Opening ${a.window} window`;
    case "set_theme": return `Switching theme to ${a.theme}`;
    default: return "Working";
  }
}

// Returns a spoken sentence that REPLACES the model's confirmation, or null
// when the model's own confirmation may stand. Two cases return a sentence:
// failures, and count-bearing bulk actions (archive, categorize) — for those
// the model would otherwise invent a confirmation ("swept it all!") that the
// server never verified, so the server speaks its own ground truth instead.
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
      // Sentinel runs at send time too, so a draft mis-staged before the
      // guard existed still cannot leave for the wrong thread.
      const mismatch = replyThreadMismatch(tenantId, body, row);
      if (mismatch) return mismatch;
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
      // Staging only — the send happens in send_email after the user approves
      // the on-screen preview. Compose once skipped the preview entirely.
      const to = (a.to ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return "I don't have a valid email address for that, so nothing was staged.";
      const body = (a.body ?? "").trim();
      if (!body) return "I didn't catch what the email should say, so nothing was staged.";
      const mismatch = addressGate(tenantId, a.contact_name, to);
      if (mismatch) return mismatch;
      const subject = (a.subject ?? "").trim() || "(no subject)";
      stagedComposes.set(tenantId, { to, subject, body, at: Date.now(), contactName: a.contact_name?.trim() });
      publishUiContext(tenantId, "inbox", {
        id: -1,
        from_addr: to,
        subject,
        received_at: null,
        body: "",
        draft_reply: body,
        status: "compose",
        sent_at: null,
      });
      return `Staged. The new email to ${to.replace("@", " at ")} is on your screen. Want me to send it?`;
    }
    if (a.type === "send_email") {
      const staged = stagedComposes.get(tenantId);
      if (!staged || Date.now() - staged.at > STAGED_TTL_MS)
        return "There's no staged email waiting. Tell me who it's for and what it should say, and I'll stage it for review.";
      if (!replySendingConfigured()) return "Email sending isn't configured on the server, so nothing was sent.";
      if (duplicateSend(`${tenantId}:compose:${staged.to}`))
        return "I just sent an email to that address moments ago, so I held this one to avoid a duplicate. If you really want another, give it a minute and ask again.";
      await sendEmail({ to: staged.to, subject: staged.subject, text: staged.body });
      // The user approved this address for this person: remember it, so next
      // time Levi proposes it and catches near-miss dictations.
      if (staged.contactName) upsertContact(tenantId, staged.contactName, staged.to);
      stagedComposes.delete(tenantId);
      publishUiContext(tenantId, "inbox", {
        id: -1,
        from_addr: staged.to,
        subject: staged.subject,
        received_at: null,
        body: "",
        draft_reply: staged.body,
        status: "compose",
        sent_at: new Date().toISOString(),
      });
      return `Sent. "${staged.subject}" is on its way to ${staged.to.replace("@", " at ")}.`;
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
      const mismatch = replyThreadMismatch(tenantId, body, row);
      if (mismatch) return mismatch;
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
      const gate = addressGate(tenantId, undefined, to);
      if (gate) return gate;
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
      const res = await applyCleanup(tenantId, [a.email_id]);
      publishUiContext(tenantId, "inbox", null);
      // Server truth replaces the model's confirmation: archived means the
      // Gmail move happened, not that we hoped it did.
      return res.archived === 1
        ? "Done, it's archived out of your Gmail inbox."
        : "That one isn't in your Gmail inbox anymore, so there was nothing to archive.";
    }
    if (a.type === "archive_emails") {
      const ids = (a.email_ids ?? []).filter((n) => Number.isInteger(n));
      if (!ids.length) return "I didn't catch which emails to archive, so nothing was touched.";
      const known = db
        .prepare(`SELECT COUNT(*) c FROM inbound_emails WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
        .get(tenantId, ...ids) as { c: number };
      if (known.c !== ids.length) return "One of those emails doesn't exist, so I archived nothing. Ask me about the inbox and try again.";
      const res = await applyCleanup(tenantId, ids);
      publishUiContext(tenantId, "inbox", null);
      const missing = res.missing ? ` ${res.missing} ${res.missing === 1 ? "was" : "were"} already out of the inbox.` : "";
      return res.archived
        ? `Done. I archived ${res.archived} email${res.archived === 1 ? "" : "s"} in Gmail.${missing}`
        : `I didn't archive anything.${missing || " Those weren't in your Gmail inbox."}`;
    }
    if (a.type === "archive_newsletters") {
      const ids = previewCleanup(tenantId).map((i) => i.id);
      if (!ids.length) return "There's no newsletter clutter left to archive, the inbox is already tidy.";
      const res = await applyCleanup(tenantId, ids);
      publishUiContext(tenantId, "inbox", null);
      const missing = res.missing ? ` ${res.missing} I couldn't find in the inbox anymore, so I left ${res.missing === 1 ? "it" : "those"} alone.` : "";
      return res.archived
        ? `Done. I archived ${res.archived} newsletter${res.archived === 1 ? "" : "s"} in Gmail.${missing}`
        : `I didn't archive anything.${missing || " The newsletters weren't in your Gmail inbox."}`;
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
      // A category the user can't see in Gmail doesn't count as filed — apply
      // the real label there too, and say plainly when only half of it landed.
      const spoken = a.category.replace(/_/g, " ");
      const labeled = await labelInGmail(tenantId, row.id, a.category).catch(() => false);
      return labeled
        ? `Filed under ${spoken}. You'll see it labeled FireLever ${spoken} in Gmail.`
        : `I recorded it as ${spoken} here, but that message isn't in your Gmail inbox anymore, so no label was applied there.`;
    }
    if (a.type === "add_task" || a.type === "add_event" || a.type === "add_note") {
      if (!a.title?.trim()) return "I didn't catch what to add, so nothing was saved.";
      // Events go on the REAL calendar when it's connected (ADR-016). The
      // spoken confirmation is server truth built from what Google returned.
      if (a.type === "add_event" && calendarConfigured()) {
        if (!a.at?.trim() || !/\d{1,2}:\d{2}/.test(a.at))
          return "I need a date and a time to put that on your Google Calendar. When should it be?";
        const invite = (a.invite ?? []).map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
        if ((a.invite?.length ?? 0) > invite.length)
          return "One of those invite addresses doesn't look right, so I haven't booked it yet. What's the exact email?";
        if (invite.length) {
          const mismatch = addressGate(tenantId, a.contact_name, invite[0]);
          if (mismatch) return mismatch;
        }
        const ev = await createEvent({
          title: a.title.trim(),
          at: a.at.trim(),
          durationMin: a.duration_minutes,
          meet: a.meet,
          attendees: invite,
        });
        invalidateLexicon(tenantId);
        if (a.contact_name && invite.length === 1) upsertContact(tenantId, a.contact_name, invite[0]);
        publishUiContext(tenantId, "schedule", null);
        const who = invite.length === 1 ? ` invite sent to ${invite[0].replace("@", " at ")},` : invite.length > 1 ? ` invites sent to ${invite.length} people,` : "";
        return `Booked. ${a.title.trim()}, ${spokenWhen(a.at)},${ev.meet_link ? " with a Google Meet link," : ""}${who} on your Google Calendar.`;
      }
      const kind = a.type.slice(4);
      createItem(tenantId, kind, a.title.trim(), a.body?.trim() || undefined, a.at?.trim() || undefined);
      invalidateLexicon(tenantId); // new entity words exist now
      publishUiContext(tenantId, kind === "task" ? "tasks" : kind === "event" ? "schedule" : "notes");
      // Asked for calendar features without a connected calendar: be honest
      // about where the event actually lives instead of implying it's booked.
      if (a.type === "add_event" && (a.meet || a.invite?.length))
        return "I put it on my local schedule, but your Google Calendar isn't connected yet, so there's no Meet link or invites. Once the calendar setup is run, I can book real meetings.";
      return null;
    }
    if (a.type === "update_event") {
      const ref = String(a.id ?? "").trim().toLowerCase();
      const invite = (a.invite ?? []).map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
      if ((a.invite?.length ?? 0) > invite.length)
        return "One of those invite addresses doesn't look right, so I haven't changed the guest list. What's the exact email?";
      const fields = {
        title: a.title?.trim() || undefined,
        at: a.at?.trim() || undefined,
        durationMin: a.duration_minutes,
        meet: a.meet || undefined,
        attendees: invite.length ? invite : undefined,
      };
      if (!fields.title && !fields.at && !fields.durationMin && !fields.meet && !fields.attendees)
        return "Tell me what to change about that event: the time, the title, the length, the guest list, or adding a Meet link.";
      if (/^g\d+$/.test(ref) || a.match?.trim() || !ref) {
        if (!calendarConfigured()) return "Your Google Calendar isn't connected, so I can't change that event.";
        if (invite.length) {
          const mismatch = addressGate(tenantId, a.contact_name, invite[0]);
          if (mismatch) return mismatch;
        }
        const target = await findCalendarTarget(tenantId, ref, a.match);
        if ("ask" in target) return target.ask;
        const ev = await updateEvent(target.gid, fields);
        if (a.contact_name && invite.length === 1) upsertContact(tenantId, a.contact_name, invite[0]);
        publishUiContext(tenantId, "schedule", null);
        const guests = fields.attendees ? ` The invite now goes to ${invite.map((i) => i.replace("@", " at ")).join(" and ")}, and the old address was dropped.` : "";
        return `Done. ${ev.title} is ${fields.at ? `now ${spokenWhen(fields.at)}` : "updated"}${fields.meet && ev.meet_link ? ", with a Google Meet link attached" : ""}, on your Google Calendar.${guests || " Anyone invited gets the update."}`;
      }
      const local: { title?: string; at?: string } = {};
      if (fields.title) local.title = fields.title;
      if (fields.at) local.at = fields.at;
      if (Object.keys(local).length && updateItem(tenantId, Number(ref), local)) {
        publishUiContext(tenantId, "schedule");
        return null;
      }
      return "I couldn't find that event, so nothing was changed.";
    }
    if (a.type === "cancel_event") {
      const ref = String(a.id ?? "").trim().toLowerCase();
      if (/^g\d+$/.test(ref) || a.match?.trim() || !ref) {
        if (!calendarConfigured()) return "Your Google Calendar isn't connected, so I can't cancel that event.";
        const target = await findCalendarTarget(tenantId, ref, a.match);
        if ("ask" in target) return target.ask;
        await cancelEvent(target.gid);
        publishUiContext(tenantId, "schedule", null);
        return "Cancelled. Anyone invited gets notified, and it stays in your calendar trash for a month if you change your mind.";
      }
      if (deleteItem(tenantId, Number(ref))) {
        publishUiContext(tenantId, "schedule", null);
        return "Removed it from your schedule.";
      }
      return "I couldn't find that event, so nothing was cancelled.";
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
    if (a.type === "show_documents") {
      const q = a.match?.trim();
      let docs: { path: string; title: string | null; chunks: number; matched?: number }[];
      if (q) {
        // Content-based, not filename-based: "documents about Ute Street"
        // must find the Title Commitment even though "Ute" isn't in its name.
        const hits = await search(tenantId, q, 60, getEmbedder(), "hybrid").catch(() => []);
        // Score-based relevance, not membership: on a small corpus every chunk
        // comes back ranked, so "related" means scoring near the best hit —
        // a document whose best passage is far below the top match is noise.
        const best = hits[0]?.score ?? 0;
        const byDoc = new Map<string, { n: number; top: number }>();
        for (const h of hits) {
          const cur = byDoc.get(h.document_path) ?? { n: 0, top: 0 };
          byDoc.set(h.document_path, { n: cur.n + 1, top: Math.max(cur.top, h.score) });
        }
        const build = (minHits: number) =>
          [...byDoc.entries()]
            .filter(([, v]) => v.n >= minHits && v.top >= best * 0.5)
            .map(([docPath, v]) => { const matched = v.n;
              const row = db
                .prepare(
                  `SELECT d.title, COUNT(c.id) chunks FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
                   WHERE d.tenant_id = ? AND d.path = ? GROUP BY d.id`
                )
                .get(tenantId, docPath) as { title: string | null; chunks: number } | undefined;
              return { path: docPath, title: row?.title ?? null, chunks: row?.chunks ?? 0, matched };
            })
            .sort((x, y) => (y.matched ?? 0) - (x.matched ?? 0));
        docs = build(2); // one stray passage is a coincidence, not a related document
        if (!docs.length) docs = build(1);
        if (!docs.length) return `I don't have any documents related to ${q}. Nothing was pulled up.`;
      } else {
        docs = db
          .prepare(
            `SELECT d.path, d.title, COUNT(c.id) chunks FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
             WHERE d.tenant_id = ? GROUP BY d.id ORDER BY d.ingested_at DESC`
          )
          .all(tenantId) as { path: string; title: string | null; chunks: number }[];
        if (!docs.length) return "There are no documents in the knowledge base yet. Forward or upload one and I'll scan it.";
      }
      publishUiDocs(tenantId, docs.slice(0, 12), q ?? null);
      return `Pulled up ${docs.length} document${docs.length === 1 ? "" : "s"}${q ? ` related to ${q}` : ""}. They're on your screen.`;
    }
    if (a.type === "show_window") {
      if (!WINDOWS.includes(a.window)) return "I don't have a window by that name.";
      publishUiContext(tenantId, a.window, a.window === "inbox" ? undefined : null);
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
const DOCS_RE = /\b(documents?|contracts?|clauses?|agreements?|pdf|files?|polic(y|ies)|sellers?|buyers?|closing|deposit|price|propert(y|ies)|street|inspection|addend(um|a)|warranty|listing|agents?|brokers?|realtors?|escrow|commission)\b/;

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
  // 3-letter tokens are allowed (entity names like "Ute" matter), so common
  // short English words must be screened out explicitly.
  "the", "and", "for", "you", "are", "can", "not", "but", "was", "has", "had", "did", "get", "got",
  "her", "him", "his", "she", "own", "our", "out", "who", "how", "why", "its", "yes", "let", "all",
  "any", "new", "now", "one", "two", "say", "see", "too", "use", "way", "off", "per", "via",
]);
interface Lexicon { inbox: Set<string>; docs: Set<string>; ws: Set<string> }
const lexCache = new Map<string, { at: number; lex: Lexicon }>();

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w)); // 3-char minimum: "Ute" is an entity
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

// Watchdog remediation: dump every cached lexicon and routed intent so the
// next turn rebuilds context from the ground truth in the database.
export function clearVoiceCaches(): void {
  lexCache.clear();
}

function routeIntent(tenantId: string, question: string, history: VoiceTurn[]): Intent {
  const raw = question.toLowerCase().trim();
  const s = maskNegations(raw);
  // Chat is ONLY for greetings, thanks, and questions about Levi himself.
  // An informational question must never land here (the chat branch has no
  // data and can only recite a capability menu). Greetings must be the whole
  // utterance: "hey, what's the price?" is a question, not a greeting.
  const looksLikeQuestion = /\b(who|what|when|where|which|why|how|show|read|tell|find|list|give)\b/.test(raw) || raw.includes("?");
  if (
    /^(hi|hey|hello|yo|sup|thanks|thank you|good (morning|afternoon|evening))[\s!,.…a-z]{0,8}$/.test(raw) ||
    /\b(who are you|what can you do|what do you do|how are you|your name)\b/.test(raw) ||
    (raw.split(/\s+/).length <= 2 && !strongSignal(s) && !looksLikeQuestion)
  )
    return "chat";
  // Layer 1: explicit domain vocabulary (negations masked).
  const own = strongSignal(s);
  if (own) return own;
  // Layer 2: the tenant's own entities. Score each domain by distinct hits.
  // Only a STRONG entity match (2+ distinct hits) may switch domains on its
  // own — emails mention everything, so a single word like "agents" appearing
  // in one email body must not yank an active documents conversation into
  // the inbox. Weak hits only decide when there is no active conversation.
  const lex = lexiconFor(tenantId);
  const qTokens = tokens(s);
  const score = (set: Set<string>) => qTokens.filter((t) => set.has(t)).length;
  const scores: [Intent, number][] = [
    ["inbox", score(lex.inbox)],
    ["docs", score(lex.docs)],
    ["workspace", score(lex.ws)],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  if (scores[0][1] >= 2 && scores[0][1] > scores[1][1]) return scores[0][0];
  // Layer 3: conversational continuity — what did we actually route last
  // turn? Outranks weak single-word lexicon hits.
  const last = getLastIntent(tenantId);
  if (last === "inbox" || last === "docs" || last === "workspace") return last;
  // No active conversation: a weak lexicon hit is better than defaulting.
  if (scores[0][1] > 0 && scores[0][1] > scores[1][1]) return scores[0][0];
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
  forced?: Intent, // set on a model-requested reroute; never recurses twice
  searchOverride?: string // set on a model-requested re-search; never recurses twice
): Promise<void> {
  const intent = forced ?? routeIntent(tenantId, question, history);
  if (intent !== "chat") setLastIntent(tenantId, intent);
  // Narrate the routing decision to the live activity feed — unless this is a
  // reroute/re-search re-run, which announces itself where it's requested.
  if (!forced && !searchOverride && intent !== "chat") {
    const domain = intent === "docs" ? "documents" : intent;
    publishUiEvent(tenantId, { kind: "route", state: "ok", label: `"${question.slice(0, 46)}${question.length > 46 ? "…" : ""}" → ${domain}` });
  }
  const convo = history
    .slice(-6)
    .map((h) => `${h.role}: ${h.text.slice(0, 300)}`)
    .join("\n");
  const convoBlock = convo ? `Conversation so far:\n${convo}\n\n` : "";
  const MEM = memoryBlock(tenantId) + contactsBlock(tenantId);
  // EVERY branch gets today's date: a turn that can book meetings but doesn't
  // know the date once scheduled "tomorrow" a year in the past.
  const dateBlock = (await todayLine()) + "\n\n";

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
    userContent = `${convoBlock}${dateBlock}User says: ${question}`;
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
    // The real calendar, when connected: listed with [gN] ids the model can
    // reschedule/cancel against. Failures surface as data, not silence.
    let gcalBlock = "";
    if (calendarConfigured()) {
      try {
        const evs = await listEvents(14);
        rememberGids(tenantId, evs);
        gcalBlock = evs
          .map(
            (e, i) =>
              `- [g${i + 1}] ${e.title} — ${e.start.replace("T", " ").slice(0, 16)} to ${e.end.replace("T", " ").slice(0, 16)}` +
              `${e.meet_link ? " (has Google Meet)" : ""}${e.attendees.length ? ` with ${e.attendees.join(", ")}` : ""}`
          )
          .join("\n");
        publishUiEvent(tenantId, { kind: "sources", state: "ok", n: evs.length, label: "Google Calendar, next 14 days" });
      } catch (e) {
        gcalBlock = `(Google Calendar couldn't be loaded: ${e instanceof Error ? e.message.slice(0, 100) : "error"})`;
        publishUiEvent(tenantId, { kind: "sources", state: "fail", label: "Google Calendar unreachable" });
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    // Surface the specific workspace window under discussion. Only the user's
    // own words pick the window — assistant prose ("worth a note...") must not.
    const wsText = question.toLowerCase();
    const lastUserText = [...history].reverse().find((h) => h.role === "user")?.text.toLowerCase() ?? "";
    const pick = (s: string) =>
      /\b(tasks?|to-?dos?|check(ed)? off|reminders?)\b/.test(s) ? "tasks" : /\bnotes?\b/.test(s) ? "notes" : /\b(schedules?|calendars?|appointments?|meetings?|events?)\b/.test(s) ? "schedule" : null;
    publishUiContext(tenantId, pick(wsText) ?? pick(lastUserText) ?? "schedule", null);
    publishUiEvent(tenantId, { kind: "search", state: "ok", label: "Loading schedule, tasks, and notes" });
    system =
      "You are Levi, answering out loud about the user's schedule, tasks, and notes using ONLY the workspace data provided. " +
      "Be concrete about times and what's open versus done. If the data is empty for what they asked, say so plainly " +
      "and offer to add an item. Items marked [gN] are REAL Google Calendar events: reference them by that id in " +
      "update_event and cancel_event actions. Local [id N] events are only on this dashboard, not the real calendar. " +
      SPEAK +
      ACTIONS +
      CTX +
      MEM;
    userContent =
      `${convoBlock}${dateBlock}` +
      (calendarConfigured() ? `Google Calendar (next 14 days):\n${gcalBlock || "(no upcoming events)"}\n\n` : "") +
      `Local events:\n${events || "(none)"}\n\nTasks:\n${tasks || "(none)"}\n\nNotes:\n${notes || "(none)"}\n\nQuestion: ${question}`;
  } else if (intent === "inbox") {
    const rows = db
      .prepare(
        `SELECT id, from_addr, subject, body, draft_reply, category, urgency, needs_reply, status, sent_at, received_at, attachments_json
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
      attachments_json: string | null;
    }[];
    const table = rows
      .map(
        (r, i) =>
          (i === 0 ? "<- MOST RECENT: " : "") +
          `[${r.id}] ${r.received_at?.slice(0, 10) ?? "?"} | ${r.from_addr} | "${r.subject}" | ${r.category ?? "?"} | ` +
          `urgency ${r.urgency ?? "?"} | needs_reply ${r.needs_reply ? "yes" : "no"} | ${r.status}` +
          (attachmentsOf(r.attachments_json) ? ` | DOCS ATTACHED: ${attachmentsOf(r.attachments_json)!.join(", ")}` : "")
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
      "make", "sure", "just", "also", "going", "okay", "yeah", "well", "take", "give", "then", "been",
      "some", "clean", "cleaned", "cleanup", "five", "four", "three", "last", "first", "next", "still",
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
    // Whole-word matching only: substring matching with short tokens produced
    // false positives ("ute" inside "execute" focused unrelated emails).
    const wordHit = (hay: string, w: string) =>
      new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay);
    // Names usually live in the body's opening lines ("Hi, I'm Dana..."),
    // not the sender address or subject — match against all three.
    const hays = rows.map((r) => (r.from_addr + " " + r.subject + " " + r.body.slice(0, 250)).toLowerCase());
    // Only DISTINCTIVE words may pin an email on screen: a word that appears
    // across many inbox emails is conversation filler, not an entity ("make"
    // in "make sure" once pinned a promo titled "Now make it yours").
    const distinctive = (w: string) => {
      let df = 0;
      for (const h of hays) if (wordHit(h, w) && ++df > 4) return false;
      return df > 0;
    };
    const nowWords = [...new Set(qNow)].filter(distinctive);
    const pastWords = [...new Set(qPast)].filter(distinctive);
    const scored = rows
      .map((r, i) => {
        const hay = hays[i];
        const hitsNow = nowWords.filter((w) => wordHit(hay, w));
        const hitsPast = pastWords.filter((w) => wordHit(hay, w));
        return { r, score: hitsNow.length * 2 + hitsPast.length, hits: [...hitsNow, ...hitsPast] };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score); // rows are newest-first, sort is stable → recency tiebreak
    const matches = scored.map((x) => x.r);
    // A single-word match may pin only when the word names the email itself
    // (sender or subject) — one word buried in a body is a coincidence, not a
    // reference ("business" in a promo body must not hijack the screen).
    const top = scored[0];
    const pinConfident =
      top &&
      (top.hits.length >= 2 ||
        top.hits.some((w) => wordHit((top.r.from_addr + " " + top.r.subject).toLowerCase(), w)) ||
        top.hits.some((w) => contactByName(tenantId, w) !== null)); // known people are entities wherever they appear
    const drafted = rows.filter((r) => r.draft_reply && r.status !== "rejected");
    // Surface the email under discussion, content included. "The latest email"
    // is an explicit recency reference; otherwise only a real entity match or
    // a pending draft may focus — never a silent most-recent fallback.
    // "The latest email" pins the newest ONE; "the last five emails" is a
    // list request and must not pin anything (it once pinned a receipt while
    // Levi described the whole inbox).
    const wantsLatest = /\b(?:last|latest|newest|most recent)\s+(?:e-?mail|message|one)\b/.test(question.toLowerCase());
    // The pending-draft fallback only fires when the user is actually asking
    // about drafts/replies — a generic inbox question must not pin it.
    const asksDraft = /\b(drafts?|repl(y|ies)|staged|approve|approval)\b/i.test(question);
    const focus = (wantsLatest ? rows[0] : null) ?? (pinConfident ? top.r : null) ?? (asksDraft ? drafted.find((r) => r.status === "drafted") : null) ?? null;
    publishUiEvent(tenantId, { kind: "search", state: "ok", label: "Scanning inbox", n: rows.length });
    if (focus) publishUiEvent(tenantId, { kind: "note", label: `Focused: "${focus.subject.slice(0, 40)}"` });
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
            attachments: attachmentsOf(focus.attachments_json),
          }
        : null
    );
    const detail = [...new Map([...rows.slice(0, 6), ...drafted.slice(0, 4), ...matches.slice(0, 5)].map((r) => [r.id, r])).values()]
      .map(
        (r) =>
          `[${r.id}] From: ${r.from_addr} | Subject: "${r.subject}" | ${r.received_at?.slice(0, 10) ?? "?"}\n` +
          (attachmentsOf(r.attachments_json)
            ? `ATTACHED DOCUMENTS (already scanned into the knowledge base, searchable): ${attachmentsOf(r.attachments_json)!.join(", ")}\n`
            : "") +
          `Body: ${clean(r.body).slice(0, 700) || "(empty)"}` +
          (r.draft_reply
            ? `\nLevi's drafted reply (${
                r.sent_at
                  ? `SENT on ${r.sent_at.slice(0, 10)}`
                  : r.status === "drafted"
                    ? "awaiting approval in the Inbox window"
                    : `verdict ${r.status} but NOT sent — never claim it was sent`
              }): ${clean(r.draft_reply).slice(0, 400)}`
            : "")
      )
      .join("\n\n");
    system =
      "You are Levi, answering out loud about the user's email inbox using ONLY the data provided. " +
      "ATTACHED DOCUMENTS are the core of this platform, never a footnote: whenever you mention or summarize an " +
      "email that has DOCS ATTACHED, say so unprompted, name the documents, note that they are already scanned " +
      "and searchable, and offer to walk through them. " +
      "The table lists every email; full content follows for the recent and relevant ones. When asked to read " +
      "an email, read its body naturally, summarizing boilerplate. Some emails have a drafted reply awaiting " +
      "approval in the Inbox window; mention that when relevant. A reply left the building ONLY if it is " +
      "marked SENT with a date; a verdict of approved does not mean it was sent, so never claim or imply an " +
      "unsent reply went out. If asked about an email whose body isn't included, say you can pull it up if " +
      "they name the sender. " +
      SPEAK +
      ACTIONS +
      CTX +
      MEM;
    userContent = rows.length
      ? `${convoBlock}${dateBlock}Inbox (${rows.length} emails, NEWEST FIRST — the FIRST row is the most recent; "the last/latest email" always means the FIRST row, never the bottom of the list):\n${table}\n\nFull content of recent/relevant emails:\n${detail}\n\nQuestion: ${question}`
      : `${convoBlock}${dateBlock}The inbox is empty.\n\nQuestion: ${question}`;
  } else {
    publishUiContext(tenantId, "answer", null); // docs turn: no email belongs on screen
    // Conversation-anchored retrieval, ALWAYS on: a follow-up like "who are
    // the listing agents?" carries no entity of its own, so the search query
    // is anchored with entity words from the recent conversation that exist
    // in this tenant's document lexicon ("ute", "contract", ...). Terse
    // follow-ups additionally inherit the previous user turn verbatim.
    let query: string;
    if (searchOverride) {
      query = searchOverride; // the model asked to search again with a better query
    } else {
      const lex = lexiconFor(tenantId);
      const recent = [...history.slice(-4).map((h) => h.text), question].join(" ");
      const anchors = [...new Set(tokens(recent).filter((t) => lex.docs.has(t)))].slice(0, 8);
      const prevUser = [...history].reverse().find((h) => h.role === "user")?.text ?? "";
      const base = question.split(/\s+/).length < 5 && prevUser ? `${prevUser} ${question}` : question;
      query = anchors.length ? `${base}\n${anchors.join(" ")}` : base;
    }
    const qLine = query.split("\n")[0];
    publishUiEvent(tenantId, { kind: "search", state: "run", label: `Searching documents: ${qLine.slice(0, 50)}${qLine.length > 50 ? "…" : ""}` });
    const hits = await search(tenantId, query, 40, getEmbedder(), "hybrid").catch(() => []);
    const docNames = [...new Set(hits.map((h) => h.document_path.split("/").pop() ?? ""))].slice(0, 2).join(", ");
    publishUiEvent(tenantId, { kind: "sources", state: hits.length ? "ok" : "fail", n: hits.length, label: hits.length ? `${hits.length} passages · ${docNames}` : "No passages found" });
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
      ? `${convoBlock}${dateBlock}<sources>\n${block}\n</sources>\n\nQuestion: ${question}`
      : `${convoBlock}${dateBlock}No sources found.\n\nQuestion: ${question}`;
  }

  // Track whether any speech left the server: a failure before the first word
  // can be retried transparently; after that, the error must surface.
  // Each completed sentence is also published as a "speak" event, so the
  // screen can caption exactly what Levi is saying as he says it.
  let emitted = false;
  let sentBuf = "";
  // TTS pauses at commas inside numbers ("288,000" reads as "288 … 000").
  // The prompt asks the model not to write them; this strips any that slip
  // through. A number can arrive split across deltas ("288," then "000"), so
  // a trailing digit-or-comma tail is carried into the next chunk.
  let numCarry = "";
  const cleanNumbers = (t: string): string => {
    let s = numCarry + t;
    const tail = s.match(/[\d,]+$/);
    if (tail && /\d/.test(tail[0])) {
      numCarry = tail[0];
      s = s.slice(0, s.length - tail[0].length);
    } else {
      numCarry = "";
    }
    return s.replace(/(\d),(?=\d{3}\b)/g, "$1");
  };
  const flushSpeak = (force = false) => {
    for (;;) {
      const m = sentBuf.match(/[.!?…](\s|$)/);
      if (!m || m.index === undefined) break;
      const s = sentBuf.slice(0, m.index + 1).trim();
      sentBuf = sentBuf.slice(m.index + 1).trimStart();
      if (s.length > 2) publishUiEvent(tenantId, { kind: "speak", label: s.slice(0, 140) });
    }
    if (force && sentBuf.trim().length > 2) {
      publishUiEvent(tenantId, { kind: "speak", label: sentBuf.trim().slice(0, 140) });
      sentBuf = "";
    }
  };
  const emit = async (t: string) => {
    const out = cleanNumbers(t);
    emitted = true; // the carry may hold the text back briefly, but speech IS coming
    if (!out) return;
    sentBuf += out;
    flushSpeak();
    await onDelta(out);
  };
  // Stream over: release whatever the number carry still holds.
  const flushNumbers = async () => {
    const rest = numCarry.replace(/(\d),(?=\d{3}\b)/g, "$1");
    numCarry = "";
    if (rest) {
      sentBuf += rest;
      await onDelta(rest);
    }
  };

  // The reply stream is multiplexed: it may open with up to two structured
  // tags — <<action:{...}>> (do something) and/or <<ctx:{...}>> (fix the
  // routing or pin an entity on screen) — followed by speech. Tags are parsed
  // out and executed BEFORE any speech is released; a ctx reroute aborts the
  // turn so it can re-run against the right data.
  let reroute: Intent | null = null;
  let research: string | null = null; // model-requested retry with a better search query
  let acted = false; // an action executed — this turn must never be regenerated
  let doneLabel: string | null = null; // label of a successfully executed action

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
        let replace: string | null = "I couldn't make sense of that request, so nothing happened.";
        let parsed: Action | null = null;
        try {
          parsed = JSON.parse(raw) as Action;
          publishUiEvent(tenantId, { kind: "action", state: "run", label: actionLabel(parsed) });
          replace = await executeAction(tenantId, parsed);
          if (replace === null && parsed) doneLabel = actionLabel(parsed);
        } catch {
          /* replace message stands */
        }
        // A returned sentence is the server's truth (a failure, or the real
        // counts for a bulk action); it replaces whatever the model was about
        // to claim. Whether it reads as success decides the feed color.
        const failed = replace !== null && !/^(Done|Filed|Booked|Cancelled|Removed|Staged|Sent|Pulled)/.test(replace);
        publishUiEvent(tenantId, {
          kind: "result",
          state: failed ? "fail" : "ok",
          label: replace ? replace.slice(0, 90) : parsed ? `${actionLabel(parsed)} — done` : "Done",
        });
        if (replace) {
          await emit(replace);
          return "stop"; // suppress the model's unverified confirmation
        }
        return "go";
      }
      // ctx: routing correction / entity focus. Malformed ctx is ignored.
      try {
        const c = JSON.parse(raw) as { reroute?: string; email_id?: number; window?: string; search?: string };
        // Rerouting to the domain we're already in is meaningless — ignore it
        // (a stop here produced silent turns: reroute → re-run → ignored tag →
        // empty reply → "Brain returned no response").
        if (c.reroute && c.reroute !== intent && !forced && !emitted && ["inbox", "docs", "workspace"].includes(c.reroute)) {
          reroute = c.reroute as Intent;
          publishUiEvent(tenantId, { kind: "route", state: "run", label: `Wrong data — rerouting to ${c.reroute === "docs" ? "documents" : c.reroute}` });
          return "stop";
        }
        // Model-requested re-search: the sources were the right domain but
        // missed the answer; retry retrieval once with the model's query.
        if (c.search?.trim() && intent === "docs" && !searchOverride && !emitted) {
          research = c.search.trim();
          publishUiEvent(tenantId, { kind: "search", state: "run", label: `Retrying search: ${research.slice(0, 50)}` });
          return "stop";
        }
        if (typeof c.email_id === "number" && intent === "inbox") {
          // Email pinning is inbox-turn-only: a docs or workspace turn must
          // never put an email on screen.
          const row = db
            .prepare(
              `SELECT id, from_addr, subject, body, received_at, draft_reply, status, sent_at, attachments_json FROM inbound_emails
               WHERE id = ? AND tenant_id = ?`
            )
            .get(c.email_id, tenantId) as (UiEmail & { attachments_json: string | null }) | undefined;
          if (row)
            publishUiContext(tenantId, "inbox", {
              ...row,
              body: cleanBody(row.body).slice(0, 1200),
              attachments: attachmentsOf(row.attachments_json),
            });
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
      await flushNumbers();
    flushSpeak(true);
      return;
    }
    await new Promise((r) => setTimeout(r, 600));
    await runOnce(); // one transparent retry for transient API failures
  }

  // GRACEFUL SILENCE HANDLING. Two ways a turn used to end mute and fall to
  // "sorry, I lost my train of thought" — making Levi look confused when he
  // wasn't:
  //  - the model tagged an action and then said nothing: the action DID run
  //    (a show_window once executed perfectly and then Levi asked the user to
  //    repeat themselves) — confirm it instead of apologizing;
  //  - the model emitted only a ctx tag (a pin) and stopped: nothing was
  //    done, so regenerate once — model silence is nondeterministic.
  if (!emitted && acted && doneLabel) {
    await emit(`${doneLabel}, done.`);
    await flushNumbers();
    flushSpeak(true);
    return;
  }
  if (!emitted && !acted && !reroute && !research) {
    await runOnce();
  }

  // Model-requested reroute: the deterministic router picked the wrong domain
  // and the model could tell from the data. Re-run once with the right one.
  if (reroute && !emitted) {
    await streamVoiceReply(tenantId, question, onDelta, history, reroute);
    return;
  }
  // Model-requested re-search: right domain, wrong retrieval. Retry once with
  // the model's own query — it knows the conversation and what it needs.
  if (research && !emitted) {
    await streamVoiceReply(tenantId, question, onDelta, history, intent, research);
    return;
  }
  // LIVENESS INVARIANT, enforced at the source: no voice turn may end silent,
  // for EVERY caller. The ElevenLabs endpoint had its own fallback; the text
  // endpoint didn't, and a sourceless docs turn once returned "" after the
  // model answered with nothing but tags twice.
  if (!emitted && !acted) {
    await emit("I came up empty on that one, sorry. Try asking it another way.");
  }
  await flushNumbers();
  flushSpeak(true); // caption any trailing words that lacked end punctuation
}
