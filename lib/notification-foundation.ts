import { dateInTimeZone } from "./finance-analytics.mjs";

export const NOTIFICATION_CHANNELS = ["telegram", "push"] as const;
export const NOTIFICATION_EVENT_TYPES = ["bill_due_tomorrow", "bill_due_today", "bill_overdue", "upcoming_digest"] as const;
export const NOTIFICATION_OUTBOX_STATUSES = ["pending", "processing", "sent", "failed", "uncertain", "cancelled"] as const;

export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number];
export type NotificationEventType = typeof NOTIFICATION_EVENT_TYPES[number];
export type NotificationOutboxStatus = typeof NOTIFICATION_OUTBOX_STATUSES[number];
export type NotificationEntityType = "bill" | "household";

export type NotificationContext = {
  d1: D1Database;
  householdId: string;
  userId: string;
  now?: Date | string;
  createId?: () => string;
};

export type NotificationPreference = {
  householdId: string;
  userId: string;
  channel: NotificationChannel;
  enabled: boolean;
  billDueTomorrow: boolean;
  billDueToday: boolean;
  billOverdue: boolean;
  upcomingDigest: boolean;
  preferredLocalTime: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
};

export type SaveNotificationPreferenceInput = {
  channel: NotificationChannel;
  enabled?: boolean;
  billDueTomorrow?: boolean;
  billDueToday?: boolean;
  billOverdue?: boolean;
  upcomingDigest?: boolean;
  preferredLocalTime?: string;
  timezone?: string;
};

export type NotificationEvent = {
  entityType: NotificationEntityType;
  entityId: string;
  eventType: NotificationEventType;
  referenceDate: string;
};

export type NotificationOutboxItem = NotificationEvent & {
  id: string;
  householdId: string;
  recipientUserId: string;
  channel: NotificationChannel;
  dedupeKey: string;
  status: NotificationOutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  leaseUntil: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
};

export class NotificationFoundationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "NotificationFoundationError";
    this.code = code;
  }
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const localTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const channelSet = new Set<string>(NOTIFICATION_CHANNELS);
const eventTypeSet = new Set<string>(NOTIFICATION_EVENT_TYPES);
const statusSet = new Set<string>(NOTIFICATION_OUTBOX_STATUSES);

function requiredIdentifier(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new NotificationFoundationError(`${label} é obrigatório.`, "NOTIFICATION_INVALID_IDENTIFIER");
  return normalized;
}

function timestamp(context: Pick<NotificationContext, "now">) {
  const value = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now());
  if (Number.isNaN(value.getTime())) throw new NotificationFoundationError("Instante inválido.", "NOTIFICATION_INVALID_INSTANT");
  return value.toISOString();
}

