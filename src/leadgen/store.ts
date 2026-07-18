// Local lead engine data model (docs/03-LEADGEN.md, spec §4). Lives in
// leads.db beside the original growth pipeline. DDL kept Postgres-compatible
// (no AUTOINCREMENT keyword, no SQLite-only defaults) so it can migrate.
import db from "../db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS metros (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vertical TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_m INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS local_leads (
  id INTEGER PRIMARY KEY,
  metro_id TEXT NOT NULL REFERENCES metros(id),
  place_id TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  owner_name TEXT,
  phone TEXT,
  website TEXT,
  email TEXT,
  address TEXT,
  rating REAL,
  review_count INTEGER,
  source TEXT NOT NULL DEFAULT 'google_places',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_signals (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES local_leads(id),
  signal_type TEXT NOT NULL,
  present INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  detected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_qualifications (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES local_leads(id),
  grade INTEGER NOT NULL,
  top_leak TEXT NOT NULL,
  matched_offer TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  evidence TEXT NOT NULL,
  qualified_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_outreach (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES local_leads(id),
  draft_body TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'draft',
  approved_by TEXT,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS local_pipeline (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES local_leads(id),
  stage TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  metro_id TEXT REFERENCES metros(id),
  notes TEXT
);
CREATE TABLE IF NOT EXISTS opt_outs (
  id INTEGER PRIMARY KEY,
  email TEXT,
  phone TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_leads_metro ON local_leads(metro_id);
CREATE INDEX IF NOT EXISTS idx_local_pipeline_lead ON local_pipeline(lead_id);
`);

const now = () => new Date().toISOString();

export interface MetroConfig {
  id: string;
  name: string;
  vertical: string;
  lat: number;
  lng: number;
  radius_m: number;
  queries: string[];
  active: boolean;
}

export function upsertMetro(m: MetroConfig): void {
  db.prepare(
    `INSERT INTO metros (id, name, vertical, lat, lng, radius_m, active) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, vertical=excluded.vertical, lat=excluded.lat,
       lng=excluded.lng, radius_m=excluded.radius_m, active=excluded.active`
  ).run(m.id, m.name, m.vertical, m.lat, m.lng, m.radius_m, m.active ? 1 : 0);
}

export interface SourcedBusiness {
  place_id: string;
  business_name: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  rating: number | null;
  review_count: number | null;
}

// Returns the new lead id, or null when the place_id is already known
// (idempotency: rerunning a sourcing pass never duplicates a lead).
export function insertLocalLead(metroId: string, b: SourcedBusiness): number | null {
  const dup = db.prepare(`SELECT id FROM local_leads WHERE place_id = ?`).get(b.place_id);
  if (dup) return null;
  const r = db
    .prepare(
      `INSERT INTO local_leads (metro_id, place_id, business_name, phone, website, address, rating, review_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(metroId, b.place_id, b.business_name, b.phone, b.website, b.address, b.rating, b.review_count, now());
  const id = Number(r.lastInsertRowid);
  db.prepare(`INSERT INTO local_pipeline (lead_id, stage, changed_at) VALUES (?, 'new', ?)`).run(id, now());
  return id;
}

export function localLeadCounts(): { metro_id: string; n: number }[] {
  return db
    .prepare(`SELECT metro_id, COUNT(*) n FROM local_leads GROUP BY metro_id`)
    .all() as { metro_id: string; n: number }[];
}

// ---- enrichment support (Milestone 2) ----

export interface LocalLead {
  id: number;
  metro_id: string;
  place_id: string;
  business_name: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  rating: number | null;
  review_count: number | null;
}

// A lead's current stage is its latest pipeline row.
export function leadsAtStage(stage: string, limit = 200): LocalLead[] {
  return db
    .prepare(
      `SELECT l.* FROM local_leads l
       JOIN (SELECT lead_id, stage, MAX(id) mid FROM local_pipeline GROUP BY lead_id) p ON p.lead_id = l.id
       WHERE p.stage = ? ORDER BY l.id LIMIT ?`
    )
    .all(stage, limit) as LocalLead[];
}

export function setStage(leadId: number, stage: string, note?: string): void {
  db.prepare(`INSERT INTO local_pipeline (lead_id, stage, changed_at, note) VALUES (?, ?, ?, ?)`).run(
    leadId,
    stage,
    now(),
    note ?? null
  );
}

// Evidence is mandatory: a signal row without evidence is a bug, not a row
// (spec §2: never fabricate a signal). present=1 means the LEAK exists.
export function insertSignal(leadId: number, signalType: string, present: boolean, evidence: object): void {
  const ev = JSON.stringify(evidence);
  if (!ev || ev === "{}" || ev === "null") throw new Error(`signal ${signalType} for lead ${leadId} has no evidence`);
  db.prepare(
    `INSERT INTO local_signals (lead_id, signal_type, present, evidence, detected_at) VALUES (?, ?, ?, ?, ?)`
  ).run(leadId, signalType, present ? 1 : 0, ev, now());
}

export function signalsForLead(leadId: number): { signal_type: string; present: number; evidence: string }[] {
  return db
    .prepare(`SELECT signal_type, present, evidence FROM local_signals WHERE lead_id = ? ORDER BY id`)
    .all(leadId) as { signal_type: string; present: number; evidence: string }[];
}
