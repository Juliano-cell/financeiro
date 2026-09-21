import { env } from "cloudflare:workers";
import type { NotificationDispatcherContext } from "./notification-dispatcher.ts";
import {
  TelegramNotificationTransport,
  TELEGRAM_NOTIFICATION_TIMEOUT_MS,
  type TelegramNotificationFetch,
} from "./telegram-notification-transport.ts";

type RuntimeTransportOptions = Readonly<{
  fetchImpl?: TelegramNotificationFetch;
  timeoutMs?: number;
}>;

type RuntimeDispatcherOptions = RuntimeTransportOptions & Readonly<{
  now?: Date | string;
  leaseDurationMs?: number;
  maxAttempts?: number;
  maxItems?: number;
}>;

export function createTelegramNotificationTransport(options: RuntimeTransportOptions = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN não configurado.");
  return new TelegramNotificationTransport({
    token,
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
    timeoutMs: options.timeoutMs ?? TELEGRAM_NOTIFICATION_TIMEOUT_MS,
  });
}

export function createTelegramNotificationDispatcherContext(
  d1: D1Database,
  options: RuntimeDispatcherOptions = {},
): NotificationDispatcherContext {
  return {
    d1,
    transport: createTelegramNotificationTransport(options),
    now: options.now,
    leaseDurationMs: options.leaseDurationMs,
    maxAttempts: options.maxAttempts,
    maxItems: options.maxItems,
  };
}
