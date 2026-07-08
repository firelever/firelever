// Read-only snapshot of the pipeline: counts by status + pending drafts summary.
import db, { leadsByStatus } from "./db.js";

const counts = db
  .prepare(`SELECT status, COUNT(*) AS n FROM leads GROUP BY status ORDER BY n DESC`)
  .all() as { status: string; n: number }[];

console.log("Pipeline status:");
for (const c of counts) console.log(`  ${c.status.padEnd(10)} ${c.n}`);

const drafted = leadsByStatus("drafted");
if (drafted.length > 0) {
  console.log(`\n${drafted.length} draft(s) awaiting review (npm run review):`);
  for (const l of drafted) {
    console.log(`  • ${l.company} — ${l.score}/100 — ${l.signal?.slice(0, 80)}`);
  }
}

const approved = leadsByStatus("approved");
if (approved.length > 0) {
  console.log(`\n${approved.length} approved (send from Gmail):`);
  for (const l of approved) console.log(`  • ${l.company}`);
}
