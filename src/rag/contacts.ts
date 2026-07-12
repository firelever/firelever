// Contact memory (ADR-017): person -> confirmed email address, persisted the
// moment the user actually uses an address (sent email, calendar invite).
// This is deliberately NOT vector/semantic memory: for exact identifiers,
// similarity is the wrong tool ("metapd" and "metapetey" embed nearly the
// same, and a neural association would confirm the wrong one). Addresses are
// stored exactly and compared exactly; the payoff is Levi proposing the right
// address next time and catching near-miss dictations for a known person.
import db from "./store.js";

db.exec(`
CREATE TABLE IF NOT EXISTS tenant_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  email TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, name)
);
`);

export function upsertContact(tenantId: string, name: string, email: string): void {
  const n = name.trim();
  const e = email.trim().toLowerCase();
  if (!n || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
  db.prepare(
    `INSERT INTO tenant_contacts (tenant_id, name, email) VALUES (?, ?, ?)
     ON CONFLICT(tenant_id, name) DO UPDATE SET email = excluded.email, updated_at = datetime('now')`
  ).run(tenantId, n, e);
}

export function contactByName(tenantId: string, name: string): { name: string; email: string } | null {
  const row = db
    .prepare(`SELECT name, email FROM tenant_contacts WHERE tenant_id = ? AND name = ? COLLATE NOCASE`)
    .get(tenantId, name.trim()) as { name: string; email: string } | undefined;
  return row ?? null;
}

// An address is "known" if ANY contact carries it — it was confirmed once,
// spelled out, so it never needs re-confirmation.
export function isKnownAddress(tenantId: string, email: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM tenant_contacts WHERE tenant_id = ? AND email = ?`).get(tenantId, email.trim().toLowerCase())
  );
}

export function listContacts(tenantId: string, limit = 40): { name: string; email: string }[] {
  return db
    .prepare(`SELECT name, email FROM tenant_contacts WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?`)
    .all(tenantId, limit) as { name: string; email: string }[];
}

// One block, appended to voice system prompts alongside MEMORY.
export function contactsBlock(tenantId: string): string {
  const cs = listContacts(tenantId);
  if (!cs.length) return "";
  return (
    " CONTACTS — addresses the user has confirmed before: " +
    cs.map((c) => `${c.name}: ${c.email}`).join("; ") +
    ". When the user names one of these people for an email, forward, or invite, USE this address (confirm it out " +
    "loud, don't ask for it again). If they dictate a DIFFERENT address for the same person, do not silently accept " +
    "either one: point out the difference and ask which is right."
  );
}
