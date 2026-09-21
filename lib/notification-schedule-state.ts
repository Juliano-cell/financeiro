import {
  NotificationFoundationError,
  type NotificationChannel,
  isNotificationChannel,
} from "./notification-foundation.ts";

export const NOTIFICATION_SCHEDULE_LEASE_MS = 5 * 60 * 1000;
export const NOTIFICATION_SCHEDULE_MAX_DUE = 100;

export type NotificationScheduleResult = "completed" | "missed";

export type NotificationScheduleState = {
  householdId: string;
  userId: string;
  channel: NotificationChannel;
  preferredLocalTime: string;
  timezone: string;
  preferenceUpdatedAt: string;
  nextRunAt: string | null;
  scheduledLocalDate: string | null;
  leaseUntil: string | null;
  leaseToken: string | null;
  lastCompletedLocalDate: string | null;
  lastResult: NotificationScheduleResult | null;
  createdAt: string;
  updatedAt: string;
};

export type NotificationScheduleContext = {
  d1: D1Database;
  householdId: string;
  userId: string;
  channel: NotificationChannel;
  now?: Date | string;
  createLeaseToken?: () => string;
};

export type NotificationScheduleOccurrence = {
  nextRunAt: string;
  scheduledLocalDate: string;
};

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

type PreferenceRow = {
  enabled: number;
  preferred_local_time: string;
  timezone: string;
  updated_at: string;
};

const localTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const civilDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const formatters = new Map<string, Intl.DateTimeFormat>();

function requiredIdentifier(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new NotificationFoundationError(`${label} é obrigatório.`, "NOTIFICATION_SCHEDULE_INVALID_IDENTIFIER");
  }
  return normalized;
}

function instant(value: Date | string | undefined, label = "Instante") {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (Number.isNaN(parsed.getTime())) {
    throw new NotificationFoundationError(`${label} inválido.`, "NOTIFICATION_SCHEDULE_INVALID_INSTANT");
  }
  return parsed;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number, label: string) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new NotificationFoundationError(`${label} inválido.`, "NOTIFICATION_SCHEDULE_INVALID_LIMIT");
  }
  return resolved;
}

function assertLocalTime(value: string) {
  if (!localTimePattern.test(value)) {
    throw new NotificationFoundationError("Horário local inválido.", "NOTIFICATION_INVALID_LOCAL_TIME");
  }
  return value;
}

function civilDateParts(value: string) {
  if (!civilDatePattern.test(value)) {
    throw new NotificationFoundationError("Data civil inválida.", "NOTIFICATION_INVALID_DATE");
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new NotificationFoundationError("Data civil inválida.", "NOTIFICATION_INVALID_DATE");
  }
  return { year, month, day };
}

function addCivilDays(value: string, days: number) {
  const { year, month, day } = civilDateParts(value);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
}

