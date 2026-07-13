// Self-healing watchdog (ADR-018): the server watches its own failure
// signals in real time and applies safe remediations automatically, instead
// of waiting for a human to read the logs. Deliberately conservative — the
// only automatic actions are ones that cannot lose data: clearing derived
// caches and surfacing loud, structured log markers that the nightly log
// review (and the operator) can act on.
type Signal = "stream_failure" | "empty_turn" | "action_failure" | "reconnect";

const WINDOW_MS = 10 * 60 * 1000;
const events: { kind: Signal; at: number; detail?: string }[] = [];
let lastRemedyAt = 0;
let remedy: (() => void) | null = null;

export function registerRemedy(fn: () => void): void {
  remedy = fn;
}

function recent(kind: Signal, ms: number): number {
  const cutoff = Date.now() - ms;
  return events.filter((e) => e.kind === kind && e.at > cutoff).length;
}

export function watchdogNote(kind: Signal, detail?: string): void {
  const now = Date.now();
  events.push({ kind, at: now, detail: detail?.slice(0, 120) });
  while (events.length && events[0].at < now - WINDOW_MS) events.shift();
  console.warn(`[watchdog] ${kind}${detail ? `: ${detail.slice(0, 100)}` : ""}`);
  // Three brain failures in five minutes usually means poisoned derived
  // state (stale lexicon, wedged cache) — reset it once, then hold off so a
  // genuine outage doesn't turn into a remediation loop.
  if (kind === "stream_failure" && recent("stream_failure", 5 * 60_000) >= 3 && now - lastRemedyAt > 10 * 60_000) {
    lastRemedyAt = now;
    console.warn("[watchdog] REMEDY: repeated stream failures — clearing voice caches");
    try {
      remedy?.();
    } catch {
      /* remediation must never take the server down */
    }
  }
}

// Surfaced on /api/health so anyone (human or agent) can read vital signs
// without grepping logs.
export function watchdogHealth(): Record<string, number> {
  return {
    stream_failures_10m: recent("stream_failure", WINDOW_MS),
    empty_turns_10m: recent("empty_turn", WINDOW_MS),
    action_failures_10m: recent("action_failure", WINDOW_MS),
    last_remedy_unix: Math.floor(lastRemedyAt / 1000),
  };
}
