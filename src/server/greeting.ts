// Session greetings that never repeat themselves: built fresh on every mic
// tap from real state — the user's name (from tenant memory), the time of day
// in the calendar's timezone, and one true hook (staged replies, mail waiting,
// the next meeting). No LLM call: the greeting must be ready the instant the
// session opens, and it must never claim anything the data doesn't show.
import { listMemories } from "../rag/memory.js";
import { calendarConfigured, calendarTimeZone } from "../calendar/google.js";

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

// The user's name, if a memory records it ("The user's name is Peter").
function nameFor(tenantId: string): string | null {
  for (const note of listMemories(tenantId, 50)) {
    const m = note.match(/\b(?:user'?s name is|name is|call (?:me|him|her))\s+([A-Z][a-zA-Z]+)/);
    if (m) return m[1];
  }
  return null;
}

// The last greeting spoken per tenant, so back-to-back sessions never open
// with the same line.
const lastGreeting = new Map<string, string>();

// Simple, warm small talk — no status report, no agenda. Levi doesn't lead
// with "one email needs a reply" the moment the mic opens (live feedback:
// it reads as jumping the gun); the user asks when they want the rundown.
export async function buildGreeting(tenantId: string): Promise<string> {
  let tz = "UTC";
  if (calendarConfigured()) tz = await calendarTimeZone().catch(() => "UTC");
  const hour = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz }));
  const name = nameFor(tenantId);
  const who = name ? ` ${name}` : "";
  const daypart = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const lines = [
    `Hey${who}, how's it going?`,
    `Hey${who}, good to hear you.`,
    `Hi${who}. What's on your mind?`,
    `Hey${who}, welcome back.`,
    `Hey${who}. What are we getting into?`,
    `Hi${who}, how's your day going?`,
    `Hey${who}. I'm all ears.`,
    `Hey${who}, what can I do for you?`,
    `Hi${who}. Ready when you are.`,
    `Hey${who}, hope the ${daypart}'s treating you well. What's up?`,
    `Hey${who}, how's the ${daypart} going?`,
  ];

  let line = pick(lines);
  for (let i = 0; i < 3 && line === lastGreeting.get(tenantId); i++) line = pick(lines);
  lastGreeting.set(tenantId, line);
  return line;
}
