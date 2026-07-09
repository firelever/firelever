// FireLever Copilot server (slice 5a, ADR-005): tenant-authenticated API + web UI.
//   npm run serve     → http://localhost:8787
// Every route is tenant-scoped by bearer key; no endpoint touches leads.db.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { authenticate, Tenant } from "./auth.js";
import { answer } from "../rag/answer.js";
import { ingestFile } from "../rag/ingest-file.js";
import { SUPPORTED } from "../rag/extract.js";
import db from "../rag/store.js";
import { emailsByStatus, updateEmail } from "../triage/store.js";
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
  const result = await answer(c.get("tenant").id, question.trim());
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
  try {
    const result = await ingestFile(tenant.id, tmp, `uploads/${path.basename(file.name)}`);
    return c.json(result);
  } finally {
    fs.unlinkSync(tmp);
  }
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`FireLever Copilot listening on http://localhost:${info.port}`);
});
