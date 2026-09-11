import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { getCurrentUser, isSameOriginRequest } from "@/app/auth";
import { getDb } from "@/db";
import { householdMembers, telegramLinkCodes, telegramLinks } from "@/db/schema";
import { digestToken, hmacToken } from "@/lib/auth-crypto.mjs";
import { consumeRateLimit, RateLimitError } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

function generateSixDigitCode() {
  const range = 1_000_000;
  const ceiling = Math.floor(0x1_0000_0000 / range) * range;
  const random = new Uint32Array(1);
  do crypto.getRandomValues(random); while (random[0] >= ceiling);
  return String(random[0] % range).padStart(6, "0");
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Origem inválida." }, { status: 403 });
  try {
    if (!env.TELEGRAM_LINK_CODE_SECRET) return NextResponse.json({ error: "Vinculação do Telegram não configurada." }, { status: 503 });
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
    await consumeRateLimit(`telegram-code-generate:${await digestToken(user.id)}`, 5, 60 * 60_000);
    const db = getDb();
    const [membership] = await db.select().from(householdMembers).where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active"))).limit(1);
    if (!membership) return NextResponse.json({ error: "Família não encontrada." }, { status: 409 });
    const [linked] = await db.select().from(telegramLinks).where(and(eq(telegramLinks.userId, user.id), eq(telegramLinks.householdId, membership.householdId), eq(telegramLinks.isActive, true))).limit(1);
    if (linked) return NextResponse.json({ error: "Este usuário já possui um Telegram conectado." }, { status: 409 });
    const createdAt = new Date().toISOString();
    await db.delete(telegramLinkCodes).where(or(isNotNull(telegramLinkCodes.usedAt), lte(telegramLinkCodes.expiresAt, createdAt)));
    await db.update(telegramLinkCodes).set({ usedAt: createdAt }).where(and(eq(telegramLinkCodes.userId, user.id), eq(telegramLinkCodes.householdId, membership.householdId), isNull(telegramLinkCodes.usedAt)));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = generateSixDigitCode();
      const codeHash = await hmacToken(code, env.TELEGRAM_LINK_CODE_SECRET);
      try {
        await db.insert(telegramLinkCodes).values({ id: `telegram_code_${crypto.randomUUID()}`, householdId: membership.householdId, userId: user.id, codeHash, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), createdAt });
        return NextResponse.json({ code, expiresInSeconds: 600 });
      } catch (error) {
        if (attempt === 9) throw error;
      }
    }
    return NextResponse.json({ error: "Não foi possível gerar um código único." }, { status: 503 });
  } catch (error) {
    if (error instanceof RateLimitError) return NextResponse.json({ error: error.message }, { status: 429 });
    console.error("telegram_link_code_failed", error);
    return NextResponse.json({ error: "Não foi possível gerar o código." }, { status: 500 });
  }
}
