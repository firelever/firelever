// Generates dashboard.html: a self-contained pipeline dashboard snapshot.
// Regenerate after any pipeline change: npm run dashboard
import fs from "fs";
import db, { Lead, SendRow } from "./db.js";

const leads = db.prepare(`SELECT * FROM leads ORDER BY score DESC NULLS LAST, id`).all() as Lead[];
const sends = db.prepare(`SELECT * FROM sends`).all() as SendRow[];

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STATUS_LABEL: Record<string, string> = {
  new: "Queued for research",
  enriched: "Researched",
  scored: "Scored",
  drafted: "Awaiting review",
  approved: "Ready to send",
  in_sequence: "Sequence running",
  replied: "REPLIED",
  sequence_done: "Sequence finished",
  parked: "Parked",
  rejected: "Rejected",
};
const STATUS_KIND: Record<string, string> = {
  new: "wait", enriched: "wait", scored: "wait", drafted: "warn",
  approved: "warn", in_sequence: "good", replied: "hot",
  sequence_done: "done", parked: "done", rejected: "done",
};

function toEmail(l: Lead): string | null {
  if (!l.drafts_json) return null;
  const e = JSON.parse(l.drafts_json).to_email;
  return typeof e === "string" && e.includes("@") ? e : null;
}
function toContact(l: Lead): string {
  if (!l.drafts_json) return "";
  const d = JSON.parse(l.drafts_json);
  return d.to_name ? `${d.to_name}, ${d.to_title}` : "";
}
function nextStep(l: Lead): string {
  switch (l.status) {
    case "approved": return toEmail(l) ? "Sender will deliver day 0" : "Add recipient email (npm run set-email)";
    case "in_sequence": {
      const done = sends.filter((s) => s.lead_id === l.id).map((s) => s.day);
      const next = [0, 3, 7].find((d) => !done.includes(d));
      return next == null ? "Sequence finishing" : `Day ${next} follow-up pending`;
    }
    case "replied": return "Draft a response and book the call";
    case "drafted": return "Review the draft (npm run review)";
    case "new": return "Enrich in next batch";
    default: return "";
  }
}
function sendDots(l: Lead): string {
  if (!["approved", "in_sequence", "replied", "sequence_done"].includes(l.status)) return "";
  const done = sends.filter((s) => s.lead_id === l.id).map((s) => s.day);
  return `<span class="dots">${[0, 3, 7]
    .map((d) => `<span class="dot ${done.includes(d) ? "sent" : "pend"}" title="day ${d}${done.includes(d) ? " sent" : ""}"></span>`)
    .join("")}</span>`;
}

const counts: Record<string, number> = {};
for (const l of leads) counts[l.status] = (counts[l.status] ?? 0) + 1;
const active = leads.filter((l) => !["parked", "rejected"].includes(l.status));
const needsAction = leads
  .map((l) => ({ l, step: nextStep(l) }))
  .filter((x) => x.step && !x.step.startsWith("Sender") && !x.step.includes("pending") && x.l.status !== "new");

const kpis = [
  { label: "Active leads", value: active.length },
  { label: "Ready / in sequence", value: (counts["approved"] ?? 0) + (counts["in_sequence"] ?? 0) },
  { label: "Emails sent", value: sends.length },
  { label: "Replies", value: counts["replied"] ?? 0 },
];

const generated = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

const rows = leads.map((l) => `
  <tr>
    <td><strong>${esc(l.company)}</strong><br><span class="mono dim">${esc(l.domain)}</span></td>
    <td>${esc(l.industry ?? "")}</td>
    <td class="num">${l.score != null ? `<span class="score s${l.score >= 80 ? "hi" : l.score >= 70 ? "mid" : "lo"}">${l.score}</span>` : "&middot;"}</td>
    <td><span class="pill ${STATUS_KIND[l.status] ?? "wait"}">${STATUS_LABEL[l.status] ?? esc(l.status)}</span> ${sendDots(l)}</td>
    <td>${esc(toContact(l))}${toEmail(l) ? `<br><span class="mono dim">${esc(toEmail(l)!)}</span>` : ""}</td>
    <td class="signal">${esc((l.signal ?? "").slice(0, 140))}${l.source_url ? ` <a href="${esc(l.source_url)}">source</a>` : ""}</td>
    <td>${esc(nextStep(l))}</td>
  </tr>`).join("");

