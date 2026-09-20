import {
  billNotificationEvent,
  type NotificationEventType,
} from "./notification-foundation.ts";

export const NOTIFICATION_DISPATCH_LEASE_MS = 5 * 60 * 1000;
export const NOTIFICATION_DISPATCH_MAX_ATTEMPTS = 4;
export const NOTIFICATION_DISPATCH_MAX_ITEMS = 25;

export type NotificationTransportMessage = Readonly<{
  chatId: string;
  text: string;
}>;

export type NotificationTransportResult =
  | { kind: "sent"; providerMessageId?: string }
  | { kind: "permanent_failure"; errorCode?: string }
  | { kind: "rate_limited"; retryAfterSeconds: number; errorCode?: string }
  | { kind: "transient_failure"; errorCode?: string }
  | { kind: "uncertain"; errorCode?: string };

export type NotificationTransport = {
  send(message: NotificationTransportMessage): Promise<NotificationTransportResult>;
};

export type NotificationDispatcherContext = {
  d1: D1Database;
  transport: NotificationTransport;
  now?: Date | string;
  leaseDurationMs?: number;
  maxAttempts?: number;
  maxItems?: number;
};

export type NotificationDispatcherSummary = {
  claimed: number;
  sent: number;
  failed: number;
  retried: number;
  uncertain: number;
  cancelled: number;
  skipped: number;
};

type ClaimedOutboxRow = {
  id: string;
  household_id: string;
  recipient_user_id: string;
  channel: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  reference_date: string;
  attempts: number;
  lease_until: string;
};

type BillNotificationEventType = Exclude<NotificationEventType, "upcoming_digest">;

type RevalidationRow = ClaimedOutboxRow & {
  bill_id: string | null;
  bill_household_id: string | null;
  description: string | null;
  amount_cents: number | null;
  due_date: string | null;
  bill_status: string | null;
  membership_status: string | null;
  preference_channel: string | null;
  preference_enabled: number | null;
  bill_due_tomorrow: number | null;
  bill_due_today: number | null;
  bill_overdue: number | null;
  timezone: string | null;
  has_active_telegram_link: number;
};

type DispatchableBill = {
  id: string;
  householdId: string;
  recipientUserId: string;
  eventType: BillNotificationEventType;
  referenceDate: string;
  description: string;
  amountCents: number;
  dueDate: string;
  timezone: string;
  leaseUntil: string;
  attempts: number;
};

type RevalidationResult =
  | { reason: string }
  | { bill: DispatchableBill };

const dispatchableBillEvents = new Set<BillNotificationEventType>([
  "bill_due_tomorrow",
  "bill_due_today",
  "bill_overdue",
]);

function instant(value: Date | string | undefined) {
  const parsed = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(parsed.getTime())) throw new Error("Instante do dispatcher inválido.");
  return parsed;
}

