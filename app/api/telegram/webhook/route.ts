import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { handleTelegramUpdate, isDuplicateTelegramError, isTelegramPayloadTooLarge } from "@/lib/telegram-handler";
import { hasTelegramDeliveryFailure } from "@/lib/telegram-delivery.mjs";
import { answerTelegramCallback, sendTelegramMessage } from "@/lib/telegram";

export const dynamic = "force-dynamic";

function safeSecretEqual(received: string | null, expected: string) {
  if (!received) return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(received);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export async function POST(request: Request) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !safeSecretEqual(request.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET)) return NextResponse.json({ error: "Webhook não autorizado." }, { status: 401 });
  if (isTelegramPayloadTooLarge(request)) return NextResponse.json({ error: "Payload muito grande." }, { status: 413 });
  if (!request.headers.get("content-type")?.toLocaleLowerCase().includes("application/json")) return NextResponse.json({ error: "Conteúdo inválido." }, { status: 415 });
  let update: unknown;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 16_384) return NextResponse.json({ error: "Payload muito grande." }, { status: 413 });
    update = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }
  const candidate = update as { message?: { chat?: { id?: number | string } }; callback_query?: { id?: string; message?: { chat?: { id?: number | string } } } };
  const chatId = String(candidate.message?.chat?.id ?? candidate.callback_query?.message?.chat?.id ?? "");
  const callbackQueryId = candidate.callback_query?.id;
  let result: Awaited<ReturnType<typeof handleTelegramUpdate>>;
  try {
    result = await handleTelegramUpdate(update);
  } catch (error) {
    if (isDuplicateTelegramError(error)) result = { duplicate: true };
    else if (error instanceof z.ZodError) return NextResponse.json({ error: "Payload inválido." }, { status: 400 });
    else {
      console.error("telegram_webhook_processing_failed");
      return NextResponse.json({ error: "Falha temporária ao processar o update." }, { status: 503 });
    }
  }

  const deliveries: Promise<void>[] = [];
  if (callbackQueryId) deliveries.push(answerTelegramCallback(callbackQueryId));
  if (!result.duplicate && result.text && chatId) deliveries.push(sendTelegramMessage(chatId, result.text, result.buttons));
  const responseDeliveryFailed = await hasTelegramDeliveryFailure(deliveries);
  if (responseDeliveryFailed) console.error("telegram_webhook_response_failed");

  if (result.duplicate) return NextResponse.json({ ok: true, duplicate: true, ...(responseDeliveryFailed ? { responseDeliveryFailed: true } : {}) });
  return NextResponse.json({ ok: true, ...(responseDeliveryFailed ? { responseDeliveryFailed: true } : {}) });
}
