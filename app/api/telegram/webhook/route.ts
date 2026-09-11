import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { handleTelegramUpdate, isDuplicateTelegramError, isTelegramPayloadTooLarge } from "@/lib/telegram-handler";
import { sendTelegramMessage } from "@/lib/telegram";

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
  try {
    const result = await handleTelegramUpdate(update);
    if (result.duplicate) return NextResponse.json({ ok: true, duplicate: true });
    const candidate = update as { message?: { chat?: { id?: number | string } }; callback_query?: { message?: { chat?: { id?: number | string } } } };
    const chatId = String(candidate.message?.chat?.id ?? candidate.callback_query?.message?.chat?.id ?? "");
    if (result.text && chatId) await sendTelegramMessage(chatId, result.text, result.buttons);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isDuplicateTelegramError(error)) return NextResponse.json({ ok: true, duplicate: true });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Payload inválido." }, { status: 400 });
    console.error("telegram_webhook_failed");
    return NextResponse.json({ ok: true });
  }
}
