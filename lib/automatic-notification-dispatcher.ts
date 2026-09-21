import {
  NOTIFICATION_DISPATCH_MAX_ATTEMPTS,
  runNotificationDispatcher,
  type NotificationDispatcherSummary,
  type NotificationRateLimitContext,
  type NotificationTransport,
} from "./notification-dispatcher.ts";
import {
  NOTIFICATION_TRANSPORT_LEASE_MS,
  acquireNotificationTransportLease,
  getNotificationTransportState,
  isNotificationTransportPaused,
  releaseNotificationTransportLease,
} from "./notification-transport-state.ts";

export const AUTOMATIC_NOTIFICATION_DISPATCH_MAX_ITEMS = 10;

export type AutomaticNotificationDispatcherSummary = NotificationDispatcherSummary & {
  rateLimited: number;
  paused: number;
};

export type AutomaticNotificationDispatcherContext = {
  d1: D1Database;
  transport: NotificationTransport;
  now?: Date | string;
  leaseDurationMs?: number;
  maxAttempts?: number;
  maxItems?: number;
  createLeaseToken?: () => string;
};

function instant(value: Date | string | undefined) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (Number.isNaN(parsed.getTime())) throw new TypeError("Instante inválido para o dispatcher automático.");
  return parsed;
}

function maxItems(value: number | undefined) {
  const resolved = value ?? AUTOMATIC_NOTIFICATION_DISPATCH_MAX_ITEMS;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > AUTOMATIC_NOTIFICATION_DISPATCH_MAX_ITEMS) {
    throw new RangeError("Limite inválido para o dispatcher automático.");
  }
  return resolved;
}

function emptySummary(values: Partial<AutomaticNotificationDispatcherSummary> = {}): AutomaticNotificationDispatcherSummary {
  return {
    claimed: 0,
    sent: 0,
    failed: 0,
    retried: 0,
    uncertain: 0,
    cancelled: 0,
    skipped: 0,
    rateLimited: 0,
    paused: 0,
    ...values,
  };
}

function changes(result: D1Result<unknown>) {
  return Number(result.meta.changes ?? 0);
}

export async function persistAutomaticTelegramRateLimit(input: {
  d1: D1Database;
  leaseToken: string;
  rateLimit: NotificationRateLimitContext;
}) {
  const { rateLimit } = input;
  const itemStatus = rateLimit.exhausted ? "failed" : "pending";
  const itemError = rateLimit.exhausted ? "transport_rate_limit_exhausted" : rateLimit.error;
  const nextAttemptAt = rateLimit.exhausted ? null : rateLimit.nextAttemptAt;
  const transportUpdate = input.d1.prepare(`UPDATE notification_transport_state
    SET paused_until = CASE
        WHEN paused_until IS NULL OR paused_until < ? THEN ? ELSE paused_until END,
      updated_at = ?
    WHERE channel = 'telegram' AND lease_token = ? AND lease_until > ?
      AND EXISTS (
        SELECT 1 FROM notification_outbox
        WHERE id = ? AND channel = 'telegram' AND status = 'uncertain' AND attempts = ?
      )`).bind(
    rateLimit.nextAttemptAt,
    rateLimit.nextAttemptAt,
    rateLimit.now,
    input.leaseToken,
    rateLimit.now,
    rateLimit.outboxId,
    rateLimit.attempt,
  );
  const outboxUpdate = input.d1.prepare(`UPDATE notification_outbox
    SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
    WHERE id = ? AND channel = 'telegram' AND status = 'uncertain' AND attempts = ?
      AND EXISTS (
        SELECT 1 FROM notification_transport_state
        WHERE channel = 'telegram' AND lease_token = ? AND lease_until > ?
          AND paused_until IS NOT NULL AND paused_until >= ?
      )`).bind(
    itemStatus,
    nextAttemptAt,
    itemError,
    rateLimit.now,
    rateLimit.outboxId,
    rateLimit.attempt,
    input.leaseToken,
    rateLimit.now,
    rateLimit.nextAttemptAt,
  );
  const results = await input.d1.batch([transportUpdate, outboxUpdate]);
  return results.length === 2 && results.every((result) => changes(result) === 1);
}

export async function runAutomaticNotificationDispatcher(
  context: AutomaticNotificationDispatcherContext,
): Promise<AutomaticNotificationDispatcherSummary> {
  const now = instant(context.now);
  const lease = await acquireNotificationTransportLease({
    d1: context.d1,
    channel: "telegram",
    now,
    leaseDurationMs: context.leaseDurationMs ?? NOTIFICATION_TRANSPORT_LEASE_MS,
    createLeaseToken: context.createLeaseToken,
  });
  if (!lease?.leaseToken) {
    const state = await getNotificationTransportState({ d1: context.d1, channel: "telegram", now });
    return isNotificationTransportPaused(state, now)
      ? emptySummary({ paused: 1 })
      : emptySummary({ skipped: 1 });
  }

  let rateLimited = 0;
  try {
    const result = await runNotificationDispatcher({
      d1: context.d1,
      transport: context.transport,
      now,
      leaseDurationMs: context.leaseDurationMs,
      maxAttempts: context.maxAttempts ?? NOTIFICATION_DISPATCH_MAX_ATTEMPTS,
      maxItems: maxItems(context.maxItems),
      handleRateLimit: async (rateLimit) => {
        const persisted = await persistAutomaticTelegramRateLimit({
          d1: context.d1,
          leaseToken: lease.leaseToken!,
          rateLimit,
        });
        if (persisted) rateLimited += 1;
        return persisted;
      },
    });
    return { ...result, rateLimited, paused: 0 };
  } finally {
    await releaseNotificationTransportLease({
      d1: context.d1,
      channel: "telegram",
      now,
      leaseToken: lease.leaseToken,
    });
  }
}
