// FireLever Copilot server (slice 5a, ADR-005): tenant-authenticated API + web UI.
//   npm run serve     → http://localhost:8787
// Every route is tenant-scoped by bearer key; no endpoint touches leads.db.
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { serve } from "@hono/node-server";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID, timingSafeEqual } from "crypto";
import { authenticate, listTenants, Tenant } from "./auth.js";
import { answer } from "../rag/answer.js";
import { classifyIntent, answerInbox, answerChat } from "../rag/inbox-qa.js";
import { streamVoiceReply, warmVoice } from "../rag/answer-voice.js";
import { ingestFile } from "../rag/ingest-file.js";
import { SUPPORTED } from "../rag/extract.js";
import db from "../rag/store.js";
import { emailsByStatus, updateEmail } from "../triage/store.js";
import { previewCleanup, applyCleanup } from "../triage/cleanup.js";
import { sendReply, replySendingConfigured } from "../triage/send.js";
import { getUiContext, resetUiContext } from "./ui-context.js";
import { listItems, createItem, updateItem, deleteItem } from "../workspace/store.js";
import { calendarConfigured, listEvents } from "../calendar/google.js";
import { buildGreeting } from "./greeting.js";
import { logTurn } from "./chatlog.js";
import { watchdogNote, watchdogHealth, registerRemedy } from "./watchdog.js";
import { clearVoiceCaches } from "../rag/answer-voice.js";
import { proposeRedlines } from "../rag/redlines.js";
import { voiceConfigured, transcribe, synthesize } from "./voice.js";
import { rateCheck, MAX_UPLOAD_BYTES } from "./limits.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "..");
const CLASSIC_UI = path.join(ROOT, "web", "index.html");
const LEVI_DIR = path.join(ROOT, "web-dist"); // built Levi frontend (Vite)
const PORT = Number(process.env.PORT ?? 8787);

type Env = { Variables: { tenant: Tenant } };
const app = new Hono<Env>();

// ---------- UI + health (no auth) ----------
app.get("/api/health", (c) => c.json({ ok: true, ...watchdogHealth() }));
registerRemedy(clearVoiceCaches);

// Levi built assets (JS/CSS/images) — served if the build exists.
const leviIndex = fs.existsSync(path.join(LEVI_DIR, "index.html"));
if (leviIndex) {
  app.get("/assets/*", (c) => {
    const file = path.join(LEVI_DIR, c.req.path.replace(/^\//, ""));
    if (!file.startsWith(LEVI_DIR) || !fs.existsSync(file)) return c.notFound();
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
    c.header("Content-Type", type);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(fs.readFileSync(file));
  });
}

// The classic single-file UI stays reachable at /classic.
app.get("/classic", (c) => c.html(fs.readFileSync(CLASSIC_UI, "utf8")));

// Root: the Levi dashboard when built, else the classic UI.
app.get("/", (c) =>
  leviIndex ? c.html(fs.readFileSync(path.join(LEVI_DIR, "index.html"), "utf8")) : c.html(fs.readFileSync(CLASSIC_UI, "utf8"))
);

// ---------- auth gate for everything else under /api ----------
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const tenant = authenticate(c.req.header("authorization"));
  if (!tenant) return c.json({ error: "invalid or missing API key" }, 401);
  c.set("tenant", tenant);
  return next();
});

app.get("/api/me", (c) => c.json(c.get("tenant")));

// Per-tenant rate limit on the expensive/abusable routes. 429 + Retry-After.
function limited(bucket: string) {
  return async (c: any, next: any) => {
    const { ok, retryAfterSec } = rateCheck(c.get("tenant").id, bucket);
    if (!ok) {
      c.header("Retry-After", String(retryAfterSec));
      return c.json({ error: "rate limit exceeded, slow down" }, 429);
    }
    return next();
  };
}

