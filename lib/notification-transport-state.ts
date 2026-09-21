import {
  NotificationFoundationError,
  isNotificationChannel,
  type NotificationChannel,
} from "./notification-foundation.ts";

export const NOTIFICATION_TRANSPORT_LEASE_MS = 5 * 60 * 1000;

export type NotificationTransportState = {
  channel: NotificationChannel;
  pausedUntil: string | null;
  leaseUntil: string | null;
  leaseToken: string | null;
  createdAt: string;
  updatedAt: string;
};

type NotificationTransportStateContext = {
  d1: D1Database;
  channel: NotificationChannel;
  now?: Date | string;
};

function instant(value: Date | string | undefined, label = "Instante") {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (Number.isNaN(parsed.getTime())) {
    throw new NotificationFoundationError(`${label} inválido.`, "NOTIFICATION_TRANSPORT_INVALID_INSTANT");
  }
  return parsed;
}

function requiredToken(value: string) {
  const token = value.trim();
  if (!token || token.length > 200) {
    throw new NotificationFoundationError("Token do lease inválido.", "NOTIFICATION_TRANSPORT_INVALID_LEASE_TOKEN");
  }
  return token;
}

function channel(value: NotificationChannel) {
  if (!isNotificationChannel(value)) {
    throw new NotificationFoundationError("Canal inválido.", "NOTIFICATION_INVALID_CHANNEL");
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 60 * 60 * 1000) {
    throw new NotificationFoundationError("Duração do lease inválida.", "NOTIFICATION_TRANSPORT_INVALID_LEASE");
  }
  return resolved;
}

function fromRow(row: Record<string, unknown>): NotificationTransportState {
  return {
    channel: String(row.channel) as NotificationChannel,
    pausedUntil: row.paused_until === null ? null : String(row.paused_until),
    leaseUntil: row.lease_until === null ? null : String(row.lease_until),
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function changes(result: D1Result<unknown>) {
  return Number(result.meta.changes ?? 0);
}

export async function getNotificationTransportState(context: NotificationTransportStateContext) {
  const selectedChannel = channel(context.channel);
  const row = await context.d1.prepare(`SELECT * FROM notification_transport_state
    WHERE channel = ? LIMIT 1`).bind(selectedChannel).first<Record<string, unknown>>();
  return row ? fromRow(row) : null;
}

export async function acquireNotificationTransportLease(input: NotificationTransportStateContext & {
  leaseDurationMs?: number;
  createLeaseToken?: () => string;
}) {
  const selectedChannel = channel(input.channel);
  const at = instant(input.now);
  const now = at.toISOString();
  const leaseUntil = new Date(at.getTime() + positiveInteger(
    input.leaseDurationMs,
    NOTIFICATION_TRANSPORT_LEASE_MS,
  )).toISOString();
  const leaseToken = requiredToken(input.createLeaseToken?.() ?? crypto.randomUUID());
  const row = await input.d1.prepare(`INSERT INTO notification_transport_state(
      channel,paused_until,lease_until,lease_token,created_at,updated_at
    ) VALUES(?,NULL,?,?,?,?)
    ON CONFLICT(channel) DO UPDATE SET
      paused_until = CASE
        WHEN notification_transport_state.paused_until <= ? THEN NULL
        ELSE notification_transport_state.paused_until END,
      lease_until = excluded.lease_until,
      lease_token = excluded.lease_token,
      updated_at = excluded.updated_at
    WHERE (notification_transport_state.paused_until IS NULL
        OR notification_transport_state.paused_until <= ?)
      AND (notification_transport_state.lease_until IS NULL
        OR notification_transport_state.lease_until <= ?)
    RETURNING *`).bind(
    selectedChannel,
    leaseUntil,
    leaseToken,
    now,
    now,
    now,
    now,
    now,
  ).first<Record<string, unknown>>();
  return row ? fromRow(row) : null;
}

export async function releaseNotificationTransportLease(input: NotificationTransportStateContext & {
  leaseToken: string;
}) {
  const selectedChannel = channel(input.channel);
  const now = instant(input.now).toISOString();
  const leaseToken = requiredToken(input.leaseToken);
  const result = await input.d1.prepare(`UPDATE notification_transport_state
    SET lease_until = NULL, lease_token = NULL, updated_at = ?
    WHERE channel = ? AND lease_token = ?`).bind(now, selectedChannel, leaseToken).run();
  return changes(result) === 1;
}

export async function pauseNotificationTransport(input: NotificationTransportStateContext & {
  leaseToken: string;
  pausedUntil: Date | string;
}) {
  const selectedChannel = channel(input.channel);
  const now = instant(input.now).toISOString();
  const pausedUntil = instant(input.pausedUntil, "Fim da pausa").toISOString();
  const leaseToken = requiredToken(input.leaseToken);
  const result = await input.d1.prepare(`UPDATE notification_transport_state
    SET paused_until = CASE
        WHEN paused_until IS NULL OR paused_until < ? THEN ? ELSE paused_until END,
      updated_at = ?
    WHERE channel = ? AND lease_token = ? AND lease_until > ?`).bind(
    pausedUntil,
    pausedUntil,
    now,
    selectedChannel,
    leaseToken,
    now,
  ).run();
  if (changes(result) !== 1) return null;
  return getNotificationTransportState(input);
}

export function isNotificationTransportPaused(
  state: NotificationTransportState | null,
  now: Date | string,
) {
  if (!state?.pausedUntil) return false;
  return new Date(state.pausedUntil).getTime() > instant(now).getTime();
}
