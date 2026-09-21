import {
  NotificationFoundationError,
  assertNotificationDate,
  createNotificationOutboxItem,
  isNotificationChannel,
  notificationLocalDate,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationEventType,
} from "./notification-foundation.ts";

export type BillNotificationPlannerContext = {
  d1: D1Database;
  now?: Date | string;
  householdId?: string;
  userId?: string;
  channel?: NotificationChannel;
  referenceDate?: string;
  createId?: () => string;
};

export type BillNotificationPlannerSummary = {
  recipientsEvaluated: number;
  billsEvaluated: number;
  eventsEligible: number;
  inserted: number;
  deduplicated: number;
  skipped: number;
};

type EligibleRecipientRow = {
  household_id: string;
  user_id: string;
  channel: NotificationChannel;
  bill_due_tomorrow: number;
  bill_due_today: number;
  bill_overdue: number;
  timezone: string;
};

type BillCandidateRow = {
  id: string;
  due_date: string;
};

function addCivilDays(value: string, days: number) {
  assertNotificationDate(value);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isEventEnabled(recipient: EligibleRecipientRow, eventType: NotificationEventType) {
  if (eventType === "bill_due_tomorrow") return Boolean(recipient.bill_due_tomorrow);
  if (eventType === "bill_due_today") return Boolean(recipient.bill_due_today);
  if (eventType === "bill_overdue") return Boolean(recipient.bill_overdue);
  return false;
}

function requiredIdentifier(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new NotificationFoundationError(`${label} é obrigatório.`, "NOTIFICATION_INVALID_IDENTIFIER");
  }
  return normalized;
}

function billNotificationEventForDate(
  entityId: string,
  dueDate: string,
  referenceDate: string,
): NotificationEvent | null {
  assertNotificationDate(dueDate);
  assertNotificationDate(referenceDate);
  const offset = Math.round(
    (Date.parse(`${dueDate}T00:00:00.000Z`) - Date.parse(`${referenceDate}T00:00:00.000Z`)) / 86_400_000,
  );
  const eventType: NotificationEventType | null = offset === 1
    ? "bill_due_tomorrow"
    : offset === 0
      ? "bill_due_today"
      : offset < 0
        ? "bill_overdue"
        : null;
  if (!eventType) return null;
  return {
    entityType: "bill",
    entityId: requiredIdentifier(entityId, "Vencimento"),
    eventType,
    referenceDate: eventType === "bill_overdue" ? addCivilDays(dueDate, 1) : referenceDate,
  };
}

async function listEligibleRecipients(context: BillNotificationPlannerContext) {
  const householdId = context.householdId?.trim();
  if (context.householdId !== undefined && !householdId) {
    throw new NotificationFoundationError("Família é obrigatória.", "NOTIFICATION_INVALID_IDENTIFIER");
  }
  const userId = context.userId?.trim();
  if (context.userId !== undefined && !userId) {
    throw new NotificationFoundationError("Usuário é obrigatório.", "NOTIFICATION_INVALID_IDENTIFIER");
  }
  if (userId && !householdId) {
    throw new NotificationFoundationError(
      "Família é obrigatória para restringir o usuário.",
      "NOTIFICATION_PLANNER_INCOMPLETE_SCOPE",
    );
  }
  const channel = context.channel ?? "telegram";
  if (!isNotificationChannel(channel)) {
    throw new NotificationFoundationError("Canal inválido.", "NOTIFICATION_INVALID_CHANNEL");
  }
  const filters: string[] = [];
  const bindings: string[] = [channel];
  if (householdId) {
    filters.push("AND p.household_id = ?");
    bindings.push(householdId);
  }
  if (userId) {
    filters.push("AND p.user_id = ?");
    bindings.push(userId);
  }
  const statement = context.d1.prepare(`SELECT
      p.household_id,
      p.user_id,
      p.channel,
      p.bill_due_tomorrow,
      p.bill_due_today,
      p.bill_overdue,
      p.timezone
    FROM user_notification_preferences p
    INNER JOIN household_members m
      ON m.household_id = p.household_id
      AND m.user_id = p.user_id
      AND m.status = 'active'
    WHERE p.channel = ?
      AND p.enabled = 1
      ${filters.join("\n      ")}
      AND (p.channel <> 'telegram' OR EXISTS (
        SELECT 1
        FROM telegram_links link
        WHERE link.household_id = p.household_id
          AND link.user_id = p.user_id
          AND link.is_active = 1
      ))
    ORDER BY p.household_id, p.user_id`);
  const result = await statement.bind(...bindings).all<EligibleRecipientRow>();
  return result.results ?? [];
}

async function listBillCandidates(d1: D1Database, householdId: string, localDate: string) {
  const result = await d1.prepare(`SELECT id, due_date
    FROM bills
    WHERE household_id = ?
      AND status = 'pending'
      AND due_date IN (?, ?, ?)
    ORDER BY due_date, id`).bind(
    householdId,
    addCivilDays(localDate, -1),
    localDate,
    addCivilDays(localDate, 1),
  ).all<BillCandidateRow>();
  return result.results ?? [];
}

export async function runBillNotificationPlanner(context: BillNotificationPlannerContext): Promise<BillNotificationPlannerSummary> {
  const now = context.now ?? new Date();
  const requestedReferenceDate = context.referenceDate === undefined
    ? null
    : assertNotificationDate(context.referenceDate);
  const recipients = await listEligibleRecipients(context);
  const summary: BillNotificationPlannerSummary = {
    recipientsEvaluated: recipients.length,
    billsEvaluated: 0,
    eventsEligible: 0,
    inserted: 0,
    deduplicated: 0,
    skipped: 0,
  };

  for (const recipient of recipients) {
    const localDate = requestedReferenceDate ?? notificationLocalDate(now, recipient.timezone);
    const bills = await listBillCandidates(context.d1, recipient.household_id, localDate);
    summary.billsEvaluated += bills.length;

    for (const bill of bills) {
      const event = billNotificationEventForDate(bill.id, bill.due_date, localDate);
      if (!event || !isEventEnabled(recipient, event.eventType)) {
        summary.skipped += 1;
        continue;
      }

      summary.eventsEligible += 1;
      const result = await createNotificationOutboxItem({
        d1: context.d1,
        householdId: recipient.household_id,
        userId: recipient.user_id,
        now,
        createId: context.createId,
      }, recipient.channel, event);

      if (result.created) summary.inserted += 1;
      else if (result.duplicate) summary.deduplicated += 1;
      else summary.skipped += 1;
    }
  }

  return summary;
}