// ---------- grounded Q&A ----------
app.post("/api/ask", limited("ask"), async (c) => {
  const { question, speak } = await c.req.json<{ question?: string; speak?: boolean }>();
  if (!question?.trim()) return c.json({ error: "question is required" }, 400);
  const tenantId = c.get("tenant").id;
  const q = question.trim();
  // Route greetings/meta to chat, inbox questions to the inbox, else the doc copilot.
  const intent = await classifyIntent(q);
  const result =
    intent === "chat"
      ? await answerChat(q)
      : intent === "inbox"
        ? await answerInbox(tenantId, q)
        : await answer(tenantId, q);
  // Speak the reply when the client asks and voice is configured (typed answers
  // get a spoken reply too, not just the mic path).
  let audio: string | null = null;
  if (speak && voiceConfigured()) {
    const spoken = result.answerable ? result.answer : "I can't find that in your documents.";
    try {
      audio = (await synthesize(spoken)).toString("base64");
    } catch (e) {
      console.error("[ask] tts failed:", e instanceof Error ? e.message : e);
    }
  }
  return c.json({
    answerable: result.answerable,
    answer: result.answer,
    audio,
    citations: result.cited_sources
      .map((n) => {
        const s = result.sources[n - 1];
        return s
          ? { n, document: s.document_path, heading: s.heading, excerpt: s.text.slice(0, 400) }
          : null;
      })
      .filter(Boolean),
  });
});

// ---------- documents ----------
app.get("/api/documents", (c) => {
  const docs = db
    .prepare(
      `SELECT d.path, d.title, d.ingested_at, COUNT(ch.id) AS chunks
       FROM documents d LEFT JOIN chunks ch ON ch.document_id = d.id
       WHERE d.tenant_id = ? GROUP BY d.id ORDER BY d.ingested_at DESC`
    )
    .all(c.get("tenant").id);
  return c.json({ documents: docs });
});

