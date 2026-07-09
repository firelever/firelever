// Pilot-scale hardening (docs/05-security-review.md residual risks):
// a per-tenant fixed-window rate limiter and an upload size cap.
// In-memory is fine for the single-machine deploy in ADR-005; move to a shared
// store (Redis) only when the app runs on more than one machine.

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024); // 10 MB

// Fixed-window counters keyed by tenant+bucket. Generous enough for real use,
// low enough to bound cost/abuse from a leaked key.
const LIMITS: Record<string, { max: number; windowMs: number }> = {
  ask: { max: 60, windowMs: 60_000 }, // 60 questions/min (each costs an API call)
  upload: { max: 30, windowMs: 60_000 }, // 30 uploads/min
  default: { max: 120, windowMs: 60_000 },
};

const windows = new Map<string, { count: number; resetAt: number }>();

export interface RateResult {
  ok: boolean;
  retryAfterSec: number;
}

export function rateCheck(tenantId: string, bucket: keyof typeof LIMITS | string): RateResult {
  const limit = LIMITS[bucket] ?? LIMITS.default;
  const key = `${tenantId}:${bucket}`;
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  if (w.count >= limit.max) {
    return { ok: false, retryAfterSec: Math.ceil((w.resetAt - now) / 1000) };
  }
  w.count++;
  return { ok: true, retryAfterSec: 0 };
}

// Prevent unbounded growth of the window map (one entry per tenant+bucket).
// Cheap sweep of expired entries on a timer; unref so it never holds the process open.
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k);
}, 60_000).unref?.();
