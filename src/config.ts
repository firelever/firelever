// Ideal Customer Profile and pipeline settings.
// Confirmed 2026-07-04: start broad across ops-heavy industries, narrow once
// score/reply data shows which segments convert.
export const ICP = `
Established SMB or mid-market companies ($5M–$500M revenue, typically 20–500 employees)
in ops-heavy industries: logistics/freight, legal services, real estate/property management,
insurance, healthcare administration, and professional services (accounting, consulting, staffing).

Strong buying signals (any of):
- Job posts mentioning manual processes, data entry, back-office bottlenecks, or "AI"/automation roles
- Recent funding, acquisition, or expansion announcements
- Leadership publicly discussing AI adoption (LinkedIn posts, interviews, podcasts)
- Visible operational pain: high-volume document handling, scheduling, intake, or compliance workflows

Buyer personas: CEO/COO/owner at SMBs; VP Operations, Head of Innovation, or CIO at mid-market.

Disqualifiers: pre-revenue startups, companies already selling AI products, companies under ~10 employees.
`.trim();

export const FIRELEVER_PITCH = `
FireLever (firelever.com) designs, builds, and deploys production AI agents for established
companies — automating real operational workflows (document intake, research, triage, reporting),
not chatbot demos. Founder-led, hands-on engagements. The outreach email itself was researched
and drafted by an agent system like the ones FireLever builds — that is the proof point.
`.trim();

export const SCORE_THRESHOLD = 70; // leads scoring below this are parked, not drafted
export const PROSPECTS_PER_RUN = 10; // keep runs small while calibrating
export const MODEL = "claude-opus-4-8";

// Appended to every outbound email. CAN-SPAM requires a real physical address
// and an opt-out — fill in the address before the first send.
export const EMAIL_FOOTER = `
--
FireLever · firelever.com
[SET YOUR BUSINESS MAILING ADDRESS IN src/config.ts — required by CAN-SPAM]
If you'd rather not hear from me, reply "no thanks" and I won't email again.
`.trim();

// Gmail sending/reply-check credentials (free tier: plain Gmail + app password).
// Set in .env: GMAIL_USER=you@gmail.com  GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
export const GMAIL_USER = process.env.GMAIL_USER ?? "";
export const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
// Address shown as the sender. Must be the account itself or a configured
// "Send mail as" alias in Gmail settings, or Google rewrites it.
export const SEND_AS = process.env.SEND_AS ?? GMAIL_USER;
// Start tiny: fresh domain with no sending history and no warmup service.
// Raise gradually (5, then 10) after a few clean weeks.
export const DAILY_SEND_CAP = 3;