app.post("/api/documents", limited("upload"), async (c) => {
  const tenant = c.get("tenant");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "multipart 'file' is required" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: `file too large (${(file.size / 1e6).toFixed(1)}MB); max ${MAX_UPLOAD_BYTES / 1e6}MB` },
      413
    );
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!SUPPORTED.includes(ext)) {
    return c.json({ error: `unsupported type ${ext} (accepted: ${SUPPORTED.join(", ")})` }, 400);
  }
  // Write to a temp file so the shared extract/ingest path applies unchanged.
  const tmp = path.join(os.tmpdir(), `flv-upload-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));

  // Stream NDJSON: heartbeats while ingestion (OCR can take a minute) runs, then a
  // terminal line. Keeps the connection alive so the browser/Fly proxy don't time
  // out mid-OCR and the machine stays awake — the "Failed to fetch" fix.
  const displayPath = `uploads/${path.basename(file.name)}`;
  return stream(c, async (s) => {
    const job = ingestFile(tenant.id, tmp, displayPath)
      .then((result) => ({ ok: true as const, result }))
      .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      });
    let done = false;
    void job.then(() => (done = true));

    const started = Date.now();
    while (!done) {
      await s.write(JSON.stringify({ status: "processing", elapsed_s: Math.round((Date.now() - started) / 1000) }) + "\n");
      await Promise.race([job, new Promise((r) => setTimeout(r, 3000))]);
    }
    const settled = await job;
    await s.write(
      (settled.ok
        ? JSON.stringify({ status: "done", ...settled.result })
        : JSON.stringify({ status: "error", error: settled.error })) + "\n"
    );
  });
});

// ---------- triage review queue ----------
app.get("/api/triage", (c) => {
  const drafted = emailsByStatus(c.get("tenant").id, "drafted").map((e) => ({
    id: e.id,
    from: e.from_addr,
    subject: e.subject,
    body: e.body,
    category: e.category,
    urgency: e.urgency,
    reasoning: e.triage_reasoning,
    draft: e.draft_reply,
    confident: e.draft_confident === 1,
    grounded_in: JSON.parse(e.draft_sources_json ?? "[]"),
    attachments: JSON.parse(e.attachments_json ?? "[]"),
  }));
  return c.json({ queue: drafted });
});

app.post("/api/triage/:id/verdict", async (c) => {
  const tenant = c.get("tenant");
  const id = Number(c.req.param("id"));
  const { verdict } = await c.req.json<{ verdict?: string }>();
  if (!["approved", "rejected", "ignored"].includes(verdict ?? "")) {
    return c.json({ error: "verdict must be approved | rejected | ignored" }, 400);
  }
  const row = db
    .prepare(
      `SELECT id, from_addr, subject, draft_reply, message_id FROM inbound_emails
       WHERE id = ? AND tenant_id = ? AND status = 'drafted'`
    )
    .get(id, tenant.id) as
    | { id: number; from_addr: string; subject: string; draft_reply: string | null; message_id: string | null }
    | undefined;
  if (!row) return c.json({ error: "not found" }, 404);

  // Approve = actually send the reply (the click is the human guardrail).
  // The status only flips to approved after the send succeeds.
  let sent = false;
  if (verdict === "approved" && row.draft_reply) {
    if (!replySendingConfigured()) {
      return c.json({ error: "sending not configured (GMAIL_USER / GMAIL_APP_PASSWORD)" }, 503);
    }
    try {
      await sendReply({ ...row, draft_reply: row.draft_reply });
      sent = true;
    } catch (e) {
      console.error("[verdict] send failed:", e instanceof Error ? e.message : e);
      return c.json({ error: "sending the reply failed; verdict not recorded" }, 502);
    }
  }
  updateEmail(id, sent ? { status: verdict, sent_at: new Date().toISOString() } : { status: verdict });
  return c.json({ ok: true, status: verdict, sent });
});

// ---------- inbox cleanup (archive-only, propose then apply) ----------
app.get("/api/inbox/cleanup", (c) => {
  return c.json({ items: previewCleanup(c.get("tenant").id) });
});

app.post("/api/inbox/cleanup/apply", limited("upload"), async (c) => {
  const { ids } = await c.req.json<{ ids?: number[] }>();
  if (!Array.isArray(ids) || ids.some((n) => typeof n !== "number")) {
    return c.json({ error: "ids must be an array of numbers" }, 400);
  }
  const result = await applyCleanup(c.get("tenant").id, ids);
  return c.json(result);
});

// ---------- workspace: tasks / schedule / notes ----------
app.get("/api/workspace/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!["task", "event", "note"].includes(kind)) return c.json({ error: "bad kind" }, 400);
  const items = listItems(c.get("tenant").id, kind);
  // The schedule window shows the REAL calendar too (ADR-016). Google events
  // get synthetic ids far above the local range and are display-only here —
  // changing them goes through Levi's update_event/cancel_event actions.
  if (kind === "event" && calendarConfigured()) {
    try {
      const evs = await listEvents(14);
      const gitems = evs.map((e, i) => {
        const m = e.start.match(/T(\d{2}:\d{2})/);
        const d = new Date(e.start);
        return {
          id: 1_000_000 + i,
          kind: "event",
          title: `${isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }) + " · "}${e.title}${e.meet_link ? " · Meet" : ""}`,
          body: e.meet_link,
          done: 0,
          at: m ? m[1] : "all day",
        };
      });
      return c.json({ items: [...gitems, ...items] });
    } catch {
      /* calendar unreachable — local items still render */
    }
  }
  return c.json({ items });
});
app.post("/api/workspace/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!["task", "event", "note"].includes(kind)) return c.json({ error: "bad kind" }, 400);
  const { title, body, at } = await c.req.json<{ title?: string; body?: string; at?: string }>();
  if (!title?.trim()) return c.json({ error: "title required" }, 400);
  return c.json(createItem(c.get("tenant").id, kind, title.trim(), body, at));
});
app.post("/api/workspace/item/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const fields = await c.req.json<{ title?: string; body?: string; done?: number; at?: string }>();
  const ok = updateItem(c.get("tenant").id, id, fields);
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
app.delete("/api/workspace/item/:id", (c) => {
  const ok = deleteItem(c.get("tenant").id, Number(c.req.param("id")));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

// ---------- contract redlines ----------
app.post("/api/redlines", limited("ask"), async (c) => {
  const result = await proposeRedlines(c.get("tenant").id);
  if (!result) return c.json({ error: "no contract found in your documents" }, 404);
  return c.json(result);
});

// ---------- voice: speech in, grounded answer, speech out ----------
app.get("/api/voice/status", (c) => c.json({ configured: voiceConfigured() }));

app.post("/api/voice", limited("ask"), async (c) => {
  if (!voiceConfigured()) return c.json({ error: "voice not configured" }, 503);
  const tenantId = c.get("tenant").id;
  const ct = c.req.header("content-type") || "audio/webm";
  const audio = await c.req.arrayBuffer();
  const transcript = await transcribe(audio, ct);
  if (!transcript) return c.json({ transcript: "", answer: "", answerable: false, citations: [], audio: null });

  const intent = await classifyIntent(transcript);
  const result =
    intent === "chat"
      ? await answerChat(transcript)
      : intent === "inbox"
        ? await answerInbox(tenantId, transcript)
        : await answer(tenantId, transcript);
  const spoken = result.answerable ? result.answer : "I can't find that in your documents.";
  let audioB64: string | null = null;
  try {
    audioB64 = (await synthesize(spoken)).toString("base64");
  } catch (e) {
    console.error("[voice] tts failed:", e instanceof Error ? e.message : e);
  }
  return c.json({
    transcript,
    answerable: result.answerable,
    answer: result.answer,
    citations: result.answerable && "sources" in result
      ? (result.cited_sources ?? []).map((n: number) => {
          const s = (result.sources as any[])[n - 1];
          return s ? { n, document: s.document_path, heading: s.heading } : null;
        }).filter(Boolean)
      : [],
    audio: audioB64,
  });
});

// ---------- real-time UI context: what the voice conversation is about ----------
// The voice brain publishes a context event per turn (window + entity); the
// frontend polls this and follows along, surfacing the matching window live.
// Recent inbox emails for the Replies window's list view: when the
// conversation is about the inbox in general (no single email pinned), the
// window shows what's actually in there instead of claiming "inbox clear".
app.get("/api/inbox/recent", (c) => {
  const rows = db
    .prepare(
      `SELECT id, from_addr, subject, category, status, needs_reply, received_at
       FROM inbound_emails WHERE tenant_id = ?
       AND status NOT IN ('archived', 'archive_missing')
       ORDER BY id DESC LIMIT 8`
    )
    .all(c.get("tenant").id);
  return c.json({ emails: rows });
});

app.get("/api/ui/context", (c) => {
  return c.json(getUiContext(c.get("tenant").id) ?? { seq: 0, window: null, email: null });
});

// Conversation boundary: the client calls this when a voice session starts so
// the window can only ever reflect the present conversation.
app.post("/api/ui/session-start", (c) => {
  resetUiContext(c.get("tenant").id);
  return c.json({ ok: true });
});

// ---------- Free-STT voice: browser does speech-to-text, we ground + speak ----------
// The browser's Web Speech API transcribes for free (no key, no quota); it POSTs
// the transcript here, we ground it (fast voice path) and return Liam audio via
// ElevenLabs raw TTS — a separate, larger free quota than Conversational AI.
app.post("/api/voice/text", limited("ask"), async (c) => {
  const tenant = c.get("tenant");
  // speak:false skips TTS — diagnostics and text-mode checks were burning
  // ElevenLabs credits synthesizing audio nobody played.
  const { text, speak } = await c.req.json<{ text?: string; speak?: boolean }>();
  const q = (text ?? "").trim();
  if (!q) return c.json({ answer: "", audio: null });
  let answer = "";
  try {
    await streamVoiceReply(tenant.id, q, (t) => {
      answer += t;
    });
  } catch {
    answer = "Sorry, I hit a problem pulling that up.";
  }
  answer = answer.trim();
  let audio: string | null = null;
  if (speak === false) return c.json({ answer, audio: null });
  try {
    audio = (await synthesize(answer)).toString("base64");
  } catch (e) {
    console.error("[voice/text] tts failed:", e instanceof Error ? e.message : e);
  }
  return c.json({ answer, audio });
});

// ---------- ElevenLabs Conversational AI: browser connection token ----------
// The browser needs a short-lived token to open a private-agent conversation
// without ever seeing the xi-api-key. Tenant-authed like the rest of /api.
app.get("/api/convai/status", (c) =>
  c.json({ configured: !!process.env.CONVAI_AGENT_ID && !!process.env.ELEVENLABS_API_KEY })
);

app.get("/api/convai/token", async (c) => {
  const agentId = process.env.CONVAI_AGENT_ID;
  const key = process.env.ELEVENLABS_API_KEY;
  if (!agentId || !key) return c.json({ error: "voice agent not configured" }, 503);
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`, {
    headers: { "xi-api-key": key },
  });
  if (!r.ok) return c.json({ error: `token fetch failed (${r.status})` }, 502);
  const data = (await r.json()) as { token?: string };
  // A fresh greeting rides along with every token, so each session opens
  // differently: name, time of day, and one true hook from live state.
  const greeting = await buildGreeting(c.get("tenant").id).catch(() => null);
  return c.json({ token: data.token, agentId, greeting });
});

