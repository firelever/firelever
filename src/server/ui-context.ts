// Real-time UI context: the voice brain publishes which window — and which
// specific entity — the conversation is about as it answers; the frontend
// polls and follows along, surfacing the window and rendering the entity.
// Patches MERGE into the previous context (a theme change keeps the window),
// and the bus also remembers the last routed intent per tenant so follow-up
// turns stick to what was actually routed, not re-parsed prose.
// In-memory is correct here: one always-on machine, ephemeral by nature.

export interface UiEmail {
  id: number;
  from_addr: string;
  subject: string;
  received_at: string | null;
  body: string;
  draft_reply: string | null;
  status: string;
  sent_at: string | null;
}

// A live activity event: one real step the brain took this turn (routed the
// intent, searched, executed an action, spoke a sentence). The frontend renders
// these as a streaming reasoning/action feed, so they must describe what
// ACTUALLY happened — never intentions or claims.
export interface UiEvent {
  id: number;
  at: number; // epoch ms
  kind: "route" | "search" | "sources" | "action" | "result" | "note" | "speak";
  state?: "run" | "ok" | "fail";
  label: string;
  n?: number; // count when meaningful (sources found, emails archived)
}

export interface UiContext {
  seq: number;
  window: string;
  email?: UiEmail | null;
  theme?: string | null;
  events?: UiEvent[];
}

const contexts = new Map<string, UiContext>();
let seq = 1;
let evId = 1;
const EVENTS_KEPT = 30;

export function publishUiContext(
  tenantId: string,
  window: string | null,
  email?: UiEmail | null,
  theme?: string | null
): void {
  const prev = contexts.get(tenantId);
  const next: UiContext = {
    seq: seq++,
    window: window ?? prev?.window ?? "answer",
    // email is tri-state: undefined = keep previous, null = clear, value = set
    email: email === undefined ? prev?.email ?? null : email,
    theme: theme ?? prev?.theme ?? null,
    events: prev?.events ?? [],
  };
  contexts.set(tenantId, next);
  // Every context change is diagnosable from one log line.
  console.log(
    `[ctx] seq=${next.seq} window=${next.window} email=${next.email ? `"${next.email.subject.slice(0, 40)}"` : "null"}${next.theme ? ` theme=${next.theme}` : ""}`
  );
}

// Append an activity event and bump seq so pollers pick it up on the next
// tick. Window, email, and theme are untouched — events are a parallel stream.
// The voice pipeline delivers turns at-least-once (duplicates ~1s apart), so
// an identical event arriving within a short window is the same step replayed,
// not a new one — drop it or the reasoning rail shows everything twice.
export function publishUiEvent(tenantId: string, ev: Omit<UiEvent, "id" | "at">): void {
  const prev = contexts.get(tenantId);
  const now = Date.now();
  const dup = (prev?.events ?? []).some((e) => e.kind === ev.kind && e.label === ev.label && now - e.at < 5000);
  if (dup) return;
  const events = [...(prev?.events ?? []), { ...ev, id: evId++, at: now }].slice(-EVENTS_KEPT);
  contexts.set(tenantId, {
    seq: seq++,
    window: prev?.window ?? "answer",
    email: prev?.email ?? null,
    theme: prev?.theme ?? null,
    events,
  });
  if (ev.kind !== "speak") console.log(`[ev] ${ev.kind}${ev.state ? ":" + ev.state : ""} ${ev.label.slice(0, 80)}`);
}

export function getUiContext(tenantId: string): UiContext | null {
  return contexts.get(tenantId) ?? null;
}

// ---- routed-intent memory (for follow-up stickiness) ----
const lastIntents = new Map<string, { intent: string; at: number }>();
const INTENT_TTL_MS = 15 * 60 * 1000; // a conversation, roughly

export function setLastIntent(tenantId: string, intent: string): void {
  lastIntents.set(tenantId, { intent, at: Date.now() });
}

export function getLastIntent(tenantId: string): string | null {
  const e = lastIntents.get(tenantId);
  if (!e || Date.now() - e.at > INTENT_TTL_MS) return null;
  return e.intent;
}

// Conversation boundary: the window may only ever reflect the PRESENT
// conversation. Called when a voice session starts — wipes the window,
// entity, and routed-intent memory so nothing from an earlier session can
// appear on screen. Theme persists (it's a preference, not context).
export function resetUiContext(tenantId: string): void {
  const prev = contexts.get(tenantId);
  contexts.set(tenantId, { seq: seq++, window: "answer", email: null, theme: prev?.theme ?? null, events: [] });
  lastIntents.delete(tenantId);
  console.log(`[ctx] reset (session start) tenant=${tenantId}`);
}
