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
export interface AskResult { answerable: boolean; answer: string; citations: Citation[] }

export const api = {
  me: () => req<{ id: string; name: string }>("/me"),
  ask: (question: string) => req<AskResult>("/ask", { method: "POST", body: JSON.stringify({ question }) }),
  documents: () => req<{ documents: { path: string; title: string; chunks: number; ingested_at: string }[] }>("/documents"),
  triage: () =>
    req<{ queue: { id: number; from: string; subject: string; category: string; urgency: string; draft: string; confident: boolean; grounded_in: string[]; attachments: string[] }[] }>("/triage"),
  verdict: (id: number, verdict: "approved" | "rejected" | "ignored") =>
    req<{ ok: boolean }>(`/triage/${id}/verdict`, { method: "POST", body: JSON.stringify({ verdict }) }),
};