// ---------- OpenAI-compatible endpoint for ElevenLabs Conversational AI ----------
// ElevenLabs Agents own the voice loop (streaming STT, turn-taking, barge-in,
// TTS). They call this as the "Custom LLM": the conversation arrives as an
// OpenAI chat/completions request, we ground the reply in the tenant's docs /
// inbox (Claude brain), and stream it back in OpenAI SSE format so ElevenLabs
// can start speaking as words arrive. Auth reuses the tenant bearer key — set
// the agent's Custom-LLM API key to the tenant's flv_ key.
// The tenant the voice agent speaks for. ElevenLabs authenticates with the
// shared Convai secret (not a per-tenant flv_ key); bind to CONVAI_TENANT_ID
// when set, otherwise the tenant that owns the most documents.
function convaiTenant(): Tenant | null {
  const tenants = listTenants();
  const want = process.env.CONVAI_TENANT_ID;
  if (want) {
    const t = tenants.find((x) => x.id === want);
    return t ? { id: t.id, name: t.name } : null;
  }
  const row = db
    .prepare(`SELECT tenant_id, COUNT(*) c FROM documents GROUP BY tenant_id ORDER BY c DESC LIMIT 1`)
    .get() as { tenant_id: string } | undefined;
  const t = row && tenants.find((x) => x.id === row.tenant_id);
  return t ? { id: t.id, name: t.name } : null;
}

