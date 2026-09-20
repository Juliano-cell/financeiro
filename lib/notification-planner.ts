import {
  NotificationFoundationError,
  assertNotificationDate,
  billNotificationEvent,
  createNotificationOutboxItem,
  notificationLocalDate,
  type NotificationEventType,
} from "./notification-foundation.ts";

export type BillNotificationPlannerContext = {
  d1: D1Database;
  now?: Date | string;
  householdId?: string;
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

async function listEligibleTelegramRecipients(context: BillNotificationPlannerContext) {
  const householdId = context.householdId?.trim();
  if (context.householdId !== undefined && !householdId) {
    throw new NotificationFoundationError("Família é obrigatória.", "NOTIFICATION_INVALID_IDENTIFIER");
  }
  const householdFilter = householdId ? "AND p.household_id = ?" : "";
  const statement = context.d1.prepare(`SELECT
      p.household_id,
      p.user_id,
      p.bill_due_tomorrow,
      p.bill_due_today,
      p.bill_overdue,
      p.timezone
    FROM user_notification_preferences p
    INNER JOIN household_members m
      ON m.household_id = p.household_id
      AND m.user_id = p.user_id
      AND m.status = 'active'
    WHERE p.channel = 'telegram'
      AND p.enabled = 1
      ${householdFilter}
      AND EXISTS (
        SELECT 1
        FROM telegram_links link
        WHERE link.household_id = p.household_id
          AND link.user_id = p.user_id
          AND link.is_active = 1
      )
    ORDER BY p.household_id, p.user_id`);
  const result = await (householdId ? statement.bind(householdId) : statement).all<EligibleRecipientRow>();
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
  const recipients = await listEligibleTelegramRecipients(context);
  const summary: BillNotificationPlannerSummary = {
    recipientsEvaluated: recipients.length,
    billsEvaluated: 0,
    eventsEligible: 0,
    inserted: 0,
    deduplicated: 0,
    skipped: 0,
  };

  for (const recipient of recipients) {
    const localDate = notificationLocalDate(now, recipient.timezone);
    const bills = await listBillCandidates(context.d1, recipient.household_id, localDate);
    summary.billsEvaluated += bills.length;

    for (const bill of bills) {
      const event = billNotificationEvent(bill.id, bill.due_date, now, recipient.timezone);
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
      }, "telegram", event);

      if (result.created) summary.inserted += 1;
      else if (result.duplicate) summary.deduplicated += 1;
      else summary.skipped += 1;
    }
  }

  return summary;
}