const actionItems = needsAction.length
  ? needsAction.map((x) => `<li><strong>${esc(x.l.company)}</strong><span>${esc(x.step)}</span></li>`).join("")
  : `<li><strong>Nothing waiting on you.</strong><span>The sender handles the rest on its daily run.</span></li>`;

const html = `<title>FireLever Growth Pipeline</title>
<style>
  :root {
    --paper:#F7F6F2; --card:#FFFFFF; --ink:#22201C; --dim:#6E6A61; --line:#E5E2D9;
    --ember:#B3400F; --good:#2E7D4F; --warn:#8A6D1F; --hot:#B3400F; --wait:#6E6A61;
  }
  * { box-sizing:border-box; }
  body { background:var(--paper); color:var(--ink); margin:0;
    font:15px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif; }
  .wrap { max-width:1080px; margin:0 auto; padding:32px 24px 64px; }
  header { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px;
    border-bottom:2px solid var(--ink); padding-bottom:14px; }
  h1 { font-family:"Avenir Next","Segoe UI",sans-serif; font-size:22px; margin:0; letter-spacing:-.01em; }
  h1 em { font-style:normal; color:var(--ember); }
  header .stamp { color:var(--dim); font-size:13px; }
  h2 { font-family:"Avenir Next","Segoe UI",sans-serif; font-size:13px; text-transform:uppercase;
    letter-spacing:.09em; color:var(--dim); margin:36px 0 12px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-top:24px; }
  .kpi { background:var(--card); border:1px solid var(--line); padding:14px 16px; }
  .kpi b { display:block; font-size:30px; font-variant-numeric:tabular-nums; line-height:1.1; }
  .kpi span { color:var(--dim); font-size:12.5px; }
  ul.actions { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
  ul.actions li { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--ember);
    padding:10px 14px; display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  ul.actions li span { color:var(--dim); }
  .tablewrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); }
  table { border-collapse:collapse; width:100%; min-width:900px; font-size:13.5px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim);
    padding:10px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:12px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  .mono { font-family:"SF Mono",Menlo,monospace; font-size:12px; }
  .dim { color:var(--dim); }
  .num { font-variant-numeric:tabular-nums; }
  .score { font-family:"SF Mono",Menlo,monospace; font-weight:600; padding:2px 7px; border-radius:2px; color:#fff; }
  .shi { background:var(--good); } .smid { background:var(--warn); } .slo { background:var(--wait); }
  .pill { display:inline-block; font-size:11px; text-transform:uppercase; letter-spacing:.05em;
    padding:2px 8px; border-radius:2px; border:1px solid currentColor; white-space:nowrap; }
  .pill.good { color:var(--good); } .pill.warn { color:var(--warn); }
  .pill.hot { color:#fff; background:var(--hot); border-color:var(--hot); }
  .pill.wait { color:var(--wait); } .pill.done { color:var(--dim); border-style:dashed; }
  .dots { display:inline-flex; gap:3px; margin-left:6px; vertical-align:middle; }
  .dot { width:8px; height:8px; border-radius:1px; display:inline-block; }
  .dot.sent { background:var(--good); } .dot.pend { border:1px solid var(--dim); }
  .signal { max-width:280px; color:var(--dim); }
  .signal a { color:var(--ember); }
  footer { color:var(--dim); font-size:12.5px; margin-top:28px; }
  a:focus-visible, li:focus-visible { outline:2px solid var(--ember); outline-offset:2px; }
</style>
<div class="wrap">
  <header>
    <h1>Fire<em>Lever</em> &nbsp;Growth Pipeline</h1>
    <span class="stamp">Snapshot: ${generated}</span>
  </header>
  <div class="kpis">${kpis.map((k) => `<div class="kpi"><b>${k.value}</b><span>${k.label}</span></div>`).join("")}</div>
  <h2>Needs a human</h2>
  <ul class="actions">${actionItems}</ul>
  <h2>All leads</h2>
  <div class="tablewrap"><table>
    <thead><tr><th>Company</th><th>Vertical</th><th>Score</th><th>Status</th><th>Contact</th><th>Signal</th><th>Next step</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <footer>Every email is human-approved before the sender touches it. Send tracker squares: day 0, 3, 7 of each sequence.
    Generated from leads.db by <span class="mono">npm run dashboard</span>.</footer>
</div>`;

fs.writeFileSync("dashboard.html", html);
console.log(`dashboard.html written (${leads.length} leads, ${sends.length} sends)`);
