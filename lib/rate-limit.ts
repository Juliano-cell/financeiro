import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { authRateLimits } from "@/db/schema";

export class RateLimitError extends Error {
  readonly status = 429;

  constructor(message = "Muitas tentativas. Aguarde alguns minutos.") {
    super(message);
  }
}

export async function consumeRateLimit(key: string, maximum: number, windowMilliseconds: number, blockMilliseconds = windowMilliseconds) {
  const currentTime = new Date();
  const currentIso = currentTime.toISOString();
  const windowCutoff = new Date(currentTime.getTime() - windowMilliseconds).toISOString();
  const blockUntil = new Date(currentTime.getTime() + blockMilliseconds).toISOString();
  if (!env.DB) throw new Error("D1 binding indisponível");
  const result = await env.DB.prepare(`
    INSERT INTO auth_rate_limits (key, attempts, window_started_at, blocked_until, updated_at)
    VALUES (?, 1, ?, NULL, ?)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE
        WHEN auth_rate_limits.blocked_until IS NOT NULL AND auth_rate_limits.blocked_until > ? THEN auth_rate_limits.attempts
        WHEN auth_rate_limits.window_started_at <= ? THEN 1
        ELSE auth_rate_limits.attempts + 1
      END,
      window_started_at = CASE WHEN auth_rate_limits.window_started_at <= ? THEN ? ELSE auth_rate_limits.window_started_at END,
      blocked_until = CASE
        WHEN auth_rate_limits.blocked_until IS NOT NULL AND auth_rate_limits.blocked_until > ? THEN auth_rate_limits.blocked_until
        WHEN auth_rate_limits.window_started_at <= ? THEN NULL
        WHEN auth_rate_limits.attempts + 1 > ? THEN ?
        ELSE NULL
      END,
      updated_at = ?
    RETURNING attempts, blocked_until
  `).bind(key, currentIso, currentIso, currentIso, windowCutoff, windowCutoff, currentIso, currentIso, windowCutoff, maximum, blockUntil, currentIso).first<{ attempts: number; blocked_until: string | null }>();
  if (!result || (result.blocked_until && result.blocked_until > currentIso) || result.attempts > maximum) throw new RateLimitError();
}

export async function clearRateLimit(key: string) {
  await getDb().delete(authRateLimits).where(eq(authRateLimits.key, key));
}