function sharedSecretOk(bearer: string | undefined): boolean {
  const secret = process.env.CONVAI_SHARED_SECRET;
  if (!secret || !bearer) return false;
  const a = Buffer.from(bearer);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const chatCompletions = async (c: any) => {
  console.log("[convai] chat hit:", c.req.method, c.req.path);
  const authHeader = c.req.header("authorization");
  // A tenant's own flv_ key works; so does the shared Convai secret, which
  // binds to the documents tenant so the voice agent needs no personal key.
  let tenant = authenticate(authHeader);
  if (!tenant && sharedSecretOk(authHeader?.match(/^Bearer\s+(.+)$/)?.[1]?.trim())) {
    tenant = convaiTenant();
  }
  if (!tenant) return c.json({ error: "invalid or missing API key" }, 401);

  const body = (await c.req.json()) as { messages?: { role: string; content: unknown }[]; stream?: boolean; model?: string };
  const messages = body.messages ?? [];
  const wantStream = body.stream !== false; // ElevenLabs streams by default
  const model = body.model || "firelever-rag";

  const textOf = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as any).text ?? "") : "")).join(" ")
        : "";
  const tenantId = tenant.id;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = textOf(lastUser?.content).trim();
  // Prior turns (excluding the current question) — used for intent stickiness
  // and follow-up context ("yes, go by sender" stays about the inbox).
  const history = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", text: textOf(m.content).trim() }))
    .filter((m) => m.text);
  if (history.length && history[history.length - 1].role === "user" && history[history.length - 1].text === question) {
    history.pop();
  }
  const greeting = "I'm here. Ask me about your documents, your inbox, or a contract.";

  const id = "chatcmpl-" + randomUUID();
  const created = Math.floor(Date.now() / 1000);

  if (!wantStream) {
    let text = greeting;
    if (question) {
      text = "";
      try {
        await streamVoiceReply(tenantId, question, (t) => {
          text += t;
        }, history);
      } catch {
        text = "Sorry, I hit a problem pulling that up. Try again.";
      }
      if (!text.trim()) text = "Sorry, I lost my train of thought there. Could you ask me that again?";
      logTurn(tenantId, question, text);
    }
    return c.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text.trim() }, finish_reason: "stop" }],
    });
  }

  // Stream the grounded answer as OpenAI SSE. streamVoiceReply uses a fast model
  // and hybrid retrieval so the first spoken word leaves in ~1-2s.
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  return stream(c, async (s) => {
    const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
      "data: " +
      JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] }) +
      "\n\n";
    await s.write(frame({ role: "assistant" }));
    // A voice turn must NEVER end silent — ElevenLabs treats an empty reply as
    // "Brain returned no response" and fails the whole conversation.
    let spoke = false;
    let full = ""; // durable history: the reply as actually spoken
    try {
      if (!question) {
        await s.write(frame({ content: greeting }));
        spoke = true;
      } else {
        await streamVoiceReply(tenantId, question, async (t) => {
          if (t) spoke = true;
          full += t;
          await s.write(frame({ content: t }));
        }, history);
      }
    } catch (e) {
      console.error("[convai] stream failed:", e instanceof Error ? e.message : e);
      watchdogNote("stream_failure", e instanceof Error ? e.message : String(e));
      await s.write(frame({ content: "Sorry, I hit a problem pulling that up. Try again." }));
      spoke = true;
    }
    if (question && full.trim()) logTurn(tenantId, question, full);
    if (!spoke) {
      watchdogNote("empty_turn", question.slice(0, 80));
      await s.write(frame({ content: "Sorry, I lost my train of thought there. Could you ask me that again?" }));
    }
    await s.write(frame({}, "stop"));
    await s.write("data: [DONE]\n\n");
  });
};

// ElevenLabs' Custom LLM may treat the configured URL as a base and append
// /chat/completions; register the handler at every plausible path so it works
// however the agent URL is set.
app.post("/v1/chat/completions", chatCompletions);
app.post("/v1/chat/completions/chat/completions", chatCompletions);
app.post("/chat/completions", chatCompletions);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`FireLever Copilot listening on http://localhost:${info.port}`);
  // Preload the embedding model so the first voice document query is fast.
  void warmVoice();
});

// Live inbox watcher: triages new mail the moment it arrives (ADR-011). Starts
// only when Gmail creds are configured; failures never take down the web server.
if (process.env.WATCH_INBOX !== "0") {
  import("../triage/watcher.js")
    .then(({ startInboxWatcher }) => startInboxWatcher("firelever"))
    .catch((e) => console.error("[watcher] failed to start:", e));
  // One-shot sweep for document attachments that earlier triage runs skipped
  // (old category gate, crashes) — new mail is handled inline by the watcher.
  import("../triage/run.js")
    .then(({ backfillAttachments }) => backfillAttachments("firelever"))
    .catch((e) => console.error("[backfill] failed:", e));
}
