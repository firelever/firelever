import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo root locally; LEADS_DB_PATH points at the mounted volume in prod so
// the Levi server (pipeline window, voice) sees the same data as the CLIs.
const db = new Database(process.env.LEADS_DB_PATH ?? path.join(here, "..", "leads.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  industry TEXT,
  signal TEXT,                -- the buying signal the Prospector found
  source_url TEXT,            -- where the signal was found
  enrichment_json TEXT,       -- Enricher output: contacts + company context
  score INTEGER,              -- Scorer output, 1-100
  score_reasoning TEXT,
  drafts_json TEXT,           -- Drafter output: 3-email sequence
  status TEXT NOT NULL DEFAULT 'new',
    -- new -> enriched -> scored -> drafted -> approved | rejected | parked (below threshold)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  day INTEGER NOT NULL,            -- 0, 3, 7
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lead_id, day)
);
`);

export interface SendRow {
  id: number;
  lead_id: number;
  day: number;
  to_email: string;
  subject: string;
  sent_at: string;
}

export interface Lead {
  id: number;
  company: string;
  domain: string;
  industry: string | null;
  signal: string | null;
  source_url: string | null;
  enrichment_json: string | null;
  score: number | null;
  score_reasoning: string | null;
  drafts_json: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export function insertLead(l: {
  company: string;
  domain: string;
  industry: string;
  signal: string;
  source_url: string;
}): boolean {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO leads (company, domain, industry, signal, source_url)
     VALUES (@company, @domain, @industry, @signal, @source_url)`
  );
  return stmt.run(l).changes > 0;
}

export function updateLead(id: number, fields: Partial<Lead>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(
    `UPDATE leads SET ${sets}, updated_at = datetime('now') WHERE id = @id`
  ).run({ ...fields, id });
}

export function leadsByStatus(status: string): Lead[] {
  return db
    .prepare(`SELECT * FROM leads WHERE status = ? ORDER BY score DESC, id`)
    .all(status) as Lead[];
}

export function knownDomains(): string[] {
  return (db.prepare(`SELECT domain FROM leads`).all() as { domain: string }[]).map(
    (r) => r.domain
  );
}

export default db;
