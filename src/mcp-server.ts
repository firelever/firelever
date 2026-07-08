// MCP server exposing the growth pipeline (leads.db) to MCP clients such as
// Claude Code and Claude Desktop. Read-only by design: approvals and sends stay
// behind the human review CLI (see docs/adr/ADR-001-mcp-server-over-leads-db.md).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import db, { Lead } from "./db.js";

const STATUSES = [
  "new",
  "enriched",
  "scored",
  "drafted",
  "approved",
  "rejected",
  "parked",
] as const;

// enrichment_json / drafts_json are free-form agent output — never trust them to parse.
function tryParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return { unparseable: true, raw: json.slice(0, 500) };
  }
}

function summarize(l: Lead) {
  return {
    id: l.id,
    company: l.company,
    domain: l.domain,
    industry: l.industry,
    status: l.status,
    score: l.score,
    signal: l.signal,
    updated_at: l.updated_at,
  };
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: "firelever-pipeline", version: "0.1.0" });

server.registerTool(
  "search_leads",
  {
    title: "Search leads",
    description:
      "Search the FireLever lead pipeline. Filters combine with AND. Returns lead summaries; use get_lead for full detail including enrichment and email drafts.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Text match against company, domain, industry, signal, and score reasoning"),
      status: z.enum(STATUSES).optional().describe("Pipeline status filter"),
      min_score: z.number().int().min(1).max(100).optional().describe("Minimum lead score (1-100)"),
      since: z
        .string()
        .optional()
        .describe("Only leads updated on/after this ISO date, e.g. 2026-07-01"),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  async ({ query, status, min_score, since, limit }) => {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (query) {
      where.push(
        `(company LIKE @q OR domain LIKE @q OR industry LIKE @q OR signal LIKE @q OR score_reasoning LIKE @q)`
      );
      params.q = `%${query}%`;
    }
    if (status) {
      where.push(`status = @status`);
      params.status = status;
    }
    if (min_score !== undefined) {
      where.push(`score >= @min_score`);
      params.min_score = min_score;
    }
    if (since) {
      where.push(`updated_at >= @since`);
      params.since = since;
    }
    const sql = `SELECT * FROM leads ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY score DESC, updated_at DESC LIMIT @limit`;
    const rows = db.prepare(sql).all(params) as Lead[];
    return json({ count: rows.length, leads: rows.map(summarize) });
  }
);

server.registerTool(
  "get_lead",
  {
    title: "Get lead detail",
    description:
      "Full detail for one lead: enrichment research, score reasoning, drafted email sequence, and send history. Look up by id or domain.",
    inputSchema: {
      id: z.number().int().optional().describe("Lead id"),
      domain: z.string().optional().describe("Company domain, e.g. acme.com"),
    },
  },
  async ({ id, domain }) => {
    if (id === undefined && !domain) {
      return json({ error: "Provide id or domain" });
    }
    const lead = (
      id !== undefined
        ? db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id)
        : db.prepare(`SELECT * FROM leads WHERE domain = ?`).get(domain)
    ) as Lead | undefined;
    if (!lead) return json({ error: "Lead not found" });
    const sends = db
      .prepare(`SELECT day, to_email, subject, sent_at FROM sends WHERE lead_id = ? ORDER BY day`)
      .all(lead.id);
    return json({
      ...summarize(lead),
      source_url: lead.source_url,
      score_reasoning: lead.score_reasoning,
      enrichment: tryParse(lead.enrichment_json),
      drafts: tryParse(lead.drafts_json),
      sends,
      created_at: lead.created_at,
    });
  }
);

server.registerTool(
  "pipeline_stats",
  {
    title: "Pipeline stats",
    description:
      "Snapshot of the pipeline: lead counts by status, score distribution, send activity, and recent throughput.",
    inputSchema: {},
  },
  async () => {
    const byStatus = db
      .prepare(`SELECT status, COUNT(*) AS n FROM leads GROUP BY status ORDER BY n DESC`)
      .all();
    const scores = db
      .prepare(
        `SELECT COUNT(*) AS scored, ROUND(AVG(score), 1) AS avg, MIN(score) AS min, MAX(score) AS max
         FROM leads WHERE score IS NOT NULL`
      )
      .get();
    const sends = db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT lead_id) AS leads_contacted,
                MAX(sent_at) AS last_send FROM sends`
      )
      .get();
    const last7 = db
      .prepare(`SELECT COUNT(*) AS n FROM leads WHERE created_at >= datetime('now', '-7 days')`)
      .get();
    return json({
      leads_by_status: byStatus,
      scores,
      sends,
      leads_added_last_7_days: last7,
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout carries the protocol; log to stderr only.
console.error("firelever-pipeline MCP server running (stdio, read-only)");
