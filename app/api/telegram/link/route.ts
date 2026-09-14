import { NextResponse } from "next/server";
import { getCurrentUser, isSameOriginRequest } from "@/app/auth";
import { FinanceValidationError } from "@/lib/finance-service";
import { disconnectTelegram, getTelegramLinkStatus } from "@/lib/telegram-link-service";

export const dynamic = "force-dynamic";

function safeError(error: unknown) {
  if (error instanceof FinanceValidationError) return NextResponse.json({ error: error.message }, { status: 409 });
  console.error("telegram_link_management_failed");
  return NextResponse.json({ error: "Não foi possível consultar ou atualizar a conexão do Telegram." }, { status: 500 });
}

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
    return NextResponse.json(await getTelegramLinkStatus(user.id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return safeError(error);
  }
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Origem inválida." }, { status: 403 });
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
    await disconnectTelegram(user.id);
    return NextResponse.json({ ok: true, connected: false });
  } catch (error) {
    return safeError(error);
  }
}
