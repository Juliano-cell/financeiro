import {
  NOTIFICATION_CHANNELS,
  NotificationFoundationError,
  type NotificationChannel,
} from "./notification-foundation.ts";
import { synchronizeNotificationScheduleState } from "./notification-schedule-state.ts";

export const NOTIFICATION_SCHEDULE_BOOTSTRAP_MAX_ITEMS = 500;

export type NotificationScheduleBootstrapSummary = {
  examined: number;
  created: number;
  skipped: number;
  failed: number;
};

type BootstrapCandidate = {
  household_id: string;
  user_id: string;
  channel: string;
};

function limit(value: number | undefined) {
  const resolved = value ?? 100;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > NOTIFICATION_SCHEDULE_BOOTSTRAP_MAX_ITEMS) {
    throw new NotificationFoundationError(
      "Limite de bootstrap inválido.",
      "NOTIFICATION_SCHEDULE_INVALID_LIMIT",
    );
  }
  return resolved;
}

/**
 * Operação administrativa deliberada e idempotente. Não é exposta por
 * rota, entrypoint ou Cron; o chamador deve injetar D1 e relógio explicitamente.
 */
export async function bootstrapNotificationScheduleStates(input: {
  d1: D1Database;
  now?: Date | string;
  limit?: number;
}): Promise<NotificationScheduleBootstrapSummary> {
  const result = await input.d1.prepare(`SELECT p.household_id,p.user_id,p.channel
    FROM user_notification_preferences p
    INNER JOIN household_members m
      ON m.household_id = p.household_id AND m.user_id = p.user_id AND m.status = 'active'
    LEFT JOIN notification_schedule_state s
      ON s.household_id = p.household_id AND s.user_id = p.user_id AND s.channel = p.channel
    WHERE p.enabled = 1 AND p.channel IN ('telegram','push')
      AND s.household_id IS NULL
    ORDER BY p.household_id,p.user_id,p.channel
    LIMIT ?`).bind(limit(input.limit)).all<BootstrapCandidate>();

  const summary: NotificationScheduleBootstrapSummary = {
    examined: result.results.length,
    created: 0,
    skipped: 0,
    failed: 0,
  };
  const supportedChannels = new Set<string>(NOTIFICATION_CHANNELS);
  for (const candidate of result.results) {
    if (!supportedChannels.has(candidate.channel)) {
      summary.skipped += 1;
      continue;
    }
    try {
      const state = await synchronizeNotificationScheduleState({
        d1: input.d1,
        householdId: candidate.household_id,
        userId: candidate.user_id,
        channel: candidate.channel as NotificationChannel,
        now: input.now,
      });
      if (state?.nextRunAt) summary.created += 1;
      else summary.skipped += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
