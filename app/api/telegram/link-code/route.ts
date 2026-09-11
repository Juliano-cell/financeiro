import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { getCurrentUser, isSameOriginRequest } from "@/app/auth";
import { digestToken } from "@/lib/auth-crypto.mjs";
import { FinanceValidationError } from "@/lib/finance-service";
import { consumeRateLimit, RateLimitError } from "@/lib/rate-limit";
import { createTelegramLinkCode } from "@/lib/telegram-link-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Origem inválida." }, { status: 403 });
  try {
    if (!env.TELEGRAM_LINK_CODE_SECRET) return NextResponse.json({ error: "Vinculação do Telegram não configurada." }, { status: 503 });
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
    await consumeRateLimit(`telegram-code-generate:${await digestToken(user.id)}`, 5, 60 * 60_000);
    return NextResponse.json(await createTelegramLinkCode(user.id));
  } catch (error) {
    if (error instanceof RateLimitError) return NextResponse.json({ error: error.message }, { status: 429 });
    if (error instanceof FinanceValidationError) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error("telegram_link_code_failed", error);
    return NextResponse.json({ error: "Não foi possível gerar o código." }, { status: 500 });
  }
}
