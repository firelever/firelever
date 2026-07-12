// Client for the FireLever Copilot API (same endpoints the classic UI uses).
// Bearer key stored in localStorage; dev proxies /api to the deployed backend.

export function getKey(): string {
  return localStorage.getItem("flv_key") ?? "";
}
export function setKey(k: string) {
  localStorage.setItem("flv_key", k.trim());
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + getKey(),
      ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error || res.statusText;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return res.json();
}

export interface Citation { n: number; document: string; heading: string | null; excerpt: string }
export interface AskResult { answerable: boolean; answer: string; citations: Citation[]; audio?: string | null }

export const api = {
  me: () => req<{ id: string; name: string }>("/me"),
  ask: (question: string, speak = false) => req<AskResult>("/ask", { method: "POST", body: JSON.stringify({ question, speak }) }),
  documents: () => req<{ documents: { path: string; title: string; chunks: number; ingested_at: string }[] }>("/documents"),
  triage: () =>
    req<{ queue: { id: number; from: string; subject: string; category: string; urgency: string; draft: string; confident: boolean; grounded_in: string[]; attachments: string[] }[] }>("/triage"),
  verdict: (id: number, verdict: "approved" | "rejected" | "ignored") =>
    req<{ ok: boolean; status: string; sent?: boolean }>(`/triage/${id}/verdict`, { method: "POST", body: JSON.stringify({ verdict }) }),
  workspace: (kind: "task" | "event" | "note") => req<{ items: WsItem[] }>(`/workspace/${kind}`),
  addItem: (kind: "task" | "event" | "note", title: string, body?: string, at?: string) =>
    req<WsItem>(`/workspace/${kind}`, { method: "POST", body: JSON.stringify({ title, body, at }) }),
  setItem: (id: number, fields: Partial<Pick<WsItem, "title" | "body" | "done" | "at">>) =>
    req<{ ok: boolean }>(`/workspace/item/${id}`, { method: "POST", body: JSON.stringify(fields) }),
  delItem: (id: number) => req<{ ok: boolean }>(`/workspace/item/${id}`, { method: "DELETE" }),
  redlines: () => req<RedlineResult>("/redlines", { method: "POST" }),
  voiceStatus: () => req<{ configured: boolean }>("/voice/status"),
  voiceText: (text: string) => req<{ answer: string; audio: string | null }>("/voice/text", { method: "POST", body: JSON.stringify({ text }) }),
  uiContext: () => req<UiCtx>("/ui/context"),
  uiSessionStart: () => req<{ ok: boolean }>("/ui/session-start", { method: "POST", body: "{}" }),
  convaiStatus: () => req<{ configured: boolean }>("/convai/status"),
  convaiToken: () => req<{ token: string; agentId: string }>("/convai/token"),
  voice: async (blob: Blob): Promise<VoiceResult> => {
    const res = await fetch("/api/voice", {
      method: "POST",
      headers: { Authorization: "Bearer " + getKey(), "Content-Type": blob.type || "audio/webm" },
      body: blob,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  },
};

export interface VoiceResult { transcript: string; answerable: boolean; answer: string; citations: { n: number; document: string; heading: string | null }[]; audio: string | null }

export interface UiEmail { id: number; from_addr: string; subject: string; received_at: string | null; body: string; draft_reply: string | null; status: string; sent_at: string | null }
export interface UiCtx { seq: number; window: string | null; email?: UiEmail | null; theme?: string | null }

export interface WsItem { id: number; kind: string; title: string; body: string | null; done: number; at: string | null }
export interface Redline { clause: string; concern: string; old_text: string; suggested_text: string }
export interface RedlineResult { document: string; redlines: Redline[] }
