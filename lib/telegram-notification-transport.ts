import type {
  NotificationTransport,
  NotificationTransportMessage,
  NotificationTransportResult,
} from "./notification-dispatcher.ts";

export const TELEGRAM_NOTIFICATION_TIMEOUT_MS = 10_000;
export const TELEGRAM_NOTIFICATION_MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

export type TelegramNotificationFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type TelegramNotificationTransportOptions = Readonly<{
  token: string;
  fetchImpl: TelegramNotificationFetch;
  timeoutMs?: number;
}>;

type TelegramApiPayload = {
  ok?: unknown;
  error_code?: unknown;
  parameters?: unknown;
  result?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedToken(value: string) {
  const token = value.trim();
  if (!/^[0-9]+:[A-Za-z0-9_-]{8,240}$/u.test(token)) {
    throw new Error("Token do transport Telegram ausente ou inválido.");
  }
  return token;
}

function normalizedTimeout(value: number | undefined) {
  const timeout = value ?? TELEGRAM_NOTIFICATION_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new Error("Timeout do transport Telegram inválido.");
  }
  return timeout;
}

function retryAfterSeconds(payload: TelegramApiPayload | null) {
  if (!payload || !isRecord(payload.parameters)) return 0;
  const value = payload.parameters.retry_after;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.ceil(value), TELEGRAM_NOTIFICATION_MAX_RETRY_AFTER_SECONDS);
}

function providerMessageId(payload: TelegramApiPayload) {
  if (!isRecord(payload.result)) return undefined;
  const value = payload.result.message_id;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,255}$/u.test(value)) return value;
  return undefined;
}

function apiErrorCode(payload: TelegramApiPayload | null) {
  const value = payload?.error_code;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function rateLimited(payload: TelegramApiPayload | null): NotificationTransportResult {
  return {
    kind: "rate_limited",
    retryAfterSeconds: retryAfterSeconds(payload),
    errorCode: "telegram_rate_limited",
  };
}

function classifyRejectedStatus(status: number, payload: TelegramApiPayload | null): NotificationTransportResult {
  if (status === 429) return rateLimited(payload);
  if (status === 408) return { kind: "transient_failure", errorCode: "telegram_http_408" };
  if (status >= 500 && status <= 599) {
    return { kind: "transient_failure", errorCode: `telegram_http_${status}` };
  }
  if (status >= 400 && status <= 499) {
    return { kind: "permanent_failure", errorCode: `telegram_http_${status}` };
  }
  return { kind: "uncertain", errorCode: "telegram_http_unexpected" };
}

function classifyApiRejection(payload: TelegramApiPayload): NotificationTransportResult {
  const status = apiErrorCode(payload);
  if (status === 429) return rateLimited(payload);
  if (status === 408) return { kind: "transient_failure", errorCode: "telegram_api_408" };
  if (status !== null && status >= 500 && status <= 599) {
    return { kind: "transient_failure", errorCode: `telegram_api_${status}` };
  }
  if (status !== null && status >= 400 && status <= 499) {
    return { kind: "permanent_failure", errorCode: `telegram_api_${status}` };
  }
  return { kind: "permanent_failure", errorCode: "telegram_api_rejected" };
}

async function safePayload(response: Response) {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value as TelegramApiPayload : null;
  } catch {
    return null;
  }
}

export class TelegramNotificationTransport implements NotificationTransport {
  readonly #token: string;
  readonly #fetch: TelegramNotificationFetch;
  readonly #timeoutMs: number;

  constructor(options: TelegramNotificationTransportOptions) {
    this.#token = normalizedToken(options.token);
    this.#fetch = options.fetchImpl;
    this.#timeoutMs = normalizedTimeout(options.timeoutMs);
  }

  async send(message: NotificationTransportMessage): Promise<NotificationTransportResult> {
    const chatId = message.chatId.trim();
    const text = message.text.trim();
    if (!chatId || chatId.length > 128) {
      return { kind: "permanent_failure", errorCode: "telegram_destination_invalid" };
    }
    if (!text) {
      return { kind: "permanent_failure", errorCode: "telegram_message_invalid" };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(
        `https://api.telegram.org/bot${this.#token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4_096) }),
          signal: controller.signal,
        },
      );
    } catch {
      clearTimeout(timeout);
      return timedOut
        ? { kind: "uncertain", errorCode: "telegram_timeout" }
        : { kind: "uncertain", errorCode: "telegram_network_ambiguous" };
    }

    let payload: TelegramApiPayload | null;
    try {
      payload = await safePayload(response);
    } finally {
      clearTimeout(timeout);
    }

    if (timedOut) return { kind: "uncertain", errorCode: "telegram_timeout" };
    if (!response.ok) return classifyRejectedStatus(response.status, payload);
    if (!payload) return { kind: "uncertain", errorCode: "telegram_response_invalid" };
    if (payload.ok === false) return classifyApiRejection(payload);
    if (payload.ok !== true) return { kind: "uncertain", errorCode: "telegram_response_unexpected" };

    const messageId = providerMessageId(payload);
    return {
      kind: "sent",
      ...(messageId ? { providerMessageId: messageId } : {}),
    };
  }
}