function civilTimestamp(value: string) {
  assertNotificationDate(value);
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function addCivilDays(value: string, days: number) {
  const date = new Date(civilTimestamp(value));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function preferenceFromRow(row: Record<string, unknown>): NotificationPreference {
  return {
    householdId: String(row.household_id),
    userId: String(row.user_id),
    channel: String(row.channel) as NotificationChannel,
    enabled: Boolean(row.enabled),
    billDueTomorrow: Boolean(row.bill_due_tomorrow),
    billDueToday: Boolean(row.bill_due_today),
    billOverdue: Boolean(row.bill_overdue),
    upcomingDigest: Boolean(row.upcoming_digest),
    preferredLocalTime: String(row.preferred_local_time),
    timezone: String(row.timezone),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function outboxFromRow(row: Record<string, unknown>): NotificationOutboxItem {
  return {
    id: String(row.id),
    householdId: String(row.household_id),
    recipientUserId: String(row.recipient_user_id),
    channel: String(row.channel) as NotificationChannel,
    entityType: String(row.entity_type) as NotificationEntityType,
    entityId: String(row.entity_id),
    eventType: String(row.event_type) as NotificationEventType,
    referenceDate: String(row.reference_date),
    dedupeKey: String(row.dedupe_key),
    status: String(row.status) as NotificationOutboxStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : String(row.next_attempt_at),
    leaseUntil: row.lease_until === null ? null : String(row.lease_until),
    providerMessageId: row.provider_message_id === null ? null : String(row.provider_message_id),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    sentAt: row.sent_at === null ? null : String(row.sent_at),
  };
}

export function isNotificationChannel(value: string): value is NotificationChannel {
  return channelSet.has(value);
}

export function isNotificationEventType(value: string): value is NotificationEventType {
  return eventTypeSet.has(value);
}

export function isNotificationOutboxStatus(value: string): value is NotificationOutboxStatus {
  return statusSet.has(value);
}

export function assertNotificationDate(value: string) {
  if (!isoDatePattern.test(value)) throw new NotificationFoundationError("Data de referência inválida.", "NOTIFICATION_INVALID_DATE");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new NotificationFoundationError("Data de referência inválida.", "NOTIFICATION_INVALID_DATE");
  }
  return value;
}

export function notificationLocalDate(now: Date | string = new Date(), timeZone = "America/Sao_Paulo") {
  try {
    const value = now instanceof Date ? now : new Date(now);
    return dateInTimeZone(value, timeZone);
  } catch {
    throw new NotificationFoundationError("Timezone inválido.", "NOTIFICATION_INVALID_TIMEZONE");
  }
}

export function classifyBillNotification(dueDate: string, now: Date | string = new Date(), timeZone = "America/Sao_Paulo"): NotificationEventType | null {
  const localDate = notificationLocalDate(now, timeZone);
  const offset = Math.round((civilTimestamp(dueDate) - civilTimestamp(localDate)) / 86_400_000);
  if (offset === 1) return "bill_due_tomorrow";
  if (offset === 0) return "bill_due_today";
  if (offset < 0) return "bill_overdue";
  return null;
}

export function billNotificationEvent(entityId: string, dueDate: string, now: Date | string = new Date(), timeZone = "America/Sao_Paulo"): NotificationEvent | null {
  const eventType = classifyBillNotification(dueDate, now, timeZone);
  if (!eventType) return null;
  const localDate = notificationLocalDate(now, timeZone);
  return {
    entityType: "bill",
    entityId: requiredIdentifier(entityId, "Vencimento"),
    eventType,
    // Overdue is one logical transition, anchored to the first overdue day.
    referenceDate: eventType === "bill_overdue" ? addCivilDays(dueDate, 1) : localDate,
  };
}

export function upcomingDigestEvent(householdId: string, now: Date | string = new Date(), timeZone = "America/Sao_Paulo"): NotificationEvent {
  const normalizedHouseholdId = requiredIdentifier(householdId, "Família");
  return { entityType: "household", entityId: normalizedHouseholdId, eventType: "upcoming_digest", referenceDate: notificationLocalDate(now, timeZone) };
}

export function buildNotificationDedupeKey(input: {
  householdId: string;
  recipientUserId: string;
  channel: NotificationChannel;
} & NotificationEvent) {
  const values = [
    requiredIdentifier(input.householdId, "Família"),
    requiredIdentifier(input.recipientUserId, "Destinatário"),
    input.channel,
    input.entityType,
    requiredIdentifier(input.entityId, "Entidade"),
    input.eventType,
    assertNotificationDate(input.referenceDate),
  ];
  if (!isNotificationChannel(input.channel)) throw new NotificationFoundationError("Canal inválido.", "NOTIFICATION_INVALID_CHANNEL");
  if (!isNotificationEventType(input.eventType)) throw new NotificationFoundationError("Evento inválido.", "NOTIFICATION_INVALID_EVENT");
  return values.map((value) => encodeURIComponent(value)).join(":");
}

export function validateNotificationPreference(input: SaveNotificationPreferenceInput) {
  if (!isNotificationChannel(input.channel)) throw new NotificationFoundationError("Canal inválido.", "NOTIFICATION_INVALID_CHANNEL");
  const preferredLocalTime = input.preferredLocalTime ?? "09:00";
  if (!localTimePattern.test(preferredLocalTime)) throw new NotificationFoundationError("Horário local inválido.", "NOTIFICATION_INVALID_LOCAL_TIME");
  const timezone = (input.timezone ?? "America/Sao_Paulo").trim();
  notificationLocalDate(new Date(0), timezone);
  return {
    channel: input.channel,
    enabled: input.enabled ?? false,
    billDueTomorrow: input.billDueTomorrow ?? true,
    billDueToday: input.billDueToday ?? true,
    billOverdue: input.billOverdue ?? true,
    upcomingDigest: input.upcomingDigest ?? false,
    preferredLocalTime,
    timezone,
  };
}

export async function getUserNotificationPreference(context: NotificationContext, channel: NotificationChannel) {
  if (!isNotificationChannel(channel)) throw new NotificationFoundationError("Canal inválido.", "NOTIFICATION_INVALID_CHANNEL");
  const row = await context.d1.prepare(`SELECT p.*
    FROM user_notification_preferences p
    INNER JOIN household_members m
      ON m.household_id = p.household_id AND m.user_id = p.user_id AND m.status = 'active'
    WHERE p.household_id = ? AND p.user_id = ? AND p.channel = ?
    LIMIT 1`).bind(context.householdId, context.userId, channel).first<Record<string, unknown>>();
  return row ? preferenceFromRow(row) : null;
}

export async function saveUserNotificationPreference(context: NotificationContext, input: SaveNotificationPreferenceInput) {
  const preference = validateNotificationPreference(input);
  const at = timestamp(context);
  const result = await context.d1.prepare(`INSERT INTO user_notification_preferences (
      household_id,user_id,channel,enabled,bill_due_tomorrow,bill_due_today,bill_overdue,
      upcoming_digest,preferred_local_time,timezone,created_at,updated_at
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?
    WHERE EXISTS (
      SELECT 1 FROM household_members
      WHERE household_id = ? AND user_id = ? AND status = 'active'
    )
    ON CONFLICT(household_id,user_id,channel) DO UPDATE SET
      enabled=excluded.enabled,
      bill_due_tomorrow=excluded.bill_due_tomorrow,
      bill_due_today=excluded.bill_due_today,
      bill_overdue=excluded.bill_overdue,
      upcoming_digest=excluded.upcoming_digest,
      preferred_local_time=excluded.preferred_local_time,
      timezone=excluded.timezone,
      updated_at=excluded.updated_at`).bind(
    context.householdId, context.userId, preference.channel, preference.enabled ? 1 : 0,
    preference.billDueTomorrow ? 1 : 0, preference.billDueToday ? 1 : 0,
    preference.billOverdue ? 1 : 0, preference.upcomingDigest ? 1 : 0,
    preference.preferredLocalTime, preference.timezone, at, at,
    context.householdId, context.userId,
  ).run();
  if ((result.meta.changes ?? 0) === 0) throw new NotificationFoundationError("Usuário não possui membership ativa nesta família.", "NOTIFICATION_INACTIVE_MEMBERSHIP");
  const saved = await getUserNotificationPreference(context, preference.channel);
  if (!saved) throw new NotificationFoundationError("Preferência não encontrada após gravação.", "NOTIFICATION_PREFERENCE_NOT_FOUND");
  return saved;
}

export async function getNotificationOutboxItem(context: NotificationContext, dedupeKey: string) {
  const row = await context.d1.prepare(`SELECT o.*
    FROM notification_outbox o
    INNER JOIN household_members m
      ON m.household_id = o.household_id AND m.user_id = o.recipient_user_id AND m.status = 'active'
    WHERE o.household_id = ? AND o.recipient_user_id = ? AND o.dedupe_key = ?
    LIMIT 1`).bind(context.householdId, context.userId, dedupeKey).first<Record<string, unknown>>();
  return row ? outboxFromRow(row) : null;
}

export async function createNotificationOutboxItem(context: NotificationContext, channel: NotificationChannel, event: NotificationEvent) {
  if (!isNotificationChannel(channel)) throw new NotificationFoundationError("Canal inválido.", "NOTIFICATION_INVALID_CHANNEL");
  if (!isNotificationEventType(event.eventType)) throw new NotificationFoundationError("Evento inválido.", "NOTIFICATION_INVALID_EVENT");
  if ((event.eventType === "upcoming_digest") !== (event.entityType === "household")) {
    throw new NotificationFoundationError("Evento e entidade são incompatíveis.", "NOTIFICATION_INVALID_ENTITY");
  }
  if (event.entityType === "household" && event.entityId !== context.householdId) {
    throw new NotificationFoundationError("Resumo pertence a outra família.", "NOTIFICATION_CROSS_HOUSEHOLD");
  }
  const referenceDate = assertNotificationDate(event.referenceDate);
  const dedupeKey = buildNotificationDedupeKey({ householdId: context.householdId, recipientUserId: context.userId, channel, ...event, referenceDate });
  const at = timestamp(context);
  const id = `notification_outbox_${context.createId?.() ?? crypto.randomUUID()}`;
  const eventFlag = {
    bill_due_tomorrow: "p.bill_due_tomorrow",
    bill_due_today: "p.bill_due_today",
    bill_overdue: "p.bill_overdue",
    upcoming_digest: "p.upcoming_digest",
  }[event.eventType];
  const result = await context.d1.prepare(`INSERT INTO notification_outbox (
      id,household_id,recipient_user_id,channel,entity_type,entity_id,event_type,
      reference_date,dedupe_key,status,attempts,next_attempt_at,lease_until,
      provider_message_id,last_error,created_at,updated_at,sent_at
    ) SELECT ?,p.household_id,p.user_id,p.channel,?,?,?,?,?,'pending',0,?,NULL,NULL,NULL,?,?,NULL
    FROM user_notification_preferences p
    INNER JOIN household_members m
      ON m.household_id = p.household_id AND m.user_id = p.user_id AND m.status = 'active'
    WHERE p.household_id = ? AND p.user_id = ? AND p.channel = ? AND p.enabled = 1
      AND ${eventFlag} = 1
      AND (? <> 'bill' OR EXISTS (
        SELECT 1 FROM bills b WHERE b.household_id = p.household_id AND b.id = ? AND b.status = 'pending'
      ))
    ON CONFLICT(household_id,recipient_user_id,channel,entity_type,entity_id,event_type,reference_date)
    DO NOTHING`).bind(
    id, event.entityType, event.entityId, event.eventType, referenceDate, dedupeKey,
    at, at, at, context.householdId, context.userId, channel, event.entityType, event.entityId,
  ).run();
  if ((result.meta.changes ?? 0) > 0) {
    const item = await getNotificationOutboxItem(context, dedupeKey);
    if (!item) throw new NotificationFoundationError("Item não encontrado após criação.", "NOTIFICATION_OUTBOX_NOT_FOUND");
    return { created: true as const, duplicate: false as const, item };
  }
  const existing = await getNotificationOutboxItem(context, dedupeKey);
  return existing
    ? { created: false as const, duplicate: true as const, item: existing }
    : { created: false as const, duplicate: false as const, item: null };
}

export function sanitizeNotificationError(error: unknown) {
  const source = error instanceof Error ? error.message : String(error ?? "Erro desconhecido");
  return source
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\b(TELEGRAM_BOT_TOKEN|token|secret|password|authorization|chat_id)\b\s*[:=]\s*["']?[^\s,;}"']+/giu, "$1=[REDACTED]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{10,}\b/gu, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 500);
}
