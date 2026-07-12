// Session greetings that never repeat themselves: built fresh on every mic
// tap from real state — the user's name (from tenant memory), the time of day
// in the calendar's timezone, and one true hook (staged replies, mail waiting,
// the next meeting). No LLM call: the greeting must be ready the instant the
// session opens, and it must never claim anything the data doesn't show.
import db from "../rag/store.js";
import { listMemories } from "../rag/memory.js";
import { calendarConfigured, calendarTimeZone, listEvents } from "../calendar/google.js";

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

// The user's name, if a memory records it ("The user's name is Peter").
function nameFor(tenantId: string): string | null {
  for (const note of listMemories(tenantId, 50)) {
    const m = note.match(/\b(?:user'?s name is|name is|call (?:me|him|her))\s+([A-Z][a-zA-Z]+)/);
    if (m) return m[1];
  }
  return null;
}

function spokenClock(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone: tz }).replace(":00", "");
}

export async function buildGreeting(tenantId: string): Promise<string> {
  let tz = "UTC";
  if (calendarConfigured()) tz = await calendarTimeZone().catch(() => "UTC");
  const hour = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz }));
  const name = nameFor(tenantId);
  const who = name ? ` ${name}` : "";

  const opener = pick(
    hour < 12
      ? [`Morning${who}.`, `Good morning${who}.`, `Hey${who}, morning.`]
      : hour < 17
        ? [`Hey${who}.`, `Good afternoon${who}.`, `Afternoon${who}.`]
        : [`Evening${who}.`, `Hey${who}, good evening.`, `Good evening${who}.`]
  );

  // One true hook, in priority order. Every fact here is read, not invented.
  const hooks: string[] = [];
  try {
    const drafted = (
      db.prepare(`SELECT COUNT(*) c FROM inbound_emails WHERE tenant_id = ? AND status = 'drafted'`).get(tenantId) as { c: number }
    ).c;
    if (drafted > 0)
      hooks.push(
        drafted === 1 ? "One reply is staged and waiting on your go-ahead." : `${drafted} replies are staged and waiting on your go-ahead.`
      );
    const waiting = (
      db
        .prepare(
          `SELECT COUNT(*) c FROM inbound_emails WHERE tenant_id = ? AND needs_reply = 1 AND status NOT IN ('approved','archived','archive_missing')`
        )
        .get(tenantId) as { c: number }
    ).c;
    if (waiting > 0) hooks.push(waiting === 1 ? "One email still needs a reply." : `${waiting} emails still need replies.`);
  } catch {
    /* hooks are optional */
  }
  if (calendarConfigured()) {
    try {
      const next = (await listEvents(2))[0];
      if (next) hooks.push(`Next up on your calendar is ${next.title}, ${spokenClock(next.start, tz)}.`);
    } catch {
      /* calendar hook is optional */
    }
  }

  const invite = pick([
    "Where do you want to start?",
    "What should we tackle first?",
    "What can I pull up?",
    "Ready when you are.",
    "What's first?",
  ]);

  // Vary the shape too: hook-led, invite-led, or both when there's real news.
  const hook = hooks.length ? pick(hooks) : null;
  if (hook && Math.random() < 0.7) return `${opener} ${hook} ${Math.random() < 0.5 ? invite : ""}`.trim();
  return `${opener} ${pick(["The inbox is quiet.", "All caught up here.", "Everything's tidy on my end."])} ${invite}`.trim();
}
