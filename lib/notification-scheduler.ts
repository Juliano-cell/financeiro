import {
  NOTIFICATION_SCHEDULE_MAX_DUE,
  claimNotificationScheduleState,
  completeNotificationScheduleState,
  isNotificationScheduleSlotMissed,
  listDueNotificationScheduleStates,
  type NotificationScheduleState,
} from "./notification-schedule-state.ts";
import {
  runBillNotificationPlanner,
  type BillNotificationPlannerContext,
  type BillNotificationPlannerSummary,
} from "./notification-planner.ts";

export const NOTIFICATION_SCHEDULER_BATCH_SIZE = 50;

export type NotificationSchedulerSummary = {
  examined: number;
  claimed: number;
  planned: number;
  missed: number;
  skipped: number;
  failed: number;
  outboxCreated: number;
};

export type NotificationSchedulerContext = {
  d1: D1Database;
  now?: Date | string;
  limit?: number;
  batchSize?: number;
  createLeaseToken?: () => string;
  createOutboxId?: () => string;
  runPlanner?: (context: BillNotificationPlannerContext) => Promise<BillNotificationPlannerSummary>;
  onCandidate?: (state: NotificationScheduleState) => void | Promise<void>;
  onClaimed?: (state: NotificationScheduleState) => void | Promise<void>;
};

function instant(value: Date | string | undefined) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (Number.isNaN(parsed.getTime())) throw new TypeError("Instante inválido para o scheduler.");
  return parsed;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number, label: string) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${label} inválido para o scheduler.`);
  }
  return resolved;
}

function emptySummary(): NotificationSchedulerSummary {
  return { examined: 0, claimed: 0, planned: 0, missed: 0, skipped: 0, failed: 0, outboxCreated: 0 };
}

export async function runNotificationScheduler(
  context: NotificationSchedulerContext,
): Promise<NotificationSchedulerSummary> {
  const now = instant(context.now);
  const limit = boundedPositiveInteger(
    context.limit,
    NOTIFICATION_SCHEDULE_MAX_DUE,
    NOTIFICATION_SCHEDULE_MAX_DUE,
    "Limite",
  );
  const batchSize = boundedPositiveInteger(
    context.batchSize,
    NOTIFICATION_SCHEDULER_BATCH_SIZE,
    NOTIFICATION_SCHEDULER_BATCH_SIZE,
    "Lote",
  );
  const planner = context.runPlanner ?? runBillNotificationPlanner;
  const summary = emptySummary();

  while (summary.examined < limit) {
    const requested = Math.min(batchSize, limit - summary.examined);
    const due = await listDueNotificationScheduleStates({
      d1: context.d1,
      now,
      limit: requested,
    });
    if (due.length === 0) break;

    for (const candidate of due) {
      summary.examined += 1;
      if (!candidate.nextRunAt || !candidate.scheduledLocalDate) {
        summary.skipped += 1;
        continue;
      }

      await context.onCandidate?.(candidate);

      const claim = await claimNotificationScheduleState({
        d1: context.d1,
        householdId: candidate.householdId,
        userId: candidate.userId,
        channel: candidate.channel,
        now,
        expectedNextRunAt: candidate.nextRunAt,
        expectedScheduledLocalDate: candidate.scheduledLocalDate,
        createLeaseToken: context.createLeaseToken,
      });
      if (!claim?.leaseToken) {
        summary.skipped += 1;
        continue;
      }
      summary.claimed += 1;

      try {
        await context.onClaimed?.(claim);
        const missed = isNotificationScheduleSlotMissed(
          claim.scheduledLocalDate!,
          now,
          claim.timezone,
        );
        if (!missed) {
          const result = await planner({
            d1: context.d1,
            now,
            householdId: claim.householdId,
            userId: claim.userId,
            channel: claim.channel,
            referenceDate: claim.scheduledLocalDate!,
            createId: context.createOutboxId,
          });
          summary.planned += 1;
          summary.outboxCreated += result.inserted;
        }

        const completed = await completeNotificationScheduleState({
          d1: context.d1,
          householdId: claim.householdId,
          userId: claim.userId,
          channel: claim.channel,
          now,
          expectedNextRunAt: candidate.nextRunAt,
          expectedScheduledLocalDate: candidate.scheduledLocalDate,
          leaseToken: claim.leaseToken,
        });
        if (!completed) {
          summary.failed += 1;
        } else if (missed) {
          summary.missed += 1;
        }
      } catch {
        // Keep the persistent lease intact. A later cycle may recover it after expiry,
        // and outbox UNIQUE constraints make partial planner progress idempotent.
        summary.failed += 1;
      }
    }

    if (due.length < requested) break;
  }

  return summary;
}