function positiveInteger(value: number | undefined, fallback: number, label: string, maximum: number) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} inválido.`);
  }
  return resolved;
}

function changes(result: D1Result<unknown>) {
  return Number(result.meta.changes ?? 0);
}

function safeErrorCode(prefix: string, value?: string) {
  const code = typeof value === "string" && /^[a-z0-9_.-]{1,64}$/iu.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
  return code ? `${prefix}:${code}` : prefix;
}

function providerMessageId(value?: string) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 255) : null;
}

function addMilliseconds(value: Date, milliseconds: number) {
  return new Date(value.getTime() + milliseconds).toISOString();
}

function retryBackoffSeconds(attempt: number) {
  return Math.min(60 * (2 ** Math.max(0, attempt - 1)), 60 * 60);
}

function formatCurrency(amountCents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(amountCents / 100).replace(/\u00a0/gu, " ");
}

function formatCivilDate(value: string) {
  const [, month, day] = value.split("-");
  return `${day}/${month}`;
}

export function buildBillNotificationMessage(input: Pick<DispatchableBill, "eventType" | "description" | "amountCents" | "dueDate">) {
  const amount = formatCurrency(input.amountCents);
  const dueDate = formatCivilDate(input.dueDate);
  if (input.eventType === "bill_due_tomorrow") {
    return `🔔 Lembrete de vencimento\n\n${input.description}\n${amount}\nVence amanhã, ${dueDate}.`;
  }
  if (input.eventType === "bill_due_today") {
    return `⚠️ Vence hoje\n\n${input.description}\n${amount}\nAinda consta como pendente.`;
  }
  return `🚨 Conta atrasada\n\n${input.description}\n${amount}\nVenceu em ${dueDate} e continua pendente.`;
}

async function claimNext(context: NotificationDispatcherContext, at: Date, leaseDurationMs: number) {
  const now = at.toISOString();
  const leaseUntil = addMilliseconds(at, leaseDurationMs);
  return context.d1.prepare(`UPDATE notification_outbox
    SET status = 'processing', lease_until = ?, updated_at = ?
    WHERE id = (
      SELECT id
      FROM notification_outbox
      WHERE channel = 'telegram'
        AND entity_type = 'bill'
        AND (
          (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'processing' AND lease_until <= ?)
        )
      ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
      LIMIT 1
    )
      AND channel = 'telegram'
      AND entity_type = 'bill'
      AND (
        (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'processing' AND lease_until <= ?)
      )
    RETURNING id,household_id,recipient_user_id,channel,entity_type,entity_id,
      event_type,reference_date,attempts,lease_until`).bind(
    leaseUntil,
    now,
    now,
    now,
    now,
    now,
  ).first<ClaimedOutboxRow>();
}

async function revalidateClaim(context: NotificationDispatcherContext, claim: ClaimedOutboxRow, at: Date): Promise<RevalidationResult> {
  const row = await context.d1.prepare(`SELECT
      o.id,o.household_id,o.recipient_user_id,o.channel,o.entity_type,o.entity_id,
      o.event_type,o.reference_date,o.attempts,o.lease_until,
      b.id AS bill_id,b.household_id AS bill_household_id,b.description,b.amount_cents,
      b.due_date,b.status AS bill_status,
      m.status AS membership_status,
      p.channel AS preference_channel,p.enabled AS preference_enabled,
      p.bill_due_tomorrow,p.bill_due_today,p.bill_overdue,p.timezone,
      EXISTS (
        SELECT 1 FROM telegram_links link
        WHERE link.household_id = o.household_id
          AND link.user_id = o.recipient_user_id
          AND link.is_active = 1
      ) AS has_active_telegram_link
    FROM notification_outbox o
    LEFT JOIN bills b
      ON b.id = o.entity_id AND b.household_id = o.household_id
    LEFT JOIN household_members m
      ON m.household_id = o.household_id AND m.user_id = o.recipient_user_id
    LEFT JOIN user_notification_preferences p
      ON p.household_id = o.household_id
      AND p.user_id = o.recipient_user_id
      AND p.channel = o.channel
    WHERE o.id = ? AND o.status = 'processing' AND o.lease_until = ?
    LIMIT 1`).bind(claim.id, claim.lease_until).first<RevalidationRow>();

  if (!row) return { reason: "claim_no_longer_owned" } as const;
  if (row.channel !== "telegram" || row.entity_type !== "bill" || !dispatchableBillEvents.has(row.event_type as BillNotificationEventType)) {
    return { reason: "unsupported_outbox_item" } as const;
  }
  if (!row.bill_id || row.bill_household_id !== row.household_id) return { reason: "bill_missing" } as const;
  if (row.bill_status !== "pending") return { reason: `bill_${row.bill_status ?? "invalid"}` } as const;
  if (row.membership_status !== "active") return { reason: "membership_inactive" } as const;
  if (row.preference_channel !== "telegram" || !row.preference_enabled) return { reason: "preference_disabled" } as const;

  const eventFlag = {
    bill_due_tomorrow: row.bill_due_tomorrow,
    bill_due_today: row.bill_due_today,
    bill_overdue: row.bill_overdue,
  }[row.event_type as "bill_due_tomorrow" | "bill_due_today" | "bill_overdue"];
  if (!eventFlag) return { reason: "event_disabled" } as const;
  if (!row.has_active_telegram_link) return { reason: "telegram_link_inactive" } as const;
  if (!row.description || !Number.isInteger(row.amount_cents) || Number(row.amount_cents) <= 0 || !row.due_date || !row.timezone) {
    return { reason: "bill_data_invalid" } as const;
  }

  try {
    const currentEvent = billNotificationEvent(row.entity_id, row.due_date, at, row.timezone);
    if (!currentEvent || currentEvent.eventType !== row.event_type || currentEvent.referenceDate !== row.reference_date) {
      return { reason: "event_no_longer_relevant" } as const;
    }
  } catch {
    return { reason: "event_data_invalid" } as const;
  }

  return {
    bill: {
      id: row.id,
      householdId: row.household_id,
      recipientUserId: row.recipient_user_id,
      eventType: row.event_type as BillNotificationEventType,
      referenceDate: row.reference_date,
      description: row.description,
      amountCents: Number(row.amount_cents),
      dueDate: row.due_date,
      timezone: row.timezone,
      leaseUntil: row.lease_until,
      attempts: Number(row.attempts),
    },
  } as const;
}

async function resolveTelegramDestination(context: NotificationDispatcherContext, bill: DispatchableBill) {
  const row = await context.d1.prepare(`SELECT link.chat_id
    FROM telegram_links link
    INNER JOIN household_members m
      ON m.household_id = link.household_id
      AND m.user_id = link.user_id
      AND m.status = 'active'
    INNER JOIN user_notification_preferences p
      ON p.household_id = link.household_id
      AND p.user_id = link.user_id
      AND p.channel = 'telegram'
      AND p.enabled = 1
    WHERE link.household_id = ?
      AND link.user_id = ?
      AND link.is_active = 1
    ORDER BY link.updated_at DESC, link.id
    LIMIT 1`).bind(bill.householdId, bill.recipientUserId).first<{ chat_id: string }>();
  const chatId = row?.chat_id?.trim();
  return chatId || null;
}

async function cancelClaim(context: NotificationDispatcherContext, claim: ClaimedOutboxRow, reason: string, at: Date) {
  const result = await context.d1.prepare(`UPDATE notification_outbox
    SET status = 'cancelled', lease_until = NULL, next_attempt_at = NULL,
      last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_until = ?`).bind(
    safeErrorCode("dispatch_cancelled", reason),
    at.toISOString(),
    claim.id,
    claim.lease_until,
  ).run();
  return changes(result) === 1;
}

async function failExhaustedClaim(context: NotificationDispatcherContext, bill: DispatchableBill, at: Date) {
  const result = await context.d1.prepare(`UPDATE notification_outbox
    SET status = 'failed', lease_until = NULL, next_attempt_at = NULL,
      last_error = 'transport_retry_limit_exhausted', updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_until = ?`).bind(
    at.toISOString(),
    bill.id,
    bill.leaseUntil,
  ).run();
  return changes(result) === 1;
}

async function armExternalAttempt(context: NotificationDispatcherContext, bill: DispatchableBill, at: Date) {
  return context.d1.prepare(`UPDATE notification_outbox
    SET status = 'uncertain', attempts = attempts + 1, lease_until = NULL,
      next_attempt_at = NULL, last_error = 'transport_outcome_pending', updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_until = ?
    RETURNING attempts`).bind(
    at.toISOString(),
    bill.id,
    bill.leaseUntil,
  ).first<{ attempts: number }>();
}

async function finishSent(context: NotificationDispatcherContext, id: string, attempt: number, result: Extract<NotificationTransportResult, { kind: "sent" }>, at: Date) {
  const timestamp = at.toISOString();
  const update = await context.d1.prepare(`UPDATE notification_outbox
    SET status = 'sent', provider_message_id = ?, last_error = NULL,
      sent_at = ?, updated_at = ?
    WHERE id = ? AND status = 'uncertain' AND attempts = ?`).bind(
    providerMessageId(result.providerMessageId),
    timestamp,
    timestamp,
    id,
    attempt,
  ).run();
  return changes(update) === 1;
}

async function finishFailed(context: NotificationDispatcherContext, id: string, attempt: number, error: string, at: Date) {
  const update = await context.d1.prepare(`UPDATE notification_outbox
    SET status = 'failed', next_attempt_at = NULL, last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'uncertain' AND attempts = ?`).bind(
    error,
    at.toISOString(),
    id,
    attempt,
  ).run();
  return changes(update) === 1;
}

async function finishRetry(context: NotificationDispatcherContext, id: string, attempt: number, error: string, nextAttemptAt: string, at: Date) {
  const update = await context.d1.prepare(`UPDATE notification_outbox
    SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'uncertain' AND attempts = ?`).bind(
    nextAttemptAt,
    error,
    at.toISOString(),
    id,
    attempt,
  ).run();
  return changes(update) === 1;
}

async function keepUncertain(context: NotificationDispatcherContext, id: string, attempt: number, error: string, at: Date) {
  const update = await context.d1.prepare(`UPDATE notification_outbox
    SET last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'uncertain' AND attempts = ?`).bind(
    error,
    at.toISOString(),
    id,
    attempt,
  ).run();
  return changes(update) === 1;
}

async function dispatchClaim(
  context: NotificationDispatcherContext,
  claim: ClaimedOutboxRow,
  at: Date,
  maxAttempts: number,
  summary: NotificationDispatcherSummary,
) {
  const validation = await revalidateClaim(context, claim, at);
  if ("reason" in validation) {
    if (validation.reason === "claim_no_longer_owned") summary.skipped += 1;
    else if (await cancelClaim(context, claim, validation.reason, at)) summary.cancelled += 1;
    else summary.skipped += 1;
    return;
  }

  const bill = validation.bill;
  if (bill.attempts >= maxAttempts) {
    if (await failExhaustedClaim(context, bill, at)) summary.failed += 1;
    else summary.skipped += 1;
    return;
  }

  const chatId = await resolveTelegramDestination(context, bill);
  if (!chatId) {
    if (await cancelClaim(context, claim, "telegram_link_inactive", at)) summary.cancelled += 1;
    else summary.skipped += 1;
    return;
  }

  const text = buildBillNotificationMessage(bill);
  const armed = await armExternalAttempt(context, bill, at);
  if (!armed) {
    summary.skipped += 1;
    return;
  }

  const attempt = Number(armed.attempts);
  let result: NotificationTransportResult;
  try {
    result = await context.transport.send({ chatId, text });
  } catch {
    if (await keepUncertain(context, bill.id, attempt, "transport_uncertain", at)) summary.uncertain += 1;
    else summary.skipped += 1;
    return;
  }

  if (result.kind === "sent") {
    if (await finishSent(context, bill.id, attempt, result, at)) summary.sent += 1;
    else summary.skipped += 1;
    return;
  }

  if (result.kind === "permanent_failure") {
    const error = safeErrorCode("transport_permanent", result.errorCode);
    if (await finishFailed(context, bill.id, attempt, error, at)) summary.failed += 1;
    else summary.skipped += 1;
    return;
  }

  if (result.kind === "rate_limited") {
    if (attempt >= maxAttempts) {
      if (await finishFailed(context, bill.id, attempt, "transport_rate_limit_exhausted", at)) summary.failed += 1;
      else summary.skipped += 1;
      return;
    }
    const retryAfter = Number.isFinite(result.retryAfterSeconds) && result.retryAfterSeconds > 0
      ? Math.ceil(result.retryAfterSeconds)
      : retryBackoffSeconds(attempt);
    const nextAttemptAt = addMilliseconds(at, retryAfter * 1000);
    const error = safeErrorCode("transport_rate_limited", result.errorCode);
    if (await finishRetry(context, bill.id, attempt, error, nextAttemptAt, at)) summary.retried += 1;
    else summary.skipped += 1;
    return;
  }

  if (result.kind === "transient_failure") {
    if (attempt >= maxAttempts) {
      if (await finishFailed(context, bill.id, attempt, "transport_retry_limit_exhausted", at)) summary.failed += 1;
      else summary.skipped += 1;
      return;
    }
    const nextAttemptAt = addMilliseconds(at, retryBackoffSeconds(attempt) * 1000);
    const error = safeErrorCode("transport_transient", result.errorCode);
    if (await finishRetry(context, bill.id, attempt, error, nextAttemptAt, at)) summary.retried += 1;
    else summary.skipped += 1;
    return;
  }

  const error = safeErrorCode("transport_uncertain", result.errorCode);
  if (await keepUncertain(context, bill.id, attempt, error, at)) summary.uncertain += 1;
  else summary.skipped += 1;
}

export async function runNotificationDispatcher(context: NotificationDispatcherContext): Promise<NotificationDispatcherSummary> {
  const at = instant(context.now);
  const leaseDurationMs = positiveInteger(context.leaseDurationMs, NOTIFICATION_DISPATCH_LEASE_MS, "Lease", 60 * 60 * 1000);
  const maxAttempts = positiveInteger(context.maxAttempts, NOTIFICATION_DISPATCH_MAX_ATTEMPTS, "Máximo de tentativas", 1000);
  const maxItems = positiveInteger(context.maxItems, NOTIFICATION_DISPATCH_MAX_ITEMS, "Limite do lote", 1000);
  const summary: NotificationDispatcherSummary = {
    claimed: 0,
    sent: 0,
    failed: 0,
    retried: 0,
    uncertain: 0,
    cancelled: 0,
    skipped: 0,
  };

  for (let index = 0; index < maxItems; index += 1) {
    const claim = await claimNext(context, at, leaseDurationMs);
    if (!claim) break;
    summary.claimed += 1;
    await dispatchClaim(context, claim, at, maxAttempts, summary);
  }

  return summary;
}
