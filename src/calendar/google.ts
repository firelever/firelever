// Google Calendar over raw REST (ADR-016): create, reschedule, retitle, and
// cancel real calendar events — with Google Meet links and invites — so Levi's
// scheduling is the user's actual calendar, not a private notebook. No SDK
// dependency: the four endpoints we need are plain fetch calls, and the OAuth2
// refresh-token exchange is one POST.
import crypto from "crypto";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } from "../config.js";

const API = "https://www.googleapis.com/calendar/v3";

export function calendarConfigured(): boolean {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN);
}

// ---- auth: refresh-token -> short-lived access token, cached until expiry ----
let cachedToken: { token: string; until: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.until) return cachedToken.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}

async function gcal(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (res.status === 204) return null; // DELETE succeeds with no body
  if (!res.ok) throw new Error(`Google Calendar ${init.method ?? "GET"} ${path.split("?")[0]} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// The calendar's own timezone governs how "Tuesday at 1 PM" is interpreted.
let cachedTz: string | null = null;
export async function calendarTimeZone(): Promise<string> {
  if (cachedTz) return cachedTz;
  const cal = await gcal("/calendars/primary");
  cachedTz = (cal.timeZone as string) || "UTC";
  return cachedTz;
}

export interface CalEvent {
  gid: string;
  title: string;
  start: string; // ISO or all-day date
  end: string;
  meet_link: string | null;
  attendees: string[];
  location: string | null;
}

function toCalEvent(e: any): CalEvent {
  return {
    gid: e.id,
    title: e.summary ?? "(untitled)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    meet_link: e.hangoutLink ?? null,
    attendees: (e.attendees ?? []).map((a: any) => a.email).filter(Boolean),
    location: e.location ?? null,
  };
}

export async function listEvents(days = 14): Promise<CalEvent[]> {
  const now = new Date();
  const max = new Date(now.getTime() + days * 86400_000);
  const q = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: max.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const j = await gcal(`/calendars/primary/events?${q}`);
  return (j.items ?? []).map(toCalEvent);
}

// "YYYY-MM-DD HH:MM" (the voice model's format) -> Google's local dateTime +
// explicit timeZone, so 1 PM means 1 PM on the user's calendar, not UTC.
async function toDateTime(at: string): Promise<{ dateTime: string; timeZone: string }> {
  const m = at.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})/);
  if (!m) throw new Error(`need a date and time like 2026-07-14 13:00, got "${at}"`);
  return { dateTime: `${m[1]}T${m[2].padStart(5, "0")}:00`, timeZone: await calendarTimeZone() };
}

export async function createEvent(opts: {
  title: string;
  at: string; // YYYY-MM-DD HH:MM in the calendar's timezone
  durationMin?: number;
  meet?: boolean;
  attendees?: string[];
  description?: string;
}): Promise<CalEvent> {
  const start = await toDateTime(opts.at);
  const endMs = new Date(`${start.dateTime}Z`).getTime() + (opts.durationMin ?? 30) * 60_000;
  const end = { dateTime: new Date(endMs).toISOString().slice(0, 19), timeZone: start.timeZone };
  const body: any = {
    summary: opts.title,
    start,
    end,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.attendees?.length ? { attendees: opts.attendees.map((email) => ({ email })) } : {}),
    ...(opts.meet
      ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } }
      : {}),
  };
  const created = await gcal(`/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return toCalEvent(created);
}

export async function updateEvent(
  gid: string,
  fields: { title?: string; at?: string; durationMin?: number; meet?: boolean }
): Promise<CalEvent> {
  const patch: any = {};
  if (fields.title) patch.summary = fields.title;
  if (fields.at) {
    const start = await toDateTime(fields.at);
    patch.start = start;
    // Rescheduling keeps the event's existing length unless a new one is given.
    let durMin = fields.durationMin;
    if (durMin === undefined) {
      const cur = toCalEvent(await gcal(`/calendars/primary/events/${encodeURIComponent(gid)}`));
      const len = new Date(cur.end).getTime() - new Date(cur.start).getTime();
      durMin = Number.isFinite(len) && len > 0 ? len / 60_000 : 30;
    }
    const endMs = new Date(`${start.dateTime}Z`).getTime() + durMin * 60_000;
    patch.end = { dateTime: new Date(endMs).toISOString().slice(0, 19), timeZone: start.timeZone };
  } else if (fields.durationMin) {
    const cur = toCalEvent(await gcal(`/calendars/primary/events/${encodeURIComponent(gid)}`));
    const startMs = new Date(cur.start).getTime();
    patch.end = { dateTime: new Date(startMs + fields.durationMin * 60_000).toISOString() };
  }
  if (fields.meet) {
    patch.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  }
  const updated = await gcal(
    `/calendars/primary/events/${encodeURIComponent(gid)}?conferenceDataVersion=1&sendUpdates=all`,
    { method: "PATCH", body: JSON.stringify(patch) }
  );
  return toCalEvent(updated);
}

// Google moves cancelled events to the calendar's trash (recoverable for ~30
// days) and notifies attendees — the calendar equivalent of archive-not-delete.
export async function cancelEvent(gid: string): Promise<void> {
  await gcal(`/calendars/primary/events/${encodeURIComponent(gid)}?sendUpdates=all`, { method: "DELETE" });
}

// ---- voice-facing id map ----
// The voice model refers to events as [g1], [g2]… from the listing it was
// shown; Google's real ids are long opaque strings. Rebuilt on every listing,
// per tenant, so a stale number can't silently hit the wrong event.
const gidMaps = new Map<string, Map<string, string>>();

export function rememberGids(tenantId: string, events: CalEvent[]): void {
  gidMaps.set(tenantId, new Map(events.map((e, i) => [`g${i + 1}`, e.gid])));
}

export function resolveGid(tenantId: string, ref: string): string | null {
  return gidMaps.get(tenantId)?.get(ref.trim().toLowerCase()) ?? null;
}
