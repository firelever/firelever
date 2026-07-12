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

export interface UiContext {
  seq: number;
  window: string;
  email?: UiEmail | null;
  theme?: string | null;
}

const contexts = new Map<string, UiContext>();
let seq = 1;

export function publishUiContext(
  tenantId: string,
  window: string | null,
  email?: UiEmail | null,
  theme?: string | null
): void {
  const prev = contexts.get(tenantId);
  contexts.set(tenantId, {
    seq: seq++,
    window: window ?? prev?.window ?? "answer",
    // email is tri-state: undefined = keep previous, null = clear, value = set
    email: email === undefined ? prev?.email ?? null : email,
    theme: theme ?? prev?.theme ?? null,
  });
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
