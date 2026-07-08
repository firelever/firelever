// Set the recipient email for a lead once you've sourced it manually:
//   npm run set-email -- 2 joe@double-stack.com
import db, { Lead } from "./db.js";

const [idArg, email] = process.argv.slice(2);
const id = Number(idArg);
if (!id || !email?.includes("@")) {
  console.log("usage: npm run set-email -- <lead-id> <email>");
  const rows = db.prepare(`SELECT id, company, status FROM leads ORDER BY id`).all() as Lead[];
  for (const r of rows) console.log(`  #${r.id} ${r.company} (${r.status})`);
  process.exit(1);
}

const lead = db.prepare(`SELECT * FROM leads WHERE id=?`).get(id) as Lead | undefined;
if (!lead?.drafts_json) {
  console.error(`lead #${id} not found or has no drafts`);
  process.exit(1);
}
const seq = JSON.parse(lead.drafts_json);
seq.to_email = email;
db.prepare(`UPDATE leads SET drafts_json=?, updated_at=datetime('now') WHERE id=?`).run(
  JSON.stringify(seq, null, 2), id
);
console.log(`#${id} ${lead.company}: recipient set to ${email}`);
