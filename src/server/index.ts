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
import { authenticate, Tenant } from "./auth.js";
import { answer } from "../rag/answer.js";
import { classifyIntent, answerInbox } from "../rag/inbox-qa.js";
import { ingestFile } from "../rag/ingest-file.js";
import { SUPPORTED } from "../rag/extract.js";
import db from "../rag/store.js";
import { emailsByStatus, updateEmail } from "../triage/store.js";
import { previewCleanup, applyCleanup } from "../triage/cleanup.js";
import { rateCheck, MAX_UPLOAD_BYTES } from "./limits.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.join(here, "..", "..", "web", "index.html");
const PORT = Number(process.env.PORT ?? 8787);

type Env = { Variables: { tenant: Tenant } };
const app = new Hono<Env>();

// ---------- UI + health (no auth) ----------
app.get("/", (c) => c.html(fs.readFileSync(UI_PATH, "utf8")));
app.get("/api/health", (c) => c.json({ ok: true }));

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
  const { question } = await c.req.json<{ question?: string }>();
  if (!question?.trim()) return c.json({ error: "question is required" }, 400);
  const tenantId = c.get("tenant").id;
  const q = question.trim();
  // Route inbox questions to the inbox; everything else to the document copilot.
  const intent = await classifyIntent(q);
  const result = intent === "inbox" ? await answerInbox(tenantId, q) : await answer(tenantId, q);
  return c.json({
    answerable: result.answerable,
    answer: result.answer,
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
    .prepare(`SELECT id FROM inbound_emails WHERE id = ? AND tenant_id = ? AND status = 'drafted'`)
    .get(id, tenant.id);
  if (!row) return c.json({ error: "not found" }, 404);
  updateEmail(id, { status: verdict });
  return c.json({ ok: true, status: verdict });
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`FireLever Copilot listening on http://localhost:${info.port}`);
});

// Live inbox watcher: triages new mail the moment it arrives (ADR-011). Starts
// only when Gmail creds are configured; failures never take down the web server.
if (process.env.WATCH_INBOX !== "0") {
  import("../triage/watcher.js")
    .then(({ startInboxWatcher }) => startInboxWatcher("firelever"))
    .catch((e) => console.error("[watcher] failed to start:", e));
}
