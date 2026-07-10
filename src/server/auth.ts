// Tenant auth: per-tenant bearer keys (flv_ + 32 hex), SHA-256 hashed at rest,
// constant-time compare. Keys are shown once at creation (ADR-005).
import crypto from "crypto";
import db from "../rag/store.js";

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,               -- slug, e.g. "firelever", "acme-freight"
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export interface Tenant {
  id: string;
  name: string;
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function createTenant(id: string, name: string): { tenant: Tenant; apiKey: string } {
  const apiKey = "flv_" + crypto.randomBytes(16).toString("hex");
  db.prepare(`INSERT INTO tenants (id, name, api_key_hash) VALUES (?, ?, ?)`).run(
    id,
    name,
    hashKey(apiKey)
  );
  return { tenant: { id, name }, apiKey };
}

export function authenticate(authHeader: string | undefined): Tenant | null {
  const key = authHeader?.match(/^Bearer\s+(flv_[0-9a-f]{32})$/)?.[1];
  if (!key) return null;
  const row = db
    .prepare(`SELECT id, name, api_key_hash FROM tenants`)
    .all() as { id: string; name: string; api_key_hash: string }[];
  const hash = hashKey(key);
  for (const t of row) {
    if (
      hash.length === t.api_key_hash.length &&
      crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(t.api_key_hash))
    ) {
      return { id: t.id, name: t.name };
    }
  }
  return null;
}

export function listTenants(): (Tenant & { created_at: string })[] {
  return db.prepare(`SELECT id, name, created_at FROM tenants ORDER BY created_at`).all() as any;
}

// Issue a fresh API key for an existing tenant (its documents are untouched).
// Used when the original one-time key was lost. The old key stops working.
export function rekeyTenant(id: string): { tenant: Tenant; apiKey: string } {
  const row = db.prepare(`SELECT id, name FROM tenants WHERE id = ?`).get(id) as Tenant | undefined;
  if (!row) throw new Error(`no tenant with id "${id}"`);
  const apiKey = "flv_" + crypto.randomBytes(16).toString("hex");
  db.prepare(`UPDATE tenants SET api_key_hash = ? WHERE id = ?`).run(hashKey(apiKey), id);
  return { tenant: row, apiKey };
}

// The tenant that owns the most documents — the user's real workspace when the
// tenant id isn't known.
export function topDocsTenantId(): string | null {
  const row = db
    .prepare(`SELECT tenant_id FROM documents GROUP BY tenant_id ORDER BY COUNT(*) DESC LIMIT 1`)
    .get() as { tenant_id: string } | undefined;
  return row?.tenant_id ?? null;
}