function formatter(timezone: string) {
  const normalized = timezone.trim();
  if (!normalized) {
    throw new NotificationFoundationError("Timezone inválido.", "NOTIFICATION_INVALID_TIMEZONE");
  }
  const cached = formatters.get(normalized);
  if (cached) return cached;
  try {
    const created = new Intl.DateTimeFormat("en-CA", {
      timeZone: normalized,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    created.formatToParts(new Date(0));
    formatters.set(normalized, created);
    return created;
  } catch {
    throw new NotificationFoundationError("Timezone inválido.", "NOTIFICATION_INVALID_TIMEZONE");
  }
}

function localParts(value: Date, timezone: string): LocalDateTimeParts {
  const parts = Object.fromEntries(
    formatter(timezone).formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function localKey(parts: LocalDateTimeParts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function localDateAt(value: Date | string, timezone: string) {
  const parts = localParts(instant(value), timezone);
  return localKey(parts).slice(0, 10);
}

export function resolveZonedScheduleInstant(
  scheduledLocalDate: string,
  preferredLocalTime: string,
  timezone: string,
) {
  const date = civilDateParts(scheduledLocalDate);
  const localTime = assertLocalTime(preferredLocalTime);
  formatter(timezone);
  const [hour, minute] = localTime.split(":").map(Number);
  const desiredKey = `${scheduledLocalDate}T${localTime}`;
  const nominal = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const start = nominal - 24 * 60 * 60 * 1000;
  const end = nominal + 36 * 60 * 60 * 1000;
  let firstValidAfterGap: Date | null = null;

  for (let timestamp = start; timestamp <= end; timestamp += 60_000) {
    const candidate = new Date(timestamp);
    const candidateKey = localKey(localParts(candidate, timezone));
    if (candidateKey === desiredKey) return candidate.toISOString();
    if (firstValidAfterGap === null && candidateKey > desiredKey) firstValidAfterGap = candidate;
  }

  if (firstValidAfterGap) return firstValidAfterGap.toISOString();
  throw new NotificationFoundationError(
    "Não foi possível resolver o próximo horário local.",
    "NOTIFICATION_SCHEDULE_UNRESOLVABLE_TIME",
  );
}

export function calculateNextNotificationSchedule(input: {
  now?: Date | string;
  preferredLocalTime: string;
  timezone: string;
}): NotificationScheduleOccurrence {
  const now = instant(input.now);
  const localDate = localDateAt(now, input.timezone);
  const today = resolveZonedScheduleInstant(localDate, input.preferredLocalTime, input.timezone);
  if (new Date(today).getTime() >= now.getTime()) {
    return { nextRunAt: today, scheduledLocalDate: localDate };
  }
  const tomorrow = addCivilDays(localDate, 1);
  return {
    nextRunAt: resolveZonedScheduleInstant(tomorrow, input.preferredLocalTime, input.timezone),
    scheduledLocalDate: tomorrow,
  };
}

export function calculateNextNotificationScheduleAfterCompleted(input: {
  now?: Date | string;
  preferredLocalTime: string;
  timezone: string;
  lastCompletedLocalDate?: string | null;
}): NotificationScheduleOccurrence {
  const occurrence = calculateNextNotificationSchedule(input);
  if (!input.lastCompletedLocalDate
    || input.lastCompletedLocalDate < occurrence.scheduledLocalDate) return occurrence;
  const nextLocalDate = addCivilDays(input.lastCompletedLocalDate, 1);
  return {
    scheduledLocalDate: nextLocalDate,
    nextRunAt: resolveZonedScheduleInstant(
      nextLocalDate,
      input.preferredLocalTime,
      input.timezone,
    ),
  };
}

function scheduleFromRow(row: Record<string, unknown>): NotificationScheduleState {
  return {
    householdId: String(row.household_id),
    userId: String(row.user_id),
    channel: String(row.channel) as NotificationChannel,
    preferredLocalTime: String(row.preferred_local_time),
    timezone: String(row.timezone),
    preferenceUpdatedAt: String(row.preference_updated_at),
    nextRunAt: row.next_run_at === null ? null : String(row.next_run_at),
    scheduledLocalDate: row.scheduled_local_date === null ? null : String(row.scheduled_local_date),
    leaseUntil: row.lease_until === null ? null : String(row.lease_until),
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    lastCompletedLocalDate: row.last_completed_local_date === null ? null : String(row.last_completed_local_date),
    lastResult: row.last_result === null ? null : String(row.last_result) as NotificationScheduleResult,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function changes(result: D1Result<unknown>) {
  return Number(result.meta.changes ?? 0);
}

function validatedContext(context: NotificationScheduleContext) {
  if (!isNotificationChannel(context.channel)) {
    throw new NotificationFoundationError("Canal inválido.", "NOTIFICATION_INVALID_CHANNEL");
  }
  return {
    householdId: requiredIdentifier(context.householdId, "Família"),
    userId: requiredIdentifier(context.userId, "Usuário"),
    channel: context.channel,
  };
}

async function preference(context: NotificationScheduleContext) {
  const identity = validatedContext(context);
  return context.d1.prepare(`SELECT p.enabled,p.preferred_local_time,p.timezone,p.updated_at
    FROM user_notification_preferences p
    INNER JOIN household_members m
      ON m.household_id = p.household_id AND m.user_id = p.user_id AND m.status = 'active'
    WHERE p.household_id = ? AND p.user_id = ? AND p.channel = ?
    LIMIT 1`).bind(identity.householdId, identity.userId, identity.channel).first<PreferenceRow>();
}

export async function getNotificationScheduleState(context: NotificationScheduleContext) {
  const identity = validatedContext(context);
  const row = await context.d1.prepare(`SELECT * FROM notification_schedule_state
    WHERE household_id = ? AND user_id = ? AND channel = ? LIMIT 1`)
    .bind(identity.householdId, identity.userId, identity.channel)
    .first<Record<string, unknown>>();
  return row ? scheduleFromRow(row) : null;
}

export async function synchronizeNotificationScheduleState(context: NotificationScheduleContext) {
  const identity = validatedContext(context);
  const currentPreference = await preference(context);
  if (!currentPreference) {
    throw new NotificationFoundationError(
      "Preferência ativa não encontrada para sincronização.",
      "NOTIFICATION_SCHEDULE_PREFERENCE_NOT_FOUND",
    );
  }
  const at = instant(context.now);
  const now = at.toISOString();

  if (!Boolean(currentPreference.enabled)) {
    await context.d1.prepare(`UPDATE notification_schedule_state
      SET next_run_at = NULL, scheduled_local_date = NULL,
        lease_until = NULL, lease_token = NULL,
        preferred_local_time = ?, timezone = ?, preference_updated_at = ?, updated_at = ?
      WHERE household_id = ? AND user_id = ? AND channel = ?
        AND EXISTS (
          SELECT 1 FROM user_notification_preferences p
          WHERE p.household_id = notification_schedule_state.household_id
            AND p.user_id = notification_schedule_state.user_id
            AND p.channel = notification_schedule_state.channel
            AND p.enabled = 0 AND p.updated_at = ?
        )`).bind(
      currentPreference.preferred_local_time,
      currentPreference.timezone,
      currentPreference.updated_at,
      now,
      identity.householdId,
      identity.userId,
      identity.channel,
      currentPreference.updated_at,
    ).run();
    return getNotificationScheduleState(context);
  }

  const existingState = await getNotificationScheduleState(context);
  const occurrence = calculateNextNotificationScheduleAfterCompleted({
    now: at,
    preferredLocalTime: currentPreference.preferred_local_time,
    timezone: currentPreference.timezone,
    lastCompletedLocalDate: existingState?.lastCompletedLocalDate,
  });
  await context.d1.prepare(`INSERT INTO notification_schedule_state (
      household_id,user_id,channel,preferred_local_time,timezone,preference_updated_at,
      next_run_at,scheduled_local_date,lease_until,lease_token,
      last_completed_local_date,last_result,created_at,updated_at
    ) SELECT p.household_id,p.user_id,p.channel,p.preferred_local_time,p.timezone,p.updated_at,
      ?,?,NULL,NULL,NULL,NULL,?,?
    FROM user_notification_preferences p
    INNER JOIN household_members m
      ON m.household_id = p.household_id AND m.user_id = p.user_id AND m.status = 'active'
    WHERE p.household_id = ? AND p.user_id = ? AND p.channel = ? AND p.enabled = 1
      AND p.preferred_local_time = ? AND p.timezone = ? AND p.updated_at = ?
    ON CONFLICT(household_id,user_id,channel) DO UPDATE SET
      preferred_local_time = excluded.preferred_local_time,
      timezone = excluded.timezone,
      preference_updated_at = excluded.preference_updated_at,
      next_run_at = CASE
        WHEN notification_schedule_state.next_run_at IS NULL
          OR notification_schedule_state.preferred_local_time <> excluded.preferred_local_time
          OR notification_schedule_state.timezone <> excluded.timezone
        THEN excluded.next_run_at ELSE notification_schedule_state.next_run_at END,
      scheduled_local_date = CASE
        WHEN notification_schedule_state.next_run_at IS NULL
          OR notification_schedule_state.preferred_local_time <> excluded.preferred_local_time
          OR notification_schedule_state.timezone <> excluded.timezone
        THEN excluded.scheduled_local_date ELSE notification_schedule_state.scheduled_local_date END,
      lease_until = CASE
        WHEN notification_schedule_state.preference_updated_at <> excluded.preference_updated_at
        THEN NULL ELSE notification_schedule_state.lease_until END,
      lease_token = CASE
        WHEN notification_schedule_state.preference_updated_at <> excluded.preference_updated_at
        THEN NULL ELSE notification_schedule_state.lease_token END,
      updated_at = excluded.updated_at`).bind(
    occurrence.nextRunAt,
    occurrence.scheduledLocalDate,
    now,
    now,
    identity.householdId,
    identity.userId,
    identity.channel,
    currentPreference.preferred_local_time,
    currentPreference.timezone,
    currentPreference.updated_at,
  ).run();
  const state = await getNotificationScheduleState(context);
  if (!state
    || state.preferenceUpdatedAt !== currentPreference.updated_at
    || state.preferredLocalTime !== currentPreference.preferred_local_time
    || state.timezone !== currentPreference.timezone) {
    throw new NotificationFoundationError(
      "Preferência mudou durante a sincronização.",
      "NOTIFICATION_SCHEDULE_STALE_PREFERENCE",
    );
  }
  return state;
}

export async function listDueNotificationScheduleStates(input: {
  d1: D1Database;
  now?: Date | string;
  limit?: number;
}) {
  const now = instant(input.now).toISOString();
  const limit = positiveInteger(input.limit, NOTIFICATION_SCHEDULE_MAX_DUE, 500, "Limite");
  const result = await input.d1.prepare(`SELECT s.*
    FROM notification_schedule_state s
    INNER JOIN user_notification_preferences p
      ON p.household_id = s.household_id AND p.user_id = s.user_id AND p.channel = s.channel
      AND p.enabled = 1 AND p.preferred_local_time = s.preferred_local_time
      AND p.timezone = s.timezone AND p.updated_at = s.preference_updated_at
    INNER JOIN household_members m
      ON m.household_id = s.household_id AND m.user_id = s.user_id AND m.status = 'active'
    WHERE s.next_run_at IS NOT NULL AND s.next_run_at <= ?
      AND (s.lease_until IS NULL OR s.lease_until <= ?)
    ORDER BY s.next_run_at,s.household_id,s.user_id,s.channel
    LIMIT ?`).bind(now, now, limit).all<Record<string, unknown>>();
  return result.results.map(scheduleFromRow);
}

export async function claimNotificationScheduleState(input: NotificationScheduleContext & {
  expectedNextRunAt: string;
  expectedScheduledLocalDate: string;
  leaseDurationMs?: number;
}) {
  const identity = validatedContext(input);
  const at = instant(input.now);
  const now = at.toISOString();
  const expectedNextRunAt = instant(input.expectedNextRunAt, "Próxima execução").toISOString();
  civilDateParts(input.expectedScheduledLocalDate);
  const expectedScheduledLocalDate = input.expectedScheduledLocalDate;
  const leaseDurationMs = positiveInteger(
    input.leaseDurationMs,
    NOTIFICATION_SCHEDULE_LEASE_MS,
    60 * 60 * 1000,
    "Duração do lease",
  );
  const leaseUntil = new Date(at.getTime() + leaseDurationMs).toISOString();
  const leaseToken = requiredIdentifier(
    input.createLeaseToken?.() ?? crypto.randomUUID(),
    "Token do lease",
  );
  const result = await input.d1.prepare(`UPDATE notification_schedule_state
    SET lease_until = ?, lease_token = ?, updated_at = ?
    WHERE household_id = ? AND user_id = ? AND channel = ?
      AND next_run_at = ? AND scheduled_local_date = ? AND next_run_at <= ?
      AND (lease_until IS NULL OR lease_until <= ?)
      AND EXISTS (
        SELECT 1 FROM user_notification_preferences p
        INNER JOIN household_members m
          ON m.household_id = p.household_id AND m.user_id = p.user_id AND m.status = 'active'
        WHERE p.household_id = notification_schedule_state.household_id
          AND p.user_id = notification_schedule_state.user_id
          AND p.channel = notification_schedule_state.channel
          AND p.enabled = 1
          AND p.preferred_local_time = notification_schedule_state.preferred_local_time
          AND p.timezone = notification_schedule_state.timezone
          AND p.updated_at = notification_schedule_state.preference_updated_at
      )`).bind(
    leaseUntil,
    leaseToken,
    now,
    identity.householdId,
    identity.userId,
    identity.channel,
    expectedNextRunAt,
    expectedScheduledLocalDate,
    now,
    now,
  ).run();
  if (changes(result) !== 1) return null;
  return getNotificationScheduleState(input);
}

export function isNotificationScheduleSlotMissed(
  scheduledLocalDate: string,
  now: Date | string,
  timezone: string,
) {
  civilDateParts(scheduledLocalDate);
  return localDateAt(now, timezone) > scheduledLocalDate;
}

export async function completeNotificationScheduleState(input: NotificationScheduleContext & {
  expectedNextRunAt: string;
  expectedScheduledLocalDate: string;
  leaseToken: string;
}) {
  const identity = validatedContext(input);
  const state = await getNotificationScheduleState(input);
  if (!state || !state.nextRunAt || !state.scheduledLocalDate) return null;
  const now = instant(input.now);
  const expectedNextRunAt = instant(input.expectedNextRunAt, "Próxima execução").toISOString();
  civilDateParts(input.expectedScheduledLocalDate);
  const leaseToken = requiredIdentifier(input.leaseToken, "Token do lease");
  if (state.nextRunAt !== expectedNextRunAt
    || state.scheduledLocalDate !== input.expectedScheduledLocalDate
    || state.leaseToken !== leaseToken) return null;

  const missed = isNotificationScheduleSlotMissed(state.scheduledLocalDate, now, state.timezone);
  const result: NotificationScheduleResult = missed ? "missed" : "completed";
  const occurrence = missed
    ? calculateNextNotificationSchedule({
        now,
        preferredLocalTime: state.preferredLocalTime,
        timezone: state.timezone,
      })
    : {
        scheduledLocalDate: addCivilDays(state.scheduledLocalDate, 1),
        nextRunAt: resolveZonedScheduleInstant(
          addCivilDays(state.scheduledLocalDate, 1),
          state.preferredLocalTime,
          state.timezone,
        ),
      };
  const update = await input.d1.prepare(`UPDATE notification_schedule_state
    SET next_run_at = ?, scheduled_local_date = ?, lease_until = NULL, lease_token = NULL,
      last_completed_local_date = ?, last_result = ?, updated_at = ?
    WHERE household_id = ? AND user_id = ? AND channel = ?
      AND next_run_at = ? AND scheduled_local_date = ? AND lease_token = ?
      AND lease_until > ?
      AND EXISTS (
        SELECT 1 FROM user_notification_preferences p
        INNER JOIN household_members m
          ON m.household_id = p.household_id AND m.user_id = p.user_id AND m.status = 'active'
        WHERE p.household_id = notification_schedule_state.household_id
          AND p.user_id = notification_schedule_state.user_id
          AND p.channel = notification_schedule_state.channel
          AND p.enabled = 1
          AND p.preferred_local_time = notification_schedule_state.preferred_local_time
          AND p.timezone = notification_schedule_state.timezone
          AND p.updated_at = notification_schedule_state.preference_updated_at
      )`).bind(
    occurrence.nextRunAt,
    occurrence.scheduledLocalDate,
    state.scheduledLocalDate,
    result,
    now.toISOString(),
    identity.householdId,
    identity.userId,
    identity.channel,
    expectedNextRunAt,
    input.expectedScheduledLocalDate,
    leaseToken,
    now.toISOString(),
  ).run();
  if (changes(update) !== 1) return null;
  return getNotificationScheduleState(input);
}

export async function releaseNotificationScheduleLease(input: NotificationScheduleContext & {
  leaseToken: string;
}) {
  const identity = validatedContext(input);
  const now = instant(input.now).toISOString();
  const leaseToken = requiredIdentifier(input.leaseToken, "Token do lease");
  const result = await input.d1.prepare(`UPDATE notification_schedule_state
    SET lease_until = NULL, lease_token = NULL, updated_at = ?
    WHERE household_id = ? AND user_id = ? AND channel = ? AND lease_token = ?`)
    .bind(now, identity.householdId, identity.userId, identity.channel, leaseToken)
    .run();
  return changes(result) === 1;
}
