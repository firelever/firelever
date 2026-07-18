// Enrichment agent (Milestone 2): fetch each lead's public website and
// combine it with the Google profile data already on the lead, then record
// the spec §2 leak signals WITH EVIDENCE. Detection is deliberately
// deterministic (marker scans): M2's job is auditable evidence collection;
// model judgment enters at qualification (M3), reading this evidence.
//
// Signals detected (present=1 means the LEAK exists):
//   no_online_booking   — no booking tool/CTA found on the site (or no site)
//   no_review_requests  — low review count on the Google profile
//   outdated_or_no_site — no website, unreachable, or stale copyright/no https
//   no_quote_followup   — raw form/phone contact with no automation tooling
// NOT detected: missed_call_text — unverifiable without phoning the business
// (spec §2: only flag what fetched data can verify; never fabricate).
//
//   npm run leads:enrich            # all leads at stage 'new'
//   npm run leads:enrich -- --limit 10
import "../config.js";
import { leadsAtStage, setStage, insertSignal, LocalLead } from "./store.js";

const BOOKING_MARKERS = [
  "calendly", "housecallpro", "housecall pro", "servicetitan", "jobber", "getjobber", "acuityscheduling",
  "schedulicity", "setmore", "booksy", "scheduleengine", "schedule engine", "workiz", "book online",
  "schedule online", "book now", "schedule now", "book an appointment", "schedule service", "request appointment",
];
const CHAT_MARKERS = ["intercom", "drift.com", "tawk.to", "livechat", "podium", "hatchapp", "chat-widget", "chatwidget"];
const AUTOMATION_MARKERS = [...BOOKING_MARKERS, ...CHAT_MARKERS, "hubspot", "mailchimp", "activecampaign", "klaviyo"];
const LOW_REVIEW_THRESHOLD = 25; // trades shops doing review automation clear this fast

interface SiteFetch {
  ok: boolean;
  status?: number;
  error?: string;
  html?: string; // lowercased, capped
  finalUrl?: string;
}

async function fetchSite(url: string): Promise<SiteFetch> {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(target, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FireLeverBot/1.0; business research)" },
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, status: res.status };
    const raw = (await res.text()).slice(0, 500_000);
    return { ok: true, status: res.status, html: raw.toLowerCase(), finalUrl: res.url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "fetch failed" };
  }
}

const found = (html: string, markers: string[]): string[] => markers.filter((m) => html.includes(m));

export async function enrichLead(lead: LocalLead): Promise<string[]> {
  const flagged: string[] = [];

  // -- review requests: verifiable from the Google profile data we hold
  const lowReviews = lead.review_count !== null && lead.review_count < LOW_REVIEW_THRESHOLD;
  insertSignal(lead.id, "no_review_requests", lowReviews, {
    source: "google_places_profile",
    review_count: lead.review_count,
    rating: lead.rating,
    threshold: LOW_REVIEW_THRESHOLD,
  });
  if (lowReviews) flagged.push("no_review_requests");

  // -- site-dependent signals
  if (!lead.website) {
    insertSignal(lead.id, "outdated_or_no_site", true, { source: "google_places_profile", website: null, note: "no website listed on the Google profile" });
    insertSignal(lead.id, "no_online_booking", true, { source: "google_places_profile", website: null, note: "no website; contact is phone only" });
    flagged.push("outdated_or_no_site", "no_online_booking");
    return flagged;
  }

  const site = await fetchSite(lead.website);
  if (!site.ok) {
    insertSignal(lead.id, "outdated_or_no_site", true, {
      source: "site_fetch",
      website: lead.website,
      status: site.status ?? null,
      error: site.error ?? null,
      note: "listed website is unreachable",
    });
    flagged.push("outdated_or_no_site");
    return flagged;
  }
  const html = site.html!;

  // booking
  const bookingHits = found(html, BOOKING_MARKERS);
  insertSignal(lead.id, "no_online_booking", bookingHits.length === 0, {
    source: "site_fetch",
    website: site.finalUrl,
    markers_found: bookingHits,
    markers_checked: BOOKING_MARKERS.length,
  });
  if (bookingHits.length === 0) flagged.push("no_online_booking");

  // outdated site: stale copyright year or plain http after redirects
  const years = [...html.matchAll(/(?:©|&copy;|copyright)\s*(\d{4})/g)].map((m) => Number(m[1]));
  const newestYear = years.length ? Math.max(...years) : null;
  const httpsOk = (site.finalUrl ?? "").startsWith("https://");
  const stale = (newestYear !== null && newestYear < new Date().getFullYear() - 1) || !httpsOk;
  insertSignal(lead.id, "outdated_or_no_site", stale, {
    source: "site_fetch",
    website: site.finalUrl,
    copyright_year: newestYear,
    https: httpsOk,
  });
  if (stale) flagged.push("outdated_or_no_site");

  // quote follow-up: a raw form (or no form at all) with zero automation
  // tooling anywhere on the page is the honest, verifiable proxy
  const hasForm = html.includes("<form");
  const automationHits = found(html, AUTOMATION_MARKERS);
  const rawContact = automationHits.length === 0;
  insertSignal(lead.id, "no_quote_followup", rawContact, {
    source: "site_fetch",
    website: site.finalUrl,
    has_form: hasForm,
    automation_markers_found: automationHits,
    note: rawContact ? "contact path has no visible automation tooling" : "automation tooling present",
  });
  if (rawContact) flagged.push("no_quote_followup");

  return flagged;
}

export async function enrichAll(limit = 200): Promise<{ enriched: number; leaksFound: number }> {
  const todo = leadsAtStage("new", limit);
  let enriched = 0;
  let leaksFound = 0;
  // small concurrency: site fetches dominate the wall clock
  const CONC = 6;
  for (let i = 0; i < todo.length; i += CONC) {
    const batch = todo.slice(i, i + CONC);
    const results = await Promise.all(
      batch.map(async (lead) => {
        try {
          const flags = await enrichLead(lead);
          setStage(lead.id, "enriched", flags.length ? `leaks: ${flags.join(", ")}` : "no leaks detected");
          console.log(`  ${String(lead.id).padStart(4)} ${lead.business_name.slice(0, 42).padEnd(42)} ${flags.length ? flags.join(", ") : "-"}`);
          return flags.length;
        } catch (e) {
          console.error(`  ${lead.id} ${lead.business_name}: ${e instanceof Error ? e.message : e}`);
          return 0;
        }
      })
    );
    enriched += batch.length;
    leaksFound += results.filter((n) => n > 0).length;
  }
  return { enriched, leaksFound };
}

const isMain = process.argv[1]?.endsWith("enrich.ts");
if (isMain) {
  const li = process.argv.indexOf("--limit");
  const limit = li >= 0 ? Number(process.argv[li + 1]) : 200;
  enrichAll(limit)
    .then((r) => console.log(`[enrich] ${r.enriched} leads enriched, ${r.leaksFound} with at least one verified leak`))
    .catch((e) => {
      console.error("[enrich] failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
