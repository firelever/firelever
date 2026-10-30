// Answer reviews with Plures (plures.si): every reply Levi gives is sent with its trace, and
// Plures picks the ones worth a look (rerouted, refused, empty, no sources, asked again, plus a
// few at random) for the team to grade. The grades come back as routing examples and as lines
// for evals/retrieval.jsonl and evals/qa.jsonl. Off unless PLURES_API_KEY is set. Never awaited
// in the user's path, and a failure here never touches the reply.
import { createHash } from "node:crypto";
import type { TurnTrace } from "../rag/answer-voice.js";

// Every intent routeIntent can pick, so graders can choose the right one.
const INTENTS = ["chat", "inbox", "docs", "workspace", "pipeline"];

// One POST to the Plures API (same body as plures.turns.log in the SDK), so there is no new
// dependency to install. Times out quickly; nothing waits on it.
async function logTurn(body: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${process.env.PLURES_BASE_URL ?? "https://plures.si"}/api/v1/turns`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.PLURES_API_KEY}`, "content-type": "application/json", "plures-app": process.env.PLURES_APP ?? "firelever" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Plures answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// A stable id for one conversation, so Plures can tell when the user asks the same thing again.
export function sessionOf(tenantId: string, firstUserText?: string): string {
  return createHash("sha256").update(`${tenantId}:${firstUserText ?? "text"}`).digest("hex").slice(0, 24);
}

export function reportTurn(tenantId: string, question: string, answer: string, trace: TurnTrace, opts: { channel: "voice" | "text"; session: string }): void {
  if (!process.env.PLURES_API_KEY || !question.trim()) return;
  logTurn({
    question, answer,
    intent: trace.intent, rerouted_to: trace.rerouted_to ?? null, retrieval: trace.retrieval,
    sources: trace.sources, refused: trace.refused,
    session: opts.session, channel: opts.channel, intents: INTENTS,
    metadata: { tenant: tenantId },
  }).catch((e: unknown) => console.error("[plures] turn not sent:", e instanceof Error ? e.message : e));
}
