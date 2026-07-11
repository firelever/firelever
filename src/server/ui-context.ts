// Real-time UI context: the voice brain publishes which window — and which
// specific entity — the conversation is about as it answers; the frontend
// polls and follows along, surfacing the window and rendering the entity.
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
}

const contexts = new Map<string, UiContext>();
let seq = 1;

export function publishUiContext(tenantId: string, window: string, email?: UiEmail | null): void {
  contexts.set(tenantId, { seq: seq++, window, email: email ?? null });
}

export function getUiContext(tenantId: string): UiContext | null {
  return contexts.get(tenantId) ?? null;
}
